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
    // How the Android app tells a Digital Bahi server from another site.
    expect(res.body.app).toBe("digitalbahi");
    expect(String(res.headers["x-request-id"]).length).toBeGreaterThan(8);
  });

  it("lets the Android app's pages (https://localhost) call the API, and no other site", async () => {
    const preflight = (origin: string) =>
      t.app.inject({
        method: "OPTIONS",
        url: "/api/v1/auth/login",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-client,authorization" },
      });
    const app = await preflight("https://localhost");
    expect(app.statusCode).toBe(204);
    expect(app.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(String(app.headers["access-control-allow-headers"])).toContain("x-client");
    const other = await preflight("https://elsewhere.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    // Every method the API takes (a device's report is a PUT, removing a push token a DELETE).
    const methods = String(app.headers["access-control-allow-methods"]);
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) expect(methods).toContain(m);
  });

  it("uses the standard error format for unknown routes", async () => {
    const res = await call(t.app, "GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("connects as a role that cannot bypass row-level security", async () => {
    const r = await t.owner.query("select rolsuper, rolbypassrls from pg_roles where rolname = 'digitalbahi_app_test'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
