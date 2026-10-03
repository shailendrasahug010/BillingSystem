import { gstinCheckChar } from "@digitalbahi/core";
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

describe.skipIf(!hasDatabase)("exports and supplies to SEZ", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const inv: Record<string, any> = {};
  const SEZ_GSTIN = gstin("27", "AABCS1429B");
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const invoice = (customerId: string | undefined, zeroRated?: object) => post("/invoices", { customerId, lines: [{ productId: ids.soap, qty: "100" }], ...(zeroRated ? { zeroRated } : {}) });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Export House", stateCode: "23", gstin: gstin("23", "AAPFE1234E") });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "5000", openingStockCost: "70" })).body.id;
    ids.abroad = (await post("/customers", { name: "Gulf Traders LLC", customerType: "b2c", gstRegistration: "overseas", stateCode: "96" })).body.id;
    ids.sez = (await post("/customers", { name: "Pune SEZ Unit", customerType: "b2b", gstRegistration: "sez", stateCode: "27", gstin: SEZ_GSTIN })).body.id;
    ids.local = (await post("/customers", { name: "Local Shop", stateCode: "23" })).body.id;
    expect((await call(t.app, "PUT", "/settings/gst.lut", { token: owner.token, body: { value: { arn: "AD230326000123X", validUntil: "2027-03-31" } } })).status).toBe(200);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("bills an export under the LUT by default: no IGST, the rate kept, place of supply 96", async () => {
    const res = await invoice(ids.abroad);
    expect(res.status).toBe(201);
    inv.lut = res.body;
    expect(res.body).toMatchObject({ zeroRatedType: "EXPWOP", placeOfSupply: "96", supplyType: "inter_state", taxableTotal: "10000.00", igstTotal: "0.00", cgstTotal: "0.00", grandTotal: "10000.00", lutArn: "AD230326000123X" });
    expect(res.body.items[0]).toMatchObject({ gstRate: "18.000", igstAmount: "0.00" });
  });

  it("bills with payment of IGST when asked, and SEZ supplies both ways; refuses export details for a local buyer", async () => {
    inv.paid = (await invoice(ids.abroad, { withPayment: true, shippingBillNumber: "7894561", shippingBillDate: "2026-09-25", portCode: "inmun1" })).body;
    expect(inv.paid).toMatchObject({ zeroRatedType: "EXPWP", igstTotal: "1800.00", grandTotal: "11800.00", shippingBillNumber: "7894561", portCode: "INMUN1", lutArn: null });
    inv.sezLut = (await invoice(ids.sez)).body;
    expect(inv.sezLut).toMatchObject({ zeroRatedType: "SEZWOP", placeOfSupply: "27", igstTotal: "0.00", shippingBillNumber: null });
    inv.sezPaid = (await invoice(ids.sez, { withPayment: true })).body;
    expect(inv.sezPaid).toMatchObject({ zeroRatedType: "SEZWP", igstTotal: "1800.00" });
    const local = await invoice(ids.local, { withPayment: true });
    expect(local.status).toBe(400);
    expect(local.body.error).toMatchObject({ code: "ZERO_RATED_NOT_ALLOWED", field: "zeroRated" });
    expect((await invoice(ids.local)).body.zeroRatedType).toBeNull();
    const early = await invoice(ids.abroad, { withPayment: true, shippingBillNumber: "7894562", shippingBillDate: "2026-09-01" });
    expect(early.body.error).toMatchObject({ code: "SHIPPING_BILL_BEFORE_INVOICE", field: "zeroRated.shippingBillDate" });
  });

  it("adds the shipping bill to an export later, and only to an export", async () => {
    const res = await call(t.app, "PATCH", `/invoices/${inv.lut.id}/shipping-bill`, { token: owner.token, body: { shippingBillNumber: "7894599", shippingBillDate: "2026-09-26", portCode: "INNSA1" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shippingBillNumber: "7894599", shippingBillDate: "2026-09-26", portCode: "INNSA1" });
    expect((await call(t.app, "PATCH", `/invoices/${inv.sezLut.id}/shipping-bill`, { token: owner.token, body: { shippingBillNumber: "1", shippingBillDate: null, portCode: null } })).status).toBe(400);
    const early = await call(t.app, "PATCH", `/invoices/${inv.lut.id}/shipping-bill`, { token: owner.token, body: { shippingBillNumber: "7894599", shippingBillDate: "2026-08-01", portCode: "INNSA1" } });
    expect(early.body.error.code).toBe("SHIPPING_BILL_BEFORE_INVOICE");
    const log = (await get("/audit-logs?entityType=invoice")).body.data.map((e: { action: string }) => e.action);
    expect(log).toContain("invoice.shipping_bill_updated");
  });

  it("returns goods on an export under LUT without tax", async () => {
    const note = await post(`/invoices/${inv.lut.id}/returns`, { lines: [{ lineId: inv.lut.items[0].id, qty: "10" }] });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ taxableTotal: "1000.00", igstTotal: "0.00", grandTotal: "1000.00" });
  });

  it("files them in GSTR-1 (EXP, B2B as SEWP / SEWOP, CDNUR) and in GSTR-3B 3.1(b)", async () => {
    const file = await t.app.inject({ method: "GET", url: "/api/v1/gst/returns/gstr1/file?period=2026-09&format=json", headers: { authorization: `Bearer ${owner.token}` } });
    const json = JSON.parse(file.body);
    expect(json.exp).toEqual([
      { exp_typ: "WPAY", inv: [{ inum: inv.paid.invoiceNumber, idt: "24-09-2026", val: 11800, sbpcode: "INMUN1", sbnum: "7894561", sbdt: "25-09-2026", itms: [{ txval: 10000, rt: 18, iamt: 1800, csamt: 0 }] }] },
      { exp_typ: "WOPAY", inv: [{ inum: inv.lut.invoiceNumber, idt: "24-09-2026", val: 10000, sbpcode: "INNSA1", sbnum: "7894599", sbdt: "26-09-2026", itms: [{ txval: 10000, rt: 18, iamt: 0, csamt: 0 }] }] },
    ]);
    expect(json.b2b).toEqual([{ ctin: SEZ_GSTIN, inv: expect.arrayContaining([expect.objectContaining({ inum: inv.sezLut.invoiceNumber, inv_typ: "SEWOP", pos: "27" }), expect.objectContaining({ inum: inv.sezPaid.invoiceNumber, inv_typ: "SEWP" })]) }]);
    expect(json.cdnur).toEqual([expect.objectContaining({ typ: "EXPWOP", ntty: "C", val: 1000 })]);
    expect(json.cdnur[0].pos).toBeUndefined();

    const csv = await t.app.inject({ method: "GET", url: "/api/v1/gst/returns/gstr1/file?period=2026-09&format=csv&section=exp", headers: { authorization: `Bearer ${owner.token}` } });
    expect(csv.body.split("\n")[0]).toContain("Export Type");
    expect(csv.body).toContain("WOPAY");

    const r3b = (await get("/gst/returns/gstr3b?period=2026-09")).body;
    expect(r3b.outward.zeroRated).toEqual({ taxable: "39000.00", igst: "3600.00", cgst: "0.00", sgst: "0.00", cess: "0.00" });
    expect(r3b.interStateUnregistered).toEqual([]);
  });

  it("prints the declaration, the LUT and the shipping bill on the invoice", async () => {
    const pdf = await t.app.inject({ method: "GET", url: `/api/v1/invoices/${inv.lut.id}/pdf`, headers: { authorization: `Bearer ${owner.token}` } });
    const text = await pdfText(pdf.rawPayload);
    expect(text).toContain("SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX");
    expect(text).toContain("Under LUT, ARN AD230326000123X");
    expect(text).toContain("Shipping bill 7894599 · 26/09/2026 · INNSA1");
    expect(text).toContain("Foreign Country");
  });

  it("pays IGST by default once the LUT has lapsed; without it then, the invoice names no LUT (a bond)", async () => {
    expect((await call(t.app, "PUT", "/settings/gst.lut", { token: owner.token, body: { value: { arn: "AD230325000999Y", validUntil: "2026-03-31" } } })).status).toBe(200);
    expect((await invoice(ids.abroad)).body).toMatchObject({ zeroRatedType: "EXPWP", igstTotal: "1800.00", lutArn: null });
    expect((await invoice(ids.sez, { withPayment: false })).body).toMatchObject({ zeroRatedType: "SEZWOP", igstTotal: "0.00", lutArn: null });
    expect((await call(t.app, "PUT", "/settings/gst.lut", { token: owner.token, body: { value: null } })).status).toBe(200);
    expect((await invoice(ids.sez)).body).toMatchObject({ zeroRatedType: "SEZWP", lutArn: null });
  });
});
