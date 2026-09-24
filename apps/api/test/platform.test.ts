import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("platform", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it("reports health and echoes a request id", async () => {
    const res = await call(t.app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(String(res.headers["x-request-id"]).length).toBeGreaterThan(8);
  });

  it("uses the standard error format for unknown routes", async () => {
    const res = await call(t.app, "GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("connects as a role that cannot bypass row-level security", async () => {
    const r = await t.owner.query("select rolsuper, rolbypassrls from pg_roles where rolname = 'vyapaar_app_test'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
