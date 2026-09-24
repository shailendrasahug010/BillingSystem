import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

/**
 * SQL migrations folder. Resolved next to this module in the workspace; in the
 * bundled deploy image it resolves to /app/migrations (dist/../migrations).
 * MIGRATIONS_DIR overrides both.
 */
export const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies pending migrations in order, as the schema OWNER (not the app role).
 * Run on deploy before the new API version starts.
 */
export async function runMigrations(ownerConnectionString: string): Promise<void> {
  const { db, pool } = createDb(ownerConnectionString, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
