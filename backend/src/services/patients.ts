/**
 * Service de búsqueda de pacientes hospitalizados. Port directo de
 * lib/hospitals.ts:searchPatients (rama hasDbEnv), preservando EXACTAMENTE el
 * SQL (REGEXP_REPLACE para cédulas, los CASE de orden) vía el escape `sql` de
 * drizzle-orm, y el contrato de salida { patient, hospital } por resultado.
 *
 * publicSafe: el route público SIEMPRE pasa publicSafe=true → WHERE solo por
 * nombre (no notas/contacto/cédula) para que un caller anónimo no enumere por
 * cédula/teléfono parcial (audit C-1). Los campos de contacto SÍ se devuelven
 * (decisión de producto), pero no son vector de búsqueda público.
 *
 * NOTA de seeding: el lib previo llamaba seedHospitalsIfNeeded() en el request
 * path. En el backend el seed de hospitales es responsabilidad del Job de
 * migrate/seed, NO del request path (evita 174 inserts inline). Si la tabla está
 * vacía, la búsqueda devuelve []. (ponytail: seed fuera del request path.)
 *
 * Allowlist de salida: toSearchResultDTO selecciona campos explícitos; las filas
 * de paciente no tienen columnas sensibles tipo ip_hash.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ensurePrn, enqueueMatcherSweep } from "@/services/person-records";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

export type PatientStatus =
  | "hospitalized"
  | "sheltered"
  | "discharged"
  | "transferred"
  | "deceased";
export type PatientCondition =
  | "stable"
  | "serious"
  | "critical"
  | "recovering"
  | "unknown";

const PATIENT_STATUSES: ReadonlySet<PatientStatus> = new Set([
  "hospitalized",
  "sheltered",
  "discharged",
  "transferred",
  "deceased",
]);
const PATIENT_CONDITIONS: ReadonlySet<PatientCondition> = new Set([
  "stable",
  "serious",
  "critical",
  "recovering",
  "unknown",
]);

export interface PatientDTO {
  id: string;
  hospitalId: string;
  name: string;
  age: number | null;
  condition: PatientCondition;
  status: PatientStatus;
  notes: string;
  contact: string;
  /**
   * true si el registro tiene documento/cédula (solo se guarda su HMAC, nunca
   * el crudo). Presente SOLO en el CRUD admin (patientSelect); la búsqueda
   * pública lo excluye a propósito.
   */
  hasDocument?: boolean;
  admittedAt: number;
  updatedAt: number;
}

export type PublicPatientDTO = Omit<PatientDTO, "notes" | "hasDocument">;

export interface PatientSearchResult {
  patient: PublicPatientDTO;
  hospital: {
    id: string;
    name: string;
    state: string;
    municipality: string;
    address: string;
  };
}

// Fila cruda devuelta por el SELECT con join (camelCase por los alias del SQL).
interface PatientWithHospitalRow {
  id: string;
  hospitalId: string;
  name: string;
  age: number | null;
  condition: string;
  status: string;
  notes: string | null;
  contact: string | null;
  /** Solo presente en el camino CRUD (patientSelect); la búsqueda no lo trae. */
  hasDocument?: boolean;
  admittedAt: number;
  updatedAt: number;
  hospitalName: string;
  hospitalState: string;
  hospitalMunicipality: string;
  hospitalAddress: string;
}

function rowToPatientDTO(r: PatientWithHospitalRow): PatientDTO {
  return {
    id: r.id,
    hospitalId: r.hospitalId,
    name: r.name,
    age: r.age === null ? null : Number(r.age),
    condition: PATIENT_CONDITIONS.has(r.condition as PatientCondition)
      ? (r.condition as PatientCondition)
      : "unknown",
    status: PATIENT_STATUSES.has(r.status as PatientStatus)
      ? (r.status as PatientStatus)
      : "hospitalized",
    notes: r.notes ?? "",
    contact: r.contact ?? "",
    ...(r.hasDocument !== undefined ? { hasDocument: Boolean(r.hasDocument) } : {}),
    admittedAt: Number(r.admittedAt),
    updatedAt: Number(r.updatedAt),
  };
}

function rowToSearchResult(r: PatientWithHospitalRow): PatientSearchResult {
  const { notes: _notes, hasDocument: _hasDocument, ...patient } = rowToPatientDTO(r);
  return {
    patient,
    hospital: {
      id: r.hospitalId,
      name: r.hospitalName,
      state: r.hospitalState,
      municipality: r.hospitalMunicipality,
      address: r.hospitalAddress,
    },
  };
}

/**
 * Búsqueda global de pacientes. Port de lib/hospitals.ts:searchPatients.
 * @param limit ya viene acotado por el route (safeLimit + 1 para detectar hasMore).
 */
export async function searchPatients(
  query: string,
  limit = 50,
  opts: { publicSafe?: boolean } = {},
): Promise<PatientSearchResult[]> {
  const q = (query ?? "").trim();
  const cleanLimit = Math.min(Math.max(limit, 1), 501);
  const publicSafe = opts.publicSafe ?? false;
  const db = await getDb();

  // REGEXP_REPLACE y los CASE de orden no se expresan con el query builder sin
  // perder fidelidad: se preserva el SQL exacto vía escape `sql`.
  const baseSelect = sql`
    SELECT
      p.id, p.hospital_id AS "hospitalId", p.name, p.age, p.condition,
      p.status, p.notes, p.contact, p.admitted_at AS "admittedAt",
      p.updated_at AS "updatedAt",
      h.name AS "hospitalName",
      h.state AS "hospitalState",
      h.municipality AS "hospitalMunicipality",
      h.address AS "hospitalAddress"
    FROM hospital_patients p
    INNER JOIN hospitals h ON h.id = p.hospital_id
  `;

  if (!q) {
    const result = await db.execute(sql`
      ${baseSelect}
      ORDER BY
        CASE WHEN p.status IN ('hospitalized', 'sheltered') THEN 0 ELSE 1 END,
        p.admitted_at DESC
      LIMIT ${cleanLimit}
    `);
    const rows = (Array.isArray(result)
      ? result
      : result.rows) as PatientWithHospitalRow[];
    return rows.map(rowToSearchResult);
  }

  if (q.length < 2) return [];

  const like = `%${q.toLowerCase()}%`;
  // Para cédulas el usuario puede escribir con o sin puntos: comparo también
  // contra una versión "limpia" (solo dígitos) de las notas.
  const digits = q.replace(/[^0-9]/g, "");
  const digitsLike = digits.length >= 4 ? `%${digits}%` : null;

  const whereSql = publicSafe
    ? sql`WHERE LOWER(p.name) LIKE ${like}`
    : sql`WHERE
        LOWER(p.name) LIKE ${like}
        OR LOWER(p.notes) LIKE ${like}
        OR LOWER(p.contact) LIKE ${like}
        OR (${digitsLike}::text IS NOT NULL
            AND REGEXP_REPLACE(p.notes, '[^0-9]', '', 'g') LIKE ${digitsLike})`;

  const result = await db.execute(sql`
    ${baseSelect}
    ${whereSql}
    ORDER BY
      CASE WHEN LOWER(p.name) LIKE ${like} THEN 0 ELSE 1 END,
      p.admitted_at DESC
    LIMIT ${cleanLimit}
  `);
  const rows = (Array.isArray(result)
    ? result
    : result.rows) as PatientWithHospitalRow[];
  return rows.map(rowToSearchResult);
}

// ============================================================================
// CRUD por id — respalda la fábrica `api/public/patients`. Mismo idioma que
// searchPatients: `await getDb()` + escape `sql` + allowlist DTO. Datos médicos
// sensibles: SOLO se exponen los campos de PatientDTO (sin columnas internas), y
// las escrituras recortan/clampean igual que el resto del service.
// ============================================================================

/** Fila cruda del paciente (sin join), camelCase por los alias del SQL. */
interface PatientRow {
  id: string;
  hospitalId: string;
  name: string;
  age: number | null;
  condition: string;
  status: string;
  notes: string | null;
  contact: string | null;
  hasDocument: boolean;
  admittedAt: number;
  updatedAt: number;
}

/** Convierte una fila sin join a PatientDTO (reusa la normalización con join vacío). */
function rowToPatient(r: PatientRow): PatientDTO {
  return rowToPatientDTO({
    ...r,
    hospitalName: "",
    hospitalState: "",
    hospitalMunicipality: "",
    hospitalAddress: "",
  });
}

/** SELECT base de un paciente (allowlist explícita de columnas, sin join). */
const patientSelect = sql`
  SELECT
    p.id, p.hospital_id AS "hospitalId", p.name, p.age, p.condition,
    p.status, p.notes, p.contact,
    (p.document_hash IS NOT NULL) AS "hasDocument",
    p.admitted_at AS "admittedAt",
    p.updated_at AS "updatedAt"
  FROM hospital_patients p
`;

/** Devuelve un paciente por id como DTO (allowlist), o null si no existe. */
export async function getPatientById(id: string): Promise<PatientDTO | null> {
  const db = await getDb();
  const result = await db.execute(sql`${patientSelect} WHERE p.id = ${id} LIMIT 1`);
  const rows = (Array.isArray(result) ? result : result.rows) as PatientRow[];
  return rows[0] ? rowToPatient(rows[0]) : null;
}

export interface CreatePatientInput {
  hospitalId: string;
  name: string;
  age?: number | null;
  condition?: PatientCondition;
  status?: PatientStatus;
  notes?: string;
  contact?: string;
  /**
   * HMAC del documento normalizado (lo computa la capa de interfaz con
   * PATIENT_DOCUMENT_HASH_SECRET; aquí NUNCA llega el documento crudo).
   */
  documentHash?: string | null;
}

/** Crea un paciente. Recorta/clampea igual que el resto del service. */
export async function createPatient(
  input: CreatePatientInput,
  scope: TenantScope,
): Promise<PatientDTO> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  const condition = PATIENT_CONDITIONS.has(input.condition as PatientCondition)
    ? (input.condition as PatientCondition)
    : "unknown";
  const status = PATIENT_STATUSES.has(input.status as PatientStatus)
    ? (input.status as PatientStatus)
    : "hospitalized";
  const age =
    input.age === null || input.age === undefined
      ? null
      : Math.max(0, Math.trunc(Number(input.age)));
  const name = input.name.trim().slice(0, 120);
  const notes = (input.notes ?? "").trim().slice(0, 600);
  const contact = (input.contact ?? "").trim().slice(0, 120);

  const ownership = incidentOwnership(scope);
  await db.execute(sql`
    INSERT INTO hospital_patients
      (id, hospital_id, name, age, condition, status, notes, contact, document_hash, admitted_at, updated_at, organization_id, incident_id)
    VALUES
      (${id}, ${input.hospitalId}, ${name}, ${age}, ${condition}, ${status},
       ${notes}, ${contact}, ${input.documentHash ?? null}, ${now}, ${now},
       ${ownership.organizationId}, ${ownership.incidentId})
  `);

  // Best-effort (U7/R8): nunca debe tumbar esta creación ya confirmada —
  // ensurePrn loguea y devuelve null ante cualquier fallo, nunca lanza. Si
  // esto queda sin estampar (p.ej. una caída a mitad), el cron de
  // reconciliación (KTD8) lo recoge en su próxima corrida.
  // AE2/U8: sweep inmediato si el PRN se estampó aquí mismo — sin esto, el
  // registro nunca aparece en listUnstamped (ya tiene PRN) y el reconcile
  // jamás lo barre, así que un paciente cuya cédula coincide con un reporte
  // existente no genera propuesta hasta el próximo cambio de document_hash.
  const prn = await ensurePrn("hospital_patient", id, scope);
  if (prn) await enqueueMatcherSweep([prn], scope);

  return {
    id,
    hospitalId: input.hospitalId,
    name,
    age,
    condition,
    status,
    notes,
    contact,
    hasDocument: (input.documentHash ?? null) !== null,
    admittedAt: now,
    updatedAt: now,
  };
}

export interface UpdatePatientInput {
  name?: string;
  age?: number | null;
  condition?: PatientCondition;
  status?: PatientStatus;
  notes?: string;
  contact?: string;
  /** Traslado a otro hospital. La capa de interfaz valida que el id exista. */
  hospitalId?: string;
  /**
   * HMAC del documento normalizado (computado en la capa de interfaz; el
   * documento crudo nunca llega aquí). `null` borra el documento del registro.
   */
  documentHash?: string | null;
}

/** Actualiza campos permitidos de un paciente. Devuelve el DTO o null si no existe. */
export async function updatePatient(
  id: string,
  input: UpdatePatientInput,
): Promise<PatientDTO | null> {
  const db = await getDb();
  const sets = [sql`updated_at = ${Date.now()}`];
  if (input.name !== undefined) sets.push(sql`name = ${input.name.trim().slice(0, 120)}`);
  if (input.age !== undefined) {
    const age = input.age === null ? null : Math.max(0, Math.trunc(Number(input.age)));
    sets.push(sql`age = ${age}`);
  }
  if (input.condition !== undefined && PATIENT_CONDITIONS.has(input.condition))
    sets.push(sql`condition = ${input.condition}`);
  if (input.status !== undefined && PATIENT_STATUSES.has(input.status))
    sets.push(sql`status = ${input.status}`);
  if (input.notes !== undefined) sets.push(sql`notes = ${input.notes.trim().slice(0, 600)}`);
  if (input.contact !== undefined)
    sets.push(sql`contact = ${input.contact.trim().slice(0, 120)}`);
  if (input.hospitalId !== undefined) sets.push(sql`hospital_id = ${input.hospitalId}`);
  if (input.documentHash !== undefined)
    sets.push(sql`document_hash = ${input.documentHash}`);

  const result = await db.execute(sql`
    UPDATE hospital_patients
    SET ${sql.join(sets, sql`, `)}
    WHERE id = ${id}
    RETURNING id
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as unknown[];
  return rows.length > 0 ? getPatientById(id) : null;
}

/** Elimina un paciente. True si existía. */
export async function removePatient(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    sql`DELETE FROM hospital_patients WHERE id = ${id} RETURNING id`,
  );
  const rows = (Array.isArray(result) ? result : result.rows) as unknown[];
  return rows.length > 0;
}

/** Lista pacientes (DTO allowlist, sin join). Hospitalizados / más recientes primero. */
export async function listPatients(limit = 200): Promise<PatientDTO[]> {
  const db = await getDb();
  const cleanLimit = Math.min(Math.max(limit, 1), 500);
  const result = await db.execute(sql`
    ${patientSelect}
    ORDER BY
      CASE WHEN p.status IN ('hospitalized', 'sheltered') THEN 0 ELSE 1 END,
      p.admitted_at DESC
    LIMIT ${cleanLimit}
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as PatientRow[];
  return rows.map(rowToPatient);
}
