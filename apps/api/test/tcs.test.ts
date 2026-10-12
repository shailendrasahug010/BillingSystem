import { descendants, gstinCheckChar, parseXml, textOf } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

/**
 * TCS on sales of specified goods (394(1), old 206C(1) and (1F)). Off until
 * the business turns it on; then a bill of goods marked for it (scrap here)
 * adds 2% of their value with GST (5% from a buyer without a PAN, none from
 * an exempt buyer, none on other goods), and a motor vehicle only when one
 * is worth more than ₹10 lakh. It is part of what the customer owes, outside
 * the GST value: in the e-invoice's other charges and on TCS Payable in
 * Tally. The month's TCS is listed with its due date and paid by a challan
 * of its own; a bill whose TCS was paid cannot be cancelled until the
 * challan lets go of it.
 */
describe.skipIf(!hasDatabase)("TCS", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const put = (url: string, body?: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const month = TEST_TODAY.slice(0, 7);
  const sell = (customerId: string | undefined, lines: Array<{ productId: string | undefined; qty: string; rate?: string }>, extra: Record<string, unknown> = {}) =>
    post("/invoices", { customerId, lines, ...extra });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Sharma Metals", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { gstin: gstin("23", "AAPFS1234K"), addressLine1: "Plot 7, Sanwer Road", city: "Indore", pincode: "452015" } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const scrap = await post("/products", { name: "MS Scrap", hsnCode: "7204", taxCategoryId: taxes["GST 18%"], baseUnitId: units.KGS ?? units.PCS, sellingPrice: "30", openingStock: "100000", openingStockCost: "25", tcsGoods: "scrap" });
    expect(scrap.status).toBe(201);
    expect(scrap.body.tcsGoods).toBe("scrap");
    ids.scrap = scrap.body.id;
    ids.gloves = (await post("/products", { name: "Work Gloves", hsnCode: "6116", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "60" })).body.id;
    ids.car = (await post("/products", { name: "Pickup Truck", hsnCode: "8704", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "900000", openingStock: "5", openingStockCost: "800000", tcsGoods: "motor_vehicle" })).body.id;
    expect((await post("/products", { name: "Bad", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, tcsGoods: "gold" })).status).toBe(400);
    ids.steel = (await post("/customers", { name: "Malwa Steel Works", customerType: "b2b", stateCode: "23", gstin: gstin("23", "AABCM5678M"), addressLine1: "Pithampur", city: "Dhar", pincode: "454775" })).body.id;
    ids.raju = (await post("/customers", { name: "Raju Kabadi", stateCode: "23" })).body.id;
    const mill = await post("/customers", { name: "Rolling Mill", stateCode: "23", pan: "AACCR4321R", tcsExempt: true });
    expect(mill.status).toBe(201);
    ids.mill = mill.body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("collects none until the business turns it on", async () => {
    const res = await sell(ids.steel, [{ productId: ids.scrap, qty: "100" }]);
    expect(res.body).toMatchObject({ grandTotal: "3540.00", tcsAmount: "0.00", tcs: null });
    ids.before = res.body.id;
    expect((await put("/settings/tcs.sales", { value: { enabled: true, rates: {}, threshold: 1000000 } })).status).toBe(200);
  });

  it("adds 2% of the goods' value with GST to the bill, outside the GST value", async () => {
    // 1,000 kg of scrap at ₹30: ₹30,000 + ₹5,400 GST = ₹35,400; TCS ₹708. Gloves take none.
    const preview = await post("/invoices/preview", { customerId: ids.steel, lines: [{ productId: ids.scrap, qty: "1000" }, { productId: ids.gloves, qty: "1" }], charges: [] });
    expect(preview.body.totals).toMatchObject({ taxableTotal: "30100.00", tcsAmount: "708.00", grandTotal: "36226.00", tcs: [{ goods: "scrap", rate: "2", base: "35400.00", amount: "708.00" }] });
    const res = await sell(ids.steel, [{ productId: ids.scrap, qty: "1000" }, { productId: ids.gloves, qty: "1" }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ taxableTotal: "30100.00", cgstTotal: "2709.00", sgstTotal: "2709.00", tcsAmount: "708.00", grandTotal: "36226.00", balanceDue: "36226.00" });
    expect(res.body.tcs).toEqual([{ goods: "scrap", rate: "2", base: "35400.00", amount: "708.00" }]);
    ids.steelBill = res.body.id;
    ids.steelNumber = res.body.invoiceNumber;
    // The customer owes the whole of it.
    const ledger = (await get(`/customers/${ids.steel}/ledger`)).body;
    expect(ledger.entries.at(-1)).toMatchObject({ docType: "invoice", debit: "36226.00" });
  });

  it("is 5% from a buyer without a PAN, none from an exempt buyer", async () => {
    // 100 kg: ₹3,000 + ₹540 = ₹3,540; 5% = ₹177.
    const noPan = await sell(ids.raju, [{ productId: ids.scrap, qty: "100" }]);
    expect(noPan.body).toMatchObject({ tcsAmount: "177.00", grandTotal: "3717.00", tcs: [{ goods: "scrap", rate: "5", base: "3540.00", amount: "177.00" }] });
    const exempt = await sell(ids.mill, [{ productId: ids.scrap, qty: "100" }]);
    expect(exempt.body).toMatchObject({ tcsAmount: "0.00", grandTotal: "3540.00", tcs: null });
  });

  it("takes 1% on a motor vehicle only when one is worth more than ₹10 lakh", async () => {
    // ₹8 lakh + 18% = ₹9,44,000: under the threshold.
    expect((await sell(ids.steel, [{ productId: ids.car, qty: "1", rate: "800000" }])).body).toMatchObject({ tcsAmount: "0.00", grandTotal: "944000.00" });
    // ₹9 lakh + 18% = ₹10,62,000: 1% = ₹10,620.
    expect((await sell(ids.steel, [{ productId: ids.car, qty: "1" }])).body).toMatchObject({ tcsAmount: "10620.00", grandTotal: "1072620.00", tcs: [{ goods: "motor_vehicle", rate: "1" }] });
  });

  it("refuses a bill whose totals leave the TCS out, as one made without it would", async () => {
    const res = await sell(ids.raju, [{ productId: ids.scrap, qty: "100" }], { clientTotals: { grandTotal: "3540.00" } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "TOTALS_MISMATCH", params: { field: "grandTotal", expected: "3717.00", received: "3540.00" } });
  });

  it("puts the TCS in the e-invoice's other charges and on TCS Payable in Tally", async () => {
    expect((await put("/settings/einvoice.enabled", { value: true })).status).toBe(200);
    const res = await t.app.inject({ method: "GET", url: `/api/v1/einvoice/file?ids=${ids.steelBill}`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(res.statusCode).toBe(200);
    const [doc] = JSON.parse(res.body);
    expect(doc.ValDtls).toMatchObject({ AssVal: 30100, CgstVal: 2709, SgstVal: 2709, OthChrg: 708, RndOffAmt: 0, TotInvVal: 36226 });

    const xml = await t.app.inject({ method: "GET", url: `/api/v1/tally/export?from=${TEST_TODAY}&to=${TEST_TODAY}`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(xml.statusCode).toBe(200);
    const voucher = descendants(parseXml(xml.body), "VOUCHER").find((v) => textOf(v, "VOUCHERNUMBER") === ids.steelNumber)!;
    const lines = [...descendants(voucher, "LEDGERENTRIES.LIST"), ...descendants(voucher, "ALLLEDGERENTRIES.LIST"), ...descendants(voucher, "ALLINVENTORYENTRIES.LIST")];
    expect(lines.reduce((s, e) => s + Math.round(Number(textOf(e, "AMOUNT")) * 100), 0)).toBe(0);
    const ledgers = Object.fromEntries(descendants(voucher, "LEDGERENTRIES.LIST").map((e) => [textOf(e, "LEDGERNAME"), textOf(e, "AMOUNT")]));
    expect(ledgers["TCS Payable"]).toBe("708.00");
    expect(ledgers["Malwa Steel Works"]).toBe("-36226.00");
  });

  it("lists the month's TCS with its due date, and a challan of its own pays it", async () => {
    const list = (await get(`/tcs/collected?month=${month}`)).body;
    expect(list).toMatchObject({ month, dueDate: "2026-10-07", total: "11505.00", paid: "0.00", pending: "11505.00", overdue: false });
    expect(list.data.map((r: { partyName: string; tcs: string; pan: string | null }) => [r.partyName, r.tcs, r.pan])).toEqual([
      ["Malwa Steel Works", "708.00", "AABCM5678M"],
      ["Raju Kabadi", "177.00", null],
      ["Malwa Steel Works", "10620.00", "AABCM5678M"],
    ]);
    const challan = await post("/tds/challans", { kind: "tcs", periodMonth: month, depositDate: TEST_TODAY, bsrCode: "0510308", challanSerial: "00077" });
    expect(challan.status).toBe(201);
    expect(challan.body).toMatchObject({ kind: "tcs", taxAmount: "11505.00", bills: 3 });
    ids.challan = challan.body.id;
    expect((await get(`/tcs/collected?month=${month}`)).body).toMatchObject({ paid: "11505.00", pending: "0.00" });
    // The TDS side has nothing to do with it.
    expect((await get(`/tds/challans?month=${month}`)).body.data).toEqual([]);
    expect((await get(`/tds/challans?month=${month}&kind=tcs`)).body.data.map((c: { id: string }) => c.id)).toEqual([ids.challan]);
    expect((await post("/tds/challans", { kind: "tcs", periodMonth: month, depositDate: TEST_TODAY, bsrCode: "0510308", challanSerial: "00078" })).body.error.code).toBe("NOTHING_TO_DEPOSIT");
  });

  it("keeps a bill whose TCS was paid until the challan lets go of it", async () => {
    const refused = await post(`/invoices/${ids.steelBill}/cancel`, { reason: "Wrong rate" });
    expect(refused.body.error).toMatchObject({ code: "TCS_PAID_ON_BILL", params: { challan: "0510308/00077" } });
    expect((await call(t.app, "DELETE", `/tds/challans/${ids.challan}`, { token: owner.token })).status).toBe(204);
    expect((await post(`/invoices/${ids.steelBill}/cancel`, { reason: "Wrong rate" })).status).toBe(200);
    expect((await get(`/tcs/collected?month=${month}`)).body).toMatchObject({ total: "10797.00", paid: "0.00" });
  });

  it("keeps the list to the business", async () => {
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    expect((await get(`/tcs/collected?month=${month}`, other.token)).body.data).toEqual([]);
  });
});
