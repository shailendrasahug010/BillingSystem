import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pumpMessages } from "../src/services/messaging/queue.js";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/** The daily summary: the day's figures sent to the owner's phone in the evening. */
describe.skipIf(!hasDatabase)("daily summary", () => {
  let t: TestApp;
  let owner: Session;
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const patch = (url: string, body: unknown) => call(t.app, "PATCH", url, { token: owner.token, body });
  const put = (url: string, body: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const sent = async () => {
    await pumpMessages(t.app.deps, { businessId: owner.businessId, userId: "" });
    return t.messenger.sent;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const cats = Object.fromEntries((await get("/expense-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    const shop = (await post("/customers", { name: "Sharma Kirana", stateCode: "23", creditDays: 7 })).body.id;
    // An old bill, overdue; today's two bills, part paid.
    await post("/invoices", { customerId: shop, invoiceDate: "2026-09-01", lines: [{ productId: soap, qty: "5" }] });
    await post("/invoices", { customerId: shop, lines: [{ productId: soap, qty: "10" }] });
    await post("/invoices", { customerId: shop, lines: [{ productId: soap, qty: "2" }] });
    await post("/payments", { direction: "in", customerId: shop, amount: "500", method: "upi" });
    await post("/expenses", { categoryId: cats.Rent, amount: "2000", paymentMethod: "cash" });
    await put("/messaging/settings", { whatsappProvider: "meta", whatsappPhoneNumberId: "109876543210", whatsappSecret: "EAAG-very-secret-token", whatsappAppSecret: "meta-app-secret-123", whatsappTemplateLanguage: "en" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is off until turned on, in the evening, for those who see sales", async () => {
    const rule = (await get("/reminder-rules")).body.data.find((r: { type: string }) => r.type === "daily_summary");
    expect(rule).toMatchObject({ isActive: false, permission: "report.view_sales", config: { hour: 20, channel: "whatsapp_or_sms", recipients: [] } });
  });

  it("sends the day's figures to the numbers set, once a day", async () => {
    const saved = await patch("/reminder-rules/daily_summary", { isActive: true, config: { recipients: ["+91 98260 11111", "9826022222"] } });
    expect(saved.body.config.recipients).toEqual(["9826011111", "9826022222"]);
    const check = await post("/reminder-rules/daily_summary/check", {});
    expect(check.body.result).toBe("raised");
    const out = await sent();
    expect(out.map((m) => [m.channel, m.to])).toEqual([
      ["whatsapp", "919826011111"],
      ["whatsapp", "919826022222"],
    ]);
    // 12 soaps at 118 = 1,416 today in two bills; 500 collected, which paid most of the old bill (590): 90 of it overdue, 1,506 owed in all; 2,000 rent.
    expect(out[0]!.text).toBe("Laxmi Traders, 24/09/2026: sales ₹1,416 (2 bills), collected ₹500, paid out ₹0, expenses ₹2,000. Customers owe ₹1,506, of which ₹90 is overdue. — Digital Bahi");
    expect(TEST_TODAY).toBe("2026-09-24");
    // Send now again the same day: nothing more.
    await post("/reminder-rules/daily_summary/check", {});
    expect(await sent()).toHaveLength(2);
    const notes = (await get("/notifications")).body.data.filter((n: { type: string }) => n.type === "daily_summary");
    expect(notes).toHaveLength(1);
  });

  it("refuses a number that is not a mobile", async () => {
    expect((await patch("/reminder-rules/daily_summary", { config: { recipients: ["12345"] } })).status).toBe(400);
  });
});
