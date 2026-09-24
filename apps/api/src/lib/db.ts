import type { Database, Tx } from "@vyapaar/db";
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
