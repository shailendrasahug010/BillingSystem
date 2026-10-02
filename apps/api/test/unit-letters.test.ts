import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("the unit buttons on a bill (invoice.quick_units)", () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let units: Record<string, string>;
  const put = (value: unknown, token = owner.token) => call(t.app, "PUT", "/settings/invoice.quick_units", { token, body: { value } });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    units = Object.fromEntries((await call(t.app, "GET", "/units", { token: owner.token })).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is not set at first (the app then shows BOX, CTN and STRIP as B, C and S)", async () => {
    expect((await call(t.app, "GET", "/settings", { token: owner.token })).body["invoice.quick_units"]).toBeNull();
    expect((await call(t.app, "GET", "/me", { token: owner.token })).body.settings["invoice.quick_units"]).toBeUndefined();
  });

  it("takes three buttons of this business's units, a letter each, and reaches every device with /me", async () => {
    const value = [{ unitId: units.BOX, alias: "b" }, { unitId: units.DOZ, alias: "D" }, null];
    const saved = await put(value);
    expect(saved.status).toBe(200);
    // Letters are kept in capitals.
    const stored = [{ unitId: units.BOX, alias: "B" }, { unitId: units.DOZ, alias: "D" }, null];
    expect(saved.body.value).toEqual(stored);
    expect((await call(t.app, "GET", "/me", { token: owner.token })).body.settings["invoice.quick_units"]).toEqual(stored);
  });

  it("refuses a unit twice, a letter twice, a letter that is not one letter, other than three buttons, and another business's unit", async () => {
    const otherUnits = Object.fromEntries((await call(t.app, "GET", "/units", { token: other.token })).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const refused = [
      [{ unitId: units.BOX, alias: "B" }, { unitId: units.BOX, alias: "C" }, null],
      [{ unitId: units.BOX, alias: "B" }, { unitId: units.CTN, alias: "b" }, null],
      [{ unitId: units.BOX, alias: "BX" }, null, null],
      [{ unitId: units.BOX, alias: "1" }, null, null],
      [{ unitId: units.BOX, alias: "B" }, null],
      [{ unitId: otherUnits.BOX, alias: "B" }, null, null],
    ];
    for (const value of refused) {
      const res = await put(value);
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error.code).toBe("INVALID_SETTING_VALUE");
    }
    // Hindi letters are letters too.
    expect((await put([{ unitId: units.BOX, alias: "ब" }, null, null])).status).toBe(200);
  });

  it("goes back to the app's own when set to null", async () => {
    expect((await put(null)).status).toBe(200);
    expect((await call(t.app, "GET", "/settings", { token: owner.token })).body["invoice.quick_units"]).toBeNull();
    expect((await call(t.app, "GET", "/me", { token: owner.token })).body.settings["invoice.quick_units"]).toBeUndefined();
  });
});
