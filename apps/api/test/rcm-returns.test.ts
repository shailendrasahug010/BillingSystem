import { gstinCheckChar } from "@vyapaar/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

async function pdfText(bytes: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return content.items.map((x) => ("str" in x ? x.str : "")).join(" ").replace(/\s+/g, " ");
}

/**
 * Returns and supplier credit notes against a reverse-charge purchase:
 * 100 kg of cashew at ₹50 under reverse charge = ₹5,000 owed to the supplier,
 * with GST of ₹125 + ₹125 that we pay ourselves (and take as credit).
 * Returning 20 kg takes back ₹1,000 from the supplier (no GST on it) and
 * lowers our reverse-charge tax by ₹25 + ₹25; a ₹400 rate difference from
 * the supplier takes back ₹400 and ₹10 + ₹10.
 */
describe.skipIf(!hasDatabase)("returns against reverse-charge purchases", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const balance = async () => (await get(`/suppliers/${ids.supplier}`)).body.balance as string;
  const r3b = async () => (await get("/gst/returns/gstr3b?period=2026-09")).body;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Indore Dry Fruits", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { gstin: gstin("23", "AAPFI1234K") } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.cashew = (await post("/products", { name: "Cashew kernels", hsnCode: "0801", taxCategoryId: taxes["GST 5%"], baseUnitId: units.KG ?? units.PCS, sellingPrice: "60" })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Konkan Growers", stateCode: "23", gstin: gstin("23", "AAFFK5678L") })).body.id;
    const purchase = await post("/purchases", {
      supplierId: ids.supplier,
      supplierInvoiceNumber: "KG-11",
      supplierInvoiceDate: "2026-09-10",
      isReverseCharge: true,
      lines: [{ productId: ids.cashew, qty: "100", rate: "50" }],
    });
    expect(purchase.body).toMatchObject({ grandTotal: "5000.00", cgstTotal: "125.00", sgstTotal: "125.00", isReverseCharge: true });
    ids.purchase = purchase.body.id;
    ids.line = purchase.body.items[0].id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("takes goods back at their value only, and lowers the reverse-charge tax and its credit", async () => {
    expect(await balance()).toBe("5000.00");
    expect((await r3b()).outward.reverseChargeInward).toMatchObject({ taxable: "5000.00", cgst: "125.00", sgst: "125.00" });
    const res = await post(`/purchases/${ids.purchase}/returns`, { noteDate: "2026-09-15", lines: [{ lineId: ids.line, qty: "20" }], reason: "damage" });
    expect(res.status).toBe(201);
    ids.return = res.body.id;
    expect(res.body).toMatchObject({ noteType: "debit", isReverseCharge: true, taxableTotal: "1000.00", cgstTotal: "25.00", sgstTotal: "25.00", grandTotal: "1000.00" });
    expect(res.body.items[0]).toMatchObject({ qty: "20.000", taxableValue: "1000.00", cgstAmount: "25.00", lineTotal: "1000.00" });
    expect(await balance()).toBe("4000.00");
    expect((await get(`/purchases/${ids.purchase}`)).body.balanceDue).toBe("4000.00");
    const r = await r3b();
    expect(r.outward.reverseChargeInward).toMatchObject({ taxable: "4000.00", cgst: "100.00", sgst: "100.00" });
    expect(r.itc.reverseCharge).toMatchObject({ cgst: "100.00", sgst: "100.00" });
  });

  it("takes a supplier's rate difference at its value only, with its GST off the reverse-charge tax", async () => {
    const res = await post(`/purchases/${ids.purchase}/price-notes`, { reason: "rate_difference", amount: "400", partyNoteNumber: "KG-CN-3", noteDate: "2026-09-18" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isReverseCharge: true, taxableTotal: "400.00", cgstTotal: "10.00", sgstTotal: "10.00", grandTotal: "400.00" });
    expect(await balance()).toBe("3600.00");
    const r = await r3b();
    expect(r.outward.reverseChargeInward).toMatchObject({ taxable: "3600.00", cgst: "90.00", sgst: "90.00" });
    expect(r.itc.reverseCharge).toMatchObject({ cgst: "90.00", sgst: "90.00" });
    // Reverse-charge tax is paid in cash.
    expect(r.payment.cash).toMatchObject({ cgst: "90.00", sgst: "90.00" });
  });

  it("prints the note with its GST shown apart from the total", async () => {
    const pdf = await t.app.inject({ method: "GET", url: `/api/v1/notes/${ids.return}/pdf`, headers: { authorization: `Bearer ${owner.token}` } });
    const text = await pdfText(pdf.rawPayload);
    expect(text).toContain("GST under reverse charge is paid by the recipient and is not included in this total.");
    expect(text).toMatch(/Reverse charge\s+Yes/);
  });

  it("puts everything back when the return is cancelled", async () => {
    const res = await post(`/notes/${ids.return}/cancel`, { reason: "Goods kept after all" });
    expect(res.status).toBe(200);
    expect(await balance()).toBe("4600.00");
    expect((await r3b()).outward.reverseChargeInward).toMatchObject({ taxable: "4600.00", cgst: "115.00", sgst: "115.00" });
  });
});
