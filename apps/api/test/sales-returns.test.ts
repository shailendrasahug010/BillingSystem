import { gstinCheckChar } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

/**
 * Goods returned without their bill (a credit note that pays the customer's
 * open bills, oldest due first, keeping the rest on account), debit notes on
 * a bill (it then asks for more), and billing from another godown.
 */
describe.skipIf(!hasDatabase)("returns without a bill, debit notes, godowns", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, headers?: Record<string, string>) => call(t.app, "POST", url, { token: owner.token, body, ...(headers ? { headers } : {}) });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows[0] as T;
  const stockOf = async (productId: string | undefined, warehouseId?: string) =>
    (await one<{ qty: string }>(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1 ${warehouseId ? "and warehouse_id = $2" : ""}`, warehouseId ? [productId, warehouseId] : [productId])).qty;
  const bill = async (id: string | undefined) => (await get(`/invoices/${id}`)).body as { balanceDue: string; paymentStatus: string; debited: string; noteCredits: Array<{ noteNumber: string; amount: string; reversedAt: string | null }> };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Mehta Distributors", stateCode: "23", gstin: gstin("23", "AAPFM1234M") });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.biscuit = (await post("/products", { name: "Biscuit", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "500", openingStockCost: "8" })).body.id;
    ids.customer = (await post("/customers", { name: "Gupta Stores", stateCode: "23", gstin: gstin("23", "AAACG1234G") })).body.id;
    // Two bills: the soap one falls due first.
    const one1 = await post("/invoices", { customerId: ids.customer, invoiceDate: "2026-09-20", lines: [{ productId: ids.soap, qty: "10", rate: "90" }] });
    expect(one1.body).toMatchObject({ invoiceNumber: "INV/26-27/00001", grandTotal: "1062.00" });
    ids.inv1 = one1.body.id;
    const two = await post("/invoices", { customerId: ids.customer, invoiceDate: "2026-09-22", lines: [{ productId: ids.biscuit, qty: "100" }] });
    expect(two.body.grandTotal).toBe("1050.00");
    ids.inv2 = two.body.id;
    ids.back = (await post("/warehouses", { name: "Back godown", code: "BACK" })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("takes goods back without their bill at the customer's last billed rate, with GST, stock and the oldest bill paid", async () => {
    const rates = (await get(`/customers/${ids.customer}/last-rates?productIds=${ids.soap},${ids.biscuit}`)).body.data;
    expect(rates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: ids.soap, rate: "90.0000", invoiceNumber: "INV/26-27/00001" }),
        expect.objectContaining({ productId: ids.biscuit, rate: "10.0000", invoiceNumber: "INV/26-27/00002" }),
      ]),
    );
    const res = await post("/returns", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "2" }], notes: "Damaged in transit" });
    expect(res.status).toBe(201);
    // 2 × 90 = 180, CGST and SGST 9% each.
    expect(res.body).toMatchObject({ noteNumber: "CN/26-27/00001", noteType: "credit", invoiceId: null, affectsStock: true, taxableTotal: "180.00", cgstTotal: "16.20", sgstTotal: "16.20", grandTotal: "212.00", amountSettled: "212.00", settlementStatus: "paid" });
    expect(res.body.allocations).toEqual([expect.objectContaining({ invoiceNumber: "INV/26-27/00001", amount: "212.00", reversedAt: null })]);
    ids.note1 = res.body.id;
    expect(await stockOf(ids.soap)).toBe("92.000");
    expect(await bill(ids.inv1)).toMatchObject({ balanceDue: "850.00", paymentStatus: "partial", noteCredits: [expect.objectContaining({ noteNumber: "CN/26-27/00001", amount: "212.00" })] });
    expect((await bill(ids.inv2)).balanceDue).toBe("1050.00");
    const ledger = (await get(`/customers/${ids.customer}/ledger`)).body.entries;
    expect(ledger.find((e: { docType: string }) => e.docType === "credit_note")).toMatchObject({ credit: "212.00" });
    const gst = await one<{ n: number; original: string | null; direction: string }>(`select count(*)::int as n, max(original_doc_number) as original, max(direction::text) as direction from gst_transactions where doc_id = $1`, [ids.note1]);
    expect(gst).toMatchObject({ n: 1, original: null, direction: "outward" });
    const gstr1 = (await get("/gst/returns/gstr1?period=2026-09")).body;
    expect(gstr1.summary.find((s: { section: string }) => s.section === "cdnr")).toMatchObject({ records: 1, taxable: "180.00" });
  });

  it("takes a rate given into another godown, checks the totals, and keeps on account what no bill needs", async () => {
    const body = { customerId: ids.customer, warehouseId: ids.back, reason: "damage", lines: [{ productId: ids.soap, qty: "30", rate: "100" }] };
    expect((await post("/returns", { ...body, clientTotals: { grandTotal: "3000.00" } })).body.error).toMatchObject({ code: "TOTALS_MISMATCH", params: { expected: "3540.00" } });
    const res = await post("/returns", { ...body, clientTotals: { grandTotal: "3540.00" } });
    expect(res.status).toBe(201);
    // 850 left on the soap bill, 1050 on the biscuits: 1900 used, 1640 on account.
    expect(res.body).toMatchObject({ grandTotal: "3540.00", amountSettled: "1900.00", settlementStatus: "partial", warehouseId: ids.back, reason: "damage" });
    expect(res.body.allocations.map((a: { invoiceNumber: string; amount: string }) => [a.invoiceNumber, a.amount])).toEqual([
      ["INV/26-27/00001", "850.00"],
      ["INV/26-27/00002", "1050.00"],
    ]);
    ids.note2 = res.body.id;
    expect(await stockOf(ids.soap, ids.back)).toBe("30.000");
    expect((await bill(ids.inv1)).paymentStatus).toBe("paid");
    expect((await bill(ids.inv2)).paymentStatus).toBe("paid");
    const listed = (await get(`/notes?customerId=${ids.customer}&withoutBill=true`)).body.data;
    expect(listed.map((n: { noteNumber: string; amountSettled: string }) => [n.noteNumber, n.amountSettled])).toEqual([
      ["CN/26-27/00002", "1900.00"],
      ["CN/26-27/00001", "212.00"],
    ]);
  });

  it("applies what is on account to a later bill when asked, and gives it back when that bill is cancelled", async () => {
    const later = await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "5" }] });
    expect(later.body.grandTotal).toBe("590.00");
    ids.inv3 = later.body.id;
    const applied = await post(`/notes/${ids.note2}/allocate`);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ amountSettled: "2490.00", settlementStatus: "partial" });
    expect((await bill(ids.inv3)).paymentStatus).toBe("paid");
    expect((await post(`/notes/${ids.note2}/allocate`)).body.error.code).toBe("NOTHING_TO_ALLOCATE");
    const againstBill = await post(`/invoices/${ids.inv3}/returns`, { lines: [{ lineId: later.body.items[0].id, qty: "1" }] });
    expect(againstBill.status).toBe(201);
    expect((await post(`/notes/${againstBill.body.id}/allocate`)).body.error.code).toBe("NOTE_NOT_ON_ACCOUNT");
    // The return against the bill goes first, then the bill.
    expect((await post(`/notes/${againstBill.body.id}/cancel`, { reason: "Entered by mistake" })).status).toBe(200);
    expect((await post(`/invoices/${ids.inv3}/cancel`, { reason: "Wrong customer" })).status).toBe(200);
    const note = (await get(`/notes/${ids.note2}`)).body;
    expect(note).toMatchObject({ amountSettled: "1900.00", settlementStatus: "partial" });
    expect(note.allocations.find((a: { invoiceNumber: string }) => a.invoiceNumber === "INV/26-27/00003").reversedAt).not.toBeNull();
  });

  it("cancels a return without its bill: the bills it paid owe it again, the goods go out again", async () => {
    const res = await post(`/notes/${ids.note1}/cancel`, { reason: "Returned goods taken back by the customer" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(await bill(ids.inv1)).toMatchObject({ balanceDue: "212.00", paymentStatus: "partial" });
    // 100 − 10 billed + 2 + 30 returned − 5 billed + 5 (that bill cancelled) − 2 (this note cancelled).
    expect(await stockOf(ids.soap)).toBe("120.000");
    const gst = await one<{ cancelled: boolean }>(`select bool_and(is_cancelled) as cancelled from gst_transactions where doc_id = $1`, [ids.note1]);
    expect(gst.cancelled).toBe(true);
    const ledger = (await get(`/customers/${ids.customer}/ledger`)).body.entries;
    expect(ledger.find((e: { docType: string; docNumber: string }) => e.docType === "credit_note_cancel" && e.docNumber === "CN/26-27/00001")).toMatchObject({ debit: "212.00" });
  });

  it("raises a bill by a debit note: GST against the bill, the customer's account, its balance and status", async () => {
    const res = await post(`/invoices/${ids.inv2}/debit-notes`, { amount: "100", reason: "rate_difference", notes: "Price revised by the company" });
    expect(res.status).toBe(201);
    // Biscuits at 5%: 100 + 2.50 + 2.50.
    expect(res.body).toMatchObject({ noteNumber: "DN/26-27/00001", noteType: "debit", invoiceId: ids.inv2, affectsStock: false, taxableTotal: "100.00", cgstTotal: "2.50", sgstTotal: "2.50", grandTotal: "105.00" });
    ids.debit = res.body.id;
    expect(await bill(ids.inv2)).toMatchObject({ debited: "105.00", balanceDue: "105.00", paymentStatus: "partial" });
    const ledger = (await get(`/customers/${ids.customer}/ledger`)).body.entries;
    expect(ledger.find((e: { docType: string }) => e.docType === "debit_note")).toMatchObject({ debit: "105.00" });
    const gst = await one<{ type: string; direction: string; original: string; taxable: string }>(
      `select max(doc_type::text) as type, max(direction::text) as direction, max(original_doc_number) as original, sum(taxable_value)::text as taxable from gst_transactions where doc_id = $1`,
      [ids.debit],
    );
    expect(gst).toMatchObject({ type: "debit_note", direction: "outward", original: "INV/26-27/00002", taxable: "100.00" });
    const json = (await get("/gst/returns/gstr1/file?period=2026-09&format=json")).body;
    const cdnr = json.cdnr.flatMap((c: { nt: Array<{ ntty: string; nt_num: string }> }) => c.nt);
    expect(cdnr).toEqual(expect.arrayContaining([expect.objectContaining({ ntty: "D", nt_num: "DN/26-27/00001" })]));
    // Paid in full, the note can no longer be cancelled.
    const paid = await post("/payments", { direction: "in", customerId: ids.customer, amount: "105", method: "cash", allocations: [{ documentId: ids.inv2, amount: "105" }] });
    expect(paid.status).toBe(201);
    expect(await bill(ids.inv2)).toMatchObject({ balanceDue: "0.00", paymentStatus: "paid" });
    expect((await post(`/notes/${ids.debit}/cancel`, { reason: "Not agreed" })).body.error.code).toBe("DEBIT_NOTE_PAID");
  });

  it("cancels a debit note the bill still owes: the bill asks for its own total again", async () => {
    const res = await post(`/invoices/${ids.inv1}/debit-notes`, { percent: "10", reason: "other" });
    // 10% of the soap bill's 900: 90 + 8.10 + 8.10.
    expect(res.body).toMatchObject({ taxableTotal: "90.00", grandTotal: "106.00" });
    expect(await bill(ids.inv1)).toMatchObject({ debited: "106.00", balanceDue: "318.00" });
    const cancelled = await post(`/notes/${res.body.id}/cancel`, { reason: "Charged by mistake" });
    expect(cancelled.status).toBe(200);
    expect(await bill(ids.inv1)).toMatchObject({ debited: "0.00", balanceDue: "212.00", paymentStatus: "partial" });
    const ledger = (await get(`/customers/${ids.customer}/ledger`)).body.entries;
    expect(ledger.find((e: { docType: string }) => e.docType === "debit_note_cancel")).toMatchObject({ credit: "106.00" });
    expect((await post(`/invoices/${ids.inv1}/debit-notes`, {})).body.error.code).toBe("NOTE_AMOUNT_REQUIRED");
  });

  it("takes both kinds from a phone's offline batch", async () => {
    const pushed = await post("/sync/push", {
      items: [
        { id: "0199a6f0-1111-7000-8000-000000000001", kind: "loose-return", body: { customerId: ids.customer, lines: [{ productId: ids.biscuit, qty: "10" }] } },
        { id: "0199a6f0-1111-7000-8000-000000000002", kind: "sale-debit-note", target: ids.inv1, body: { amount: "50" } },
      ],
    });
    expect(pushed.body.results.map((r: { status: number }) => r.status)).toEqual([201, 201]);
    expect(pushed.body.results[0].body).toMatchObject({ grandTotal: "105.00", noteType: "credit" });
    expect(pushed.body.results[1].body).toMatchObject({ grandTotal: "59.00", noteType: "debit" });
  });

  it("bills from another godown and tells the bill screen what each godown has", async () => {
    const stock = (await get(`/warehouses/${ids.back}/stock`)).body;
    expect(stock.data).toEqual([{ productId: ids.soap, qty: "30.000" }]);
    const res = await post("/invoices", { customerId: ids.customer, warehouseId: ids.back, lines: [{ productId: ids.soap, qty: "4" }] });
    expect(res.status).toBe(201);
    expect(res.body.warehouseId).toBe(ids.back);
    expect(await stockOf(ids.soap, ids.back)).toBe("26.000");
  });

  it("asks for the bill for an export customer's returns, and keeps notes to the business", async () => {
    const abroad = (await post("/customers", { name: "Dubai Traders", customerType: "b2c", gstRegistration: "overseas", stateCode: "96" })).body.id;
    expect((await post("/returns", { customerId: abroad, lines: [{ productId: ids.soap, qty: "1" }] })).body.error.code).toBe("RETURN_NEEDS_BILL");
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    const theirs = await call(t.app, "POST", "/returns", { token: other.token, body: { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "1" }] } });
    expect(theirs.body.error.code).toBe("REFERENCE_NOT_FOUND");
    expect((await call(t.app, "POST", `/invoices/${ids.inv1}/debit-notes`, { token: other.token, body: { amount: "10" } })).status).toBe(404);
    expect(TEST_TODAY).toBe("2026-09-24");
  });
});
