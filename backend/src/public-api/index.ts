/**
 * Punto de montaje de la superficie `api/public/*` (integraciones + admin).
 *
 * Cada recurso es un router CRUD generado por la fábrica a partir de su config.
 * `mountPublicApi(app)` los cuelga bajo `/api/public/*`. El router de auth
 * (login/invite/me) se monta aparte porque no es un CRUD de modelo.
 *
 * Para añadir un modelo: crea `resources/<modelo>.resource.ts` con su CONFIG y
 * regístralo en RESOURCES abajo (config) — el router y la doc OpenAPI se derivan
 * solos de esa config. Nada más.
 */
import type { Express } from "express";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { authRouter } from "@/routes/auth";
import { patientImportsRouter } from "@/public-api/patient-imports";
import { officialDeceasedImportsRouter } from "@/public-api/official-deceased-imports";
import { reportsResource } from "@/public-api/resources/reports.resource";
import { missingResource } from "@/public-api/resources/missing.resource";
import { petsResource } from "@/public-api/resources/pets.resource";
import { hospitalsResource } from "@/public-api/resources/hospitals.resource";
import { patientsResource } from "@/public-api/resources/patients.resource";
import { donationsResource } from "@/public-api/resources/donations.resource";
import { chatResource } from "@/public-api/resources/chat.resource";
import { contactResource } from "@/public-api/resources/contact.resource";
import { volunteersResource } from "@/public-api/resources/volunteers.resource";
import { volunteerTasksResource } from "@/public-api/resources/volunteer-tasks.resource";
import { volunteerCheckinsResource } from "@/public-api/resources/volunteer-checkins.resource";
import { rolesResource } from "@/public-api/resources/roles.resource";
import { campaignSitesResource } from "@/public-api/resources/campaign-sites.resource";
import { campaignStewardsResource } from "@/public-api/resources/campaign-stewards.resource";
import { campaignPledgesResource } from "@/public-api/resources/campaign-pledges.resource";
import { campaignShipmentsResource } from "@/public-api/resources/campaign-shipments.resource";
// Routers RBAC escritos a mano (verbos irregulares que no encajan en la fábrica).
import { usersRouter } from "@/public-api/routers/users.router";
import { grantsRouter } from "@/public-api/routers/grants.router";
import { auditRouter } from "@/public-api/routers/audit.router";
import { capabilitiesRouter } from "@/public-api/routers/capabilities.router";
import { apiKeysRouter } from "@/public-api/routers/api-keys.router";
import { hubCredentialsRouter } from "@/public-api/routers/hub-credentials.router";
import { hospitalSuppliesRouter } from "@/public-api/routers/hospital-supplies.router";
import { volunteerAnalyticsRouter } from "@/public-api/routers/volunteer-analytics.router";
import { deletionRequestsRouter } from "@/public-api/routers/deletion-requests.router";
import { partnerSyncRouter } from "@/public-api/routers/partner-sync.router";
import { personLinksRouter } from "@/public-api/routers/person-links.router";
import { recordSignalsRouter } from "@/public-api/routers/record-signals.router";
import { psychologyRouter } from "@/public-api/routers/psychology.router";
import { volunteersActionsRouter } from "@/public-api/routers/volunteers-actions.router";
import { volunteerTasksActionsRouter } from "@/public-api/routers/volunteer-tasks-actions.router";
import { deploymentsRouter } from "@/public-api/routers/deployments.router";

/**
 * Registro path → CONFIG del recurso. Fuente de verdad ÚNICA: de aquí salen
 * tanto los routers (createCrudRouter) como la doc OpenAPI (buildCrudOpenApiPaths).
 */
// Los recursos tienen parámetros de tipo distintos (algunos sin update -> never),
// así que el registro los guarda con los genéricos en `unknown` (la fábrica solo
// necesita la forma, no los tipos exactos, para montar y documentar).
type AnyResource = CrudResource<unknown, unknown, unknown, unknown>;
export const PUBLIC_RESOURCES: Record<string, AnyResource> = {
  reports: reportsResource as AnyResource,
  missing: missingResource as AnyResource,
  pets: petsResource as AnyResource,
  hospitals: hospitalsResource as AnyResource,
  patients: patientsResource as AnyResource,
  donations: donationsResource as AnyResource,
  chat: chatResource as AnyResource,
  contact: contactResource as AnyResource,
  volunteers: volunteersResource as AnyResource,
  "volunteer-tasks": volunteerTasksResource as AnyResource,
  "volunteer-checkins": volunteerCheckinsResource as AnyResource,
  // RBAC: roles encaja en el cuarteto CRUD (read/create/edit/delete) → fábrica.
  roles: rolesResource as AnyResource,
  // Campaña de reconstrucción. Los cuatro comparten la capability "campaign":
  // quien coordina la campaña administra puntos, responsables, compromisos y
  // lotes como una sola cosa, igual que volunteer-tasks reutiliza "volunteer".
  "campaign-sites": campaignSitesResource as AnyResource,
  "campaign-stewards": campaignStewardsResource as AnyResource,
  "campaign-pledges": campaignPledgesResource as AnyResource,
  "campaign-shipments": campaignShipmentsResource as AnyResource,
};

export function mountPublicApi(app: Express): void {
  // Auth (no CRUD de modelo): login, invite, accept, me, logout, reset.
  app.use("/api/public/auth", authRouter);
  // Importación de pacientes (#151): no es CRUD de modelo, router escrito a mano
  // pero deny-by-default con patient:import en cada ruta.
  app.use("/api/public/patient-imports", patientImportsRouter);
  // Official deceased lists use the existing missing:create capability. The
  // domain stays separate from hospitals and citizen missing-person reports.
  app.use("/api/public/deceased-imports", officialDeceasedImportsRouter);
  // Recursos CRUD — un router generado por recurso desde su config.
  for (const [path, resource] of Object.entries(PUBLIC_RESOURCES)) {
    app.use(`/api/public/${path}`, createCrudRouter(resource));
  }
  // Insumos hospitalarios (agregado por hospital, no CRUD plano): router a mano
  // reutilizando las capacidades hospital:read / hospital:edit del catálogo.
  app.use("/api/public/hospital-supplies", hospitalSuppliesRouter);
  // Analítica de voluntarios (agregados, sin PII): volunteer:read.
  app.use("/api/public/volunteer-analytics", volunteerAnalyticsRouter);
  // Supresión de datos (Ley 1581): gestión de solicitudes, deletion:read/edit.
  app.use("/api/public/deletion-requests", deletionRequestsRouter);
  // Ingesta síncrona de un socio externo (missing:create, sin cola — ver el
  // comment-block del router para por qué no usa worker/sync ni worker/hub).
  app.use("/api/public/partner-sync", partnerSyncRouter);
  // Family Search (U9): cola de revisión, decisión, propuesta manual,
  // unmerge, búsqueda de registros y ficha de cluster. person:search/
  // person:review/person:merge (capabilities.ts).
  app.use("/api/public/person-links", personLinksRouter);
  // U14 — "señal, no verdad": cola de transiciones de status reclamadas por
  // una fuente externa + decisión (confirmar/descartar). person:search/
  // person:review (mismas capabilities que person-links, ver capabilities.ts).
  app.use("/api/public/record-signals", recordSignalsRouter);
  // RBAC con verbos irregulares (no CRUD): routers a mano. Cada ruta lleva
  // rateLimit + requireCapability + writeAudit (gates que exige el ESLint).
  app.use("/api/public/users", usersRouter); // user:read/edit/delete (invite→auth)
  app.use("/api/public/grants", grantsRouter); // grant:read/manage
  app.use("/api/public/audit", auditRouter); // audit:read
  app.use("/api/public/capabilities", capabilitiesRouter); // role:read (catálogo p/ UI)
  app.use("/api/public/api-keys", apiKeysRouter); // apikey:manage (self-service)
  app.use("/api/public/hub-credentials", hubCredentialsRouter); // mirror:manage (super admin)
  app.use("/api/public/deployments", deploymentsRouter); // deployment:manage (super admin)
  // Portal de psicólogos (/psicologia): gateado por psychology:access.
  app.use("/api/public/psychology", psychologyRouter);
  // Acciones de dominio sobre voluntarios (enviar mensaje): volunteer:edit.
  // Junto al CRUD de la fábrica; no colisiona (POST /:id/message no existe ahí).
  app.use("/api/public/volunteers", volunteersActionsRouter);
  // Asignación de tareas a voluntarios (crea token + envía correo): volunteer:edit.
  app.use("/api/public/volunteer-tasks", volunteerTasksActionsRouter);
}
