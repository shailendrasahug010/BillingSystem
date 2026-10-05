import {
  ChangePasswordBody,
  CheckPasswordBody,
  CreateBusinessBody,
  LoginBody,
  OtpLoginBody,
  OtpRequestBody,
  RefreshBody,
  ResetPasswordBody,
  SignupBody,
  SwitchBusinessBody,
  UpdateProfileBody,
  type MeResponse,
  type OtpRequestResponse,
} from "@digitalbahi/contracts";
import { expandGrants, normalizeIndianMobile, type Grant } from "@digitalbahi/core";
import { schema } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { authenticate, loadAccess } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import { withTenant, withUser } from "../../lib/db.js";
import { ApiError, badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { hashPassword, isLoopback, sha256, verifyPassword } from "../../lib/security.js";
import type { ApiModule } from "../types.js";
import { createBusiness, MAX_OWNED_BUSINESSES, validateBusinessInput } from "./businesses.js";
import { issueOtp, requireOtp } from "./otp.js";
import {
  clearRefreshCookie,
  isUsable,
  listBusinesses,
  pickBusiness,
  presentedRefreshToken,
  publicUser,
  revokeAllSessions,
  revokeFamily,
  rotateRefreshToken,
  sessionResponse,
  setSessionBusiness,
  startSession,
  type UserRow,
} from "./sessions.js";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** Businesses one person may own (abuse guard for free trials). */

function mobileOrThrow(raw: string, field = "mobile"): string {
  const mobile = normalizeIndianMobile(raw);
  if (!mobile) throw badRequest("INVALID_MOBILE", {}, field);
  return mobile;
}

const actorOf = (request: FastifyRequest, user: { id: string; name: string }) => ({
  userId: user.id,
  userName: user.name,
  ip: request.ip,
  userAgent: request.headers["user-agent"] ?? null,
  requestId: request.id,
});

export const identityModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const authLimit = { rateLimit: { max: deps.config.rateLimit.authMax, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } };
  const now = () => deps.clock.now();

  const findUserByMobile = async (mobile: string) =>
    (await deps.db.select().from(schema.users).where(eq(schema.users.mobile, mobile)))[0];

  /** Opens a session for a verified user and records the login. */
  async function signIn(request: FastifyRequest, reply: Parameters<typeof sessionResponse>[2], user: UserRow, requested?: string, method = "password") {
    const businesses = await listBusinesses(deps.db, user.id);
    const business = pickBusiness(businesses, requested, user.lastBusinessId);
    const session = await deps.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now().toISOString(), ...(business ? { lastBusinessId: business.id } : {}) })
        .where(eq(schema.users.id, user.id));
      return startSession(tx, deps, request, user.id, business?.id ?? null);
    });
    if (business) {
      await withTenant(deps.db, { businessId: business.id, userId: user.id }, (tx) =>
        audit(tx, { ...actorOf(request, user), businessId: business.id }, { action: "auth.login", changes: { method } }),
      );
    }
    return sessionResponse(deps, request, reply, { user, familyId: session.familyId, business, businesses, refreshToken: session.refreshToken });
  }

  // ---------------------------------------------------------------- OTP
  r.post("/auth/otp", { config: authLimit, schema: { tags: ["auth"], security: [], body: OtpRequestBody } }, async (request, reply) => {
    const mobile = mobileOrThrow(request.body.mobile);
    const existing = await findUserByMobile(mobile);
    if (request.body.purpose === "signup" && existing) throw conflict("ACCOUNT_EXISTS", {}, "mobile");
    // For login / reset, an unknown number gets the same answer but no SMS (no account discovery).
    const deliver = request.body.purpose === "signup" || Boolean(existing?.isActive);
    const { expiresIn, code } = await issueOtp(deps, mobile, request.body.purpose, { deliver });
    // The socket's own address, not request.ip: a forwarded-for header cannot make a phone look local.
    const echo = deps.config.otpDevEcho && (!deps.config.otpDevEchoLocalOnly || isLoopback(request.socket.remoteAddress));
    const body: OtpRequestResponse = { sent: true, expiresIn, ...(echo && deliver ? { devCode: code } : {}) };
    return reply.code(202).send(body);
  });

  // ---------------------------------------------------------------- signup (creates the tenant)
  r.post("/auth/signup", { config: authLimit, schema: { tags: ["auth"], security: [], body: SignupBody } }, async (request, reply) => {
    const body = request.body;
    const mobile = mobileOrThrow(body.mobile);
    await validateBusinessInput(deps.db, body.business, "business.");
    if (await findUserByMobile(mobile)) throw conflict("ACCOUNT_EXISTS", {}, "mobile");
    await requireOtp(deps, mobile, "signup", body.otp);
    const passwordHash = await hashPassword(body.password);

    const userId = uuidv7();
    const result = await deps.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({
          id: userId,
          name: body.name,
          mobile,
          email: body.email?.toLowerCase() ?? null,
          passwordHash,
          preferredLocale: body.preferredLocale,
          passwordChangedAt: now().toISOString(),
          lastLoginAt: now().toISOString(),
        })
        .returning();
      const business = await createBusiness(tx, deps, actorOf(request, user!), body.business);
      await audit(tx, { ...actorOf(request, user!), businessId: business.id }, { action: "auth.signup", entityType: "user", entityId: userId, entityLabel: body.name });
      const session = await startSession(tx, deps, request, userId, business.id);
      return { user: { ...user!, lastBusinessId: business.id }, business, session };
    });
    const res = await sessionResponse(deps, request, reply, {
      user: result.user,
      familyId: result.session.familyId,
      business: result.business,
      businesses: [result.business],
      refreshToken: result.session.refreshToken,
    });
    return reply.code(201).send(res);
  });

  // ---------------------------------------------------------------- password login
  r.post("/auth/login", { config: authLimit, schema: { tags: ["auth"], security: [], body: LoginBody } }, async (request, reply) => {
    const { identifier, password, businessId } = request.body;
    let user: UserRow | undefined;
    // Mobile number, email, or the user ID a business gave its staff (it starts with a letter).
    if (identifier.includes("@")) {
      user = (await deps.db.select().from(schema.users).where(eq(schema.users.email, identifier.toLowerCase())))[0];
    } else {
      const mobile = normalizeIndianMobile(identifier);
      if (mobile) user = await findUserByMobile(mobile);
      else if (/^[a-z]/i.test(identifier)) user = (await deps.db.select().from(schema.users).where(eq(schema.users.username, identifier.toLowerCase())))[0];
    }
    const at = now();
    if (user?.lockedUntil && Date.parse(user.lockedUntil) > at.getTime()) {
      throw new ApiError(429, "ACCOUNT_LOCKED", { retryAfter: Math.ceil((Date.parse(user.lockedUntil) - at.getTime()) / 1000) });
    }
    const ok = await verifyPassword(user?.isActive ? user.passwordHash : null, password);
    if (!user || !ok) {
      if (user) {
        await withUser(deps.db, user.id, async (tx) => {
          await tx
            .update(schema.users)
            .set({
              failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
              lockedUntil: sql`case when ${schema.users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS}
                then ${new Date(at.getTime() + LOCK_MINUTES * 60_000).toISOString()}::timestamptz else ${schema.users.lockedUntil} end`,
            })
            .where(eq(schema.users.id, user.id));
          await tx.insert(schema.auditLogs).values({
            businessId: null,
            userId: user.id,
            userName: user.name,
            action: "auth.login_failed",
            ip: request.ip,
            userAgent: request.headers["user-agent"] ?? null,
            requestId: request.id,
          });
        });
      }
      throw unauthorized("INVALID_CREDENTIALS");
    }
    return signIn(request, reply, user, businessId);
  });

  // ---------------------------------------------------------------- OTP login
  r.post("/auth/login/otp", { config: authLimit, schema: { tags: ["auth"], security: [], body: OtpLoginBody } }, async (request, reply) => {
    const mobile = mobileOrThrow(request.body.mobile);
    await requireOtp(deps, mobile, "login", request.body.otp);
    const user = await findUserByMobile(mobile);
    if (!user?.isActive) throw unauthorized("INVALID_CREDENTIALS");
    return signIn(request, reply, user, request.body.businessId, "otp");
  });

  // ---------------------------------------------------------------- refresh (rotation)
  r.post("/auth/refresh", { config: authLimit, schema: { tags: ["auth"], security: [], body: RefreshBody } }, async (request, reply) => {
    const token = presentedRefreshToken(request, request.body);
    if (!token) throw unauthorized("REFRESH_INVALID");
    const result = await rotateRefreshToken(deps, token);
    if (!result.ok) {
      if (result.code !== "REFRESH_ROTATED") clearRefreshCookie(deps, reply);
      throw unauthorized(result.code);
    }
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, result.userId));
    const businesses = await listBusinesses(deps.db, result.userId);
    const current = businesses.find((b) => b.id === result.businessId && isUsable(b)) ?? null;
    if (result.businessId && !current) await setSessionBusiness(deps.db, result.familyId, null);
    return sessionResponse(deps, request, reply, {
      user: user!,
      familyId: result.familyId,
      business: current,
      businesses,
      refreshToken: result.refreshToken,
    });
  });

  // ---------------------------------------------------------------- logout
  r.post("/auth/logout", { schema: { tags: ["auth"], body: RefreshBody } }, async (request, reply) => {
    const header = request.headers.authorization;
    let familyId: string | null = null;
    if (header?.startsWith("Bearer ")) {
      familyId = await deps.tokens.verifyAccess(header.slice(7)).then((c) => c.sessionId, () => null);
    }
    const token = presentedRefreshToken(request, request.body);
    if (!familyId && token) {
      const [row] = await deps.db
        .select({ familyId: schema.refreshTokens.familyId })
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, sha256(token)));
      familyId = row?.familyId ?? null;
    }
    if (familyId) await revokeFamily(deps.db, familyId, now());
    clearRefreshCookie(deps, reply);
    return reply.code(204).send();
  });

  r.post("/auth/logout-all", { preHandler: authenticate(deps), schema: { tags: ["auth"] } }, async (request, reply) => {
    await revokeAllSessions(deps.db, request.user!.userId, now());
    clearRefreshCookie(deps, reply);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- passwords
  r.post("/auth/password/reset", { config: authLimit, schema: { tags: ["auth"], security: [], body: ResetPasswordBody } }, async (request, reply) => {
    const mobile = mobileOrThrow(request.body.mobile);
    await requireOtp(deps, mobile, "reset", request.body.otp);
    const user = await findUserByMobile(mobile);
    if (!user?.isActive) throw badRequest("OTP_INVALID", {}, "otp");
    const passwordHash = await hashPassword(request.body.password);
    await deps.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ passwordHash, passwordChangedAt: now().toISOString(), failedLoginCount: 0, lockedUntil: null })
        .where(eq(schema.users.id, user.id));
      await revokeAllSessions(tx, user.id, now());
    });
    return reply.code(204).send();
  });

  r.post(
    "/auth/password/change",
    { preHandler: authenticate(deps), config: authLimit, schema: { tags: ["auth"], body: ChangePasswordBody } },
    async (request, reply) => {
      const claims = request.user!;
      const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, claims.userId));
      if (!user || !(await verifyPassword(user.passwordHash, request.body.currentPassword))) {
        throw badRequest("INVALID_CREDENTIALS", {}, "currentPassword");
      }
      const passwordHash = await hashPassword(request.body.newPassword);
      await deps.db.transaction(async (tx) => {
        await tx.update(schema.users).set({ passwordHash, passwordChangedAt: now().toISOString() }).where(eq(schema.users.id, user.id));
        // Everyone else holding this account's sessions is signed out; this device stays in.
        await revokeAllSessions(tx, user.id, now(), claims.sessionId);
      });
      return reply.code(204).send();
    },
  );

  /**
   * Checks the signed-in person's password without signing in again: a device
   * uses it before it lets that password open its copy without internet.
   * Wrong answers count toward the same lock as sign-in.
   */
  r.post("/auth/password/check", { preHandler: authenticate(deps), config: authLimit, schema: { tags: ["auth"], body: CheckPasswordBody } }, async (request, reply) => {
    const claims = request.user!;
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, claims.userId));
    if (!user?.isActive) throw unauthorized();
    const at = now();
    if (user.lockedUntil && Date.parse(user.lockedUntil) > at.getTime()) {
      throw new ApiError(429, "ACCOUNT_LOCKED", { retryAfter: Math.ceil((Date.parse(user.lockedUntil) - at.getTime()) / 1000) });
    }
    if (!(await verifyPassword(user.passwordHash, request.body.password))) {
      await deps.db
        .update(schema.users)
        .set({
          failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
          lockedUntil: sql`case when ${schema.users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS}
            then ${new Date(at.getTime() + LOCK_MINUTES * 60_000).toISOString()}::timestamptz else ${schema.users.lockedUntil} end`,
        })
        .where(eq(schema.users.id, user.id));
      throw badRequest("INVALID_CREDENTIALS", {}, "password");
    }
    if (user.failedLoginCount > 0) await deps.db.update(schema.users).set({ failedLoginCount: 0 }).where(eq(schema.users.id, user.id));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- businesses (tenants)
  r.get("/businesses", { preHandler: authenticate(deps), schema: { tags: ["business"] } }, async (request) => ({
    data: await listBusinesses(deps.db, request.user!.userId),
  }));

  r.post("/businesses", { preHandler: authenticate(deps), schema: { tags: ["business"], body: CreateBusinessBody } }, async (request, reply) => {
    const claims = request.user!;
    await validateBusinessInput(deps.db, request.body);
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, claims.userId));
    if (!user?.isActive) throw unauthorized();
    const owned = (await listBusinesses(deps.db, user.id)).filter((b) => b.isOwner).length;
    if (owned >= MAX_OWNED_BUSINESSES) throw conflict("BUSINESS_LIMIT_REACHED", { max: MAX_OWNED_BUSINESSES });
    const business = await withUser(deps.db, user.id, async (tx) => {
      const created = await createBusiness(tx, deps, actorOf(request, user), request.body);
      await setSessionBusiness(tx, claims.sessionId, created.id);
      return created;
    });
    const res = await sessionResponse(deps, request, reply, {
      user,
      familyId: claims.sessionId,
      business,
      businesses: await listBusinesses(deps.db, user.id),
    });
    return reply.code(201).send(res);
  });

  r.post("/auth/switch-business", { preHandler: authenticate(deps), schema: { tags: ["auth"], body: SwitchBusinessBody } }, async (request, reply) => {
    const claims = request.user!;
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, claims.userId));
    if (!user?.isActive) throw unauthorized();
    const businesses = await listBusinesses(deps.db, user.id);
    const business = pickBusiness(businesses, request.body.businessId);
    await deps.db.transaction(async (tx) => {
      await setSessionBusiness(tx, claims.sessionId, business!.id);
      await tx.update(schema.users).set({ lastBusinessId: business!.id }).where(eq(schema.users.id, user.id));
    });
    return sessionResponse(deps, request, reply, { user, familyId: claims.sessionId, business, businesses });
  });

  // ---------------------------------------------------------------- me
  /**
   * The key that locks the copy of the business kept on this person's
   * devices for offline work (the copy's own key is wrapped with it). Only a
   * signed-in session gets it, so a copy opens by itself only while its
   * person is signed in; otherwise (offline, or signed out elsewhere) it takes
   * their password. Made on first use; stored field-encrypted.
   */
  r.get("/me/device-key", { preHandler: authenticate(deps), schema: { tags: ["auth"] } }, async (request, reply) => {
    const claims = request.user!;
    const [user] = await deps.db.select({ isActive: schema.users.isActive, deviceKey: schema.users.deviceKey }).from(schema.users).where(eq(schema.users.id, claims.userId));
    if (!user?.isActive) throw unauthorized();
    let sealed = user.deviceKey;
    if (!sealed) {
      const fresh = deps.cipher.encrypt(randomBytes(32).toString("base64"));
      // Two first requests at once both get the one that was stored first.
      const [row] = await deps.db
        .update(schema.users)
        .set({ deviceKey: sql`coalesce(${schema.users.deviceKey}, ${fresh})` })
        .where(eq(schema.users.id, claims.userId))
        .returning({ deviceKey: schema.users.deviceKey });
      sealed = row!.deviceKey!;
    }
    reply.header("cache-control", "private, no-store");
    return { key: deps.cipher.decrypt(sealed) };
  });

  /** The person changes their own name or email (their mobile number stays: it is how they sign in). */
  r.patch("/me", { preHandler: authenticate(deps), schema: { tags: ["auth"], body: UpdateProfileBody } }, async (request) => {
    const claims = request.user!;
    const { name, email } = request.body;
    const [user] = await deps.db
      .update(schema.users)
      .set({ ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email: email ? email.toLowerCase() : null } : {}) })
      .where(and(eq(schema.users.id, claims.userId), eq(schema.users.isActive, true)))
      .returning();
    if (!user) throw unauthorized();
    return { user: publicUser(user) };
  });

  r.get("/me", { preHandler: authenticate(deps), schema: { tags: ["auth"] } }, async (request): Promise<MeResponse> => {
    const claims = request.user!;
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, claims.userId));
    if (!user?.isActive) throw unauthorized();
    const access = claims.businessId ? await loadAccess(deps.db, user.id, claims.businessId) : null;
    if (!claims.businessId || !access || !["trial", "active"].includes(access.businessStatus)) {
      return { user: publicUser(user), business: null, permissions: [], settings: {}, today: deps.clock.today() };
    }
    const businessId = claims.businessId;
    return withTenant(deps.db, { businessId, userId: user.id }, async (tx) => {
      const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
      const settings = await tx
        .select({ key: schema.settings.key, value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.businessId, businessId));
      const [member] = await tx
        .select({ isOwner: schema.businessMembers.isOwner })
        .from(schema.businessMembers)
        .where(and(eq(schema.businessMembers.businessId, businessId), eq(schema.businessMembers.userId, user.id)));
      return {
        user: publicUser(user),
        business: {
          id: b!.id,
          legalName: b!.legalName,
          tradeName: b!.tradeName,
          gstin: b!.gstin,
          stateCode: b!.stateCode,
          status: b!.status,
          plan: b!.plan,
          trialEndsAt: b!.trialEndsAt ? new Date(b!.trialEndsAt).toISOString() : null,
          role: access.roleKey,
          isOwner: Boolean(member?.isOwner),
          financialYearStartMonth: b!.financialYearStartMonth,
          timeZone: b!.timeZone,
          gstRegistration: b!.gstRegistration,
          addressLine1: b!.addressLine1,
          addressLine2: b!.addressLine2,
          city: b!.city,
          pincode: b!.pincode,
          phone: b!.phone,
          email: b!.email,
          logoFileId: b!.logoFileId,
        },
        permissions: expandGrants(access.grants as Grant[]),
        settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
        today: deps.clock.today(b!.timeZone),
      };
    });
  });
};
