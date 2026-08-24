/**
 * Parameterized SQL for Node CLI schema checks. Uses TCP `pg`, same as
 * `migrate.ts`. The Neon HTTP driver cannot talk to local compose Postgres.
 */
import { Pool } from "pg";

export async function querySql<T extends Record<string, unknown>>(
  databaseUrl: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<T>(text, values);
    return result.rows;
  } finally {
    await pool.end();
  }
}
