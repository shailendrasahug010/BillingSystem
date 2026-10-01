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

const IRN = "a5c12dca80e743321740b001fd70953e8738d109865d28ba4013750f2046f229";

describe.skipIf(!hasDatabase)("e-invoice and e-way bill files", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const patch = (url: string, body: unknown) => call(t.app, "PATCH", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const file = (url: string) => t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${owner.token}` } });
  const bill = async (customerId: string | undefined, qty: string) => (await post("/invoices", { customerId, invoiceDate: "2026-09-24", lines: [{ productId: ids.biscuit, qty, rate: "10" }] })).body;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Ravi Distributors", stateCode: "23" });
    await patch("/business", { gstin: gstin("23", "AAPFR1234K"), addressLine1: "12 MG Road", city: "Indore", pincode: "452001" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.biscuit = (await post("/products", { name: "Parle-G 100g", hsnCode: "190531", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "20000", openingStockCost: "8" })).body.id;
    ids.sharma = (await post("/customers", { name: "Sharma Kirana", customerType: "b2b", stateCode: "23", gstin: gstin("23", "ABCDE1234F"), addressLine1: "Shop 4, Rajwada", city: "Indore", pincode: "452002" })).body.id;
    ids.nopin = (await post("/customers", { name: "Verma Stores", customerType: "b2b", stateCode: "23", gstin: gstin("23", "ABCDV1234F"), addressLine1: "Palasia", city: "Indore" })).body.id;
    ids.walkin = (await post("/customers", { name: "Walk-in", stateCode: "23" })).body.id;
    expect((await call(t.app, "PUT", "/settings/einvoice.enabled", { token: owner.token, body: { value: true } })).status).toBe(200);
    ids.inv1 = (await bill(ids.sharma, "100")).id;
    ids.b2c = (await bill(ids.walkin, "10")).id;
    ids.nopinInv = (await bill(ids.nopin, "10")).id;
    ids.big = (await bill(ids.sharma, "6000")).id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("lists the month's B2B bills for IRNs, with what the portal would refuse", async () => {
    const res = await get("/gst/einvoice?period=2026-09");
    expect(res.body.enabled).toBe(true);
    const byId = Object.fromEntries(res.body.documents.map((d: { id: string }) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual([ids.inv1, ids.nopinInv, ids.big].sort());
    expect(byId[ids.inv1!]).toMatchObject({ kind: "invoice", supplyType: "B2B", value: "1050.00", irn: null, issues: [] });
    expect(byId[ids.nopinInv!].issues).toEqual([{ code: "BUYER_PINCODE", level: "error" }]);
  });

  it("downloads the bulk-upload JSON, and refuses bills the portal would reject or that need none", async () => {
    const res = await file(`/einvoice/file?ids=${ids.inv1}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("EINV_INV-26-27-00001.json");
    const [doc] = JSON.parse(res.body);
    expect(doc).toMatchObject({
      Version: "1.1",
      TranDtls: { SupTyp: "B2B" },
      DocDtls: { Typ: "INV", No: "INV/26-27/00001", Dt: "24/09/2026" },
      SellerDtls: { LglNm: "Ravi Distributors", Addr1: "12 MG Road", Loc: "Indore", Pin: 452001, Stcd: "23" },
      BuyerDtls: { LglNm: "Sharma Kirana", Pos: "23", Pin: 452002 },
      ItemList: [{ HsnCd: "190531", Qty: 100, Unit: "PCS", UnitPrice: 10, AssAmt: 1000, GstRt: 5, CgstAmt: 25, SgstAmt: 25, TotItemVal: 1050 }],
      ValDtls: { AssVal: 1000, CgstVal: 25, SgstVal: 25, TotInvVal: 1050, RndOffAmt: 0 },
    });
    expect((await file(`/einvoice/file?ids=${ids.nopinInv}`)).json().error).toMatchObject({ code: "EINVOICE_HAS_ERRORS", params: { issue: "BUYER_PINCODE" } });
    expect((await file(`/einvoice/file?ids=${ids.b2c}`)).json().error.code).toBe("EINVOICE_NOT_APPLICABLE");
  });

  it("records the IRN the portal returned and prints it with the QR code", async () => {
    expect((await patch(`/invoices/${ids.inv1}/irn`, { irn: "abc", ackNumber: "112010036556789", ackDate: "2026-09-24T14:05" })).status).toBe(400);
    expect((await patch(`/invoices/${ids.b2c}/irn`, { irn: IRN, ackNumber: "112010036556789", ackDate: "2026-09-24T14:05" })).body.error.code).toBe("EINVOICE_NOT_APPLICABLE");
    const res = await patch(`/invoices/${ids.inv1}/irn`, { irn: IRN.toUpperCase(), ackNumber: "112010036556789", ackDate: "2026-09-24T14:05", signedQrCode: "eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoiIn0.c2lnbmF0dXJl" });
    expect(res.status).toBe(200);
    expect((await get(`/invoices/${ids.inv1}`)).body).toMatchObject({ irn: IRN, irnAckNumber: "112010036556789" });
    const listed = (await get("/gst/einvoice?period=2026-09")).body.documents.find((d: { id: string }) => d.id === ids.inv1);
    expect(listed).toMatchObject({ irn: IRN, ackNumber: "112010036556789" });
    const text = await pdfText((await file(`/invoices/${ids.inv1}/pdf`)).rawPayload);
    expect(text).toContain(`IRN: ${IRN}`);
    expect(text).toContain("Ack. no. 112010036556789");
    expect(text).toContain("Ack. date 24/09/2026 14:05");
    const log = (await get("/audit-logs?entityType=invoice")).body.data.map((e: { action: string }) => e.action);
    expect(log).toContain("einvoice.irn_recorded");
  });

  it("e-invoices a credit note against the invoice it reduces", async () => {
    const lineId = (await get(`/invoices/${ids.inv1}`)).body.items[0].id;
    const note = (await post(`/invoices/${ids.inv1}/returns`, { noteDate: "2026-09-24", lines: [{ lineId, qty: "10" }] })).body;
    const listed = (await get("/gst/einvoice?period=2026-09")).body.documents.find((d: { id: string }) => d.id === note.id);
    expect(listed).toMatchObject({ kind: "credit_note", value: "105.00", issues: [] });
    const [doc] = JSON.parse((await file(`/einvoice/file?ids=${note.id}`)).body);
    expect(doc).toMatchObject({ DocDtls: { Typ: "CRN", Dt: "24/09/2026" }, RefDtls: { PrecDocDtls: [{ InvNo: "INV/26-27/00001", InvDt: "24/09/2026" }] }, ValDtls: { AssVal: 100, TotInvVal: 105 } });
    expect((await patch(`/notes/${note.id}/irn`, { irn: IRN.replace(/a/g, "b"), ackNumber: "112010036556790", ackDate: "2026-09-24" })).status).toBe(200);
    expect((await patch(`/notes/${note.id}/irn`, { irn: null })).body.irn).toBeNull();
  });

  it("lists bills above ₹50,000 for e-way bills and downloads them with the trip's vehicle", async () => {
    const list = (await get("/ewaybills?period=2026-09")).body;
    expect(list.threshold).toBe(50000);
    expect(list.documents.map((d: { id: string }) => d.id)).toEqual([ids.big]);
    expect(list.documents[0]).toMatchObject({ value: "63000.00", due: true, ewayBillNumber: null, trip: null });
    const trip = (await post("/dispatches", { dispatchDate: "2026-09-24", vehicleNumber: "MP09AB1234", transporterName: "Shree Logistics", lrNumber: "LR-55", lrDate: "2026-09-24", invoiceIds: [ids.big] })).body;
    expect((await get("/ewaybills?period=2026-09")).body.documents[0].trip).toMatchObject({ id: trip.id, vehicleNumber: "MP09AB1234" });
    const fromTrip = JSON.parse((await file(`/dispatches/${trip.id}/ewaybills`)).body);
    expect(fromTrip.version).toBe("1.0.0621");
    expect(fromTrip.billLists[0]).toMatchObject({ docNo: "INV/26-27/00004", totalValue: 60000, cgstValue: 1500, sgstValue: 1500, totInvValue: 63000, vehicleNo: "MP09AB1234", transporterName: "Shree Logistics", transDocNo: "LR-55", transDocDate: "24/09/2026", toPincode: 452002 });
    const other = JSON.parse((await file(`/ewaybills/file?ids=${ids.big}&vehicleNo=mp09cd9999&distance=12`)).body);
    expect(other.billLists[0]).toMatchObject({ vehicleNo: "MP09CD9999", transDistance: 12 });
  });

  it("records the e-way bill number; the trip then has none left to make, and the bill prints it", async () => {
    expect((await patch(`/invoices/${ids.big}/eway-bill`, { number: "33100123456", date: "2026-09-24T15:00" })).status).toBe(400);
    expect((await patch(`/invoices/${ids.big}/eway-bill`, { number: "331001234567", date: "2026-09-20T15:00" })).body.error.code).toBe("EWAY_BILL_BEFORE_INVOICE");
    expect((await patch(`/invoices/${ids.big}/eway-bill`, { number: "331001234567", date: "2026-09-24T15:00", validUntil: "2026-09-25T23:59" })).status).toBe(200);
    const trip = (await get("/dispatches?status=all")).body.data[0];
    expect((await file(`/dispatches/${trip.id}/ewaybills`)).json().error.code).toBe("NO_EWAY_BILLS_DUE");
    const text = await pdfText((await file(`/invoices/${ids.big}/pdf`)).rawPayload);
    expect(text).toContain("E-way bill 331001234567");
    expect(text).toContain("valid until 25/09/2026 23:59");
  });
});
