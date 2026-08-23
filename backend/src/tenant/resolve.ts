import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createTenantScope, type TenantScope } from "@/tenant/scope";

export async function loadDeploymentByHostname(
  hostname: string,
): Promise<TenantScope | null> {
  const db = getDb();
  const [row] = await db
    .select({
      hostname: schema.deployments.hostname,
      organizationId: schema.deployments.organizationId,
      incidentId: schema.deployments.incidentId,
    })
    .from(schema.deployments)
    .where(eq(schema.deployments.hostname, hostname))
    .limit(1);
  if (!row) return null;
  return createTenantScope({
    hostname: row.hostname,
    organizationId: row.organizationId,
    incidentId: row.incidentId,
  });
}
