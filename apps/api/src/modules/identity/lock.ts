import { schema, type Executor } from "@digitalbahi/db";
import { eq, sql } from "drizzle-orm";
import { ApiError } from "../../lib/errors.js";

/** Wrong passwords or codes in a row before the account is locked… */
export const MAX_FAILED_LOGINS = 5;
/** …for this long. */
export const LOCK_MINUTES = 15;

/** Refuses while the account is locked, saying how long is left. */
export function assertNotLocked(user: { lockedUntil: string | null }, at: Date): void {
  if (user.lockedUntil && Date.parse(user.lockedUntil) > at.getTime()) {
    throw new ApiError(429, "ACCOUNT_LOCKED", { retryAfter: Math.ceil((Date.parse(user.lockedUntil) - at.getTime()) / 1000) });
  }
}

/**
 * Counts a wrong password or a wrong code from the authenticator app; at the
 * limit the account is locked. A successful sign-in starts the count again.
 */
export async function countFailedSignIn(db: Executor, userId: string, at: Date): Promise<void> {
  await db
    .update(schema.users)
    .set({
      failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
      lockedUntil: sql`case when ${schema.users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS}
        then ${new Date(at.getTime() + LOCK_MINUTES * 60_000).toISOString()}::timestamptz else ${schema.users.lockedUntil} end`,
    })
    .where(eq(schema.users.id, userId));
}
