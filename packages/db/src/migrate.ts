import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
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

let journal: Array<{ tag: string; when: number }> | null = null;

/** The migrations this code ships, oldest first (empty when the folder cannot be read). */
function journalEntries(): Array<{ tag: string; when: number }> {
  if (journal) return journal;
  try {
    journal = (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> }).entries;
  } catch {
    journal = [];
  }
  return journal;
}

/** The newest migration's tag (e.g. "0010_messaging"): the schema version a backup was made with. */
export function schemaVersion(): string {
  return journalEntries().at(-1)?.tag ?? "unknown";
}

/** How the database's migrations compare with the ones this code ships. */
export type SchemaCheck =
  | { status: "current" }
  /** Migrations this code needs are not applied (named oldest first): the code is newer than the database. */
  | { status: "behind"; missing: string[] }
  /** The database has a migration this code does not know: an older version started on a newer database. */
  | { status: "ahead" }
  /** The role may not read the migrations table: this version's database step (setupAppRole) has not run. */
  | { status: "not_granted" };

/**
 * Compares the migrations applied to the database with the ones this code
 * ships, the way Drizzle's migrator does (by the time each was made). Run as
 * the application role at start-up, which setupAppRole lets read Drizzle's
 * table, so code started on a database it is ahead of says so, instead of
 * failing on whatever it added ("function … does not exist").
 */
export async function checkSchema(client: pg.Pool | pg.ClientBase): Promise<SchemaCheck> {
  let last: number;
  try {
    const r = await client.query<{ last: string | null }>("select max(created_at)::text as last from drizzle.__drizzle_migrations");
    last = Number(r.rows[0]?.last ?? 0);
  } catch (e) {
    const code = (e as { code?: string }).code;
    // No migrations table (or no schema for it): never migrated.
    if (code === "42P01" || code === "3F000") return { status: "behind", missing: journalEntries().map((m) => m.tag) };
    if (code === "42501") return { status: "not_granted" };
    throw e;
  }
  const entries = journalEntries();
  const missing = entries.filter((m) => m.when > last).map((m) => m.tag);
  if (missing.length > 0) return { status: "behind", missing };
  if (entries.length > 0 && last > entries.at(-1)!.when) return { status: "ahead" };
  return { status: "current" };
}
