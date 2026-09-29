import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextBackupAt, runDueBackups } from "../src/services/backup-schedule.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;

describe("next automatic backup time", () => {
  it("is the next such hour in the firm's time zone", () => {
    // 10:00 IST on Tue 29 Sep 2026.
    const now = new Date("2026-09-29T04:30:00Z");
    expect(nextBackupAt(now, { frequency: "daily", hour: 21, weekday: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-09-29T15:30:00.000Z");
    expect(nextBackupAt(now, { frequency: "daily", hour: 2, weekday: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-09-29T20:30:00.000Z");
    // The same hour already passed today: tomorrow.
    expect(nextBackupAt(now, { frequency: "daily", hour: 10, weekday: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-09-30T04:30:00.000Z");
    // Weekly on Sunday 9 pm, and on today's weekday after its hour: a week later.
    expect(nextBackupAt(now, { frequency: "weekly", hour: 21, weekday: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-10-04T15:30:00.000Z");
    expect(nextBackupAt(now, { frequency: "weekly", hour: 9, weekday: 2 }, "Asia/Kolkata").toISOString()).toBe("2026-10-06T03:30:00.000Z");
    // Near midnight UTC the firm's day is already the next one.
    expect(nextBackupAt(new Date("2026-09-29T20:00:00Z"), { frequency: "daily", hour: 21, weekday: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-09-30T15:30:00.000Z");
    // A zone with summer time keeps the wall-clock hour across the change.
    expect(nextBackupAt(new Date("2026-10-24T12:00:00Z"), { frequency: "daily", hour: 21, weekday: 0 }, "Europe/London").toISOString()).toBe("2026-10-24T20:00:00.000Z");
    expect(nextBackupAt(new Date("2026-10-24T21:00:00Z"), { frequency: "daily", hour: 21, weekday: 0 }, "Europe/London").toISOString()).toBe("2026-10-25T21:00:00.000Z");
  });
});

describe.skipIf(!hasDatabase)("automatic backups", () => {
  let t: TestApp;
  let owner: Session;
  const put = (body: unknown, token = owner.token) => call(t.app, "PUT", "/backups/schedule", { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const login = async (identifier: string, password: string) => (await call(t.app, "POST", "/auth/login", { body: { identifier, password } })).body.accessToken as string;
  const schedule = async (businessId = owner.businessId) => (await t.owner.query("select * from backup_schedules where business_id = $1", [businessId])).rows[0];
  const autoMails = () => t.messenger.sent.filter((m) => m.channel === "email" && m.subject?.includes("automatic backup"));
  /** Moves the clock past the schedule's next time. */
  const reach = async (businessId = owner.businessId) => {
    const s = await schedule(businessId);
    t.advance(Math.max(0, Date.parse(s.next_run_at) - Date.now()) + 60_000);
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is off until the owner turns it on, with a password", async () => {
    const first = await get("/backups/schedule");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ frequency: "off", hasPassword: false, nextRunAt: null, emailReady: true, defaultTo: null });

    // No email for the firm and none typed.
    const noAddress = await put({ frequency: "daily", hour: 21, passphrase: "kirana-2026!" });
    expect(noAddress.status).toBe(400);
    expect(noAddress.body.error.code).toBe("MESSAGE_NO_RECIPIENT");
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { email: "accounts@laxmitraders.in" } });
    const noPassword = await put({ frequency: "daily", hour: 21 });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error).toMatchObject({ code: "BACKUP_SCHEDULE_NO_PASSWORD", field: "passphrase" });
    expect((await put({ frequency: "daily", hour: 21, passphrase: "short" })).status).toBe(400);

    const on = await put({ frequency: "daily", hour: 21, passphrase: "kirana-2026!" });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ frequency: "daily", hour: 21, to: null, defaultTo: "accounts@laxmitraders.in", hasPassword: true, setUpBy: "Owner" });
    expect(on.body.passphrase).toBeUndefined();
    const next = new Date(on.body.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * HOUR);
    expect(next.getUTCHours() * 60 + next.getUTCMinutes()).toBe(15 * 60 + 30); // 9 pm in India

    // The password is kept encrypted; changing the time keeps it.
    const row = await schedule();
    expect(row.passphrase).not.toContain("kirana");
    const moved = await put({ frequency: "weekly", weekday: 0, hour: 21 });
    expect(moved.body).toMatchObject({ frequency: "weekly", hasPassword: true });
    expect(new Date(moved.body.nextRunAt).getUTCDay()).toBe(0);
    expect((await schedule()).passphrase).toBe(row.passphrase);
    await put({ frequency: "daily", hour: 21 });

    const audit = (await get("/audit-logs?action=backup.schedule_changed")).body.data;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("kirana");
  });

  it("is only for people who may download backups", async () => {
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Manager Mohan", mobile, roleId: roles.manager, password: "Mohan-pass-1" } });
    const manager = await login(mobile, "Mohan-pass-1");
    expect((await get("/backups/schedule", manager)).status).toBe(403);
    expect((await put({ frequency: "off", hour: 21 }, manager)).status).toBe(403);
    // Setting a schedule sends the whole book by email: configure alone is not enough.
    const role = await call(t.app, "POST", "/roles", { token: owner.token, body: { key: "backup_setup", name: "Backup setup", grants: ["backup.configure"] } });
    const other = nextMobile();
    await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Setup Suresh", mobile: other, roleId: role.body.id, password: "Suresh-pass-1" } });
    const setup = await login(other, "Suresh-pass-1");
    expect((await get("/backups/schedule", setup)).status).toBe(200);
    expect((await put({ frequency: "off", hour: 21 }, setup)).status).toBe(403);
  });

  it("emails an encrypted copy when it is due, once", async () => {
    expect((await runDueBackups(t.app.deps)).sent).toBe(0);
    expect(autoMails()).toHaveLength(0);

    await reach();
    expect(await runDueBackups(t.app.deps)).toEqual({ sent: 1, failed: 0 });
    const mails = autoMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ channel: "email", to: "accounts@laxmitraders.in" });
    expect(mails[0]!.attachment!.filename).toMatch(/^digital-bahi-laxmi-traders-.*\.dbbackup$/);
    expect(mails[0]!.attachment!.content[5]).toBe(1); // password-protected
    const s = await schedule();
    expect(s.last_status).toBe("sent");
    expect(Date.parse(s.next_run_at)).toBeGreaterThan(Date.now());
    const history = (await t.owner.query("select kind, status, encrypted, requested_by from backups where business_id = $1 order by created_at desc", [owner.businessId])).rows;
    expect(history[0]).toMatchObject({ kind: "auto", status: "completed", encrypted: true, requested_by: owner.userId });

    // Not again until the next time.
    expect(await runDueBackups(t.app.deps)).toEqual({ sent: 0, failed: 0 });
    expect(autoMails()).toHaveLength(1);
  });

  it("keeps the failure for the Backup screen and tries again next time", async () => {
    await reach();
    t.messenger.failNext("mailbox full");
    expect(await runDueBackups(t.app.deps)).toEqual({ sent: 0, failed: 1 });
    const s = await schedule();
    expect(s.last_status).toBe("failed");
    expect(JSON.parse(s.last_error)).toEqual({ code: "MESSAGE_SEND_FAILED", params: { reason: "mailbox full" } });
    expect(s.frequency).toBe("daily");
    expect(Date.parse(s.next_run_at)).toBeGreaterThan(Date.now());

    const token = await login(owner.mobile, owner.password);
    const view = (await get("/backups/schedule", token)).body;
    expect(view).toMatchObject({ lastStatus: "failed", lastError: { code: "MESSAGE_SEND_FAILED", params: { reason: "mailbox full" } } });
    expect((await get("/backups", token)).body.data[0]).toMatchObject({ kind: "auto", status: "failed" });

    await reach();
    expect(await runDueBackups(t.app.deps)).toEqual({ sent: 1, failed: 0 });
    expect((await schedule()).last_status).toBe("sent");
  });

  it("stops when the person who set it up loses access", async () => {
    let token = await login(owner.mobile, owner.password);
    const role = await call(t.app, "POST", "/roles", { token, body: { key: "backup_keeper", name: "Backup keeper", grants: ["backup.*"] } });
    const mobile = nextMobile();
    const member = await call(t.app, "POST", "/members", { token, body: { name: "Accountant Asha", mobile, roleId: role.body.id, password: "Asha-pass-12" } });
    const asha = await login(mobile, "Asha-pass-12");
    const set = await put({ frequency: "daily", hour: 21, to: "asha@example.com" }, asha);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ to: "asha@example.com", setUpBy: "Accountant Asha", hasPassword: true });

    expect((await call(t.app, "PATCH", `/members/${member.body.id}`, { token, body: { isActive: false } })).status).toBe(200);
    await reach();
    const before = autoMails().length;
    expect(await runDueBackups(t.app.deps)).toEqual({ sent: 0, failed: 1 });
    expect(autoMails()).toHaveLength(before);
    const s = await schedule();
    expect(s).toMatchObject({ frequency: "off", next_run_at: null, last_status: "failed" });
    expect(JSON.parse(s.last_error).code).toBe("BACKUP_SCHEDULE_NO_ACCESS");

    token = await login(owner.mobile, owner.password);
    const audit = (await get("/audit-logs?action=backup.schedule_stopped", token)).body.data;
    expect(audit).toHaveLength(1);
  });
});
