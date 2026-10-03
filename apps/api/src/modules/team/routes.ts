import { InviteMemberBody, MemberCredentialsBody, RoleBody, RolePermissionsBody, UpdateMemberBody, UpdateRoleBody } from "@digitalbahi/contracts";
import { ALL_PERMISSIONS, expandGrants, hasPermission, normalizeIndianMobile, PERMISSION_CATALOG, type Grant } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard, invalidateAccess } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { hashPassword } from "../../lib/security.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const KNOWN = new Set<string>(ALL_PERMISSIONS);
const MODULES = new Set(Object.keys(PERMISSION_CATALOG));

function assertKnownGrants(grants: string[]): void {
  for (const g of grants) {
    const ok = g === "*" || KNOWN.has(g) || (g.endsWith(".*") && MODULES.has(g.slice(0, -2)));
    if (!ok) throw badRequest("UNKNOWN_PERMISSION", { grant: g }, "grants");
  }
}

/** No privilege escalation: you can only hand out (or take away) access you hold yourself. */
function assertCanGrant(ctx: RequestCtx, grants: readonly string[]): void {
  const missing = expandGrants(grants as Grant[]).find((p) => !hasPermission(ctx.grants, p));
  if (missing) throw new ApiError(403, "CANNOT_GRANT_ABOVE_OWN", { permission: missing });
}

async function roleGrants(tx: Tx, roleId: string): Promise<string[]> {
  const rows = await tx.select({ grant: schema.rolePermissions.grant }).from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
  return rows.map((r) => r.grant).sort();
}

/** Loads a role of the current business (row-level security hides other tenants' roles). */
async function findRole(tx: Tx, businessId: string, roleId: string) {
  const [role] = await tx
    .select()
    .from(schema.roles)
    .where(and(eq(schema.roles.id, roleId), eq(schema.roles.businessId, businessId)));
  return role;
}

/** User IDs are unique across Digital Bahi. */
async function assertUsernameFree(tx: Tx, username: string, exceptUserId?: string): Promise<void> {
  const [taken] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username));
  if (taken && taken.id !== exceptUserId) throw conflict("USERNAME_TAKEN", {}, "username");
}

async function listMembers(tx: Tx, businessId: string, memberId?: string) {
  const res = await tx.execute<{
    id: string;
    user_id: string;
    name: string;
    mobile: string;
    email: string | null;
    username: string | null;
    has_password: boolean;
    last_login_at: string | null;
    role_id: string;
    role_key: string;
    role_name: string;
    is_owner: boolean;
    is_active: boolean;
    created_at: string;
  }>(sql`
    select bm.id, bm.user_id, u.name, u.mobile, u.email, u.username, u.password_hash is not null as has_password, u.last_login_at, bm.role_id, r.key as role_key, r.name as role_name,
           bm.is_owner, bm.is_active, bm.created_at
    from business_members bm
    join users u on u.id = bm.user_id
    join roles r on r.id = bm.role_id
    where bm.business_id = ${businessId} ${memberId ? sql`and bm.id = ${memberId}` : sql``}
    order by bm.is_owner desc, bm.is_active desc, u.name`);
  return res.rows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    name: m.name,
    mobile: m.mobile,
    email: m.email,
    username: m.username,
    hasPassword: m.has_password,
    lastLoginAt: m.last_login_at,
    role: { id: m.role_id, key: m.role_key, name: m.role_name },
    isOwner: m.is_owner,
    isActive: m.is_active,
    createdAt: m.created_at,
  }));
}

export const teamModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  // ---------------------------------------------------------------- permissions catalogue
  r.get("/permissions", { preHandler: guard(deps, "user.view"), schema: { tags: ["team"] } }, async () => ({
    data: Object.entries(PERMISSION_CATALOG).map(([module, actions]) => ({ module, actions: [...actions] })),
  }));

  // ---------------------------------------------------------------- members
  r.get("/members", { preHandler: guard(deps, "user.view"), schema: { tags: ["team"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) => listMembers(tx, request.ctx.businessId)),
  }));

  r.post("/members", { preHandler: guard(deps, "user.invite"), schema: { tags: ["team"], body: InviteMemberBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const mobile = normalizeIndianMobile(body.mobile);
    if (!mobile) throw badRequest("INVALID_MOBILE", {}, "mobile");
    const member = await tenant(ctx, async (tx) => {
      const role = await findRole(tx, ctx.businessId, body.roleId);
      if (!role) throw badRequest("ROLE_NOT_FOUND", {}, "roleId");
      assertCanGrant(ctx, await roleGrants(tx, role.id));

      // People are global identities: an existing account simply joins this business,
      // keeping its own user ID and password (a business never sets those for someone
      // who already has an account).
      let [user] = await tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.mobile, mobile));
      const existingAccount = Boolean(user);
      if (!user) {
        if (body.username) await assertUsernameFree(tx, body.username);
        [user] = await tx
          .insert(schema.users)
          .values({
            id: uuidv7(),
            name: body.name,
            mobile,
            email: body.email?.toLowerCase() ?? null,
            username: body.username ?? null,
            ...(body.password ? { passwordHash: await hashPassword(body.password), passwordChangedAt: deps.clock.now().toISOString() } : {}),
          })
          .returning({ id: schema.users.id, name: schema.users.name });
      }
      const id = uuidv7();
      await tx.insert(schema.businessMembers).values({ id, businessId: ctx.businessId, userId: user!.id, roleId: role.id, invitedBy: ctx.userId });
      await audit(tx, ctx, {
        action: "member.invited",
        entityType: "member",
        entityId: id,
        entityLabel: user!.name,
        changes: { role: role.key, ...(!existingAccount && body.username ? { username: body.username } : {}), ...(!existingAccount && body.password ? { password: "set" } : {}) },
      });
      return { ...(await listMembers(tx, ctx.businessId, id))[0]!, existingAccount };
    });
    return reply.code(201).send(member);
  });

  /**
   * A staff member's user ID and password, set by the business. Only for an
   * account used in this business alone: someone who also works for (or owns)
   * another business keeps sole control of their sign-in. Their sessions end
   * when the password changes.
   */
  r.put(
    "/members/:id/credentials",
    { preHandler: guard(deps, "user.update"), schema: { tags: ["team"], params: IdParams, body: MemberCredentialsBody } },
    async (request) => {
      const ctx = request.ctx;
      const body = request.body;
      const result = await tenant(ctx, async (tx) => {
        const [m] = await tx
          .select()
          .from(schema.businessMembers)
          .where(and(eq(schema.businessMembers.id, request.params.id), eq(schema.businessMembers.businessId, ctx.businessId)))
          .for("update");
        if (!m) throw notFound("member");
        if (m.isOwner) throw conflict("OWNER_MEMBERSHIP_LOCKED");
        if (m.userId === ctx.userId) throw conflict("CANNOT_CHANGE_OWN_MEMBERSHIP");
        assertCanGrant(ctx, await roleGrants(tx, m.roleId));
        const shared = await tx.execute<{ shared: boolean }>(sql`select user_in_other_business(${m.userId}::uuid, ${ctx.businessId}::uuid) as shared`);
        if (shared.rows[0]?.shared) throw conflict("MEMBER_ACCOUNT_SHARED");
        const [u] = await tx.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, m.userId)).for("update");
        const changes: { username?: string | null; passwordHash?: string; passwordChangedAt?: string; failedLoginCount?: number; lockedUntil?: null } = {};
        if (body.username !== undefined && body.username !== u?.username) {
          if (body.username) await assertUsernameFree(tx, body.username, m.userId);
          changes.username = body.username;
        }
        if (body.password) {
          changes.passwordHash = await hashPassword(body.password);
          changes.passwordChangedAt = deps.clock.now().toISOString();
          changes.failedLoginCount = 0;
          changes.lockedUntil = null;
        }
        if (Object.keys(changes).length) {
          await tx.update(schema.users).set(changes).where(eq(schema.users.id, m.userId));
          if (body.password) {
            await tx
              .update(schema.refreshTokens)
              .set({ revokedAt: deps.clock.now().toISOString() })
              .where(and(eq(schema.refreshTokens.userId, m.userId), sql`${schema.refreshTokens.revokedAt} is null`));
          }
          await audit(tx, ctx, {
            action: "member.credentials_set",
            entityType: "member",
            entityId: m.id,
            changes: { ...(changes.username !== undefined ? { username: changes.username } : {}), ...(body.password ? { password: "changed" } : {}) },
          });
        }
        return (await listMembers(tx, ctx.businessId, m.id))[0]!;
      });
      return result;
    },
  );

  r.patch(
    "/members/:id",
    { preHandler: guard(deps, "user.view"), schema: { tags: ["team"], params: IdParams, body: UpdateMemberBody } },
    async (request) => {
      const ctx = request.ctx;
      const body = request.body;
      if (body.roleId !== undefined && !can(ctx, "user.update")) throw forbidden("user.update");
      if (body.isActive !== undefined && !can(ctx, "user.deactivate")) throw forbidden("user.deactivate");
      const result = await tenant(ctx, async (tx) => {
        const [m] = await tx
          .select()
          .from(schema.businessMembers)
          .where(and(eq(schema.businessMembers.id, request.params.id), eq(schema.businessMembers.businessId, ctx.businessId)))
          .for("update");
        if (!m) throw notFound("member");
        if (m.isOwner) throw conflict("OWNER_MEMBERSHIP_LOCKED");
        if (m.userId === ctx.userId) throw conflict("CANNOT_CHANGE_OWN_MEMBERSHIP");
        // Managing someone requires holding at least their current access.
        assertCanGrant(ctx, await roleGrants(tx, m.roleId));
        const changes: Partial<typeof m> = {};
        if (body.roleId !== undefined && body.roleId !== m.roleId) {
          const role = await findRole(tx, ctx.businessId, body.roleId);
          if (!role) throw badRequest("ROLE_NOT_FOUND", {}, "roleId");
          assertCanGrant(ctx, await roleGrants(tx, role.id));
          changes.roleId = role.id;
        }
        if (body.isActive !== undefined) changes.isActive = body.isActive;
        const d = diff(m, changes);
        if (Object.keys(d).length) {
          await tx.update(schema.businessMembers).set(changes).where(eq(schema.businessMembers.id, m.id));
          await audit(tx, ctx, {
            action: body.isActive === false ? "member.deactivated" : "member.updated",
            entityType: "member",
            entityId: m.id,
            changes: d,
          });
          if (changes.isActive === false) {
            // Their sessions in this business end now, not when the access token expires.
            await tx
              .update(schema.refreshTokens)
              .set({ revokedAt: deps.clock.now().toISOString() })
              .where(
                and(
                  eq(schema.refreshTokens.userId, m.userId),
                  eq(schema.refreshTokens.businessId, ctx.businessId),
                  sql`${schema.refreshTokens.revokedAt} is null`,
                ),
              );
          }
        }
        return (await listMembers(tx, ctx.businessId, m.id))[0]!;
      });
      invalidateAccess(ctx.businessId);
      return result;
    },
  );

  // ---------------------------------------------------------------- roles
  r.get("/roles", { preHandler: guard(deps, "user.view"), schema: { tags: ["team"] } }, async (request) => {
    const rows = await tenant(request.ctx, async (tx) =>
      (
        await tx.execute<{
          id: string;
          key: string;
          name: string;
          name_hi: string | null;
          description: string | null;
          is_system: boolean;
          grants: string[];
          member_count: number;
        }>(sql`
          select r.id, r.key, r.name, r.name_hi, r.description, r.is_system,
                 coalesce((select array_agg(rp."grant" order by rp."grant") from role_permissions rp where rp.role_id = r.id), '{}') as grants,
                 (select count(*) from business_members bm where bm.role_id = r.id and bm.is_active)::int as member_count
          from roles r
          where r.business_id = ${request.ctx.businessId}
          order by r.is_system desc, r.name`)
      ).rows,
    );
    return {
      data: rows.map((x) => ({
        id: x.id,
        key: x.key,
        name: x.name,
        nameHi: x.name_hi,
        description: x.description,
        isSystem: x.is_system,
        grants: x.grants,
        memberCount: x.member_count,
      })),
    };
  });

  r.post("/roles", { preHandler: guard(deps, "user.manage_roles"), schema: { tags: ["team"], body: RoleBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const grants = [...new Set(body.grants)].sort();
    assertKnownGrants(grants);
    assertCanGrant(ctx, grants);
    const role = await tenant(ctx, async (tx) => {
      const id = uuidv7();
      const [row] = await tx
        .insert(schema.roles)
        .values({
          id,
          businessId: ctx.businessId,
          key: body.key,
          name: body.name,
          nameHi: body.nameHi ?? null,
          description: body.description ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      if (grants.length) await tx.insert(schema.rolePermissions).values(grants.map((grant) => ({ roleId: id, grant, createdBy: ctx.userId })));
      await audit(tx, ctx, { action: "role.created", entityType: "role", entityId: id, entityLabel: body.name, changes: { grants } });
      return row!;
    });
    return reply.code(201).send({ ...roleOut(role), grants, memberCount: 0 });
  });

  r.patch(
    "/roles/:id",
    { preHandler: guard(deps, "user.manage_roles"), schema: { tags: ["team"], params: IdParams, body: UpdateRoleBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const role = await findRole(tx, ctx.businessId, request.params.id);
        if (!role) throw notFound("role");
        const d = diff(role, request.body);
        if (!Object.keys(d).length) return roleOut(role);
        const [row] = await tx
          .update(schema.roles)
          .set({ ...request.body, updatedBy: ctx.userId })
          .where(eq(schema.roles.id, role.id))
          .returning();
        await audit(tx, ctx, { action: "role.updated", entityType: "role", entityId: role.id, entityLabel: row!.name, changes: d });
        return roleOut(row!);
      });
    },
  );

  r.put(
    "/roles/:id/permissions",
    { preHandler: guard(deps, "user.manage_roles"), schema: { tags: ["team"], params: IdParams, body: RolePermissionsBody } },
    async (request) => {
      const ctx = request.ctx;
      const grants = [...new Set(request.body.grants)].sort();
      assertKnownGrants(grants);
      const result = await tenant(ctx, async (tx) => {
        const role = await findRole(tx, ctx.businessId, request.params.id);
        if (!role) throw notFound("role");
        const before = await roleGrants(tx, role.id);
        // Both what is added and what is removed must be within the caller's own access.
        assertCanGrant(ctx, [...before, ...grants]);
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, role.id));
        if (grants.length) await tx.insert(schema.rolePermissions).values(grants.map((grant) => ({ roleId: role.id, grant, createdBy: ctx.userId })));
        await tx.update(schema.roles).set({ updatedBy: ctx.userId }).where(eq(schema.roles.id, role.id));
        await audit(tx, ctx, {
          action: "role.permissions_changed",
          entityType: "role",
          entityId: role.id,
          entityLabel: role.name,
          changes: { grants: [before, grants] },
        });
        return { ...roleOut(role), grants };
      });
      invalidateAccess(ctx.businessId);
      return result;
    },
  );

  r.delete("/roles/:id", { preHandler: guard(deps, "user.manage_roles"), schema: { tags: ["team"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const role = await findRole(tx, ctx.businessId, request.params.id);
      if (!role) throw notFound("role");
      if (role.isSystem) throw conflict("SYSTEM_ROLE_PROTECTED");
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.businessMembers)
        .where(eq(schema.businessMembers.roleId, role.id));
      if (used!.n > 0) throw conflict("ROLE_IN_USE", { members: used!.n });
      await tx.delete(schema.roles).where(eq(schema.roles.id, role.id));
      await audit(tx, ctx, { action: "role.deleted", entityType: "role", entityId: role.id, entityLabel: role.name });
    });
    return reply.code(204).send();
  });
};

const roleOut = (role: typeof schema.roles.$inferSelect) => ({
  id: role.id,
  key: role.key,
  name: role.name,
  nameHi: role.nameHi,
  description: role.description,
  isSystem: role.isSystem,
});
