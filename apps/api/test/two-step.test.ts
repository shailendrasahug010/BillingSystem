import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "../src/lib/totp.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const ANDROID_APP = "Mozilla/5.0 (Linux; Android 14; SM-A146B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36";

describe.skipIf(!hasDatabase)("two-step sign-in and signed-in devices", () => {
  let t: TestApp;
  let owner: Session;
  let secret = "";
  let recovery: string[] = [];
  /** The API's clock (tests move it on to get the app's next code). */
  let offsetMs = 0;
  const at = (plusMs = 0) => new Date(Date.now() + offsetMs + plusMs);
  const advance = (ms: number) => {
    offsetMs += ms;
    t.advance(ms);
  };
  /** The code the app shows now, or one 30-second step later (still accepted). */
  const code = (stepsAhead = 0, s = secret) => totpCode(s, at(stepsAhead * 30_000));
  /** A 6-digit code that is not the app's code just now. */
  const wrongCode = (s = secret) => {
    const right = new Set([-1, 0, 1].map((n) => code(n, s)));
    let c = 123456;
    while (right.has(String(c))) c++;
    return String(c);
  };

  /** Turns two-step sign-in on for a person; returns the secret and the recovery codes. */
  async function turnOn(session: { token: string }, password: string) {
    const setup = await call(t.app, "POST", "/auth/two-step/setup", { token: session.token, body: { password } });
    expect(setup.status).toBe(200);
    const on = await call(t.app, "POST", "/auth/two-step/enable", { token: session.token, body: { code: totpCode(setup.body.secret, at()) } });
    expect(on.status).toBe(200);
    return { secret: setup.body.secret as string, recovery: on.body.recoveryCodes as string[] };
  }

  /** Password then code: the session. */
  async function signIn(mobile: string, password: string, second: string, headers: Record<string, string> = {}) {
    const first = await call(t.app, "POST", "/auth/login", { body: { identifier: mobile, password }, headers });
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe("TWO_STEP_REQUIRED");
    return call(t.app, "POST", "/auth/login/two-step", { body: { token: first.body.error.params.token, code: second }, headers });
  }

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { name: "Meera", legalName: "Meera Traders" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("turns on with the password and the app's first code, and shows the recovery codes once", async () => {
    expect((await call(t.app, "GET", "/auth/two-step", { token: owner.token })).body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });

    const wrongPassword = await call(t.app, "POST", "/auth/two-step/setup", { token: owner.token, body: { password: "not-my-password" } });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.body.error).toMatchObject({ code: "INVALID_CREDENTIALS", field: "password" });
    const early = await call(t.app, "POST", "/auth/two-step/enable", { token: owner.token, body: { code: "123456" } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("TWO_STEP_NOT_STARTED");

    const setup = await call(t.app, "POST", "/auth/two-step/setup", { token: owner.token, body: { password: owner.password } });
    expect(setup.status).toBe(200);
    expect(setup.headers["cache-control"]).toBe("private, no-store");
    secret = setup.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.uri).toBe(`otpauth://totp/Digital%20Bahi:${owner.mobile}?secret=${secret}&issuer=Digital%20Bahi&algorithm=SHA1&digits=6&period=30`);
    // Kept encrypted, and not on until the first code comes back.
    const kept = await t.owner.query("select mfa_secret_enc, mfa_enabled_at from users where id = $1", [owner.userId]);
    expect(kept.rows[0].mfa_secret_enc).toMatch(/^v1\./);
    expect(kept.rows[0].mfa_secret_enc).not.toContain(secret);
    expect(kept.rows[0].mfa_enabled_at).toBeNull();
    expect((await call(t.app, "POST", "/auth/login", { body: { identifier: owner.mobile, password: owner.password } })).status).toBe(200);

    const wrong = await call(t.app, "POST", "/auth/two-step/enable", { token: owner.token, body: { code: wrongCode() } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: "TWO_STEP_CODE_WRONG", field: "code" });

    const on = await call(t.app, "POST", "/auth/two-step/enable", { token: owner.token, body: { code: code() } });
    expect(on.status).toBe(200);
    recovery = on.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    for (const c of recovery) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(new Set(recovery).size).toBe(10);
    // Only their hashes are kept.
    const stored = await t.owner.query("select mfa_recovery_codes::text as codes from users where id = $1", [owner.userId]);
    expect(stored.rows[0].codes).not.toContain(recovery[0]!.slice(0, 5));

    const status = await call(t.app, "GET", "/auth/two-step", { token: owner.token });
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect(Date.parse(status.body.enabledAt)).toBeGreaterThan(0);
    const again = await call(t.app, "POST", "/auth/two-step/setup", { token: owner.token, body: { password: owner.password } });
    expect(again.body.error.code).toBe("TWO_STEP_ALREADY_ON");
    const history = await t.owner.query("select action from audit_logs where user_id = $1 and action like 'auth.two_step%'", [owner.userId]);
    expect(history.rows.map((r) => r.action)).toEqual(["auth.two_step_on"]);
  });

  it("asks for the app's code after the password or the OTP; a code works once, and so does a recovery code", async () => {
    const first = await call(t.app, "POST", "/auth/login", { body: { identifier: owner.mobile, password: owner.password } });
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe("TWO_STEP_REQUIRED");
    expect(first.body.error.params.expiresIn).toBe(300);
    expect(first.body.accessToken).toBeUndefined();
    expect(first.cookies.find((c) => c.name === "db_rt")).toBeUndefined();
    const token = first.body.error.params.token as string;
    // The half-done sign-in's token opens nothing.
    expect((await call(t.app, "GET", "/me", { token })).status).toBe(401);

    const wrong = await call(t.app, "POST", "/auth/login/two-step", { body: { token, code: wrongCode() } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: "TWO_STEP_CODE_WRONG", field: "code" });

    const now = code();
    const ok = await call(t.app, "POST", "/auth/login/two-step", { body: { token, code: now } });
    expect(ok.status).toBe(200);
    expect(ok.body.business.legalName).toBe("Meera Traders");
    expect(ok.cookies.find((c) => c.name === "db_rt")).toBeTruthy();
    expect((await call(t.app, "GET", "/me", { token: ok.body.accessToken })).status).toBe(200);
    const login = await t.owner.query("select changes from audit_logs where user_id = $1 and action = 'auth.login' order by created_at desc limit 1", [owner.userId]);
    expect(login.rows[0].changes).toEqual({ method: "password+totp" });

    // The same code again (copied, or typed twice) is refused; the next one works.
    const replay = await signIn(owner.mobile, owner.password, now);
    expect(replay.status).toBe(400);
    expect((await signIn(owner.mobile, owner.password, code(1))).status).toBe(200);
    advance(60_000);

    // A recovery code, typed any old way, works once.
    const typed = ` ${recovery[0]!.toUpperCase().replace("-", " ")} `;
    expect((await signIn(owner.mobile, owner.password, typed)).status).toBe(200);
    expect((await signIn(owner.mobile, owner.password, recovery[0]!)).status).toBe(400);
    expect((await call(t.app, "GET", "/auth/two-step", { token: owner.token })).body.recoveryCodesLeft).toBe(9);

    // By OTP too.
    await call(t.app, "POST", "/auth/otp", { body: { mobile: owner.mobile, purpose: "login" } });
    const byOtp = await call(t.app, "POST", "/auth/login/otp", { body: { mobile: owner.mobile, otp: t.otp.last(owner.mobile) } });
    expect(byOtp.status).toBe(401);
    expect(byOtp.body.error.code).toBe("TWO_STEP_REQUIRED");
    const otpDone = await call(t.app, "POST", "/auth/login/two-step", { body: { token: byOtp.body.error.params.token, code: code() } });
    expect(otpDone.status).toBe(200);
    owner.token = otpDone.body.accessToken;
    const otpLogin = await t.owner.query("select changes from audit_logs where user_id = $1 and action = 'auth.login' order by created_at desc limit 1", [owner.userId]);
    expect(otpLogin.rows[0].changes).toEqual({ method: "otp+totp" });

    const forged = await call(t.app, "POST", "/auth/login/two-step", { body: { token: "x".repeat(40), code: code() } });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("TWO_STEP_EXPIRED");
    // An access token is not a two-step token either.
    const swapped = await call(t.app, "POST", "/auth/login/two-step", { body: { token: owner.token, code: code() } });
    expect(swapped.body.error.code).toBe("TWO_STEP_EXPIRED");
  });

  it("locks the account after five wrong codes, even with the right password", async () => {
    const asha = await signup(t, { name: "Asha", legalName: "Asha Stores" });
    const app = await turnOn(asha, asha.password);
    advance(30_000);
    for (let i = 0; i < 5; i++) expect((await signIn(asha.mobile, asha.password, wrongCode(app.secret))).status).toBe(400);
    const locked = await call(t.app, "POST", "/auth/login", { body: { identifier: asha.mobile, password: asha.password } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    advance(16 * 60_000);
    // The right password alone (checked to open the copy kept on a device) does not start the count again: one more wrong code locks it at once.
    expect((await call(t.app, "POST", "/auth/password/check", { token: asha.token, body: { password: asha.password } })).status).toBe(204);
    expect((await signIn(asha.mobile, asha.password, wrongCode(app.secret))).status).toBe(400);
    expect((await call(t.app, "POST", "/auth/login", { body: { identifier: asha.mobile, password: asha.password } })).status).toBe(429);
    advance(16 * 60_000);
    expect((await signIn(asha.mobile, asha.password, code(0, app.secret))).status).toBe(200);
    // A right code does.
    expect((await t.owner.query("select failed_login_count from users where id = $1", [asha.userId])).rows[0].failed_login_count).toBe(0);
  });

  it("lists the signed-in devices and signs one out at once", async () => {
    advance(30_000);
    const phone = await signIn(owner.mobile, owner.password, code(), { "user-agent": ANDROID_APP, "x-client": "native" });
    expect(phone.status).toBe(200);
    const phoneToken = phone.body.accessToken as string;
    const phoneRefresh = phone.body.refreshToken as string;
    expect(phoneRefresh).toBeTruthy();

    const list = await call(t.app, "GET", "/auth/sessions", { token: owner.token });
    expect(list.status).toBe(200);
    const sessions = list.body.data as Array<{ id: string; current: boolean; userAgent: string | null; ip: string | null; signedInAt: string; lastSeenAt: string }>;
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const onPhone = sessions.find((s) => s.userAgent === ANDROID_APP)!;
    expect(onPhone).toMatchObject({ current: false });
    expect(Date.parse(onPhone.signedInAt)).toBeGreaterThan(0);
    // Most recently used first: the phone that just signed in.
    expect(sessions[0]!.id).toBe(onPhone.id);

    // A refresh moves "last seen" on and records where it came from.
    advance(60_000);
    const refreshed = await call(t.app, "POST", "/auth/refresh", { body: { refreshToken: phoneRefresh }, headers: { "x-client": "native", "user-agent": `${ANDROID_APP} (new)` } });
    expect(refreshed.status).toBe(200);
    const after = (await call(t.app, "GET", "/auth/sessions", { token: owner.token })).body.data.find((s: { id: string }) => s.id === onPhone.id);
    expect(after.userAgent).toBe(`${ANDROID_APP} (new)`);
    expect(after.signedInAt).toBe(onPhone.signedInAt);
    expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(onPhone.lastSeenAt));

    expect((await call(t.app, "DELETE", `/auth/sessions/${onPhone.id}`, { token: owner.token })).status).toBe(204);
    // Its access token stops at once, and it cannot refresh.
    const gone = await call(t.app, "GET", "/me", { token: refreshed.body.accessToken });
    expect(gone.status).toBe(401);
    expect(gone.body.error.code).toBe("SESSION_REVOKED");
    expect((await call(t.app, "GET", "/me", { token: phoneToken })).status).toBe(401);
    const noRefresh = await call(t.app, "POST", "/auth/refresh", { body: { refreshToken: refreshed.body.refreshToken }, headers: { "x-client": "native" } });
    expect(noRefresh.status).toBe(401);
    expect((await call(t.app, "GET", "/auth/sessions", { token: owner.token })).body.data.some((s: { id: string }) => s.id === onPhone.id)).toBe(false);
    // Someone else's session (or one already ended) is not found.
    expect((await call(t.app, "DELETE", `/auth/sessions/${onPhone.id}`, { token: owner.token })).status).toBe(404);

    const others = await call(t.app, "POST", "/auth/sessions/end-others", { token: owner.token });
    expect(others.status).toBe(200);
    expect(others.body.ended).toBeGreaterThan(0);
    const left = (await call(t.app, "GET", "/auth/sessions", { token: owner.token })).body.data;
    expect(left).toHaveLength(1);
    expect(left[0].current).toBe(true);
    expect((await call(t.app, "GET", "/me", { token: owner.token })).status).toBe(200);
  });

  it("makes new recovery codes with a code, and turns off with the password and a code", async () => {
    advance(30_000);
    const wrong = await call(t.app, "POST", "/auth/two-step/recovery-codes", { token: owner.token, body: { code: wrongCode() } });
    expect(wrong.status).toBe(400);
    const fresh = await call(t.app, "POST", "/auth/two-step/recovery-codes", { token: owner.token, body: { code: code() } });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    // The old ones stop working.
    advance(30_000);
    expect((await signIn(owner.mobile, owner.password, recovery[1]!)).status).toBe(400);
    recovery = fresh.body.recoveryCodes;

    const noPassword = await call(t.app, "POST", "/auth/two-step/disable", { token: owner.token, body: { password: "wrong-password", code: code() } });
    expect(noPassword.body.error).toMatchObject({ code: "INVALID_CREDENTIALS", field: "password" });
    const noCode = await call(t.app, "POST", "/auth/two-step/disable", { token: owner.token, body: { password: owner.password, code: wrongCode() } });
    expect(noCode.body.error).toMatchObject({ code: "TWO_STEP_CODE_WRONG", field: "code" });
    const off = await call(t.app, "POST", "/auth/two-step/disable", { token: owner.token, body: { password: owner.password, code: recovery[0] } });
    expect(off.status).toBe(204);
    expect((await call(t.app, "GET", "/auth/two-step", { token: owner.token })).body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    const plain = await call(t.app, "POST", "/auth/login", { body: { identifier: owner.mobile, password: owner.password } });
    expect(plain.status).toBe(200);
    owner.token = plain.body.accessToken;
    const row = await t.owner.query("select mfa_secret_enc, mfa_recovery_codes, failed_login_count from users where id = $1", [owner.userId]);
    expect(row.rows[0]).toEqual({ mfa_secret_enc: null, mfa_recovery_codes: null, failed_login_count: 0 });
  });

  it("lets the owner ask a role for it: the business stays closed to them until they turn it on", async () => {
    const roles = Object.fromEntries((await call(t.app, "GET", "/roles", { token: owner.token })).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    // Asking it of their own role before they use it themselves would shut them out.
    const first = await call(t.app, "PUT", "/settings/security.two_step_roles", { token: owner.token, body: { value: ["admin", "manager"] } });
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe("TWO_STEP_OWNER_FIRST");
    expect((await call(t.app, "PUT", "/settings/security.two_step_roles", { token: owner.token, body: { value: ["no_such_role"] } })).body.error.code).toBe("INVALID_SETTING_VALUE");

    const mobile = nextMobile();
    const password = "Manager-pass-1";
    const invite = await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Vikram", mobile, roleId: roles.manager, password } });
    expect(invite.status).toBe(201);
    expect(invite.body.twoStep).toBe(false);
    const manager = await call(t.app, "POST", "/auth/login", { body: { identifier: mobile, password } });
    expect(manager.status).toBe(200);
    const managerToken = manager.body.accessToken as string;
    expect((await call(t.app, "GET", "/customers", { token: managerToken })).status).toBe(200);
    // Only the owner decides.
    const byManager = await call(t.app, "PUT", "/settings/security.two_step_roles", { token: managerToken, body: { value: [] } });
    expect(byManager.status).toBe(403);

    expect((await call(t.app, "PUT", "/settings/security.two_step_roles", { token: owner.token, body: { value: ["manager"] } })).status).toBe(200);
    expect((await call(t.app, "GET", "/settings", { token: owner.token })).body["security.two_step_roles"]).toEqual(["manager"]);
    const closed = await call(t.app, "GET", "/customers", { token: managerToken });
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe("TWO_STEP_SETUP_REQUIRED");
    const me = await call(t.app, "GET", "/me", { token: managerToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ twoStepRequired: true, permissions: [], settings: {} });
    expect(me.body.business.legalName).toBe("Meera Traders");
    // The owner is not asked (their role is not on the list).
    expect((await call(t.app, "GET", "/customers", { token: owner.token })).status).toBe(200);

    const app = await turnOn({ token: managerToken }, password);
    expect((await call(t.app, "GET", "/customers", { token: managerToken })).status).toBe(200);
    const open = await call(t.app, "GET", "/me", { token: managerToken });
    expect(open.body.twoStepRequired).toBeUndefined();
    expect(open.body.permissions).toContain("invoice.create");
    const members = (await call(t.app, "GET", "/members", { token: owner.token })).body.data;
    expect(members.find((m: { userId: string }) => m.userId === invite.body.userId).twoStep).toBe(true);

    // Their phone and recovery codes lost: the owner turns it off for them, and the business asks again.
    const reset = await call(t.app, "PUT", `/members/${invite.body.id}/credentials`, { token: owner.token, body: { twoStepOff: true } });
    expect(reset.status).toBe(200);
    expect(reset.body.twoStep).toBe(false);
    expect((await call(t.app, "GET", "/customers", { token: managerToken })).body.error.code).toBe("TWO_STEP_SETUP_REQUIRED");
    const audit = await t.owner.query("select changes from audit_logs where action = 'member.credentials_set' and entity_id = $1", [invite.body.id]);
    expect(audit.rows.at(-1).changes).toEqual({ twoStep: "off" });
    expect(app.secret).toBeTruthy();
  });
});
