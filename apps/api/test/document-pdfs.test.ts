import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

/** Text of each page, as pdf.js reads it back from the file. */
async function pdfText(bytes: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((x) => ("str" in x ? x.str : "")).join(" "));
  }
  return pages.join(" ").replace(/\s+/g, " ");
}

describe.skipIf(!hasDatabase)("invoices, notes and receipts as PDF", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const pdf = (url: string, token = owner.token) => t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23", gstin: "23AAGFG5678G1ZA" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { addressLine1: "12 Siyaganj Main Road", city: "Indore", pincode: "452007", phone: "9826012345" } });
    await call(t.app, "PUT", "/settings/invoice.terms", { token: owner.token, body: { value: "Goods once sold will not be taken back." } });
    const payTo = { bankName: "State Bank of India", accountNumber: "30123456789", ifsc: "sbin0001234", upiId: "laxmi.traders@okaxis" };
    expect((await call(t.app, "PUT", "/settings/invoice.payment_details", { token: owner.token, body: { value: payTo } })).status).toBe(200);
    expect((await call(t.app, "PUT", "/settings/invoice.payment_details", { token: owner.token, body: { value: { ...payTo, upiId: "not a upi id" } } })).status).toBe(400);
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", nameLocal: "नहाने का साबुन", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.salt = (await post("/products", { name: "Tata Salt 1kg", hsnCode: "2501", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "25", openingStock: "100", openingStockCost: "20" })).body.id;
    ids.shop = (await post("/customers", { name: "Sharma Kirana Store", mobile: "9826011111", email: "sharma@example.in", stateCode: "23", gstin: "23AAACM1234M1ZR", addressLine1: "5 MG Road", city: "Indore" })).body.id;
    ids.delhi = (await post("/customers", { name: "Delhi Mart", stateCode: "07" })).body.id;
    const inv = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "10" }, { productId: ids.salt, qty: "4" }], payment: { amount: "500", method: "upi" } });
    ids.invoice = inv.body.id;
    ids.invoiceNumber = inv.body.invoiceNumber;
    ids.soapLine = inv.body.items.find((i: { productId: string }) => i.productId === ids.soap).id;
    ids.igst = (await post("/invoices", { customerId: ids.delhi, lines: [{ productId: ids.soap, qty: "2" }] })).body.id;
    const note = await post(`/invoices/${ids.invoice}/returns`, { lines: [{ lineId: ids.soapLine, qty: "2" }], notes: "Two soaps came back damaged." });
    ids.note = note.body.id;
    ids.noteNumber = note.body.noteNumber;
    const receipt = await post("/payments", { direction: "in", customerId: ids.shop, amount: "300", method: "cheque", referenceNumber: "004512", chequeDate: "2026-09-24", chequeBank: "SBI" });
    ids.receipt = receipt.body.id;
    ids.receiptNumber = receipt.body.paymentNumber;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("makes the tax invoice with the letterhead, GST table, totals and words", async () => {
    const res = await pdf(`/invoices/${ids.invoice}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${ids.invoiceNumber!.replace(/\//g, "-")}.pdf"`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const text = await pdfText(res.rawPayload);
    for (const s of [
      "Laxmi Traders",
      "12 Siyaganj Main Road",
      "GSTIN: 23AAGFG5678G1ZA",
      "TAX INVOICE",
      ids.invoiceNumber!,
      "Sharma Kirana Store",
      "GSTIN: 23AAACM1234M1ZR",
      "Bath Soap",
      "3401",
      "10 PCS",
      "CGST",
      "SGST",
      "Grand total",
      "Goods once sold will not be taken back.",
      "Bank details",
      "State Bank of India · A/c 30123456789 · IFSC SBIN0001234",
      "UPI: laxmi.traders@okaxis",
      "Authorised signatory",
      "Made with",
      "Page 1 of 1",
    ]) {
      expect(text).toContain(s);
    }
    // 10 x 100 + 18% and 4 x 25 + 5% = 1,285; 500 paid by UPI and 300 by the cheque later, 2 soaps (236) returned.
    expect(text).toContain("Grand total ₹1,285.00");
    expect(text).toContain("Rupees One Thousand Two Hundred Eighty Five Only");
    expect(text).toContain("Paid ₹800.00 Less: returns ₹236.00 Balance ₹249.00");
  });

  it("prints IGST for another state, and Hindi when asked", async () => {
    const igst = await pdfText((await pdf(`/invoices/${ids.igst}/pdf`)).rawPayload);
    expect(igst).toContain("IGST");
    expect(igst).not.toContain("CGST");
    const hi = await pdfText((await pdf(`/invoices/${ids.invoice}/pdf?locale=hi`)).rawPayload);
    expect(hi).toContain("टैक्स इनवॉइस");
    expect(hi).toContain("नहाने का साबुन");
    expect(hi).toContain("पृष्ठ 1 / 1");
  });

  it("makes the credit note against the invoice, and the receipt", async () => {
    const note = await pdfText((await pdf(`/notes/${ids.note}/pdf`)).rawPayload);
    for (const s of ["CREDIT NOTE", ids.noteNumber!, ids.invoiceNumber!, "Sharma Kirana Store", "Two soaps came back damaged.", "₹236.00"]) expect(note).toContain(s);
    // Where to pay is for bills, not notes.
    expect(note).not.toContain("Bank details");
    const receipt = await pdfText((await pdf(`/payments/${ids.receipt}/pdf`)).rawPayload);
    for (const s of ["RECEIPT", ids.receiptNumber!, "Received from", "Sharma Kirana Store", "₹300.00", "Cheque", "004512", "SBI", "Cheque payments are subject to realisation."]) expect(receipt).toContain(s);
  });

  it("needs the right to see the document, within the business", async () => {
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Godown Gopal", mobile, roleId: roles.warehouse });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    const token = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
    expect((await pdf(`/payments/${ids.receipt}/pdf`, token)).statusCode).toBe(403);
    const other = await signup(t, { legalName: "Other Firm", stateCode: "27" });
    expect((await pdf(`/invoices/${ids.invoice}/pdf`, other.token)).statusCode).toBe(404);
  });
});
