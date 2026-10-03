import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("units on a bill's lines (invoice.unit_letters, invoice.default_unit)", () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let units: Record<string, string>;
  let otherUnits: Record<string, string>;
  const put = (key: string, value: unknown, token = owner.token) => call(t.app, "PUT", `/settings/${key}`, { token, body: { value } });
  const unitsOf = async (s: Session) => Object.fromEntries((await call(t.app, "GET", "/units", { token: s.token })).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    units = await unitsOf(owner);
    otherUnits = await unitsOf(other);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("are not set at first (the app then uses each symbol's first letter, and starts lines in strips)", async () => {
    const settings = (await call(t.app, "GET", "/settings", { token: owner.token })).body;
    expect(settings["invoice.unit_letters"]).toBeNull();
    expect(settings["invoice.default_unit"]).toBeNull();
    const me = (await call(t.app, "GET", "/me", { token: owner.token })).body.settings;
    expect(me["invoice.unit_letters"]).toBeUndefined();
    expect(me["invoice.default_unit"]).toBeUndefined();
  });

  it("take a letter for any of this business's units, and reach every device with /me", async () => {
    const saved = await put("invoice.unit_letters", { [units.CTN!]: "k", [units.BAG!]: "G" });
    expect(saved.status).toBe(200);
    // Letters are kept in capitals.
    const stored = { [units.CTN!]: "K", [units.BAG!]: "G" };
    expect(saved.body.value).toEqual(stored);
    expect((await call(t.app, "GET", "/me", { token: owner.token })).body.settings["invoice.unit_letters"]).toEqual(stored);
    // Two units may share a letter (on a product sold in both, the letter picks one, then the other); Hindi letters are letters too.
    expect((await put("invoice.unit_letters", { [units.BOX!]: "B", [units.BTL!]: "B", [units.DOZ!]: "द" })).status).toBe(200);
  });

  it("refuse what is not one letter, and another business's unit", async () => {
    for (const value of [{ [units.BOX!]: "BX" }, { [units.BOX!]: "1" }, { [units.BOX!]: "" }, { "not-a-unit": "B" }, { [otherUnits.BOX!]: "B" }, ["B"]]) {
      const res = await put("invoice.unit_letters", value);
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error.code).toBe("INVALID_SETTING_VALUE");
    }
  });

  it("start new lines in a unit of this business, or in each product's own", async () => {
    expect((await put("invoice.default_unit", units.BOX)).status).toBe(200);
    expect((await call(t.app, "GET", "/me", { token: owner.token })).body.settings["invoice.default_unit"]).toBe(units.BOX);
    expect((await put("invoice.default_unit", "own")).status).toBe(200);
    for (const value of [otherUnits.STRIP, "STRIP", 3]) {
      const res = await put("invoice.default_unit", value);
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error.code).toBe("INVALID_SETTING_VALUE");
    }
  });

  it("go back to the app's own when set to null", async () => {
    expect((await put("invoice.unit_letters", null)).status).toBe(200);
    expect((await put("invoice.default_unit", null)).status).toBe(200);
    const me = (await call(t.app, "GET", "/me", { token: owner.token })).body.settings;
    expect(me["invoice.unit_letters"]).toBeUndefined();
    expect(me["invoice.default_unit"]).toBeUndefined();
  });
});
