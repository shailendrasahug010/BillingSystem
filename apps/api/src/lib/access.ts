import { hasPermission, type Permission } from "@vyapaar/core";
import type { Database } from "@vyapaar/db";
import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./context.js";
import { withTenant } from "./db.js";
import { ApiError, forbidden, unauthorized } from "./errors.js";

export interface Access {
  userName: string;
  roleKey: string;
  grants: string[];
  isOwner: boolean;
  timeZone: string;
  businessStatus: string;
}

/**
 * Membership + grants, cached for a short time. Role and membership changes in
 * this process invalidate immediately; other API instances pick them up within
 * the TTL. Access tokens are short-lived, so a removed user is out within minutes.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Access | null }>();

export function invalidateAccess(businessId?: string): void {
  if (!businessId) return cache.clear();
  for (const key of cache.keys()) if (key.endsWith(`:${businessId}`)) cache.delete(key);
}

export async function loadAccess(db: Database, userId: string, businessId: string, now = Date.now()): Promise<Access | null> {
  const key = `${userId}:${businessId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = await withTenant(db, { businessId, userId }, async (tx) => {
    const res = await tx.execute<{
      user_name: string;
      role_key: string;
      is_owner: boolean;
      member_active: boolean;
      user_active: boolean;
      time_zone: string;
      status: string;
      grants: string[] | null;
    }>(sql`
      select u.name as user_name, r.key as role_key, bm.is_owner, bm.is_active as member_active, u.is_active as user_active,
             b.time_zone, b.status,
             array_remove(array_agg(rp."grant"), null) as grants
      from business_members bm
      join users u on u.id = bm.user_id
      join roles r on r.id = bm.role_id
      join businesses b on b.id = bm.business_id
      left join role_permissions rp on rp.role_id = r.id
      where bm.user_id = ${userId} and bm.business_id = ${businessId}
      group by u.name, r.key, bm.is_owner, bm.is_active, u.is_active, b.time_zone, b.status`);
    const row = res.rows[0];
    if (!row || !row.member_active || !row.user_active) return null;
    return {
      userName: row.user_name,
      roleKey: row.role_key,
      grants: row.grants ?? [],
      isOwner: row.is_owner,
      timeZone: row.time_zone,
      businessStatus: row.status,
    } satisfies Access;
  });
  cache.set(key, { at: now, value });
  return value;
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Verifies the bearer token. */
export function authenticate(deps: AppDeps): Handler {
  return async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    try {
      request.user = await deps.tokens.verifyAccess(header.slice(7));
    } catch {
      throw unauthorized("TOKEN_INVALID");
    }
  };
}

/** Resolves the current business membership and fills request.ctx. */
export function requireBusiness(deps: AppDeps): Handler {
  return async (request) => {
    const user = request.user;
    if (!user) throw unauthorized();
    if (!user.businessId) throw new ApiError(403, "NO_BUSINESS_SELECTED");
    const access = await loadAccess(deps.db, user.userId, user.businessId);
    if (!access) throw forbidden();
    if (access.businessStatus === "suspended" || access.businessStatus === "closed") {
      throw new ApiError(403, "BUSINESS_SUSPENDED");
    }
    request.ctx = {
      userId: user.userId,
      userName: access.userName,
      businessId: user.businessId,
      sessionId: user.sessionId,
      roleKey: access.roleKey,
      grants: access.grants,
      isOwner: access.isOwner,
      timeZone: access.timeZone,
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    };
  };
}

export function requirePermission(permission: Permission): Handler {
  return async (request) => {
    if (!hasPermission(request.ctx.grants, permission)) throw forbidden(permission);
  };
}

export function can(ctx: { grants: string[] }, permission: Permission): boolean {
  return hasPermission(ctx.grants, permission);
}

/** Route guard list: authenticated + business member (+ permission). */
export function guard(deps: AppDeps, permission?: Permission): Handler[] {
  return [authenticate(deps), requireBusiness(deps), ...(permission ? [requirePermission(permission)] : [])];
}
