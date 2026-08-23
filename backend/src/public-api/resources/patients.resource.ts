/**
 * Recurso `api/public/patients` — CONFIG declarativa sobre la fábrica CRUD.
 * Pacientes hospitalizados (datos médicos sensibles): el DTO del service ya es
 * una allowlist estricta; aquí solo validamos la entrada con cotas sanas y
 * delegamos toda la lógica/DB al service. La fábrica pone rate-limit,
 * requireCapability, validación y auditoría.
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { env } from "@/config/env";
import { invalidate } from "@/lib/cache";
import { badRequest, conflict, serviceUnavailable } from "@/lib/errors";
import { getHospital } from "@/services/hospitals";
import {
  documentDigits,
  hashDocumentDigits,
} from "@/services/patient-import-logic";
import * as service from "@/services/patients";
import { tombstonePersonRecord } from "@/services/person-records";
import { writeAudit } from "@/auth/audit";
import { requireTenantScope } from "@/middleware/tenant";

/**
 * Cédula/documento → HMAC, MISMA normalización y clave que la importación en
 * lote (documentDigits + PATIENT_DOCUMENT_HASH_SECRET): un documento editado a
 * mano deduplica contra los importados. El crudo NUNCA baja al service ni a la
 * tabla. `null` = borrar el documento del registro.
 */
function toDocumentHash(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = documentDigits(raw);
  if (!digits) {
    throw badRequest(
      "Documento inválido: se esperan al menos 4 dígitos (se ignoran puntos y guiones).",
    );
  }
  const secret = env.PATIENT_DOCUMENT_HASH_SECRET;
  if (!secret) {
    throw serviceUnavailable(
      "PATIENT_DOCUMENT_HASH_SECRET no está configurado; no se puede guardar el documento.",
    );
  }
  return hashDocumentDigits(digits, secret);
}

function isUniqueViolation(err: unknown): boolean {
  // drizzle envuelve el error de pg en DrizzleQueryError: el code 23505 vive
  // en `cause`. Recorrer la cadena cubre ambas formas.
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const DOCUMENT_CONFLICT_MESSAGE =
  "Ya existe otro paciente con ese documento — probablemente es el mismo registro; búscalo antes de duplicarlo.";

const condition = z.enum(["stable", "serious", "critical", "recovering", "unknown"]);
const status = z.enum([
  "hospitalized",
  "sheltered",
  "discharged",
  "transferred",
  "deceased",
]);

// age opcional/nullable; entero >= 0 y acotado a un máximo plausible (mismo
// clamp que el service: Math.max(0, trunc)).
const age = z.coerce.number().int().min(0).max(150).nullable();

// Documento/cédula CRUDO de entrada: se convierte a HMAC en esta capa y jamás
// se persiste ni se devuelve. En update, `null` explícito borra el documento.
const documentId = z.string().trim().min(1).max(60);

const createSchema = z.object({
  hospitalId: z.string().trim().min(1, "Indica el hospital.").max(120),
  name: z.string().trim().min(1, "Indica el nombre.").max(120),
  age: age.optional(),
  condition: condition.optional(),
  status: status.optional(),
  notes: z.string().max(600).optional(),
  contact: z.string().max(120).optional(),
  documentId: documentId.optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    age: age.optional(),
    condition: condition.optional(),
    status: status.optional(),
    notes: z.string().max(600).optional(),
    contact: z.string().max(120).optional(),
    hospitalId: z.string().trim().min(1).max(120).optional(),
    documentId: documentId.nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo a actualizar.");

// DTO de SALIDA (lo que devuelve el service: PatientDTO). Solo para documentar la
// forma del retorno en /api/docs.
const responseSchema = z.object({
  id: z.string(),
  hospitalId: z.string(),
  name: z.string(),
  age: z.number().nullable(),
  condition: z.string(),
  status: z.string(),
  notes: z.string(),
  contact: z.string(),
  // Presencia de documento (el HMAC ni el crudo se exponen jamás).
  hasDocument: z.boolean().optional(),
  admittedAt: z.number(),
  updatedAt: z.number(),
});

export const patientsResource: CrudResource<
  Awaited<ReturnType<typeof service.listPatients>>[number],
  Awaited<ReturnType<typeof service.getPatientById>>,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "patient",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    list: () => service.listPatients(),
    get: (id) => service.getPatientById(id),
    create: async (input, req) => {
      const { documentId, ...rest } = input;
      const documentHash =
        documentId === undefined ? undefined : toDocumentHash(documentId);
      try {
        const patient = await service.createPatient(
          { ...rest, documentHash },
          requireTenantScope(req),
        );
        invalidate();
        return patient;
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(DOCUMENT_CONFLICT_MESSAGE);
        throw err;
      }
    },
    update: async (id, input) => {
      const { documentId, ...rest } = input;
      // Traslado: validar el hospital ANTES de tocar la fila (la FK daría un
      // 500 opaco; esto da un 400 con causa).
      if (rest.hospitalId !== undefined) {
        const hospital = await getHospital(rest.hospitalId);
        if (!hospital) throw badRequest("El hospital indicado no existe en el catálogo.");
      }
      const documentHash =
        documentId === undefined ? undefined : toDocumentHash(documentId);
      try {
        const patient = await service.updatePatient(id, { ...rest, documentHash });
        if (patient) invalidate();
        return patient;
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(DOCUMENT_CONFLICT_MESSAGE);
        throw err;
      }
    },
    remove: async (id) => {
      const removed = await service.removePatient(id);
      if (removed) invalidate();
      return removed;
    },
    // U10 (R21/AE3): tombstone de identidad ANTES del borrado físico — mismo
    // orden que missing.resource.ts. Best-effort (tombstonePersonRecord nunca
    // lanza); req.user existe siempre aquí (requireCapability autentica
    // primero).
    onBeforeRemove: async (req, id) => {
      const tombstone = await tombstonePersonRecord("hospital_patient", id, req.user!.id);
      if (tombstone.prn) {
        await writeAudit(req, {
          action: "person.purge",
          targetType: "person_record",
          targetId: tombstone.prn,
        });
      }
    },
  },
};

export const publicPatientsRouter = createCrudRouter(patientsResource);
