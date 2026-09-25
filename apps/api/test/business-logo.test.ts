import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

// A real 1x1 PNG and a JPEG header; the server checks the bytes, not just the declared type.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString("base64");

describe.skipIf(!hasDatabase)("the firm's logo", () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let salesToken: string;
  const put = (image: string, token = owner.token) => call(t.app, "PUT", "/business/logo", { token, body: { image } });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Sales Sam", mobile, roleId: roles.sales } });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is uploaded by the owner, shown to everyone in the business, and replaced cleanly", async () => {
    expect((await get("/business/logo")).status).toBe(404);
    const first = await put(`data:image/png;base64,${PNG}`);
    expect(first.status).toBe(200);
    expect((await get("/me")).body.business.logoFileId).toBe(first.body.logoFileId);
    const read = await get("/business/logo", salesToken);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ id: first.body.logoFileId, mimeType: "image/png", dataUrl: `data:image/png;base64,${PNG}` });

    const second = await put(`data:image/jpeg;base64,${JPEG}`);
    expect(second.body.logoFileId).not.toBe(first.body.logoFileId);
    expect((await get("/business/logo")).body.mimeType).toBe("image/jpeg");
    // The old file is retired and its bytes dropped; the row stays for the audit trail.
    const old = (await t.owner.query("select deleted_at, content from files where id = $1", [first.body.logoFileId])).rows[0];
    expect(old.deleted_at).not.toBeNull();
    expect(old.content).toBeNull();
    const actions = (await get("/audit-logs?entityType=business")).body.data.map((a: { action: string }) => a.action);
    expect(actions.filter((a: string) => a === "business.logo_updated")).toHaveLength(2);
  });

  it("checks the file and who may change it; other businesses never see it", async () => {
    expect((await put(`data:image/png;base64,${JPEG}`)).body.error.code).toBe("INVALID_IMAGE");
    expect((await put("data:image/gif;base64,R0lGODlh")).status).toBe(400);
    const big = Buffer.alloc(310 * 1024);
    Buffer.from(PNG, "base64").copy(big);
    expect((await put(`data:image/png;base64,${big.toString("base64")}`)).body.error.code).toBe("IMAGE_TOO_LARGE");
    expect((await put(`data:image/png;base64,${PNG}`, salesToken)).status).toBe(403);
    expect((await get("/business/logo", other.token)).status).toBe(404);
  });

  it("can be removed", async () => {
    expect((await call(t.app, "DELETE", "/business/logo", { token: salesToken })).status).toBe(403);
    expect((await call(t.app, "DELETE", "/business/logo", { token: owner.token })).status).toBe(204);
    expect((await get("/business/logo")).status).toBe(404);
    expect((await get("/me")).body.business.logoFileId).toBeNull();
  });
});
