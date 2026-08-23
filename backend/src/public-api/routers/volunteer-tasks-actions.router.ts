/**
 * Acciones de dominio sobre tareas de voluntarios que no encajan en el CRUD
 * de la fábrica: asignar una tarea a un voluntario (crea la asignación con
 * token y envía el correo de bienvenida/asignación con logo y coordenadas).
 *
 * Se monta en /api/public/volunteer-tasks junto al router CRUD (no colisiona:
 * la fábrica no tiene POST /:id/assign). Gates: rateLimit + requireCapability
 * + writeAudit.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import { writeAudit } from "@/auth/audit";
import { env } from "@/config/env";
import { badRequest, notFound, serviceUnavailable } from "@/lib/errors";
import { sendVolunteerAssignmentEmail } from "@/auth/mailer";
import * as service from "@/services/volunteer-tasks";
import { requireTenantScope } from "@/middleware/tenant";

export const volunteerTasksActionsRouter = Router();

const assignBody = z.object({
  volunteerId: z.string().trim().min(1, "Indica el voluntario."),
});

/**
 * @swagger
 * /api/public/volunteer-tasks/{id}/assign:
 *   post:
 *     summary: Asigna la tarea a un voluntario y le envía el correo con su link
 *     tags: [VolunteerTasks]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [volunteerId]
 *             properties:
 *               volunteerId: { type: string }
 *     responses:
 *       200: { description: Asignación creada y correo enviado }
 *       400: { description: El contacto del voluntario no es un correo }
 *       404: { description: Tarea o voluntario no encontrado (o tarea cerrada) }
 *       503: { description: SMTP no configurado en el backend }
 */
volunteerTasksActionsRouter.post(
  "/:id/assign",
  rateLimit({ scope: "volunteer-tasks:assign", limit: 20 }),
  requireCapability("volunteer:edit"),
  validate({ body: assignBody }),
  asyncHandler(async (req, res) => {
    const taskId = (req.params as { id: string }).id;
    const { volunteerId } = req.body as z.infer<typeof assignBody>;
    const assigned = await service.assignVolunteer(
      taskId,
      volunteerId,
      requireTenantScope(req),
    );
    if (!assigned.ok && assigned.reason === "not-email") {
      throw badRequest(
        "El contacto de este voluntario no es un correo; asígnale la tarea por WhatsApp.",
      );
    }
    if (!assigned.ok) throw notFound("Tarea o voluntario no encontrado (o la tarea está cerrada).");
    const assignmentUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/voluntariado/${assigned.token}`;
    const { sent } = await sendVolunteerAssignmentEmail(assigned.volunteerEmail, {
      volunteerName: assigned.volunteerName,
      task: assigned.task,
      assignmentUrl,
    });
    if (!sent) {
      // Compensación: sin correo el link nunca llega — no dejar huérfanos.
      await service.deleteAssignment(assigned.assignmentId);
      throw serviceUnavailable("SMTP no configurado en el backend: no se pudo enviar el correo.");
    }
    await writeAudit(req, {
      action: "volunteer-task.assign",
      targetType: "volunteer-task",
      targetId: taskId,
      metadata: { volunteerId, assignmentId: assigned.assignmentId },
    });
    res.json({ ok: true, assignmentId: assigned.assignmentId, sentTo: assigned.volunteerEmail });
  }),
);
