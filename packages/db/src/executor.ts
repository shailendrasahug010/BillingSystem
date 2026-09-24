import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "./schema/index.js";

type Schema = typeof schema;

/** A connection pool handle. */
export type Database = NodePgDatabase<Schema>;
/** An open transaction. Services take an Executor so they can join the caller's transaction. */
export type Tx = NodePgTransaction<Schema, ExtractTablesWithRelations<Schema>>;
export type Executor = Database | Tx;
