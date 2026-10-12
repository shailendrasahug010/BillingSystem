import { gstinCheckChar } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

/**
 * TDS both ways. A customer deducts TDS when they pay: the receipt records
 * it, it settles their bill with the money, has a line of its own on their
 * account and in the quarter's list (with the certificate once it comes),
 * and goes when the receipt is cancelled. The business keeps TDS back on
 * purchase bills once its rule is on: on the part of the year's purchases
 * from a supplier past the threshold, 5% without their PAN, none for an
 * exempt supplier; the supplier is owed the rest, the month's TDS goes on a
 * challan, and a bill whose TDS was paid cannot be cancelled until the
 * challan lets go of it.
 */
describe.skipIf(!hasDatabase)("TDS", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const put = (url: string, body?: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const month = TEST_TODAY.slice(0, 7);
  const bill = (supplierId: string | undefined, number: string, qty: string) =>
    post("/purchases", { supplierId, supplierInvoiceNumber: number, supplierInvoiceDate: TEST_TODAY, lines: [{ productId: ids.oil, qty, rate: "100" }] });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Mehta Distributors", stateCode: "23", gstin: gstin("23", "AAPFM1234M") });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Lifebuoy 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "70" })).body.id;
    ids.oil = (await post("/products", { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", purchasePrice: "100" })).body.id;
    ids.dmart = (await post("/customers", { name: "Avenue Supermarts", stateCode: "23", gstin: gstin("23", "AACCA8432H") })).body.id;
    ids.hul = (await post("/suppliers", { name: "HUL Distributor", stateCode: "23", gstin: gstin("23", "AAACH1234H") })).body.id;
    ids.local = (await post("/suppliers", { name: "Local Oil Mill", stateCode: "23", gstRegistration: "unregistered" })).body.id;
    ids.exempt = (await post("/suppliers", { name: "Certified Mills", stateCode: "23", gstin: gstin("23", "AABCC1111C"), tdsExempt: true })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("deducted by a customer", () => {
    it("settles the bill with the money and the TDS, each a line of the customer's account", async () => {
      const inv = await post("/invoices", { customerId: ids.dmart, lines: [{ productId: ids.soap, qty: "100" }] });
      expect(inv.body).toMatchObject({ taxableTotal: "10000.00", grandTotal: "11800.00" });
      ids.invoice = inv.body.id;
      // 0.1% of the ₹10,000 the bill is worth before GST.
      const res = await post("/payments", { direction: "in", customerId: ids.dmart, amount: "11790", method: "bank_transfer", referenceNumber: "UTR1", tdsAmount: "10", tdsSection: "goods" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ amount: "11790.00", tdsAmount: "10.00", tdsSection: "goods", unallocatedAmount: "0.00" });
      expect(res.body.allocations).toEqual([expect.objectContaining({ documentId: ids.invoice, amount: "11800.00" })]);
      ids.receipt = res.body.id;
      expect((await get(`/invoices/${ids.invoice}`)).body).toMatchObject({ balanceDue: "0.00", paymentStatus: "paid" });
      const ledger = (await get(`/customers/${ids.dmart}/ledger`)).body;
      expect(ledger.entries.map((e: { docType: string; debit: string; credit: string }) => [e.docType, e.debit, e.credit])).toEqual([
        ["invoice", "11800.00", "0.00"],
        ["payment_in", "0.00", "11790.00"],
        ["tds_in", "0.00", "10.00"],
      ]);
      // Only the money is in the bank book.
      const book = (await get(`/payments/cash-book?from=${TEST_TODAY}&to=${TEST_TODAY}&book=bank`)).body;
      expect(book.rows.filter((r: { amount: string }) => r.amount === "11790.00")).toHaveLength(1);
    });

    it("lists it for the quarter, with the certificate once it comes", async () => {
      const list = (await get(`/tds/received?from=2026-07-01&to=2026-09-30`)).body;
      expect(list).toMatchObject({ total: "10.00", quarters: [{ quarter: "2026-27 Q2", tds: "10.00", receipts: 1, withCertificate: 0 }] });
      expect(list.data).toEqual([expect.objectContaining({ paymentId: ids.receipt, partyName: "Avenue Supermarts", pan: "AACCA8432H", amount: "11790.00", tds: "10.00", section: "goods", certificate: null })]);
      const saved = await call(t.app, "PATCH", `/payments/${ids.receipt}/tds-certificate`, { token: owner.token, body: { certificate: "KXAB12345" } });
      expect(saved.body.tdsCertificate).toBe("KXAB12345");
      expect((await get(`/tds/received?from=2026-07-01&to=2026-09-30`)).body.quarters[0].withCertificate).toBe(1);
    });

    it("is refused on a payment to a supplier (kept back on the bill instead)", async () => {
      const res = await post("/payments", { direction: "out", supplierId: ids.hul, amount: "100", method: "cash", tdsAmount: "1" });
      expect(res.body.error).toMatchObject({ code: "TDS_ON_RECEIPTS_ONLY", field: "tdsAmount" });
    });

    it("goes with the receipt when it is cancelled: the bill is open in full again", async () => {
      expect((await post(`/payments/${ids.receipt}/cancel`, { reason: "Entered twice" })).status).toBe(200);
      expect((await get(`/invoices/${ids.invoice}`)).body).toMatchObject({ balanceDue: "11800.00", paymentStatus: "unpaid" });
      const ledger = (await get(`/customers/${ids.dmart}/ledger`)).body;
      expect(ledger.entries.slice(-2).map((e: { docType: string; debit: string }) => [e.docType, e.debit])).toEqual([
        ["payment_in_cancel", "11790.00"],
        ["tds_in_cancel", "10.00"],
      ]);
      expect(ledger.closing).toBe("11800.00");
      expect((await get(`/tds/received?from=2026-07-01&to=2026-09-30`)).body.data).toEqual([]);
    });
  });

  describe("kept back on purchase bills", () => {
    it("keeps none back until the rule is turned on", async () => {
      const first = await bill(ids.hul, "HUL-1", "600");
      expect(first.body).toMatchObject({ taxableTotal: "60000.00", tdsAmount: "0.00", balanceDue: "63000.00" });
      expect((await get(`/suppliers/${ids.hul}/tds?date=${TEST_TODAY}`)).body).toMatchObject({ enabled: false, applies: false });
    });

    it("keeps 0.1% back on what passes the threshold; the supplier is owed the rest", async () => {
      expect((await put("/settings/tds.purchases", { value: { enabled: true, threshold: 100000, rate: 0.1, noPanRate: 5 } })).status).toBe(200);
      expect((await get(`/suppliers/${ids.hul}/tds?date=${TEST_TODAY}`)).body).toMatchObject({ enabled: true, applies: true, hasPan: true, taxYear: "2026-27", boughtBefore: "60000.00" });
      // ₹60,000 before and ₹60,000 now: ₹20,000 past ₹1 lakh, ₹20 at 0.1%.
      const second = await bill(ids.hul, "HUL-2", "600");
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ grandTotal: "63000.00", tdsAmount: "20.00", tdsBase: "20000.00", tdsRate: "0.100", balanceDue: "62980.00" });
      ids.hul2 = second.body.id;
      // Past it already: the whole bill.
      const third = await bill(ids.hul, "HUL-3", "100");
      expect(third.body).toMatchObject({ tdsAmount: "10.00", tdsBase: "10000.00", balanceDue: "10490.00" });
      ids.hul3 = third.body.id;
      const ledger = (await get(`/suppliers/${ids.hul}/ledger`)).body;
      expect(ledger.entries.filter((e: { docType: string }) => e.docType === "tds_out").map((e: { debit: string }) => e.debit)).toEqual(["20.00", "10.00"]);
      expect(ledger.closing).toBe("136470.00");
    });

    it("is 5% without the supplier's PAN, and none for an exempt supplier", async () => {
      await bill(ids.local, "LM-1", "1000");
      const noPan = await bill(ids.local, "LM-2", "100");
      // An unregistered mill with no PAN: ₹1,00,000 then ₹10,000, all past the threshold, at 5%.
      expect(noPan.body).toMatchObject({ taxableTotal: "10000.00", tdsAmount: "500.00", tdsRate: "5.000" });
      await bill(ids.exempt, "CM-1", "1000");
      expect((await bill(ids.exempt, "CM-2", "100")).body.tdsAmount).toBe("0.00");
      expect((await get(`/suppliers/${ids.exempt}/tds?date=${TEST_TODAY}`)).body).toMatchObject({ applies: false, exempt: true });
    });

    it("is paid in full when the rest is paid", async () => {
      const pay = await post("/payments", { direction: "out", supplierId: ids.hul, amount: "10490", method: "bank_transfer", allocations: [{ documentId: ids.hul3, amount: "10490" }] });
      expect(pay.status).toBe(201);
      expect((await get(`/purchases/${ids.hul3}`)).body).toMatchObject({ balanceDue: "0.00", paymentStatus: "paid", amountPaid: "10490.00" });
    });

    it("lists the month's TDS with its due date, and a challan pays it", async () => {
      const month0 = (await get(`/tds/deducted?month=${month}`)).body;
      expect(month0).toMatchObject({ month, dueDate: "2026-10-07", total: "530.00", paid: "0.00", pending: "530.00" });
      expect(month0.data.map((r: { supplierInvoiceNumber: string; tds: string; pan: string | null }) => [r.supplierInvoiceNumber, r.tds, r.pan])).toEqual([
        ["HUL-2", "20.00", "AAACH1234H"],
        ["HUL-3", "10.00", "AAACH1234H"],
        ["LM-2", "500.00", null],
      ]);
      const wrong = await post("/tds/challans", { periodMonth: month, depositDate: TEST_TODAY, bsrCode: "12345", challanSerial: "00042" });
      expect(wrong.status).toBe(400);
      const challan = await post("/tds/challans", { periodMonth: month, depositDate: TEST_TODAY, bsrCode: "0510308", challanSerial: "00042" });
      expect(challan.status).toBe(201);
      expect(challan.body).toMatchObject({ taxAmount: "530.00", bills: 3, bsrCode: "0510308", challanSerial: "00042" });
      ids.challan = challan.body.id;
      expect((await get(`/tds/deducted?month=${month}`)).body).toMatchObject({ paid: "530.00", pending: "0.00", overdue: false });
      expect((await post("/tds/challans", { periodMonth: month, depositDate: TEST_TODAY, bsrCode: "0510308", challanSerial: "00043" })).body.error.code).toBe("NOTHING_TO_DEPOSIT");
    });

    it("keeps a bill whose TDS was paid until the challan lets go of it; cancelled, its TDS comes off the supplier's account", async () => {
      const refused = await post(`/purchases/${ids.hul2}/cancel`, { reason: "Wrong bill" });
      expect(refused.body.error).toMatchObject({ code: "TDS_PAID_ON_BILL", params: { challan: "0510308/00042" } });
      expect((await call(t.app, "DELETE", `/tds/challans/${ids.challan}`, { token: owner.token })).status).toBe(204);
      expect((await post(`/purchases/${ids.hul2}/cancel`, { reason: "Wrong bill" })).status).toBe(200);
      const ledger = (await get(`/suppliers/${ids.hul}/ledger`)).body;
      expect(ledger.entries.slice(-2).map((e: { docType: string; debit: string; credit: string }) => [e.docType, e.debit, e.credit])).toEqual([
        ["purchase_cancel", "63000.00", "0.00"],
        ["tds_out_cancel", "0.00", "20.00"],
      ]);
      // 1,36,470 owed before, less the cancelled bill's 62,980, less the 10,490 paid.
      expect(ledger.closing).toBe("63000.00");
      expect((await get(`/tds/deducted?month=${month}`)).body).toMatchObject({ total: "510.00", paid: "0.00" });
    });

    it("keeps the challans and the lists to the business", async () => {
      const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
      expect((await get(`/tds/deducted?month=${month}`, other.token)).body.data).toEqual([]);
      expect((await get(`/suppliers/${ids.hul}/tds`, other.token)).status).toBe(404);
    });
  });
});
