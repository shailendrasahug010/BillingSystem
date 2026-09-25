import { gstinCheckChar } from "@vyapaar/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("discount and rate-difference notes", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows[0] as T;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Scheme Traders", stateCode: "23", gstin: gstin("23", "AAPFS1234S") });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.biscuit = (await post("/products", { name: "Biscuit", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "500", openingStockCost: "8" })).body.id;
    ids.customer = (await post("/customers", { name: "Mehta Stores", stateCode: "23", gstin: gstin("23", "AAACM1234M") })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Soap Depot", stateCode: "23", gstin: gstin("23", "AAACS5678K") })).body.id;
    const inv = (await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "10" }, { productId: ids.biscuit, qty: "100" }] })).body;
    ids.invoice = inv.id;
    ids.soapLine = inv.items[0].id;
    expect(inv).toMatchObject({ taxableTotal: "2000.00", grandTotal: "2230.00" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("gives a percent discount after the sale: value-only credit note spread over the lines", async () => {
    const res = await post(`/invoices/${ids.invoice}/price-notes`, { percent: "10", reason: "discount", notes: "Diwali scheme" });
    expect(res.status).toBe(201);
    ids.discount = res.body.id;
    // 10% of 1000 (18%) and 1000 (5%): 100 + 18 and 100 + 5.
    expect(res.body).toMatchObject({ noteNumber: "CN/26-27/00001", noteType: "credit", reason: "discount", affectsStock: false, taxableTotal: "200.00", cgstTotal: "11.50", sgstTotal: "11.50", grandTotal: "223.00", amountSettled: "223.00" });
    const inv = (await get(`/invoices/${ids.invoice}`)).body;
    expect(inv.balanceDue).toBe("2007.00");
    expect(inv.items.map((i: { returnedQty: string }) => i.returnedQty)).toEqual(["0.000", "0.000"]);
    expect(inv.returns).toEqual([expect.objectContaining({ noteNumber: "CN/26-27/00001", grandTotal: "223.00" })]);
    const stock = await one<{ qty: string }>(`select sum(qty)::text as qty from stock_balances where product_id = $1`, [ids.soap]);
    expect(stock.qty).toBe("90.000");
    const gst = await one<{ n: number; qty: string; original: string }>(`select count(*)::int as n, sum(qty)::text as qty, max(original_doc_number) as original from gst_transactions where doc_id = $1`, [ids.discount]);
    expect(gst).toMatchObject({ n: 2, qty: "0.000", original: "INV/26-27/00001" });
    const gstr1 = (await get("/gst/returns/gstr1?period=2026-09")).body;
    expect(gstr1.summary.find((s: { section: string }) => s.section === "cdnr")).toMatchObject({ records: 1, taxable: "200.00" });
  });

  it("caps notes at what the bill still carries and accepts amounts per line", async () => {
    expect((await post(`/invoices/${ids.invoice}/price-notes`, { amount: "1801" })).body.error).toMatchObject({ code: "NOTE_EXCEEDS_BILL", params: { max: "1800.00" } });
    expect((await post(`/invoices/${ids.invoice}/price-notes`, {})).body.error.code).toBe("NOTE_AMOUNT_REQUIRED");
    expect((await post(`/invoices/${ids.invoice}/price-notes`, { amount: "10", percent: "5" })).body.error.code).toBe("NOTE_AMOUNT_REQUIRED");
    const rate = await post(`/invoices/${ids.invoice}/price-notes`, { reason: "rate_difference", lines: [{ lineId: ids.soapLine, amount: "50" }] });
    expect(rate.body).toMatchObject({ reason: "rate_difference", taxableTotal: "50.00", cgstTotal: "4.50", grandTotal: "59.00" });
    ids.rate = rate.body.id;
  });

  it("returns after a discount credit only what the goods are still worth", async () => {
    // Soap line: 1000 billed, 100 discount + 50 rate difference credited -> 850 left for 10 pieces.
    const ret = await post(`/invoices/${ids.invoice}/returns`, { lines: [{ lineId: ids.soapLine, qty: "10" }] });
    expect(ret.body).toMatchObject({ taxableTotal: "850.00", cgstTotal: "76.50", sgstTotal: "76.50", grandTotal: "1003.00" });
    expect((await get(`/invoices/${ids.invoice}`)).body.balanceDue).toBe("945.00");
  });

  it("cancels a value-only note without touching quantities or stock", async () => {
    const cancelled = await post(`/notes/${ids.rate}/cancel`, { reason: "Wrong rate" });
    expect(cancelled.body.status).toBe("cancelled");
    const inv = (await get(`/invoices/${ids.invoice}`)).body;
    expect(inv.items[0].returnedQty).toBe("10.000");
    expect(inv.balanceDue).toBe("1004.00");
    const ledger = (await get(`/customers/${ids.customer}/ledger`)).body.entries.map((e: { docType: string }) => e.docType);
    expect(ledger).toEqual(expect.arrayContaining(["credit_note", "credit_note_cancel"]));
  });

  it("records a supplier's credit note on a purchase: payable and input tax credit go down", async () => {
    const pur = (await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "SD/9", supplierInvoiceDate: "2026-09-20", lines: [{ productId: ids.soap, qty: "20", rate: "70" }] })).body;
    expect(pur).toMatchObject({ taxableTotal: "1400.00", grandTotal: "1652.00" });
    const note = await post(`/purchases/${pur.id}/price-notes`, { amount: "100", reason: "discount", partyNoteNumber: "SD-CN-4" });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ noteNumber: "SCN/26-27/00001", partyNoteNumber: "SD-CN-4", partyType: "supplier", taxableTotal: "100.00", grandTotal: "118.00" });
    expect((await get(`/purchases/${pur.id}`)).body.balanceDue).toBe("1534.00");
    const gst = (await get("/reports/gst?period=2026-09")).body;
    expect(gst.notes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "purchase_credit_note", taxable: "100.00", cgst: "9.00" })]));
    expect(gst.estimate.eligibleItc).toMatchObject({ cgst: "117.00", sgst: "117.00" });
    const r3b = (await get("/gst/returns/gstr3b?period=2026-09")).body;
    expect(r3b.itc.allOther).toMatchObject({ cgst: "117.00", sgst: "117.00" });
    const register = await one<{ doc_number: string }>(`select doc_number from gst_transactions where doc_id = $1 limit 1`, [note.body.id]);
    expect(register.doc_number).toBe("SD-CN-4");
    const cancelled = await post(`/notes/${note.body.id}/cancel`, { reason: "Entered twice" });
    expect(cancelled.body.status).toBe("cancelled");
    expect((await get(`/purchases/${pur.id}`)).body.balanceDue).toBe("1652.00");
  });
});
