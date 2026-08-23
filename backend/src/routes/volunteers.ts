/**
 * /api/volunteers — recibe un registro de voluntario. El form público de
 * /voluntario no tenía onSubmit ni action: los registros se perdían en
 * silencio. Este route es la pieza que finalmente los persiste.
 *
 * POST público → rateLimit (estricto: limit 3) + requireHuman (Turnstile) +
 * validate(zod). Acepta `turnstileToken` opcional en el body (como contact)
 * para que el gate siga funcionando si el mantenedor repone
 * TURNSTILE_SECRET_KEY (ver CLAUDE.md "Limitaciones conocidas" — hoy
 * requireHuman deja pasar sin el secreto configurado). Persiste el HASH de IP
 * (hashIp), nunca la IP cruda.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, requireHuman, validate } from "@/middleware";
import { hashIp } from "@/lib/client-ip";
import { logDbFailure } from "@/lib/db-error";
import { captureFailedSubmission } from "@/lib/failed-submission";
import { serviceUnavailable } from "@/lib/errors";
import { requireTenantScope } from "@/middleware/tenant";
import * as service from "@/services/volunteers";

export const volunteersRouter = Router();

// Contrato del llamado Mallanet: pregunta ramificadora `offerTypes` (cada
// tipo abre solo sus preguntas) + datos base para todas las personas.
// `offer` queda como detalles opcionales (insumos/dinero/maquinaria/
// transporte); las ramas persona → digital/terreno llegan en sus campos.
export const VOLUNTEER_OFFER_TYPES = [
  "persona",
  "insumos",
  "dinero",
  "maquinaria",
  "transporte",
] as const;

const createBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "El nombre debe tener entre 1 y 120 caracteres.")
    .max(120, "El nombre debe tener entre 1 y 120 caracteres."),
  contact: z
    .string()
    .trim()
    .min(1, "Indica tu WhatsApp o correo (1 a 120 caracteres).")
    .max(120, "Indica tu WhatsApp o correo (1 a 120 caracteres)."),
  zone: z
    .string()
    .trim()
    .min(1, "Indica tu ciudad y país (1 a 200 caracteres).")
    .max(200, "Indica tu ciudad y país (1 a 200 caracteres)."),
  availability: z
    .string()
    .trim()
    .min(1, "Indica tu disponibilidad (1 a 120 caracteres).")
    .max(120, "Indica tu disponibilidad (1 a 120 caracteres)."),
  offerTypes: z
    .array(z.enum(VOLUNTEER_OFFER_TYPES))
    .min(1, "Marca al menos una cosa que puedes ofrecer.")
    .max(5),
  offer: z.string().trim().max(2000, "Los detalles no pueden pasar de 2000 caracteres.").optional().default(""),
  digitalSkills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  crisisExperience: z.boolean().optional(),
  fieldCity: z.string().trim().max(200).optional(),
  rescueTraining: z.boolean().optional(),
  fieldRole: z.string().trim().max(120).optional(),
  ownVehicle: z.boolean().optional(),
  // De dónde llegó la persona (utm:*, referrer externo o "directo"). Lo arma
  // el frontend; aquí solo acotamos longitud.
  source: z.string().trim().max(500).optional(),
  turnstileToken: z.string().optional(),
});

/**
 * @swagger
 * /api/volunteers:
 *   post:
 *     tags: [system]
 *     summary: Registra un voluntario (rate-limited)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, contact, zone, availability, offerTypes]
 *             properties:
 *               name: { type: string }
 *               contact: { type: string, description: "WhatsApp o correo" }
 *               zone: { type: string, description: "Ciudad y país actual" }
 *               availability: { type: string }
 *               offerTypes:
 *                 type: array
 *                 items: { type: string, enum: [persona, insumos, dinero, maquinaria, transporte] }
 *               offer: { type: string, description: "Detalles opcionales" }
 *               digitalSkills: { type: array, items: { type: string } }
 *               crisisExperience: { type: boolean }
 *               fieldCity: { type: string }
 *               rescueTraining: { type: boolean }
 *               fieldRole: { type: string }
 *               ownVehicle: { type: boolean }
 *               source: { type: string, description: "Origen del registro (utm/referrer/directo)" }
 *     responses:
 *       200:
 *         description: Registro recibido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 id: { type: string }
 *                 message: { type: string }
 *       400:
 *         description: Entrada inválida
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       429:
 *         description: Demasiados registros (rate limit)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo guardar el registro
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
volunteersRouter.post(
  "/",
  rateLimit({ scope: "volunteers", limit: 3 }),
  requireHuman, // Cloudflare Turnstile: formulario público, vector de spam
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createBody>;
    try {
      const volunteer = await service.createVolunteer({
        name: body.name,
        contact: body.contact,
        offer: body.offer,
        zone: body.zone,
        availability: body.availability,
        offerTypes: body.offerTypes,
        digitalSkills: body.digitalSkills,
        crisisExperience: body.crisisExperience,
        fieldCity: body.fieldCity,
        rescueTraining: body.rescueTraining,
        fieldRole: body.fieldRole,
        ownVehicle: body.ownVehicle,
        source: body.source,
        ipHash: hashIp(req),
      }, requireTenantScope(req));
      res.status(200).json({
        ok: true,
        id: volunteer.id,
        // El código se expone UNA sola vez, a la persona que se acaba de
        // registrar: es su credencial para check-ins y reportes atribuidos.
        code: volunteer.code,
        message: "Registro recibido. El equipo de coordinación te contactará.",
      });
    } catch (err) {
      // El cliente sigue viendo un 503 pelado; el SQLSTATE va al log del
      // Worker (PII-safe, ver lib/db-error). Sin esto un fallo determinista
      // —una migracion pendiente, p.ej.— es indistinguible de un parpadeo
      // de red y se pierden registros de voluntarios en silencio.
      logDbFailure("volunteers.create", err);
      // Red de durabilidad: el 503 sigue igual, pero el envio de la
      // persona no se tira. Ver lib/failed-submission (nunca lanza).
      await captureFailedSubmission("volunteers", body, err, req.tenantScope);
      throw serviceUnavailable("No se pudo guardar el registro.");
    }
  }),
);
