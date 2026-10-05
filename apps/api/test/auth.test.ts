import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateAccess } from "../src/lib/access.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, TEST_TODAY, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("auth and SaaS signup", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("signup", () => {
    it("creates the user, a trial business with defaults and an owner session", async () => {
      const mobile = nextMobile();
      expect((await call(t.app, "POST", "/auth/otp", { body: { mobile: `+91 ${mobile}`, purpose: "signup" } })).status).toBe(202);
      const code = t.otp.last(mobile)!;
      const wrong = code === "000000" ? "111111" : "000000";

      const bad = await call(t.app, "POST", "/auth/signup", {
        body: { name: "Ramesh", mobile, password: "Str0ng-pass!", otp: wrong, business: { legalName: "Shree Traders", stateCode: "23" } },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatchObject({ code: "OTP_INVALID", field: "otp" });

      const res = await call(t.app, "POST", "/auth/signup", {
        body: {
          name: "Ramesh",
          mobile,
          email: "Ramesh@Example.com",
          password: "Str0ng-pass!",
          otp: code,
          preferredLocale: "hi",
          business: { legalName: "Shree Traders", stateCode: "23", city: "Indore" },
        },
      });
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ name: "Ramesh", mobile, email: "ramesh@example.com", preferredLocale: "hi" });
      expect(res.body.business).toMatchObject({ legalName: "Shree Traders", status: "trial", role: "admin", isOwner: true });
      expect(res.body.businesses).toHaveLength(1);
      expect(res.body.refreshToken).toBeUndefined();
      const cookie = res.cookies.find((c) => c.name === "db_rt")!;
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/v1/auth" });

      const biz = res.body.business.id as string;
      const seeded = await t.owner.query(
        `select (select count(*) from roles where business_id = $1)::int as roles,
                (select count(*) from document_series where business_id = $1)::int as series,
                (select count(*) from settings where business_id = $1)::int as settings,
                (select count(*) from warehouses where business_id = $1 and is_default)::int as warehouses`,
        [biz],
      );
      expect(seeded.rows[0]).toEqual({ roles: 6, series: 11, settings: 14, warehouses: 1 });

      const me = await call(t.app, "GET", "/me", { token: res.body.accessToken });
      expect(me.status).toBe(200);
      expect(me.body.business).toMatchObject({ id: biz, role: "admin", timeZone: "Asia/Kolkata", financialYearStartMonth: 4 });
      expect(me.body.permissions).toContain("invoice.create");
      expect(me.body.permissions).toContain("user.manage_roles");
      expect(me.body.settings["stock.negative_policy"]).toBe("warn");
      expect(me.body.today).toBe(TEST_TODAY);
    });

    it("refuses a second account for the same mobile", async () => {
      const s = await signup(t);
      const res = await call(t.app, "POST", "/auth/otp", { body: { mobile: s.mobile, purpose: "signup" } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "ACCOUNT_EXISTS", field: "mobile" });
    });

    it("validates the GSTIN against the state", async () => {
      const mobile = nextMobile();
      await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "signup" } });
      const res = await call(t.app, "POST", "/auth/signup", {
        body: {
          name: "Asha",
          mobile,
          password: "Str0ng-pass!",
          otp: t.otp.last(mobile),
          business: { legalName: "Asha Agencies", stateCode: "23", gstin: "27AAPFU0939F1ZV" },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "GSTIN_STATE_MISMATCH", field: "business.gstin" });
    });

    it("throttles OTP requests per number", async () => {
      const mobile = nextMobile();
      expect((await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "signup" } })).status).toBe(202);
      const again = await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "signup" } });
      expect(again.status).toBe(429);
      expect(again.body.error.code).toBe("OTP_TOO_SOON");
    });

    it("rejects an invalid mobile number", async () => {
      const res = await call(t.app, "POST", "/auth/otp", { body: { mobile: "12345abcde", purpose: "login" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "INVALID_MOBILE", field: "mobile" });
    });
  });

  describe("login", () => {
    it("signs in with mobile (any format) or email", async () => {
      const s = await signup(t, { email: "login.test@example.com" });
      const byMobile = await call(t.app, "POST", "/auth/login", { body: { identifier: `0${s.mobile}`, password: s.password } });
      expect(byMobile.status).toBe(200);
      expect(byMobile.body.business.id).toBe(s.businessId);
      const byEmail = await call(t.app, "POST", "/auth/login", { body: { identifier: "LOGIN.test@example.com", password: s.password } });
      expect(byEmail.status).toBe(200);
    });

    it("gives the same answer for a wrong password and an unknown user", async () => {
      const s = await signup(t);
      const wrong = await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: "nope-nope" } });
      const unknown = await call(t.app, "POST", "/auth/login", { body: { identifier: nextMobile(), password: "nope-nope" } });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
      expect(unknown.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("locks the account after repeated failures", async () => {
      const s = await signup(t);
      for (let i = 0; i < 5; i++) {
        await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: "wrong-password" } });
      }
      const locked = await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: s.password } });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
      const failures = await t.owner.query(`select count(*)::int as n from audit_logs where user_id = $1 and action = 'auth.login_failed'`, [s.userId]);
      expect(failures.rows[0].n).toBe(5);
    });

    it("signs in with an OTP, without revealing unknown numbers", async () => {
      const s = await signup(t);
      t.advance(31_000); // past the resend wait after the signup OTP
      const unknown = nextMobile();
      const ghost = await call(t.app, "POST", "/auth/otp", { body: { mobile: unknown, purpose: "login" } });
      expect(ghost.status).toBe(202);
      expect(t.otp.last(unknown)).toBeUndefined();

      await call(t.app, "POST", "/auth/otp", { body: { mobile: s.mobile, purpose: "login" } });
      const res = await call(t.app, "POST", "/auth/login/otp", { body: { mobile: s.mobile, otp: t.otp.last(s.mobile) } });
      expect(res.status).toBe(200);
      expect(res.body.business.id).toBe(s.businessId);
      // A code works once.
      const replay = await call(t.app, "POST", "/auth/login/otp", { body: { mobile: s.mobile, otp: t.otp.last(s.mobile) } });
      expect(replay.status).toBe(400);
    });

    it("stops accepting an OTP after five wrong attempts", async () => {
      const s = await signup(t);
      t.advance(31_000);
      await call(t.app, "POST", "/auth/otp", { body: { mobile: s.mobile, purpose: "login" } });
      const code = t.otp.last(s.mobile)!;
      const wrong = code === "123456" ? "654321" : "123456";
      for (let i = 0; i < 5; i++) await call(t.app, "POST", "/auth/login/otp", { body: { mobile: s.mobile, otp: wrong } });
      const res = await call(t.app, "POST", "/auth/login/otp", { body: { mobile: s.mobile, otp: code } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OTP_INVALID");
    });
  });

  describe("sessions", () => {
    it("rotates refresh tokens and revokes the family when an old one is replayed", async () => {
      const s = await signup(t);
      const first = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } });
      expect(first.status).toBe(200);
      expect(first.body.business.id).toBe(s.businessId);
      const rotated = first.cookies.find((c) => c.name === "db_rt")!.value;
      expect(rotated).not.toBe(s.refreshCookie);

      // A parallel tab using the old cookie within the grace window just retries.
      const race = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } });
      expect(race.status).toBe(401);
      expect(race.body.error.code).toBe("REFRESH_ROTATED");

      // Later, the same old token means it was stolen: the whole session dies.
      t.advance(60_000);
      const replay = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } });
      expect(replay.body.error.code).toBe("SESSION_REVOKED");
      const afterTheft = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: rotated } });
      expect(afterTheft.status).toBe(401);
      expect(afterTheft.body.error.code).toBe("SESSION_REVOKED");
    });

    it("still accepts the cookie under its former name, and replaces it", async () => {
      const s = await signup(t);
      const res = await call(t.app, "POST", "/auth/refresh", { cookies: { vy_rt: s.refreshCookie } });
      expect(res.status).toBe(200);
      expect(res.cookies.find((c) => c.name === "db_rt")!.value).not.toBe(s.refreshCookie);
      const legacy = res.cookies.find((c) => c.name === "vy_rt")!;
      expect(legacy).toMatchObject({ value: "", path: "/api/v1/auth" });
    });

    it("gives native apps the refresh token in the body instead of a cookie", async () => {
      const s = await signup(t);
      const login = await call(t.app, "POST", "/auth/login", {
        headers: { "x-client": "native" },
        body: { identifier: s.mobile, password: s.password },
      });
      expect(login.body.refreshToken).toBeTruthy();
      expect(login.cookies.find((c) => c.name === "db_rt")).toBeUndefined();
      const refreshed = await call(t.app, "POST", "/auth/refresh", {
        headers: { "x-client": "native" },
        body: { refreshToken: login.body.refreshToken },
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
    });

    it("expires refresh tokens", async () => {
      const s = await signup(t);
      t.advance(31 * 86_400_000);
      const res = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } });
      expect(res.body.error.code).toBe("REFRESH_EXPIRED");
    });

    it("logs out the current session", async () => {
      const s = await signup(t);
      const out = await call(t.app, "POST", "/auth/logout", { token: s.token, cookies: { db_rt: s.refreshCookie } });
      expect(out.status).toBe(204);
      const res = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } });
      expect(res.body.error.code).toBe("SESSION_REVOKED");
    });

    it("hands a person's device key only to their signed-in sessions, the same each time", async () => {
      const a = await signup(t);
      const b = await signup(t);
      const first = await call(t.app, "GET", "/me/device-key", { token: a.token });
      expect(first.status).toBe(200);
      expect(first.headers["cache-control"]).toBe("private, no-store");
      expect(Buffer.from(first.body.key, "base64")).toHaveLength(32);
      expect((await call(t.app, "GET", "/me/device-key", { token: a.token })).body.key).toBe(first.body.key);
      expect((await call(t.app, "GET", "/me/device-key", { token: b.token })).body.key).not.toBe(first.body.key);
      expect((await call(t.app, "GET", "/me/device-key")).status).toBe(401);
      // Kept encrypted in the database.
      const stored = (await t.owner.query("select device_key from users where id = $1", [a.userId])).rows[0].device_key as string;
      expect(stored).not.toContain(first.body.key);
    });

    it("checks the signed-in person's password without a new session, counting wrong tries", async () => {
      const s = await signup(t);
      const check = (password: string) => call(t.app, "POST", "/auth/password/check", { token: s.token, body: { password } });
      expect((await check(s.password)).status).toBe(204);
      const wrong = await check("not-my-password");
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatchObject({ code: "INVALID_CREDENTIALS", field: "password" });
      expect((await t.owner.query("select failed_login_count from users where id = $1", [s.userId])).rows[0].failed_login_count).toBe(1);
      expect((await call(t.app, "POST", "/auth/password/check", { body: { password: s.password } })).status).toBe(401);
    });

    it("rejects missing and forged access tokens", async () => {
      expect((await call(t.app, "GET", "/me")).body.error.code).toBe("UNAUTHORIZED");
      expect((await call(t.app, "GET", "/me", { token: "x.y.z" })).body.error.code).toBe("TOKEN_INVALID");
    });
  });

  describe("passwords", () => {
    it("resets a forgotten password with an OTP and signs out every session", async () => {
      const s = await signup(t);
      t.advance(31_000);
      await call(t.app, "POST", "/auth/otp", { body: { mobile: s.mobile, purpose: "reset" } });
      const res = await call(t.app, "POST", "/auth/password/reset", {
        body: { mobile: s.mobile, otp: t.otp.last(s.mobile), password: "N3w-password!" },
      });
      expect(res.status).toBe(204);
      expect((await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } })).body.error.code).toBe("SESSION_REVOKED");
      expect((await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: s.password } })).status).toBe(401);
      expect((await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: "N3w-password!" } })).status).toBe(200);
    });

    it("changes the password, keeping only the current device signed in", async () => {
      const s = await signup(t);
      const other = await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: s.password } });
      const otherCookie = other.cookies.find((c) => c.name === "db_rt")!.value;
      const bad = await call(t.app, "POST", "/auth/password/change", { token: s.token, body: { currentPassword: "wrong", newPassword: "An0ther-pass!" } });
      expect(bad.status).toBe(400);
      const ok = await call(t.app, "POST", "/auth/password/change", {
        token: s.token,
        body: { currentPassword: s.password, newPassword: "An0ther-pass!" },
      });
      expect(ok.status).toBe(204);
      expect((await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: otherCookie } })).body.error.code).toBe("SESSION_REVOKED");
      expect((await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } })).status).toBe(200);
    });
  });

  describe("multi-business (SaaS tenancy)", () => {
    it("creates another business and switches between them per session", async () => {
      const s = await signup(t, { legalName: "First Traders" });
      const created = await call(t.app, "POST", "/businesses", {
        token: s.token,
        body: { legalName: "Second Distributors", stateCode: "27", gstin: "27AAPFU0939F1ZV" },
      });
      expect(created.status).toBe(201);
      expect(created.body.business).toMatchObject({ legalName: "Second Distributors", role: "admin", gstin: "27AAPFU0939F1ZV" });
      expect(created.body.businesses).toHaveLength(2);
      const second = created.body.business.id as string;

      const me = await call(t.app, "GET", "/me", { token: created.body.accessToken });
      expect(me.body.business.id).toBe(second);

      // The session remembers the business across refreshes.
      const refreshed = await call(t.app, "POST", "/auth/refresh", { cookies: { db_rt: s.refreshCookie } });
      expect(refreshed.body.business.id).toBe(second);

      const back = await call(t.app, "POST", "/auth/switch-business", { token: created.body.accessToken, body: { businessId: s.businessId } });
      expect(back.status).toBe(200);
      expect(back.body.business.id).toBe(s.businessId);
    });

    it("never lets a user into someone else's business", async () => {
      const a = await signup(t, { legalName: "Alpha" });
      const b = await signup(t, { legalName: "Beta" });
      const res = await call(t.app, "POST", "/auth/switch-business", { token: a.token, body: { businessId: b.businessId } });
      expect(res.status).toBe(403);
      const login = await call(t.app, "POST", "/auth/login", { body: { identifier: a.mobile, password: a.password, businessId: b.businessId } });
      expect(login.status).toBe(403);
      const list = await call(t.app, "GET", "/businesses", { token: a.token });
      expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([a.businessId]);
    });

    it("blocks a suspended business but still lets the user sign in", async () => {
      const s = await signup(t);
      await t.owner.query(`update businesses set status = 'suspended' where id = $1`, [s.businessId]);
      invalidateAccess(s.businessId);
      const members = await call(t.app, "GET", "/members", { token: s.token });
      expect(members.status).toBe(403);
      expect(members.body.error.code).toBe("BUSINESS_SUSPENDED");
      const login = await call(t.app, "POST", "/auth/login", { body: { identifier: s.mobile, password: s.password } });
      expect(login.status).toBe(200);
      expect(login.body.business).toBeNull();
      expect(login.body.businesses[0]).toMatchObject({ id: s.businessId, status: "suspended" });
      const me = await call(t.app, "GET", "/me", { token: login.body.accessToken });
      expect(me.body.business).toBeNull();
    });
  });
});

describe.skipIf(!hasDatabase)("OTP codes on screen for this computer only (phone mode)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { OTP_DEV_ECHO: "true", OTP_DEV_ECHO_LOCAL_ONLY: "true" } });
  });
  afterAll(async () => {
    await t?.close();
  });

  const ask = (remoteAddress: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: "POST", url: "/api/v1/auth/otp", remoteAddress, headers, payload: { mobile: nextMobile(), purpose: "signup" } });

  it("shows the code to this computer", async () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await ask(address);
      expect(res.statusCode).toBe(202);
      expect(res.json().devCode).toMatch(/^\d{6}$/);
    }
  });

  it("never shows it to a phone on the Wi-Fi, even one claiming to be local", async () => {
    for (const res of [await ask("192.168.1.42"), await ask("192.168.1.42", { "x-forwarded-for": "127.0.0.1" })]) {
      expect(res.statusCode).toBe(202);
      expect(res.json()).not.toHaveProperty("devCode");
    }
  });
});
