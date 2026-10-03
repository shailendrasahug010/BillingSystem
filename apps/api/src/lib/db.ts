import type { Database, Tx } from "@digitalbahi/db";
import { sql } from "drizzle-orm";

export interface TenantScope {
  businessId: string;
  userId: string;
}

/**
 * Runs `fn` in one transaction scoped to a business. Row-level security in
 * PostgreSQL reads app.business_id / app.user_id, so even a query that forgets
 * its WHERE business_id = … cannot see or write another tenant's rows.
 */
export async function withTenant<T>(db: Database, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.business_id', ${scope.businessId}, true), set_config('app.user_id', ${scope.userId}, true)`,
    );
    return fn(tx);
  });
}

/** Scope for work that happens before a business is chosen (login: list my businesses). */
export async function withUser<T>(db: Database, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true), set_config('app.business_id', '', true)`);
    return fn(tx);
  });
}

/**
 * Runs a transaction's reads one after another. A transaction is a single
 * connection, so Promise.all gains nothing there (node-postgres only queues
 * the queries, and pg 9 rejects overlapping ones). Tasks are thunks so each
 * query starts only when the previous one has finished.
 */
export async function inSequence<const T extends readonly (() => unknown)[]>(tasks: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const task of tasks) out.push(await task());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/**
 * Serialises requests that carry the same Idempotency-Key (two tabs syncing
 * the same work, a retry while the first is still running): the second waits
 * until the first commits, then finds what it made and returns it, instead of
 * failing on a number or key the first one took. Called first in the
 * transaction, before looking the key up; other keys never wait.
 */
export async function lockIdempotencyKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`idempotency:${key}`}, 0))`);
}
