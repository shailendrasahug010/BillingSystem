import type { BusinessSummary, SessionResponse } from "@digitalbahi/contracts";
import { schema, type Database, type Executor } from "@digitalbahi/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../../lib/context.js";
import { withUser } from "../../lib/db.js";
import { ApiError, forbidden } from "../../lib/errors.js";
import { newOpaqueToken, sha256 } from "../../lib/security.js";

export const REFRESH_COOKIE = "vy_rt";
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

function setRefreshCookie(deps: AppDeps, reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: deps.config.jwt.refreshTtlDays * 86_400,
  });
}

export function clearRefreshCookie(deps: AppDeps, reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, httpOnly: true, secure: deps.config.cookieSecure, sameSite: "strict" });
}

export function presentedRefreshToken(request: FastifyRequest, body: { refreshToken?: string | undefined } | null | undefined): string | null {
  return request.cookies[REFRESH_COOKIE] ?? body?.refreshToken ?? null;
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
 * is revoked and every device using it must sign in again.
 */
export async function rotateRefreshToken(deps: AppDeps, token: string): Promise<RotateResult> {
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
      ip: row.ip,
      userAgent: row.userAgent,
      expiresAt: refreshExpiry(deps),
    });
    return { ok: true, userId: row.userId, familyId: row.familyId, businessId: row.businessId, refreshToken: next.token };
  });
}

/** Points the session at another business (so refreshes keep it). */
export async function setSessionBusiness(db: Executor, familyId: string, businessId: string | null): Promise<void> {
  await db
    .update(schema.refreshTokens)
    .set({ businessId })
    .where(and(eq(schema.refreshTokens.familyId, familyId), isNull(schema.refreshTokens.revokedAt)));
}
