import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("members, roles and audit", () => {
  let t: TestApp;
  let owner: Session;
  let roles: Record<string, string>;

  /** Invites someone with a role and signs them in by OTP. */
  async function member(roleKey: string, name = "Member") {
    const mobile = nextMobile();
    const invite = await call(t.app, "POST", "/members", { token: owner.token, body: { name, mobile, roleId: roles[roleKey] } });
    expect(invite.status).toBe(201);
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    const login = await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } });
    expect(login.status).toBe(200);
    return {
      id: invite.body.id as string,
      userId: invite.body.userId as string,
      token: login.body.accessToken as string,
      cookie: login.cookies.find((c) => c.name === "vy_rt")!.value,
    };
  }

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { name: "Owner", legalName: "Team Traders" });
    const list = await call(t.app, "GET", "/roles", { token: owner.token });
    roles = Object.fromEntries(list.body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
  });
  afterAll(async () => {
    await t?.close();
  });

  it("lists the seeded roles and the permission catalogue", async () => {
    expect(Object.keys(roles).sort()).toEqual(["accountant", "admin", "hr", "manager", "sales", "warehouse"]);
    const catalogue = await call(t.app, "GET", "/permissions", { token: owner.token });
    expect(catalogue.body.data.find((m: { module: string }) => m.module === "invoice").actions).toContain("cancel");
  });

  it("invites a member who then works with exactly their role's access", async () => {
    const sales = await member("sales", "Sunil");
    const me = await call(t.app, "GET", "/me", { token: sales.token });
    expect(me.body.business.role).toBe("sales");
    expect(me.body.permissions).toContain("invoice.create");
    expect(me.body.permissions).not.toContain("product.view_cost");
    expect(me.body.permissions).not.toContain("user.view");

    const denied = await call(t.app, "GET", "/members", { token: sales.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: "FORBIDDEN", params: { permission: "user.view" } });
    const members = await call(t.app, "GET", "/members", { token: owner.token });
    expect(members.body.data.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(["Owner", "Sunil"]));
  });

  it("refuses duplicate members and roles from another business", async () => {
    const other = await signup(t, { legalName: "Other Co" });
    const otherRoles = await call(t.app, "GET", "/roles", { token: other.token });
    const foreignRole = otherRoles.body.data[0].id;
    const res = await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Xavier", mobile: nextMobile(), roleId: foreignRole } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ROLE_NOT_FOUND");

    // The other business's owner can be added here too (people are global), but only once.
    const first = await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Other", mobile: other.mobile, roleId: roles.manager } });
    expect(first.status).toBe(201);
    const again = await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Other", mobile: other.mobile, roleId: roles.manager } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_MEMBER");
    const theirs = await call(t.app, "GET", "/businesses", { token: other.token });
    expect(theirs.body.data).toHaveLength(2);
  });

  it("never lets a user hand out more access than they hold", async () => {
    const createLead = await call(t.app, "POST", "/roles", {
      token: owner.token,
      body: { key: "team_lead", name: "Team Lead", grants: ["user.*", "customer.view"] },
    });
    expect(createLead.status).toBe(201);
    const lead = await member("sales", "Lata");
    const promote = await call(t.app, "PATCH", `/members/${lead.id}`, { token: owner.token, body: { roleId: createLead.body.id } });
    expect(promote.status).toBe(200);
    expect(promote.body.role.key).toBe("team_lead");

    const godRole = await call(t.app, "POST", "/roles", { token: lead.token, body: { key: "god", name: "God", grants: ["*"] } });
    expect(godRole.status).toBe(403);
    expect(godRole.body.error.code).toBe("CANNOT_GRANT_ABOVE_OWN");

    const inviteAdmin = await call(t.app, "POST", "/members", { token: lead.token, body: { name: "Yash", mobile: nextMobile(), roleId: roles.admin } });
    expect(inviteAdmin.status).toBe(403);

    const ownRole = await call(t.app, "PUT", `/roles/${createLead.body.id}/permissions`, { token: lead.token, body: { grants: ["*"] } });
    expect(ownRole.status).toBe(403);

    const allowed = await call(t.app, "POST", "/roles", { token: lead.token, body: { key: "viewer", name: "Viewer", grants: ["customer.view"] } });
    expect(allowed.status).toBe(201);
  });

  it("applies role permission changes immediately", async () => {
    const wh = await member("warehouse", "Wasim");
    expect((await call(t.app, "GET", "/me", { token: wh.token })).body.permissions).not.toContain("customer.view");
    const res = await call(t.app, "PUT", `/roles/${roles.warehouse}/permissions`, {
      token: owner.token,
      body: { grants: ["product.view", "inventory.*", "customer.view"] },
    });
    expect(res.status).toBe(200);
    expect((await call(t.app, "GET", "/me", { token: wh.token })).body.permissions).toContain("customer.view");

    const unknown = await call(t.app, "PUT", `/roles/${roles.warehouse}/permissions`, { token: owner.token, body: { grants: ["rocket.launch"] } });
    expect(unknown.status).toBe(400);
  });

  it("deactivating a member ends their access and sessions at once", async () => {
    const acc = await member("accountant", "Anil");
    const res = await call(t.app, "PATCH", `/members/${acc.id}`, { token: owner.token, body: { isActive: false } });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect((await call(t.app, "GET", "/audit-logs", { token: acc.token })).status).toBe(403);
    const refresh = await call(t.app, "POST", "/auth/refresh", { cookies: { vy_rt: acc.cookie } });
    expect(refresh.body.error.code).toBe("SESSION_REVOKED");
  });

  it("protects the owner and the caller's own membership", async () => {
    const members = await call(t.app, "GET", "/members", { token: owner.token });
    const ownerRow = members.body.data.find((m: { isOwner: boolean }) => m.isOwner);
    const res = await call(t.app, "PATCH", `/members/${ownerRow.id}`, { token: owner.token, body: { isActive: false } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("OWNER_MEMBERSHIP_LOCKED");
  });

  it("owners keep full access even if the admin role is edited", async () => {
    await call(t.app, "PUT", `/roles/${roles.admin}/permissions`, { token: owner.token, body: { grants: ["dashboard.view"] } });
    const me = await call(t.app, "GET", "/me", { token: owner.token });
    expect(me.body.permissions).toContain("user.manage_roles");
    await call(t.app, "PUT", `/roles/${roles.admin}/permissions`, { token: owner.token, body: { grants: ["*"] } });
  });

  it("deletes only unused custom roles", async () => {
    const inUse = await call(t.app, "DELETE", `/roles/${roles.sales}`, { token: owner.token });
    expect(inUse.status).toBe(409);
    const temp = await call(t.app, "POST", "/roles", { token: owner.token, body: { key: "temp", name: "Temp", grants: [] } });
    expect((await call(t.app, "DELETE", `/roles/${temp.body.id}`, { token: owner.token })).status).toBe(204);
    expect((await call(t.app, "DELETE", `/roles/${temp.body.id}`, { token: owner.token })).status).toBe(404);
  });

  it("records an audit trail, newest first, with pagination", async () => {
    const page1 = await call(t.app, "GET", "/audit-logs?limit=3", { token: owner.token });
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(3);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call(t.app, "GET", `/audit-logs?limit=3&cursor=${page1.body.nextCursor}`, { token: owner.token });
    expect(page2.body.data[0].id).toBeLessThan(page1.body.data[2].id);

    const perms = await call(t.app, "GET", "/audit-logs?action=role.permissions_changed", { token: owner.token });
    expect(perms.body.data.length).toBeGreaterThanOrEqual(3);
    expect(perms.body.data[0].changes.grants).toHaveLength(2);
    const created = await call(t.app, "GET", "/audit-logs?action=business.created", { token: owner.token });
    expect(created.body.data).toHaveLength(1);
    expect(created.body.data[0].entityLabel).toBe("Team Traders");
  });

  it("keeps tenants apart even when ids are guessed", async () => {
    const other = await signup(t, { legalName: "Snoop Ltd" });
    const members = await call(t.app, "GET", "/members", { token: owner.token });
    const target = members.body.data.find((m: { isOwner: boolean }) => !m.isOwner);
    const res = await call(t.app, "PATCH", `/members/${target.id}`, { token: other.token, body: { isActive: false } });
    expect(res.status).toBe(404);
    const roleRes = await call(t.app, "PATCH", `/roles/${roles.sales}`, { token: other.token, body: { name: "Hacked" } });
    expect(roleRes.status).toBe(404);
    const logs = await call(t.app, "GET", "/audit-logs", { token: other.token });
    expect(logs.body.data.every((l: { businessId: string }) => l.businessId === other.businessId)).toBe(true);
  });
});
