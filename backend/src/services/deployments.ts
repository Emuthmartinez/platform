/**
 * Hostname catalog (KTD7): canonical hostname → organization + incident.
 *
 * Mutations are superadmin-only at the router. This module does not decide
 * who may call it. It refuses mixed org/incident pairs (composite FK) and
 * refuses delete of the live API/admin/public hostnames for this process.
 */
import { asc, eq } from "drizzle-orm";
import { env } from "@/config/env";
import { getDb, schema } from "@/db";
import { badRequest, conflict } from "@/lib/errors";
import { canonicalizeHostname } from "@/tenant/hostname";

const { deployments, organizations, incidents } = schema;

export interface DeploymentDTO {
  hostname: string;
  organizationId: string;
  incidentId: string;
  organizationName: string;
  incidentName: string;
  createdAt: number;
}

export interface OrganizationOption {
  id: string;
  name: string;
}

export interface IncidentOption {
  id: string;
  organizationId: string;
  name: string;
}

export interface DeploymentCatalog {
  items: DeploymentDTO[];
  organizations: OrganizationOption[];
  incidents: IncidentOption[];
}

function pgCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: string }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function requireCanonicalHostname(raw: string): string {
  const hostname = canonicalizeHostname(raw);
  if (!hostname || hostname.length > 253) {
    throw badRequest("Hostname inválido.");
  }
  return hostname;
}

export function protectedHostnames(currentHostname?: string | null): Set<string> {
  const hosts = new Set<string>();
  for (const raw of [env.APP_BASE_URL, env.ADMIN_BASE_URL]) {
    if (!raw) continue;
    try {
      const host = canonicalizeHostname(new URL(raw).hostname);
      if (host) hosts.add(host);
    } catch {
      // Ignore unparseable env URLs; delete protection still covers PINNED
      // and the current request hostname.
    }
  }
  const pin = canonicalizeHostname(env.PINNED_DEPLOYMENT_HOSTNAME);
  if (pin) hosts.add(pin);
  const current = canonicalizeHostname(currentHostname);
  if (current) hosts.add(current);
  return hosts;
}

export async function listDeploymentCatalog(): Promise<DeploymentCatalog> {
  const db = getDb();
  const [rows, orgs, incs] = await Promise.all([
    db
      .select({
        hostname: deployments.hostname,
        organizationId: deployments.organizationId,
        incidentId: deployments.incidentId,
        createdAt: deployments.createdAt,
        organizationName: organizations.name,
        incidentName: incidents.name,
      })
      .from(deployments)
      .innerJoin(organizations, eq(deployments.organizationId, organizations.id))
      .innerJoin(incidents, eq(deployments.incidentId, incidents.id))
      .orderBy(asc(deployments.hostname)),
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .orderBy(asc(organizations.name)),
    db
      .select({
        id: incidents.id,
        organizationId: incidents.organizationId,
        name: incidents.name,
      })
      .from(incidents)
      .orderBy(asc(incidents.name)),
  ]);
  return {
    items: rows.map((row) => ({
      hostname: row.hostname,
      organizationId: row.organizationId,
      incidentId: row.incidentId,
      organizationName: row.organizationName,
      incidentName: row.incidentName,
      createdAt: row.createdAt,
    })),
    organizations: orgs,
    incidents: incs,
  };
}

export async function createDeployment(input: {
  hostname: string;
  organizationId: string;
  incidentId: string;
}): Promise<DeploymentDTO> {
  const hostname = requireCanonicalHostname(input.hostname);
  const db = getDb();
  try {
    await db.insert(deployments).values({
      hostname,
      organizationId: input.organizationId,
      incidentId: input.incidentId,
      createdAt: Date.now(),
    });
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505") throw conflict("Ese hostname ya tiene un deployment.");
    if (code === "23503") {
      throw badRequest("organization_id e incident_id deben ser un incidente de esa organización.");
    }
    throw err;
  }
  const catalog = await listDeploymentCatalog();
  const item = catalog.items.find((row) => row.hostname === hostname);
  if (!item) throw badRequest("No se pudo leer el deployment creado.");
  return item;
}

export async function updateDeployment(
  rawHostname: string,
  input: { organizationId?: string; incidentId?: string },
): Promise<DeploymentDTO | null> {
  const hostname = requireCanonicalHostname(rawHostname);
  const db = getDb();
  const [existing] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.hostname, hostname))
    .limit(1);
  if (!existing) return null;

  const organizationId = input.organizationId ?? existing.organizationId;
  const incidentId = input.incidentId ?? existing.incidentId;
  try {
    await db
      .update(deployments)
      .set({ organizationId, incidentId })
      .where(eq(deployments.hostname, hostname));
  } catch (err) {
    const code = pgCode(err);
    if (code === "23503") {
      throw badRequest("organization_id e incident_id deben ser un incidente de esa organización.");
    }
    throw err;
  }
  const catalog = await listDeploymentCatalog();
  return catalog.items.find((row) => row.hostname === hostname) ?? null;
}

export async function deleteDeployment(
  rawHostname: string,
  currentHostname?: string | null,
): Promise<boolean> {
  const hostname = requireCanonicalHostname(rawHostname);
  if (protectedHostnames(currentHostname).has(hostname)) {
    throw badRequest("No puedes borrar el hostname en uso de este entorno.");
  }
  const db = getDb();
  const [existing] = await db
    .select({ hostname: deployments.hostname })
    .from(deployments)
    .where(eq(deployments.hostname, hostname))
    .limit(1);
  if (!existing) return false;
  await db.delete(deployments).where(eq(deployments.hostname, hostname));
  return true;
}
