import {
  CheckPasswordBody,
  TwoStepCodeBody,
  TwoStepEnableBody,
  TwoStepLoginBody,
  TwoStepOffBody,
  type SignedInSession,
  type TwoStepSetup,
  type TwoStepStatus,
} from "@digitalbahi/contracts";
import { schema } from "@digitalbahi/db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate, endSessions, invalidateUserAccess } from "../../lib/access.js";
import type { AppDeps } from "../../lib/context.js";
import { withUser } from "../../lib/db.js";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../../lib/errors.js";
import { verifyPassword } from "../../lib/security.js";
import { matchTotp, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryCodeHash } from "../../lib/totp.js";
import type { ApiModule } from "../types.js";
import { assertNotLocked, countFailedSignIn } from "./lock.js";
import { clearRefreshCookie, listSessions, revokeAllSessions, revokeFamily, signIn, type UserRow } from "./sessions.js";

const IdParams = z.object({ id: z.uuid() });
/** The name the authenticator app shows next to the code. */
const ISSUER = "Digital Bahi";

/**
 * The answer to a right password or OTP when two-step sign-in is on: no
 * session yet, but a token that lets the app send the authenticator app's
 * code to POST /auth/login/two-step within a few minutes.
 */
export async function twoStepChallenge(deps: AppDeps, user: UserRow, requested: string | undefined, method: string): Promise<ApiError> {
  const token = await deps.tokens.signTwoStep({ userId: user.id, businessId: requested ?? null, method });
  return new ApiError(401, "TWO_STEP_REQUIRED", { token, expiresIn: deps.tokens.twoStepTtlSeconds });
}

/** An entry in the person's own security history (no business: it is about the account). */
async function auditAccount(deps: AppDeps, request: FastifyRequest, user: Pick<UserRow, "id" | "name">, action: string): Promise<void> {
  await withUser(deps.db, user.id, async (tx) => {
    await tx.insert(schema.auditLogs).values({
      businessId: null,
      userId: user.id,
      userName: user.name,
      action,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      requestId: request.id,
    });
  });
}

/**
 * Two-step sign-in with an authenticator app (a code that changes every 30
 * seconds, RFC 6238), its recovery codes, and the person's list of
 * signed-in devices, each of which can be signed out from here.
 *
 * A wrong code counts toward the same lock as a wrong password (5 in a row:
 * 15 minutes), so the 6 digits cannot be guessed; a code works once.
 */
export const twoStepModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const authLimit = { rateLimit: { max: deps.config.rateLimit.authMax, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } };
  const now = () => deps.clock.now();

  const activeUser = async (userId: string): Promise<UserRow> => {
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!user?.isActive) throw unauthorized();
    return user;
  };

  /** The person's password, for turning two-step sign-in on or off; a wrong one counts toward the lock. */
  const checkPassword = async (user: UserRow, password: string): Promise<void> => {
    const at = now();
    assertNotLocked(user, at);
    if (!(await verifyPassword(user.passwordHash, password))) {
      await countFailedSignIn(deps.db, user.id, at);
      throw badRequest("INVALID_CREDENTIALS", {}, "password");
    }
  };

  /**
   * Uses a code from the app or a recovery code, for a person with two-step
   * sign-in on; says which. The code is used up at once (in the same update
   * that checks it, so two requests with one code cannot both pass). A
   * wrong one counts toward the lock; only a right one starts the count
   * again (a right password alone does not, with two-step sign-in on).
   */
  const useSecondStep = async (user: UserRow, typed: string): Promise<"totp" | "recovery"> => {
    const at = now();
    assertNotLocked(user, at);
    const code = typed.replace(/\s/g, "");
    if (/^\d{6}$/.test(code)) {
      const step = user.mfaSecretEnc ? matchTotp(deps.cipher.decrypt(user.mfaSecretEnc), code, at, user.mfaLastStep) : null;
      if (step !== null) {
        const used = await deps.db
          .update(schema.users)
          .set({ mfaLastStep: step, failedLoginCount: 0 })
          .where(and(eq(schema.users.id, user.id), or(isNull(schema.users.mfaLastStep), lt(schema.users.mfaLastStep, step))))
          .returning({ id: schema.users.id });
        if (used.length) return "totp";
      }
    } else {
      const hash = recoveryCodeHash(code);
      const used = await deps.db
        .update(schema.users)
        .set({ mfaRecoveryCodes: sql`${schema.users.mfaRecoveryCodes} - ${hash}::text`, failedLoginCount: 0 })
        .where(and(eq(schema.users.id, user.id), sql`${schema.users.mfaRecoveryCodes} @> jsonb_build_array(${hash}::text)`))
        .returning({ id: schema.users.id });
      if (used.length) return "recovery";
    }
    await countFailedSignIn(deps.db, user.id, at);
    throw badRequest("TWO_STEP_CODE_WRONG", {}, "code");
  };

  // ---------------------------------------------------------------- status
  r.get("/auth/two-step", { preHandler: authenticate(deps), schema: { tags: ["auth"] } }, async (request): Promise<TwoStepStatus> => {
    const user = await activeUser(request.user!.userId);
    return {
      enabled: Boolean(user.mfaEnabledAt),
      enabledAt: user.mfaEnabledAt ? new Date(user.mfaEnabledAt).toISOString() : null,
      recoveryCodesLeft: user.mfaEnabledAt ? (user.mfaRecoveryCodes ?? []).length : 0,
    };
  });

  // ---------------------------------------------------------------- turning it on
  /**
   * Step 1 (with the password, so a phone left signed in cannot tie the
   * account to someone else's app): a new secret for the app, as a QR code's
   * text and to type by hand. It counts only after step 2.
   */
  r.post(
    "/auth/two-step/setup",
    { preHandler: authenticate(deps), config: authLimit, schema: { tags: ["auth"], body: CheckPasswordBody } },
    async (request, reply): Promise<TwoStepSetup> => {
      const user = await activeUser(request.user!.userId);
      if (user.mfaEnabledAt) throw conflict("TWO_STEP_ALREADY_ON");
      await checkPassword(user, request.body.password);
      const secret = newTotpSecret();
      await deps.db.update(schema.users).set({ mfaSecretEnc: deps.cipher.encrypt(secret), mfaLastStep: null, mfaRecoveryCodes: null }).where(eq(schema.users.id, user.id));
      reply.header("cache-control", "private, no-store");
      return { secret, uri: otpauthUri({ secret, issuer: ISSUER, account: user.mobile }) };
    },
  );

  /** Step 2: the first code from the app turns it on; the recovery codes are shown this once. */
  r.post("/auth/two-step/enable", { preHandler: authenticate(deps), config: authLimit, schema: { tags: ["auth"], body: TwoStepEnableBody } }, async (request, reply) => {
    const user = await activeUser(request.user!.userId);
    if (user.mfaEnabledAt) throw conflict("TWO_STEP_ALREADY_ON");
    if (!user.mfaSecretEnc) throw conflict("TWO_STEP_NOT_STARTED");
    const step = matchTotp(deps.cipher.decrypt(user.mfaSecretEnc), request.body.code, now(), null);
    if (step === null) throw badRequest("TWO_STEP_CODE_WRONG", {}, "code");
    const codes = newRecoveryCodes();
    const [on] = await deps.db
      .update(schema.users)
      .set({ mfaEnabledAt: now().toISOString(), mfaLastStep: step, mfaRecoveryCodes: codes.map(recoveryCodeHash) })
      .where(and(eq(schema.users.id, user.id), isNull(schema.users.mfaEnabledAt), eq(schema.users.mfaSecretEnc, user.mfaSecretEnc)))
      .returning({ id: schema.users.id });
    // Set up again on another screen meanwhile: that newer secret is the one to finish.
    if (!on) throw conflict("TWO_STEP_NOT_STARTED");
    await auditAccount(deps, request, user, "auth.two_step_on");
    invalidateUserAccess(user.id);
    reply.header("cache-control", "private, no-store");
    return { recoveryCodes: codes };
  });

  // ---------------------------------------------------------------- recovery codes and turning it off
  r.post("/auth/two-step/recovery-codes", { preHandler: authenticate(deps), config: authLimit, schema: { tags: ["auth"], body: TwoStepCodeBody } }, async (request, reply) => {
    const user = await activeUser(request.user!.userId);
    if (!user.mfaEnabledAt) throw conflict("TWO_STEP_OFF");
    await useSecondStep(user, request.body.code);
    const codes = newRecoveryCodes();
    await deps.db.update(schema.users).set({ mfaRecoveryCodes: codes.map(recoveryCodeHash) }).where(eq(schema.users.id, user.id));
    await auditAccount(deps, request, user, "auth.two_step_new_codes");
    reply.header("cache-control", "private, no-store");
    return { recoveryCodes: codes };
  });

  r.post("/auth/two-step/disable", { preHandler: authenticate(deps), config: authLimit, schema: { tags: ["auth"], body: TwoStepOffBody } }, async (request, reply) => {
    const user = await activeUser(request.user!.userId);
    if (!user.mfaEnabledAt) return reply.code(204).send();
    await checkPassword(user, request.body.password);
    await useSecondStep(user, request.body.code);
    await deps.db
      .update(schema.users)
      .set({ mfaSecretEnc: null, mfaEnabledAt: null, mfaRecoveryCodes: null, mfaLastStep: null })
      .where(eq(schema.users.id, user.id));
    await auditAccount(deps, request, user, "auth.two_step_off");
    invalidateUserAccess(user.id);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- the second step of a sign-in
  r.post("/auth/login/two-step", { config: authLimit, schema: { tags: ["auth"], security: [], body: TwoStepLoginBody } }, async (request, reply) => {
    const claims = await deps.tokens.verifyTwoStep(request.body.token).catch(() => null);
    if (!claims) throw unauthorized("TWO_STEP_EXPIRED");
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, claims.userId));
    // Turned off (or the account closed) since the first step: sign in again from the start.
    if (!user?.isActive || !user.mfaEnabledAt) throw unauthorized("TWO_STEP_EXPIRED");
    const used = await useSecondStep(user, request.body.code);
    return signIn(deps, request, reply, user, claims.businessId ?? undefined, `${claims.method}+${used}`);
  });

  // ---------------------------------------------------------------- signed-in devices
  r.get("/auth/sessions", { preHandler: authenticate(deps), schema: { tags: ["auth"] } }, async (request): Promise<{ data: SignedInSession[] }> => {
    const claims = request.user!;
    await activeUser(claims.userId);
    return { data: await listSessions(deps.db, claims.userId, claims.sessionId, now()) };
  });

  /** Signs one device out: its next request is refused and it has to sign in again. */
  r.delete("/auth/sessions/:id", { preHandler: authenticate(deps), schema: { tags: ["auth"], params: IdParams } }, async (request, reply) => {
    const claims = request.user!;
    const user = await activeUser(claims.userId);
    const [mine] = await deps.db
      .select({ id: schema.refreshTokens.id })
      .from(schema.refreshTokens)
      .where(and(eq(schema.refreshTokens.familyId, request.params.id), eq(schema.refreshTokens.userId, claims.userId), isNull(schema.refreshTokens.revokedAt)))
      .limit(1);
    if (!mine) throw notFound("session");
    await revokeFamily(deps.db, request.params.id, now());
    endSessions([request.params.id], deps.tokens.accessTtlSeconds);
    await auditAccount(deps, request, user, "auth.session_ended");
    if (request.params.id === claims.sessionId) clearRefreshCookie(deps, reply);
    return reply.code(204).send();
  });

  /** Signs out every other device; this one stays signed in. Says how many were signed in. */
  r.post("/auth/sessions/end-others", { preHandler: authenticate(deps), schema: { tags: ["auth"] } }, async (request) => {
    const claims = request.user!;
    const user = await activeUser(claims.userId);
    const others = (await listSessions(deps.db, claims.userId, claims.sessionId, now())).filter((s) => !s.current).map((s) => s.id);
    await revokeAllSessions(deps.db, claims.userId, now(), claims.sessionId);
    endSessions(others, deps.tokens.accessTtlSeconds);
    if (others.length) await auditAccount(deps, request, user, "auth.sessions_ended");
    return { ended: others.length };
  });
};
