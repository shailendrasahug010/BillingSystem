import { timingSafeEqual } from "node:crypto";
import { schema, type Database } from "@vyapaar/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../../lib/context.js";
import { ApiError } from "../../lib/errors.js";
import { newOtpCode, sha256 } from "../../lib/security.js";

export type OtpPurpose = "signup" | "login" | "reset";

const OTP_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_SECONDS = 30;
const MAX_PER_HOUR = 5;

const hashCode = (mobile: string, purpose: OtpPurpose, code: string) => sha256(`${mobile}:${purpose}:${code}`);

/**
 * Creates a challenge and hands the code to the configured sender. Only the
 * hash is stored. Throttled per mobile number on top of the per-IP limit.
 */
export async function issueOtp(
  deps: AppDeps,
  mobile: string,
  purpose: OtpPurpose,
  options: { deliver: boolean },
): Promise<{ expiresIn: number; code: string }> {
  const now = deps.clock.now();
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const recent = await deps.db
    .select({ createdAt: schema.otpChallenges.createdAt })
    .from(schema.otpChallenges)
    .where(and(eq(schema.otpChallenges.mobile, mobile), gt(schema.otpChallenges.createdAt, hourAgo)))
    .orderBy(desc(schema.otpChallenges.createdAt));
  const last = recent[0];
  if (last) {
    const wait = RESEND_AFTER_SECONDS - Math.floor((now.getTime() - Date.parse(last.createdAt)) / 1000);
    if (wait > 0) throw new ApiError(429, "OTP_TOO_SOON", { retryAfter: wait });
  }
  if (recent.length >= MAX_PER_HOUR) throw new ApiError(429, "OTP_LIMIT_REACHED");

  const code = newOtpCode();
  await deps.db.insert(schema.otpChallenges).values({
    id: uuidv7(),
    mobile,
    purpose,
    codeHash: hashCode(mobile, purpose, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000).toISOString(),
    createdAt: now.toISOString(),
  });
  if (options.deliver) {
    try {
      await deps.otp.send(mobile, code, purpose);
    } catch {
      throw new ApiError(502, "OTP_DELIVERY_FAILED");
    }
  }
  return { expiresIn: OTP_TTL_SECONDS, code };
}

/**
 * Checks a code against the newest open challenge and consumes it on success.
 * Runs in its own transaction so failed attempts are counted even when the
 * caller's work is rolled back.
 */
export async function consumeOtp(db: Database, now: Date, mobile: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: schema.otpChallenges.id, codeHash: schema.otpChallenges.codeHash, attempts: schema.otpChallenges.attempts })
      .from(schema.otpChallenges)
      .where(
        and(
          eq(schema.otpChallenges.mobile, mobile),
          eq(schema.otpChallenges.purpose, purpose),
          isNull(schema.otpChallenges.consumedAt),
          gt(schema.otpChallenges.expiresAt, now.toISOString()),
        ),
      )
      .orderBy(desc(schema.otpChallenges.createdAt))
      .limit(1)
      .for("update");
    if (!row || row.attempts >= MAX_ATTEMPTS) return false;
    const expected = Buffer.from(row.codeHash, "hex");
    const actual = Buffer.from(hashCode(mobile, purpose, code), "hex");
    if (!timingSafeEqual(expected, actual)) {
      await tx
        .update(schema.otpChallenges)
        .set({ attempts: sql`${schema.otpChallenges.attempts} + 1` })
        .where(eq(schema.otpChallenges.id, row.id));
      return false;
    }
    await tx.update(schema.otpChallenges).set({ consumedAt: now.toISOString() }).where(eq(schema.otpChallenges.id, row.id));
    return true;
  });
}

export async function requireOtp(deps: AppDeps, mobile: string, purpose: OtpPurpose, code: string): Promise<void> {
  if (!(await consumeOtp(deps.db, deps.clock.now(), mobile, purpose, code))) {
    throw new ApiError(400, "OTP_INVALID", {}, "otp");
  }
}
