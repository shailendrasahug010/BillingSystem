import { gstinCheckChar } from "@vyapaar/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("GST returns", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const BUSINESS_GSTIN = gstin("23", "AAPFG1234G");
  const B2B_GSTIN = gstin("23", "AAACM1234M");
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const raw = (url: string, token = owner.token) => t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  const invoice = async (customerId: string, lines: Array<{ productId: string; qty: string }>) => (await post("/invoices", { customerId, lines })).body;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Filing Traders", stateCode: "23", gstin: BUSINESS_GSTIN });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "2000", openingStockCost: "70" })).body.id;
    ids.rice = (await post("/products", { name: "Loose Rice", hsnCode: "1006", taxCategoryId: taxes.Exempt, baseUnitId: units.KG, sellingPrice: "50", openingStock: "100", openingStockCost: "40" })).body.id;
    ids.b2b = (await post("/customers", { name: "Mehta Stores", stateCode: "23", gstin: B2B_GSTIN })).body.id;
    ids.local = (await post("/customers", { name: "Walk-in Local", stateCode: "23" })).body.id;
    ids.far = (await post("/customers", { name: "Pune Retail", stateCode: "27" })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Soap Depot", stateCode: "23", gstin: gstin("23", "AAACS5678K") })).body.id;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;

    // A month of business.
    const b2b = await invoice(ids.b2b, [{ productId: ids.soap, qty: "10" }]);
    await invoice(ids.local, [{ productId: ids.soap, qty: "2" }, { productId: ids.rice, qty: "4" }]);
    const b2cl = await invoice(ids.far, [{ productId: ids.soap, qty: "1000" }]);
    ids.small = (await invoice(ids.far, [{ productId: ids.soap, qty: "5" }])).id;
    const wrong = await invoice(ids.local, [{ productId: ids.soap, qty: "1" }]);
    await post(`/invoices/${wrong.id}/cancel`, { reason: "Wrong party" });
    await post(`/invoices/${b2cl.id}/returns`, { lines: [{ lineId: b2cl.items[0].id, qty: "100" }] });
    await post(`/invoices/${b2b.id}/returns`, { lines: [{ lineId: b2b.items[0].id, qty: "1" }] });
    await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "SD/77", supplierInvoiceDate: "2026-09-20", lines: [{ productId: ids.soap, qty: "10", rate: "70" }] });
    const cats = Object.fromEntries((await get("/expense-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    await post("/expenses", { categoryId: cats.Transport, amount: "500", gstRate: "18", vendorGstin: gstin("27", "AAACT1234T"), paymentMethod: "bank_transfer", referenceNumber: "VRL-1" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("previews GSTR-1 by table with the document summary", async () => {
    const res = await get("/gst/returns/gstr1?period=2026-09");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gstin: BUSINESS_GSTIN, version: "gstr1-json@2025.05", b2clThreshold: "100000.00", hsnMinDigits: 4, warnings: [], status: { GSTR1: { status: "open" } } });
    const by = Object.fromEntries(res.body.summary.map((s: { section: string }) => [s.section, s]));
    expect(by.b2b).toMatchObject({ records: 1, taxable: "1000.00", cgst: "90.00", sgst: "90.00" });
    expect(by.b2cl).toMatchObject({ records: 1, value: "118000.00", taxable: "100000.00", igst: "18000.00" });
    expect(by.b2cs).toMatchObject({ records: 2, taxable: "700.00", igst: "90.00", cgst: "18.00" });
    expect(by.cdnr).toMatchObject({ records: 1, taxable: "100.00", cgst: "9.00" });
    expect(by.cdnur).toMatchObject({ records: 1, taxable: "10000.00", igst: "1800.00" });
    expect(by.nil).toMatchObject({ records: 1, value: "200.00" });
    expect(res.body.documents).toEqual([
      { docNum: 1, label: "Invoices for outward supply", from: "INV/26-27/00001", to: "INV/26-27/00005", total: 5, cancelled: 1, net: 4 },
      { docNum: 5, label: "Credit Note", from: "CN/26-27/00001", to: "CN/26-27/00002", total: 2, cancelled: 0, net: 2 },
    ]);
  });

  it("downloads the JSON for the offline tool and one table as CSV, recording each export", async () => {
    const file = await raw("/gst/returns/gstr1/file?period=2026-09&format=json");
    expect(file.statusCode).toBe(200);
    expect(String(file.headers["content-disposition"])).toContain(`GSTR1_${BUSINESS_GSTIN}_092026.json`);
    const json = JSON.parse(file.body);
    expect(json).toMatchObject({ gstin: BUSINESS_GSTIN, fp: "092026" });
    expect(json.b2b[0]).toMatchObject({ ctin: B2B_GSTIN, inv: [{ inum: "INV/26-27/00001", val: 1180, pos: "23", itms: [{ itm_det: { txval: 1000, rt: 18, camt: 90, samt: 90 } }] }] });
    expect(json.b2cl).toEqual([{ pos: "27", inv: [expect.objectContaining({ inum: "INV/26-27/00003", val: 118000 })] }]);
    expect(json.cdnur).toEqual([expect.objectContaining({ typ: "B2CL", ntty: "C", nt_num: "CN/26-27/00001", val: 11800, pos: "27" })]);
    expect(json.cdnr[0].nt[0]).toMatchObject({ ntty: "C", nt_num: "CN/26-27/00002", val: 118 });
    expect(json.nil.inv).toEqual([{ sply_ty: "INTRAB2C", expt_amt: 200, nil_amt: 0, ngsup_amt: 0 }]);
    expect(json.hsn.hsn_b2c).toEqual(expect.arrayContaining([expect.objectContaining({ hsn_sc: "1006", uqc: "KGS", qty: 4, rt: 0, txval: 200 })]));
    expect(json.doc_issue.doc_det[0].docs[0]).toMatchObject({ totnum: 5, cancel: 1, net_issue: 4 });

    const csv = await raw("/gst/returns/gstr1/file?period=2026-09&format=csv&section=b2b");
    expect(String(csv.headers["content-type"])).toContain("text/csv");
    expect(csv.body.split("\r\n")[1]).toBe(`${B2B_GSTIN},Mehta Stores,INV/26-27/00001,24-Sep-2026,1180,23-Madhya Pradesh,N,,Regular B2B,,18,1000,0`);
    const exports = (await get("/gst/exports?period=2026-09")).body.data;
    expect(exports.map((e: { format: string; formatterVersion: string }) => `${e.format} ${e.formatterVersion}`)).toEqual(["csv gstr1-json@2025.05/csv-b2b", "json gstr1-json@2025.05"]);
    expect((await raw("/gst/returns/gstr1/file?period=2026-09", salesToken)).statusCode).toBe(403);
  });

  it("computes GSTR-3B: output tax net of notes, ITC from purchases and expenses, cash to pay", async () => {
    const r = (await get("/gst/returns/gstr3b?period=2026-09")).body;
    expect(r.outward.taxable).toEqual({ taxable: "91600.00", igst: "16290.00", cgst: "99.00", sgst: "99.00", cess: "0.00" });
    expect(r.outward.nilExempt).toEqual({ taxable: "200.00" });
    expect(r.interStateUnregistered).toEqual([{ placeOfSupply: "27", taxable: "90500.00", igst: "16290.00" }]);
    expect(r.itc.allOther).toEqual({ igst: "90.00", cgst: "63.00", sgst: "63.00", cess: "0.00" });
    expect(r.itc.net).toEqual({ igst: "90.00", cgst: "63.00", sgst: "63.00", cess: "0.00" });
    // IGST credit first on IGST; CGST / SGST credit on their own heads, the rest in cash.
    expect(r.payment.paidFromCredit).toEqual({ igst: "90.00", cgst: "63.00", sgst: "63.00", cess: "0.00" });
    expect(r.payment.cash).toEqual({ igst: "16200.00", cgst: "36.00", sgst: "36.00", cess: "0.00" });
  });

  it("locks a month (no more changes to its documents), unlocks it, and freezes it once filed", async () => {
    const locked = await post("/gst/periods/2026-09/lock", {});
    expect(locked.body.GSTR1).toMatchObject({ status: "locked" });
    expect((await post("/gst/periods/2026-09/lock", {})).body.error.code).toBe("GST_PERIOD_ALREADY_LOCKED");
    expect((await post(`/invoices/${ids.small}/cancel`, { reason: "Test lock" })).body.error.code).toBe("GST_PERIOD_LOCKED");
    const cats = Object.fromEntries((await get("/expense-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    expect((await post("/expenses", { categoryId: cats.Rent, amount: "100", gstRate: "18", vendorGstin: B2B_GSTIN, paymentMethod: "cash" })).body.error.code).toBe("GST_PERIOD_LOCKED");

    expect((await post("/gst/periods/2026-09/unlock", {})).body.GSTR1.status).toBe("open");
    expect((await post("/gst/periods/2026-10/lock", {})).body.error.code).toBe("GST_PERIOD_IN_FUTURE");
    const filed = await post("/gst/periods/2026-09/filed", { arn: "AA230926123456X" });
    expect(filed.body.GSTR1).toMatchObject({ status: "filed", arn: "AA230926123456X" });
    expect((await post("/gst/periods/2026-09/unlock", {})).body.error.code).toBe("GST_PERIOD_FILED");
    expect((await post(`/invoices/${ids.small}/cancel`, { reason: "Test lock" })).body.error.code).toBe("GST_PERIOD_LOCKED");
    expect((await get("/gst/returns/gstr1?period=2026-09")).body.status.GSTR1).toMatchObject({ status: "filed", arn: "AA230926123456X" });
    const actions = (await get("/audit-logs?entityType=gst_period")).body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["gst.period_locked", "gst.period_unlocked", "gst.return_filed", "gst.exported"]));
  });

  it("needs the business GSTIN to produce the file", async () => {
    const other = await signup(t, { legalName: "No Gstin Traders", stateCode: "23" });
    const preview = await get("/gst/returns/gstr1?period=2026-09", other.token);
    expect(preview.body.warnings).toEqual([{ code: "BUSINESS_GSTIN_MISSING" }]);
    const file = await raw("/gst/returns/gstr1/file?period=2026-09", other.token);
    expect(file.statusCode).toBe(409);
    expect(JSON.parse(file.body).error.code).toBe("BUSINESS_GSTIN_REQUIRED");
  });
});
