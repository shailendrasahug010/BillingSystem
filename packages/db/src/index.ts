import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export * as schema from "./schema/index.js";

/**
 * Create a Drizzle client. The API uses one pool per process; every business
 * operation that touches money or stock runs inside db.transaction(...).
 */
export function createDb(connectionString: string, options: { max?: number } = {}) {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

export type Database = ReturnType<typeof createDb>["db"];

export { seedBusinessDefaults, seedReferenceData } from "./seed/index.js";
