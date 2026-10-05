import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/lib/db.js";
import { runRepeatBillsFor } from "../src/services/repeat-bills.js";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

/** Repeat bills: a bill made again every week or month, by the job, on its day. */
describe.skipIf(!hasDatabase)("repeat bills", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const patch = (url: string, body: unknown) => call(t.app, "PATCH", url, { token: owner.token, body });
  const run = () => withTenant(t.app.deps.db, { businessId: owner.businessId, userId: "" }, (tx) => runRepeatBillsFor(tx, t.app.deps, owner.businessId, "Asia/Kolkata"));
  const bills = async () => (await get(`/invoices?customerId=${ids.shop}`)).body.data as Array<{ id: string; invoiceNumber: string; invoiceDate: string; grandTotal: string }>;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Repeat Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "70" })).body.id;
    ids.shop = (await post("/customers", { name: "Hotel Shree", stateCode: "23" })).body.id;
    const bill = await post("/invoices", {
      customerId: ids.shop,
      invoiceDate: "2026-08-30",
      lines: [{ productId: ids.soap, qty: "10", rate: "95", discountPercent: "2" }],
      documentDiscount: { percent: "1" },
      charges: [{ label: "Delivery", amount: "50", gstRate: "18" }],
      notes: "Monthly supply",
    });
    expect(bill.status).toBe(201);
    ids.bill = bill.body.id;
    ids.total = bill.body.grandTotal;
  });
  afterAll(async () => {
    await t?.close();
    t?.setToday(null);
  });

  it("is set up from a bill, starting today or later", async () => {
    expect((await post("/repeat-bills", { invoiceId: ids.bill, frequency: "monthly", startDate: "2026-09-01" })).body.error.code).toBe("REPEAT_START_IN_PAST");
    expect((await post("/repeat-bills", { invoiceId: ids.bill, frequency: "monthly", startDate: "2026-09-30", endDate: "2026-09-01" })).body.error.code).toBe("REPEAT_END_BEFORE_START");
    const made = await post("/repeat-bills", { invoiceId: ids.bill, frequency: "monthly", startDate: "2026-09-30" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ customerName: "Hotel Shree", frequency: "monthly", anchorDay: 30, nextDate: "2026-09-30", isActive: true, billsMade: 0, amount: ids.total });
    ids.repeat = made.body.id;
    expect((await get(`/repeat-bills?invoiceId=${ids.bill}`)).body.data).toHaveLength(1);
    // Another business sees none of it.
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    expect((await get("/repeat-bills", other.token)).body.data).toEqual([]);
  });

  it("makes each bill due on its day, catching up missed ones, once", async () => {
    t.setToday("2026-09-29");
    expect((await run()).bills).toBe(0);
    t.setToday("2026-11-02");
    expect(await run()).toMatchObject({ bills: 2, failed: 0 });
    const list = await bills();
    const repeats = list.filter((b) => b.id !== ids.bill).sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
    expect(repeats.map((b) => [b.invoiceDate, b.grandTotal])).toEqual([
      ["2026-09-30", ids.total],
      ["2026-10-30", ids.total],
    ]);
    const rule = (await get("/repeat-bills")).body.data[0];
    expect(rule).toMatchObject({ nextDate: "2026-11-30", billsMade: 2, lastNumber: repeats[1]!.invoiceNumber, lastError: null });
    const note = (await get("/notifications")).body.data.find((n: { type: string }) => n.type === "repeat_bills_made");
    expect(note.params).toMatchObject({ count: 2 });
    // The same day again: nothing more.
    expect((await run()).bills).toBe(0);
    expect(await bills()).toHaveLength(3);
  });

  it("skips the time it was paused and stops after its end date", async () => {
    expect((await patch(`/repeat-bills/${ids.repeat}`, { isActive: false })).body.isActive).toBe(false);
    t.setToday("2026-12-03");
    expect((await run()).bills).toBe(0);
    // November's bill was missed while paused; the next is December's, on its usual day.
    const resumed = await patch(`/repeat-bills/${ids.repeat}`, { isActive: true, endDate: "2027-01-15" });
    expect(resumed.body).toMatchObject({ isActive: true, nextDate: "2026-12-30", endDate: "2027-01-15" });
    expect((await run()).bills).toBe(0);
    t.setToday("2027-02-01");
    expect((await run()).bills).toBe(1);
    expect((await get("/repeat-bills")).body.data[0]).toMatchObject({ billsMade: 3, nextDate: "2027-01-30", isActive: false });
  });

  it("says why a bill could not be made and tries again the next day", async () => {
    t.setToday("2027-02-01");
    const weekly = await post("/repeat-bills", { invoiceId: ids.bill, frequency: "weekly", startDate: "2027-02-01" });
    expect(weekly.status).toBe(201);
    await t.owner.query("update customers set is_active = false where id = $1", [ids.shop]);
    expect(await run()).toMatchObject({ bills: 0, failed: 1 });
    const row = (await get("/repeat-bills")).body.data.find((r: { id: string }) => r.id === weekly.body.id);
    expect(row.nextDate).toBe("2027-02-01");
    expect(row.lastError).toBe("CUSTOMER_INACTIVE");
    expect((await get("/notifications")).body.data.some((n: { type: string }) => n.type === "repeat_bill_failed")).toBe(true);
    // Not again the same day.
    expect((await run()).failed).toBe(0);
    expect((await call(t.app, "DELETE", `/repeat-bills/${weekly.body.id}`, { token: owner.token })).status).toBe(204);
  });
});
