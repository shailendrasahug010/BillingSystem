import { parseTallyMasters, parseXml, descendants, textOf } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

const MASTERS = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
 <TALLYMESSAGE><LEDGER NAME="Gupta Stores"><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>23AAACM1234M1ZR</PARTYGSTIN><LEDGERMOBILE>9826011111</LEDGERMOBILE><OPENINGBALANCE>-1500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
 <TALLYMESSAGE><LEDGER NAME="Verma Kirana"><PARENT>Sundry Debtors</PARENT><LEDSTATENAME>Madhya Pradesh</LEDSTATENAME></LEDGER></TALLYMESSAGE>
 <TALLYMESSAGE><LEDGER NAME="Parle Agro"><PARENT>Sundry Creditors</PARENT><STATENAME>Maharashtra</STATENAME><OPENINGBALANCE>25000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
 <TALLYMESSAGE><LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
 <TALLYMESSAGE><STOCKITEM NAME="Parle-G 100g"><BASEUNITS>Nos</BASEUNITS><GSTDETAILS.LIST><HSNCODE>1905</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>5</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST><OPENINGBALANCE>100 Nos</OPENINGBALANCE><OPENINGRATE>8.00/Nos</OPENINGRATE><FULLPRICELIST.LIST><PRICELEVELLIST.LIST><RATE>10.00/Nos</RATE></PRICELEVELLIST.LIST></FULLPRICELIST.LIST></STOCKITEM></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

describe.skipIf(!hasDatabase)("Tally", () => {
  let t: TestApp;
  let owner: Session;
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Tally Traders", stateCode: "23" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("imports customers, suppliers and products from Tally's masters, with opening balances and stock", async () => {
    const parsed = parseTallyMasters(MASTERS);
    const m = { customers: parsed.customers, suppliers: parsed.suppliers, products: parsed.products };
    const check = await post("/tally/import", { ...m, dryRun: true });
    expect(check.body).toMatchObject({ imported: false, customers: { total: 2, errors: [] }, suppliers: { total: 1, errors: [] }, products: { total: 1, errors: [] } });
    expect((await get("/customers")).body.data).toHaveLength(0);

    const res = await post("/tally/import", m);
    expect(res.body).toMatchObject({ imported: true, customers: { created: 2 }, suppliers: { created: 1 }, products: { created: 1 } });
    const customers = (await get("/customers?q=Gupta")).body.data;
    expect(customers[0]).toMatchObject({ businessName: "Gupta Stores", gstin: "23AAACM1234M1ZR", balance: "1500.00" });
    const suppliers = (await get("/suppliers?q=Parle")).body.data;
    expect(suppliers[0]).toMatchObject({ name: "Parle Agro", balance: "25000.00", stateCode: "27" });
    const product = (await get("/products?q=Parle")).body.data[0];
    expect(product).toMatchObject({ name: "Parle-G 100g", sellingPrice: "10.0000" });
    expect((await get(`/products/${product.id}`)).body.stock.total).toBe("100.000");

    // The same file again: names on file are left alone.
    const again = await post("/tally/import", m);
    expect(again.body).toMatchObject({ imported: true, skipped: { customers: 2, suppliers: 1, products: 1 }, customers: null });
  });

  it("refuses the whole file when a row is wrong, naming it", async () => {
    const res = await post("/tally/import", { customers: [{ name: "Bad GSTIN Shop", gstin: "23AAACM1234M1ZZ" }], suppliers: [{ name: "Fine Supplier" }] });
    expect(res.body.imported).toBe(false);
    expect(res.body.customers.errors[0]).toMatchObject({ row: 1, column: "gstin", code: "INVALID_GSTIN" });
    expect((await get("/suppliers?q=Fine")).body.data).toHaveLength(0);
  });

  it("exports the period's sales, purchases, receipts and payments as balanced Tally vouchers", async () => {
    const customer = (await get("/customers?q=Gupta")).body.data[0].id;
    const supplier = (await get("/suppliers?q=Parle")).body.data[0].id;
    const product = (await get("/products?q=Parle")).body.data[0].id;
    const sale = (await post("/invoices", { customerId: customer, lines: [{ productId: product, qty: "10" }] })).body;
    await post("/purchases", { supplierId: supplier, supplierInvoiceNumber: "PA/77", supplierInvoiceDate: "2026-09-20", lines: [{ productId: product, qty: "20", rate: "8" }] });
    await post("/payments", { direction: "in", customerId: customer, amount: "105", method: "cash" });
    await post("/payments", { direction: "out", supplierId: supplier, amount: "1000", method: "bank_transfer" });

    const res = await t.app.inject({ method: "GET", url: "/api/v1/tally/export?from=2026-09-01&to=2026-09-30", headers: { authorization: `Bearer ${owner.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("tally-vouchers-2026-09-01-to-2026-09-30.xml");
    const doc = parseXml(res.body);
    const vouchers = descendants(doc, "VOUCHER");
    expect(vouchers.map((v) => [v.attrs.VCHTYPE, textOf(v, "VOUCHERNUMBER")])).toEqual([
      ["Payment", expect.any(String)],
      ["Purchase", expect.any(String)],
      ["Receipt", expect.any(String)],
      ["Sales", sale.invoiceNumber],
    ]);
    for (const v of vouchers) {
      const sum = descendants(v, "ALLLEDGERENTRIES.LIST").reduce((s, e) => s + Math.round(Number(textOf(e, "AMOUNT")) * 100), 0);
      expect(sum).toBe(0);
    }
    const saleVoucher = vouchers.find((v) => v.attrs.VCHTYPE === "Sales")!;
    const entries = descendants(saleVoucher, "ALLLEDGERENTRIES.LIST").map((e) => [textOf(e, "LEDGERNAME"), textOf(e, "AMOUNT")]);
    expect(entries).toEqual([
      ["Gupta Stores", `-${sale.grandTotal}`],
      ["Sales", "100.00"],
      ["Output CGST", "2.50"],
      ["Output SGST", "2.50"],
    ]);
    const ledgers = descendants(doc, "LEDGER").map((l) => [l.attrs.NAME, textOf(l, "PARENT")]);
    expect(ledgers).toEqual(expect.arrayContaining([["Gupta Stores", "Sundry Debtors"], ["Parle Agro", "Sundry Creditors"], ["Sales", "Sales Accounts"], ["Purchase", "Purchase Accounts"], ["Output CGST", "Duties & Taxes"], ["Cash", "Cash-in-Hand"], ["Bank", "Bank Accounts"]]));
    const purchase = vouchers.find((v) => v.attrs.VCHTYPE === "Purchase")!;
    expect(textOf(purchase, "REFERENCE")).toBe("PA/77");
  });

  it("needs the GST export permission and a sensible period", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/tally/export?from=2026-09-30&to=2026-09-01", headers: { authorization: `Bearer ${owner.token}` } });
    expect(JSON.parse(res.body).error.code).toBe("PERIOD_END_BEFORE_START");
  });
});
