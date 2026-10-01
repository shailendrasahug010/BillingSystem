import { gstinCheckChar } from "@digitalbahi/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("returns: credit and debit notes", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown, token = owner.token, headers?: Record<string, string>) =>
    call(t.app, "POST", url, { token, body, ...(headers ? { headers } : {}) });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows[0] as T;
  const stockOf = async (productId: string | undefined) => (await one<{ qty: string }>(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1`, [productId])).qty;
  const balanceOf = async (table: "customers" | "suppliers", id: string | undefined) => (await one<{ balance: string }>(`select balance from ${table} where id = $1`, [id])).balance;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Return Traders", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { gstin: gstin("23", "AAPFR5678K") } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (
      await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })
    ).body.id;
    ids.customer = (await post("/customers", { name: "Kirana One", stateCode: "23", creditDays: 7 })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Soap Depot", stateCode: "23", gstin: gstin("23", "AAACS5678K") })).body.id;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("sales returns", () => {
    it("credits part of an invoice: stock back, invoice balance down, customer ledger, GST credit note", async () => {
      const inv = (await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "10" }] })).body;
      ids.invoice = inv.id;
      ids.invoiceLine = inv.items[0].id;
      expect(inv.grandTotal).toBe("1180.00");
      expect(await stockOf(ids.soap)).toBe("90.000");

      const res = await post(`/invoices/${inv.id}/returns`, { lines: [{ lineId: ids.invoiceLine, qty: "4" }], clientTotals: { grandTotal: "472" } });
      expect(res.status).toBe(201);
      ids.note1 = res.body.id;
      expect(res.body).toMatchObject({
        noteNumber: "CN/26-27/00001",
        noteType: "credit",
        partyType: "customer",
        reason: "sales_return",
        taxableTotal: "400.00",
        cgstTotal: "36.00",
        sgstTotal: "36.00",
        grandTotal: "472.00",
        amountSettled: "472.00",
        original: { id: inv.id, number: inv.invoiceNumber },
      });
      expect(await stockOf(ids.soap)).toBe("94.000");
      expect(await balanceOf("customers", ids.customer)).toBe("708.00");
      const after = (await get(`/invoices/${inv.id}`)).body;
      expect(after).toMatchObject({ balanceDue: "708.00", paymentStatus: "partial" });
      expect(after.items[0].returnedQty).toBe("4.000");
      expect(after.returns).toEqual([expect.objectContaining({ noteNumber: "CN/26-27/00001", grandTotal: "472.00", status: "posted" })]);
      const gst = await one<{ n: number; taxable: string; original: string }>(
        `select count(*)::int as n, sum(taxable_value)::text as taxable, max(original_doc_number) as original from gst_transactions where doc_type = 'credit_note' and doc_id = $1`,
        [ids.note1],
      );
      expect(gst).toMatchObject({ n: 1, taxable: "400.00", original: inv.invoiceNumber });
    });

    it("refuses to return more than is left on the line, or a line from another bill", async () => {
      const over = await post(`/invoices/${ids.invoice}/returns`, { lines: [{ lineId: ids.invoiceLine, qty: "7" }] });
      expect(over.status).toBe(400);
      expect(over.body.error).toMatchObject({ code: "RETURN_QTY_EXCEEDS", params: { max: "6.000" } });
      const foreign = await post(`/invoices/${ids.invoice}/returns`, { lines: [{ lineId: randomUUID(), qty: "1" }] });
      expect(foreign.body.error.code).toBe("RETURN_LINE_NOT_ON_DOCUMENT");
    });

    it("the return that completes a line credits exactly what is left, and settles the invoice", async () => {
      const res = await post(`/invoices/${ids.invoice}/returns`, { lines: [{ lineId: ids.invoiceLine, qty: "6" }] });
      expect(res.status).toBe(201);
      ids.note2 = res.body.id;
      expect(res.body).toMatchObject({ noteNumber: "CN/26-27/00002", taxableTotal: "600.00", grandTotal: "708.00" });
      expect((await get(`/invoices/${ids.invoice}`)).body).toMatchObject({ balanceDue: "0.00", paymentStatus: "paid" });
      expect(await balanceOf("customers", ids.customer)).toBe("0.00");
      expect(await stockOf(ids.soap)).toBe("100.000");
    });

    it("an invoice with returns cannot be cancelled until the returns are", async () => {
      const res = await post(`/invoices/${ids.invoice}/cancel`, { reason: "Wrong customer" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DOCUMENT_HAS_RETURNS");
    });

    it("cancelling a return reverses stock, quantities, ledger, invoice balance and GST", async () => {
      const res = await post(`/notes/${ids.note2}/cancel`, { reason: "Goods not received back" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "cancelled", amountSettled: "0.00" });
      expect(await stockOf(ids.soap)).toBe("94.000");
      expect(await balanceOf("customers", ids.customer)).toBe("708.00");
      const inv = (await get(`/invoices/${ids.invoice}`)).body;
      expect(inv).toMatchObject({ balanceDue: "708.00", paymentStatus: "partial" });
      expect(inv.items[0].returnedQty).toBe("4.000");
      const gst = await one<{ cancelled: boolean }>(`select bool_and(is_cancelled) as cancelled from gst_transactions where doc_id = $1`, [ids.note2]);
      expect(gst.cancelled).toBe(true);
      expect((await post(`/notes/${ids.note2}/cancel`, { reason: "Again" })).body.error.code).toBe("NOTE_NOT_POSTED");
    });

    it("a return on a paid invoice leaves the customer in credit (advance)", async () => {
      const inv = (await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "1" }], payment: { amount: "118", method: "cash" } })).body;
      expect(inv.paymentStatus).toBe("paid");
      const res = await post(`/invoices/${inv.id}/returns`, { lines: [{ lineId: inv.items[0].id, qty: "1" }], restock: false, reason: "damage" });
      expect(res.body).toMatchObject({ grandTotal: "118.00", amountSettled: "0.00", settlementStatus: "unpaid", affectsStock: false });
      // Stock unchanged (the damaged piece is not sellable); 708 due on the first invoice less the 118 credit.
      expect(await stockOf(ids.soap)).toBe("93.000");
      expect(await balanceOf("customers", ids.customer)).toBe("590.00");
    });

    it("is idempotent and needs note.create", async () => {
      const key = randomUUID();
      const inv = (await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "2" }] })).body;
      const body = { lines: [{ lineId: inv.items[0].id, qty: "1" }] };
      const first = await post(`/invoices/${inv.id}/returns`, body, owner.token, { "idempotency-key": key });
      const again = await post(`/invoices/${inv.id}/returns`, body, owner.token, { "idempotency-key": key });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect((await get(`/invoices/${inv.id}`)).body.items[0].returnedQty).toBe("1.000");
      expect((await post(`/invoices/${inv.id}/returns`, body, salesToken)).status).toBe(403);
    });
  });

  describe("purchase returns", () => {
    it("debits the supplier: stock out, bill balance down, inward GST debit note", async () => {
      const bill = (
        await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "SD/77", supplierInvoiceDate: "2026-09-20", lines: [{ productId: ids.soap, qty: "20", rate: "70" }] })
      ).body;
      expect(bill.grandTotal).toBe("1652.00");
      const stockBefore = Number(await stockOf(ids.soap));
      const res = await post(`/purchases/${bill.id}/returns`, { lines: [{ lineId: bill.items[0].id, qty: "5" }], partyNoteNumber: "SD-CN-9" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ noteNumber: "DN/26-27/00001", noteType: "debit", partyType: "supplier", taxableTotal: "350.00", grandTotal: "413.00", partyNoteNumber: "SD-CN-9" });
      expect(Number(await stockOf(ids.soap))).toBe(stockBefore - 5);
      expect(await balanceOf("suppliers", ids.supplier)).toBe("1239.00");
      expect((await get(`/purchases/${bill.id}`)).body).toMatchObject({ balanceDue: "1239.00", returns: [expect.objectContaining({ noteNumber: "DN/26-27/00001" })] });
      const cancel = await post(`/purchases/${bill.id}/cancel`, { reason: "Duplicate" });
      expect(cancel.body.error.code).toBe("DOCUMENT_HAS_RETURNS");
    });

    it("the GST summary nets returns out of output tax and ITC and lists them", async () => {
      const g = (await get("/reports/gst?period=2026-09")).body;
      // Output: invoices 10 + 1 + 2 soaps (1300 taxable, 234 tax) less posted credit notes 4 + 1 + 1 (600, 108).
      expect(Number(g.estimate.outputTax.cgst) + Number(g.estimate.outputTax.sgst)).toBe(126);
      // ITC: 20 soaps at 70 (252 tax) less the return of 5 (63).
      expect(Number(g.estimate.eligibleItc.cgst) + Number(g.estimate.eligibleItc.sgst)).toBe(189);
      expect(g.notes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "credit_note", registered: false, documents: 3, taxable: "600.00" }),
          expect.objectContaining({ kind: "debit_note", registered: true, documents: 1, taxable: "350.00" }),
        ]),
      );
      const hsn = g.hsnSummary.find((h: { hsnCode: string }) => h.hsnCode === "3401");
      expect(hsn).toMatchObject({ taxable: "700.00", qty: "7.000" });
    });

    it("lists notes by party and document", async () => {
      const all = (await get("/notes")).body.data;
      expect(all).toHaveLength(5);
      const supplierNotes = (await get(`/notes?party=supplier`)).body.data;
      expect(supplierNotes).toEqual([expect.objectContaining({ noteNumber: "DN/26-27/00001", partyName: "Soap Depot" })]);
      const onInvoice = (await get(`/notes?invoiceId=${ids.invoice}&status=posted`)).body.data;
      expect(onInvoice.map((n: { noteNumber: string }) => n.noteNumber)).toEqual(["CN/26-27/00001"]);
    });
  });
});
