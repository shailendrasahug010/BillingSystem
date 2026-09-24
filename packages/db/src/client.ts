import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

// NUMERIC stays a string (exact money), bigint (OID 20) is parsed as a JS number: ledger ids stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * Create a Drizzle client. The API uses one pool per process; every business
 * operation that touches money or stock runs inside db.transaction(...).
 */
export function createDb(connectionString: string, options: { max?: number; onError?: (err: Error) => void } = {}) {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // An idle connection closed by the server (restart, failover, admin) is dropped
  // from the pool and replaced on next use; without this listener it would crash the process.
  pool.on("error", options.onError ?? ((err) => console.error(`database pool: ${err.message}`)));
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}
