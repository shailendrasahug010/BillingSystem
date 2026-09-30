import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("saved report views", () => {
  let t: TestApp;
  let owner: Session;
  const tokens: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => call(t.app, "GET", url, { token }),
    post: (url: string, body: unknown) => call(t.app, "POST", url, { token, body }),
    patch: (url: string, body: unknown) => call(t.app, "PATCH", url, { token, body }),
    del: (url: string) => call(t.app, "DELETE", url, { token }),
  });
  const member = async (roleId: string, name: string) => {
    const mobile = nextMobile();
    await as(owner.token).post("/members", { name, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { name: "Asha Owner", legalName: "View Traders", stateCode: "23" });
    const roles = Object.fromEntries((await as(owner.token).get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    // Sales and collection reports, but not profit.
    const analyst = (await as(owner.token).post("/roles", { key: "sales_analyst", name: "Sales analyst", grants: ["report.view_sales", "report.view_collection"] })).body.id;
    tokens.analyst = await member(analyst, "Ravi Analyst");
    tokens.hr = await member(roles.hr, "HR person");
  });
  afterAll(async () => {
    await t?.close();
  });

  it("saves a report's tab and settings under a name, keeping a preset period as the preset", async () => {
    const o = as(owner.token);
    const brand = await o.post("/report-views", { name: "Sales by brand", report: "sales", settings: { period: "thisMonth", from: "2026-09-01", to: "2026-09-30", groupBy: "brand" }, shared: true });
    expect(brand.status).toBe(201);
    expect(brand.body).toMatchObject({ name: "Sales by brand", report: "sales", settings: { period: "thisMonth", groupBy: "brand" }, shared: true, mine: true });
    expect(brand.body.settings.from).toBeUndefined();
    const custom = await o.post("/report-views", { name: "Diwali margin", report: "profit", settings: { period: "custom", from: "2026-10-15", to: "2026-11-05", groupBy: "customer" } });
    expect(custom.status).toBe(201);
    expect(custom.body.settings).toEqual({ period: "custom", from: "2026-10-15", to: "2026-11-05", groupBy: "customer" });
    expect(custom.body.shared).toBe(false);
    expect((await o.post("/report-views", { name: "Dues by bill date", report: "outstanding", settings: { party: "customer", basis: "invoice_date" }, shared: true })).status).toBe(201);
    expect((await o.post("/report-views", { name: "Team margin", report: "profit", settings: { period: "lastMonth", groupBy: "salesperson" }, shared: true })).status).toBe(201);

    const mine = (await o.get("/report-views")).body.data;
    expect(mine.map((v: { name: string }) => v.name)).toEqual(["Diwali margin", "Dues by bill date", "Sales by brand", "Team margin"]);
  });

  it("refuses settings the report does not have, a custom period without dates, and a name used twice", async () => {
    const o = as(owner.token);
    const wrongGroup = await o.post("/report-views", { name: "X", report: "sales", settings: { groupBy: "supplier" } });
    expect(wrongGroup.status).toBe(400);
    expect(wrongGroup.body.error).toMatchObject({ code: "REPORT_VIEW_SETTINGS_INVALID", field: "settings.groupBy" });
    expect((await o.post("/report-views", { name: "X", report: "sales", settings: { party: "supplier" } })).body.error.code).toBe("REPORT_VIEW_SETTINGS_INVALID");
    expect((await o.post("/report-views", { name: "X", report: "outstanding", settings: { period: "thisMonth" } })).body.error.code).toBe("REPORT_VIEW_SETTINGS_INVALID");
    expect((await o.post("/report-views", { name: "X", report: "sales", settings: { period: "custom", from: "2026-09-01" } })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await o.post("/report-views", { name: "X", report: "stock", settings: {} })).body.error.code).toBe("VALIDATION_FAILED");
    const twice = await o.post("/report-views", { name: "sales BY brand", report: "collections", settings: { period: "last7" } });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: "DUPLICATE_NAME", field: "name" });
  });

  it("shows the team's shared views for the reports each role opens; only the one who saved a view changes it", async () => {
    const a = as(tokens.analyst!);
    const seen = (await a.get("/report-views")).body.data;
    // Shared sales view yes; the private profit view and the shared profit / outstanding views no.
    expect(seen).toEqual([expect.objectContaining({ name: "Sales by brand", mine: false, ownerName: "Asha Owner", shared: true })]);
    const shared = seen[0];
    expect((await a.patch(`/report-views/${shared.id}`, { name: "Mine now" })).status).toBe(403);
    expect((await a.del(`/report-views/${shared.id}`)).status).toBe(403);
    const privateOne = (await as(owner.token).get("/report-views")).body.data.find((v: { name: string }) => v.name === "Diwali margin");
    expect((await a.patch(`/report-views/${privateOne.id}`, { name: "Peek" })).status).toBe(404);

    // A copy of their own, under the same name; not for a report their role does not open.
    const copy = await a.post("/report-views", { name: "Sales by brand", report: "sales", settings: shared.settings });
    expect(copy.status).toBe(201);
    expect((await a.post("/report-views", { name: "Margin", report: "profit", settings: {} })).status).toBe(403);
    expect((await a.get("/report-views")).body.data.map((v: { name: string; mine: boolean }) => [v.name, v.mine])).toEqual([
      ["Sales by brand", true],
      ["Sales by brand", false],
    ]);
    // Someone with no report at all has no views.
    expect((await as(tokens.hr!).get("/report-views")).status).toBe(403);
  });

  it("renames, re-sets, stops sharing and deletes a view, each in the audit log", async () => {
    const o = as(owner.token);
    const view = (await o.get("/report-views")).body.data.find((v: { name: string }) => v.name === "Sales by brand");
    const changed = await o.patch(`/report-views/${view.id}`, { name: "Sales by company", settings: { period: "lastMonth", groupBy: "brand" }, shared: false });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ name: "Sales by company", settings: { period: "lastMonth", groupBy: "brand" }, shared: false });
    expect((await o.patch(`/report-views/${view.id}`, { settings: { groupBy: "method" } })).body.error.code).toBe("REPORT_VIEW_SETTINGS_INVALID");
    expect((await o.patch(`/report-views/${view.id}`, {})).body.error.code).toBe("VALIDATION_FAILED");
    // No longer shared: the analyst sees only their own copy.
    expect((await as(tokens.analyst!).get("/report-views")).body.data.map((v: { mine: boolean }) => v.mine)).toEqual([true]);
    expect((await o.del(`/report-views/${view.id}`)).status).toBe(204);
    expect((await o.get("/report-views")).body.data.map((v: { name: string }) => v.name)).not.toContain("Sales by company");

    const log = (await o.get("/audit-logs?entityType=report_view")).body.data.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(["report_view.saved", "report_view.updated", "report_view.deleted"]));
  });

  it("keeps each person to 50 views", async () => {
    const a = as(tokens.analyst!);
    const have = (await a.get("/report-views")).body.data.filter((v: { mine: boolean }) => v.mine).length;
    for (let i = have; i < 50; i++) expect((await a.post("/report-views", { name: `View ${i}`, report: "collections", settings: { period: "last7" } })).status).toBe(201);
    const over = await a.post("/report-views", { name: "One more", report: "collections", settings: {} });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: "REPORT_VIEW_LIMIT", params: { max: 50 } });
  });
});
