import type { BusinessSummary, SessionResponse, SignedInSession } from "@digitalbahi/contracts";
import { schema, type Database, type Executor } from "@digitalbahi/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import { audit } from "../../lib/audit.js";
import type { AppDeps } from "../../lib/context.js";
import { withTenant, withUser } from "../../lib/db.js";
import { ApiError, forbidden } from "../../lib/errors.js";
import { newOpaqueToken, sha256 } from "../../lib/security.js";

export const REFRESH_COOKIE = "db_rt";
/** The cookie's name under the project's former working name: still accepted, and replaced by REFRESH_COOKIE when next set. */
export const LEGACY_REFRESH_COOKIE = "vy_rt";
const REFRESH_COOKIE_PATH = "/api/v1/auth";
/** Two tabs refreshing at the same moment: the loser retries instead of being logged out. */
const ROTATION_GRACE_MS = 30_000;
const USABLE = new Set(["trial", "active"]);

export type UserRow = typeof schema.users.$inferSelect;

export const publicUser = (u: Pick<UserRow, "id" | "name" | "mobile" | "email" | "preferredLocale">) => ({
  id: u.id,
  name: u.name,
  mobile: u.mobile,
  email: u.email,
  preferredLocale: u.preferredLocale,
});

/** Businesses the user is an active member of (visible through the membership RLS policy). */
export async function listBusinesses(db: Database, userId: string): Promise<BusinessSummary[]> {
  return withUser(db, userId, async (tx) => {
    const res = await tx.execute<{
      id: string;
      legal_name: string;
      trade_name: string | null;
      gstin: string | null;
      state_code: string;
      status: string;
      plan: string;
      trial_ends_at: string | null;
      role: string;
      is_owner: boolean;
    }>(sql`
      select b.id, b.legal_name, b.trade_name, b.gstin, b.state_code, b.status, b.plan, b.trial_ends_at,
             r.key as role, bm.is_owner
      from business_members bm
      join businesses b on b.id = bm.business_id
      join roles r on r.id = bm.role_id
      where bm.user_id = ${userId} and bm.is_active
      order by b.legal_name`);
    return res.rows.map((r) => ({
      id: r.id,
      legalName: r.legal_name,
      tradeName: r.trade_name,
      gstin: r.gstin,
      stateCode: r.state_code,
      status: r.status,
      plan: r.plan,
      trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at).toISOString() : null,
      role: r.role,
      isOwner: r.is_owner,
    }));
  });
}

export const isUsable = (b: BusinessSummary) => USABLE.has(b.status);

/**
 * Business to open: the one asked for (must be a usable membership), else the
 * last one used, else the first usable one. Null = the client shows the picker.
 */
export function pickBusiness(list: BusinessSummary[], requested?: string | null, last?: string | null): BusinessSummary | null {
  if (requested) {
    const b = list.find((x) => x.id === requested);
    if (!b) throw forbidden();
    if (!isUsable(b)) throw new ApiError(403, "BUSINESS_SUSPENDED");
    return b;
  }
  return list.find((x) => x.id === last && isUsable(x)) ?? list.find(isUsable) ?? null;
}

function refreshExpiry(deps: AppDeps): string {
  return new Date(deps.clock.now().getTime() + deps.config.jwt.refreshTtlDays * 86_400_000).toISOString();
}

/** Starts a new session (refresh-token family). */
export async function startSession(
  db: Executor,
  deps: AppDeps,
  request: FastifyRequest,
  userId: string,
  businessId: string | null,
): Promise<{ familyId: string; refreshToken: string }> {
  const familyId = uuidv7();
  const { token, hash } = newOpaqueToken();
  await db.insert(schema.refreshTokens).values({
    id: uuidv7(),
    userId,
    familyId,
    businessId,
    tokenHash: hash,
    ip: request.ip,
    userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
    expiresAt: refreshExpiry(deps),
  });
  return { familyId, refreshToken: token };
}

export const isNativeClient = (request: FastifyRequest) => request.headers["x-client"] === "native";

/**
 * Opens a session for a person whose sign-in is complete (password or OTP,
 * and the authenticator app's code when two-step sign-in is on) and records
 * the login. `method` says how: password, otp, password+totp, otp+recovery…
 */
export async function signIn(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  requested?: string,
  method = "password",
): Promise<SessionResponse> {
  const now = deps.clock.now().toISOString();
  const businesses = await listBusinesses(deps.db, user.id);
  const business = pickBusiness(businesses, requested, user.lastBusinessId);
  const session = await deps.db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, ...(business ? { lastBusinessId: business.id } : {}) })
      .where(eq(schema.users.id, user.id));
    return startSession(tx, deps, request, user.id, business?.id ?? null);
  });
  if (business) {
    const actor = { businessId: business.id, userId: user.id, userName: user.name, ip: request.ip, userAgent: request.headers["user-agent"] ?? null, requestId: request.id };
    await withTenant(deps.db, { businessId: business.id, userId: user.id }, (tx) => audit(tx, actor, { action: "auth.login", changes: { method } }));
  }
  return sessionResponse(deps, request, reply, { user, familyId: session.familyId, business, businesses, refreshToken: session.refreshToken });
}

/**
 * Builds the login/refresh/switch response. Browsers receive the refresh token
 * only as an HttpOnly, SameSite=Strict cookie scoped to /api/v1/auth; native
 * apps (X-Client: native) receive it in the body and keep it in secure storage.
 */
export async function sessionResponse(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    user: Pick<UserRow, "id" | "name" | "mobile" | "email" | "preferredLocale">;
    familyId: string;
    business: BusinessSummary | null;
    businesses: BusinessSummary[];
    refreshToken?: string;
  },
): Promise<SessionResponse> {
  const accessToken = await deps.tokens.signAccess({
    userId: input.user.id,
    businessId: input.business?.id ?? null,
    sessionId: input.familyId,
  });
  const native = isNativeClient(request);
  if (input.refreshToken && !native) setRefreshCookie(deps, reply, input.refreshToken);
  return {
    accessToken,
    expiresIn: deps.tokens.accessTtlSeconds,
    user: publicUser(input.user),
    business: input.business,
    businesses: input.businesses,
    ...(input.refreshToken && native ? { refreshToken: input.refreshToken } : {}),
  };
}

/** A browser still holding the cookie under its former name gets it removed. */
function clearLegacyCookie(deps: AppDeps, reply: FastifyReply): void {
  if (reply.request.cookies?.[LEGACY_REFRESH_COOKIE] === undefined) return;
  reply.clearCookie(LEGACY_REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, httpOnly: true, secure: deps.config.cookieSecure, sameSite: "strict" });
}

function setRefreshCookie(deps: AppDeps, reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: deps.config.jwt.refreshTtlDays * 86_400,
  });
  clearLegacyCookie(deps, reply);
}

export function clearRefreshCookie(deps: AppDeps, reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, httpOnly: true, secure: deps.config.cookieSecure, sameSite: "strict" });
  clearLegacyCookie(deps, reply);
}

export function presentedRefreshToken(request: FastifyRequest, body: { refreshToken?: string | undefined } | null | undefined): string | null {
  return request.cookies[REFRESH_COOKIE] ?? request.cookies[LEGACY_REFRESH_COOKIE] ?? body?.refreshToken ?? null;
}

export async function revokeFamily(db: Executor, familyId: string, now: Date): Promise<void> {
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(schema.refreshTokens.familyId, familyId), isNull(schema.refreshTokens.revokedAt)));
}

/** Signs the user out everywhere (optionally keeping the current session). */
export async function revokeAllSessions(db: Executor, userId: string, now: Date, exceptFamilyId?: string): Promise<void> {
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        eq(schema.refreshTokens.userId, userId),
        isNull(schema.refreshTokens.revokedAt),
        ...(exceptFamilyId ? [ne(schema.refreshTokens.familyId, exceptFamilyId)] : []),
      ),
    );
}

export type RotateResult =
  | { ok: true; userId: string; familyId: string; businessId: string | null; refreshToken: string }
  | { ok: false; code: "REFRESH_INVALID" | "REFRESH_EXPIRED" | "REFRESH_ROTATED" | "SESSION_REVOKED" };

/**
 * Exchanges a refresh token for a new one (rotation). Presenting an already
 * rotated token after the grace window means it was copied: the whole family
 * is revoked and every device using it must sign in again. `seen`: where the
 * refresh came from, kept on the new token for the list of signed-in devices.
 */
export async function rotateRefreshToken(deps: AppDeps, token: string, seen?: { ip: string; userAgent: string | null }): Promise<RotateResult> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx): Promise<RotateResult> => {
    const [row] = await tx
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, sha256(token)))
      .for("update");
    if (!row) return { ok: false, code: "REFRESH_INVALID" };
    if (row.revokedAt) return { ok: false, code: "SESSION_REVOKED" };
    if (row.rotatedAt) {
      if (now.getTime() - Date.parse(row.rotatedAt) < ROTATION_GRACE_MS) return { ok: false, code: "REFRESH_ROTATED" };
      await revokeFamily(tx, row.familyId, now);
      return { ok: false, code: "SESSION_REVOKED" };
    }
    if (Date.parse(row.expiresAt) <= now.getTime()) return { ok: false, code: "REFRESH_EXPIRED" };

    const [user] = await tx.select({ isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, row.userId));
    if (!user?.isActive) {
      await revokeFamily(tx, row.familyId, now);
      return { ok: false, code: "SESSION_REVOKED" };
    }

    await tx.update(schema.refreshTokens).set({ rotatedAt: now.toISOString() }).where(eq(schema.refreshTokens.id, row.id));
    const next = newOpaqueToken();
    await tx.insert(schema.refreshTokens).values({
      id: uuidv7(),
      userId: row.userId,
      familyId: row.familyId,
      businessId: row.businessId,
      tokenHash: next.hash,
      deviceId: row.deviceId,
      ip: seen?.ip ?? row.ip,
      userAgent: seen ? (seen.userAgent?.slice(0, 500) ?? row.userAgent) : row.userAgent,
      expiresAt: refreshExpiry(deps),
    });
    return { ok: true, userId: row.userId, familyId: row.familyId, businessId: row.businessId, refreshToken: next.token };
  });
}

/**
 * The person's signed-in sessions (one per sign-in on a phone, browser or
 * computer), most recently used first: where each signed in, and the device
 * and address it last refreshed from (every few minutes while it is open).
 */
export async function listSessions(db: Database, userId: string, currentId: string, now: Date): Promise<SignedInSession[]> {
  const res = await db.execute<{ family_id: string; signed_in_at: string; last_seen_at: string; user_agent: string | null; ip: string | null }>(sql`
    with active as (
      select distinct family_id from refresh_tokens
      where user_id = ${userId} and revoked_at is null and rotated_at is null and expires_at > ${now.toISOString()}::timestamptz
    )
    select t.family_id,
           min(t.created_at) as signed_in_at,
           max(t.created_at) as last_seen_at,
           (array_agg(t.user_agent order by t.created_at desc))[1] as user_agent,
           (array_agg(t.ip order by t.created_at desc))[1] as ip
    from refresh_tokens t
    join active a on a.family_id = t.family_id
    where t.user_id = ${userId}
    group by t.family_id
    order by max(t.created_at) desc
    limit 50`);
  return res.rows.map((r) => ({
    id: r.family_id,
    current: r.family_id === currentId,
    userAgent: r.user_agent,
    ip: r.ip,
    signedInAt: new Date(r.signed_in_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  }));
}

/** Points the session at another business (so refreshes keep it). */
export async function setSessionBusiness(db: Executor, familyId: string, businessId: string | null): Promise<void> {
  await db
    .update(schema.refreshTokens)
    .set({ businessId })
    .where(and(eq(schema.refreshTokens.familyId, familyId), isNull(schema.refreshTokens.revokedAt)));
}
