/**
 * Create or promote a superadmin on the current DATABASE_URL.
 *
 *   ENSURE_SUPERADMIN_EMAIL=operator@example.org \
 *   ENSURE_SUPERADMIN_PASSWORD=... \
 *   npm run ops:ensure-superadmin -- --confirm platform-operator-bootstrap
 *
 * Does not print the password. Refuses Colombia production Neon.
 * Does not call this from Worker request code.
 */
import { ensureSuperadmin, OPERATOR_CONFIRM } from "@/lib/ops-ensure-superadmin";

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) return "true";
  return next;
}

async function main(): Promise<void> {
  const confirm = argValue(process.argv, "--confirm");
  const email = process.env.ENSURE_SUPERADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "";
  const password = process.env.ENSURE_SUPERADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "";
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const result = await ensureSuperadmin({
    email,
    password,
    name: process.env.ENSURE_SUPERADMIN_NAME,
    databaseUrl,
    confirm,
    nodeEnv: process.env.NODE_ENV,
  });
  const action = result.created ? "created" : result.promoted ? "promoted" : "already-superadmin";
  console.log(`[ops-ensure-superadmin] ${action} ${result.email}`);
  console.log(`[ops-ensure-superadmin] confirm=${OPERATOR_CONFIRM}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[ops-ensure-superadmin] ${message}`);
  process.exit(1);
});
