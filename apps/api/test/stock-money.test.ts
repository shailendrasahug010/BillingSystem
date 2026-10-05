import { gstinCheckChar } from "@digitalbahi/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

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

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

/**
 * Stock and money screens: batches that are expiring, correcting a purchase
 * bill in one step, the purchase bill and supplier statement as PDFs, and
 * the cash book.
 */
describe.skipIf(!hasDatabase)("expiring stock, corrected purchases, cash book", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const pdf = async (url: string) => {
    const res = await t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${owner.token}` } });
    return { status: res.statusCode, headers: res.headers, text: res.statusCode === 200 ? await pdfText(res.rawPayload) : res.body };
  };
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Stock Money Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.BOX = units.BOX;
    ids.parle = (
      await post("/products", { name: "Parle-G 100g", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", units: [{ unitId: units.BOX, conversionFactor: "24", isDefaultPurchase: true }] })
    ).body.id;
    ids.ors = (await post("/products", { name: "ORS Sachet", hsnCode: "3004", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "20", trackBatches: true, trackExpiry: true })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Local Stockist", stateCode: "23", gstin: gstin("23", "AAACL1234K"), creditDays: 15 })).body.id;
    ids.customer = (await post("/customers", { name: "Cash Kirana", stateCode: "23" })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("lists batches that are expired or expiring, and writes them off as an expiry adjustment", async () => {
    const res = await post("/purchases", {
      supplierId: ids.supplier,
      supplierInvoiceNumber: "ORS-1",
      supplierInvoiceDate: TEST_TODAY,
      lines: [
        { productId: ids.ors, qty: "10", rate: "12", batchNumber: "OLD1", expiryDate: "2026-09-01" },
        { productId: ids.ors, qty: "20", rate: "12", batchNumber: "NEAR1", expiryDate: "2026-10-10" },
        { productId: ids.ors, qty: "30", rate: "12", batchNumber: "FAR1", expiryDate: "2027-06-30" },
      ],
    });
    expect(res.status).toBe(201);
    const expiring = await get("/stock/batches");
    expect(expiring.status).toBe(200);
    expect(expiring.body.warningDays).toBe(30);
    expect(expiring.body.data.map((b: { batchNumber: string; expired: boolean; qty: string }) => [b.batchNumber, b.expired, Number(b.qty)])).toEqual([
      ["OLD1", true, 10],
      ["NEAR1", false, 20],
    ]);
    expect(expiring.body.data[0].value).toBe("120.00");
    const expired = await get("/stock/batches?status=expired");
    expect(expired.body.data).toHaveLength(1);
    expect((await get("/stock/batches?status=all")).body.data).toHaveLength(3);

    const old = expired.body.data[0];
    const off = await post("/stock/adjustments", { reason: "expiry", warehouseId: old.warehouseId, lines: [{ productId: ids.ors, batchId: old.batchId, qtyChange: "-10" }] });
    expect(off.status).toBe(201);
    expect((await get("/stock/batches?status=expired")).body.data).toHaveLength(0);
    const [moved] = await q<{ movement_type: string }>(`select movement_type from stock_ledger where ref_type = 'adjustment' and product_id = $1`, [ids.ors]);
    expect(moved!.movement_type).toBe("expired");
  });

  it("corrects a purchase bill in one step: the old one cancelled, stock and payments moved to the new one", async () => {
    const first = await post("/purchases", {
      supplierId: ids.supplier,
      supplierInvoiceNumber: "LS/2001",
      supplierInvoiceDate: TEST_TODAY,
      lines: [{ productId: ids.parle, unitId: ids.BOX, qty: "10", rate: "200" }],
      payment: { amount: "1000", method: "upi", reference: "UTR1" },
    });
    expect(first.status).toBe(201);
    // Sell some, so taking the wrong bill's stock out first would go below zero.
    expect((await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.parle, qty: "230" }] })).status).toBe(201);

    // The same bill number would clash while the wrong bill stands.
    const clash = await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "LS/2001", supplierInvoiceDate: TEST_TODAY, lines: [{ productId: ids.parle, qty: "1", rate: "8" }] });
    expect(clash.status).toBe(409);

    const fixed = await post("/purchases", {
      supplierId: ids.supplier,
      supplierInvoiceNumber: "LS/2001",
      supplierInvoiceDate: TEST_TODAY,
      lines: [{ productId: ids.parle, unitId: ids.BOX, qty: "12", rate: "200" }],
      replacesPurchaseId: first.body.id,
    });
    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ grandTotal: "2520.00", amountPaid: "1000.00", balanceDue: "1520.00", paymentStatus: "partial" });
    expect(fixed.body.payments.map((p: { amount: string; reversedAt: string | null }) => [p.amount, p.reversedAt])).toEqual([["1000.00", null]]);
    const old = await get(`/purchases/${first.body.id}`);
    expect(old.body).toMatchObject({ status: "cancelled", cancelReason: "Corrected: entered again", balanceDue: "0.00" });
    const [stock] = await q<{ qty: string }>(`select sum(qty)::text as qty from stock_balances where product_id = $1`, [ids.parle]);
    expect(Number(stock!.qty)).toBe(288 - 230);
    const [payment] = await q<{ unallocated_amount: string }>(`select unallocated_amount from payments where reference_number = 'UTR1'`);
    expect(payment!.unallocated_amount).toBe("0.00");
    const [supplier] = await q<{ balance: string }>(`select balance from suppliers where id = $1`, [ids.supplier]);
    // ORS bill (720 less the written-off batch stays payable) + the corrected bill's balance.
    expect(supplier!.balance).toBe("2276.00");

    // Already cancelled: it cannot be replaced again.
    const again = await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "LS/2002", supplierInvoiceDate: TEST_TODAY, lines: [{ productId: ids.parle, qty: "1", rate: "8" }], replacesPurchaseId: first.body.id });
    expect(again.status).toBe(409);
    ids.purchase = fixed.body.id;
  });

  it("gives the purchase bill and the supplier's statement as PDFs", async () => {
    const bill = await pdf(`/purchases/${ids.purchase}/pdf`);
    expect(bill.status).toBe(200);
    expect(bill.headers["content-type"]).toBe("application/pdf");
    expect(bill.headers["content-disposition"]).toContain("purchase-LS-2001.pdf");
    expect(bill.text).toContain("PURCHASE BILL");
    expect(bill.text).toContain("LS/2001");
    expect(bill.text).toContain("Local Stockist");
    const statement = await pdf(`/suppliers/${ids.supplier}/statement/pdf?from=2026-04-01`);
    expect(statement.status).toBe(200);
    expect(statement.text).toContain("Account statement: Local Stockist");
    expect(statement.text).toContain("Purchase cancelled");
    expect(statement.text).toContain("Closing balance");
  });

  it("keeps the cash book: opening, every receipt, payment and expense, running and closing balance", async () => {
    const cats = Object.fromEntries((await get("/expense-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    expect((await post("/payments", { direction: "in", customerId: ids.customer, amount: "500", method: "cash" })).status).toBe(201);
    expect((await post("/expenses", { categoryId: Object.values(cats)[0], amount: "120", paidTo: "Tea stall", paymentMethod: "cash" })).status).toBe(201);
    expect((await post("/payments", { direction: "out", supplierId: ids.supplier, amount: "300", method: "cash" })).status).toBe(201);

    const cash = await get(`/payments/cash-book?from=${TEST_TODAY}&to=${TEST_TODAY}`);
    expect(cash.status).toBe(200);
    expect(cash.body).toMatchObject({ book: "cash", opening: "0.00", in: "500.00", out: "420.00", closing: "80.00", includesExpenses: true });
    expect(cash.body.rows.map((r: { kind: string; balance: string }) => [r.kind, r.balance])).toEqual([
      ["payment", "500.00"],
      ["expense", "380.00"],
      ["payment", "80.00"],
    ]);
    expect(cash.body.days).toHaveLength(1);
    // The UPI paid with the first bill is in the bank book, not the cash book.
    const bank = await get(`/payments/cash-book?from=${TEST_TODAY}&to=${TEST_TODAY}&book=bank`);
    expect(bank.body).toMatchObject({ in: "0.00", out: "1000.00", closing: "-1000.00" });
    // The day after opens with the closing.
    const next = await get(`/payments/cash-book?from=2026-09-25&to=2026-09-25`);
    expect(next.body).toMatchObject({ opening: "80.00", closing: "80.00", rows: [] });

    const file = await pdf(`/payments/cash-book?from=${TEST_TODAY}&to=${TEST_TODAY}&format=pdf`);
    expect(file.status).toBe(200);
    expect(file.text).toContain("Cash book");
    expect(file.text).toContain("Tea stall");
  });
});
