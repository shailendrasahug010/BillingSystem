import { gstinCheckChar } from "@vyapaar/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateAccess } from "../src/lib/access.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("invoicing", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown, token = owner.token, headers?: Record<string, string>) =>
    call(t.app, "POST", url, { token, body, ...(headers ? { headers } : {}) });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const put = (url: string, body: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const stockOf = async (productId: string | undefined) =>
    (await q<{ qty: string }>(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1`, [productId]))[0]!.qty;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Invoice Traders", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { gstin: gstin("23", "AAPFI1234K") } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const levels = Object.fromEntries((await get("/price-levels")).body.data.map((l: { name: string; id: string }) => [l.name, l.id]));
    ids.PCS = units.PCS;
    ids.BOX = units.BOX;

    const parle = await post("/products", {
      name: "Parle-G 100g",
      hsnCode: "1905",
      taxCategoryId: taxes["GST 5%"],
      baseUnitId: units.PCS,
      sellingPrice: "10",
      units: [{ unitId: units.BOX, conversionFactor: "24", isDefaultSale: true }],
      prices: [{ priceLevelId: levels["Price B"], unitId: units.BOX, price: "220" }],
      openingStock: "500",
      openingStockCost: "8",
    });
    ids.parle = parle.body.id;
    ids.surf = (
      await post("/products", { name: "Surf Excel 1kg", hsnCode: "3402", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "10", openingStockCost: "120" })
    ).body.id;
    ids.coke = (
      await post("/products", {
        name: "Cola 750ml",
        hsnCode: "2202",
        taxCategoryId: taxes["GST 40%"],
        baseUnitId: units.PCS,
        sellingPrice: "45",
        pricesIncludeTax: true,
        openingStock: "100",
      })
    ).body.id;

    ids.retail = (await post("/customers", { name: "Sharma Kirana", stateCode: "23", creditDays: 7 })).body.id;
    ids.b2b = (
      await post("/customers", {
        name: "Pune Wholesale",
        customerType: "b2b",
        stateCode: "27",
        gstin: gstin("27", "AABCP1234C"),
        priceLevelId: levels["Price B"],
      })
    ).body.id;
    ids.credit = (await post("/customers", { name: "Tight Credit Stores", stateCode: "23", creditLimit: "1000" })).body.id;
    ids.history = (await post("/customers", { name: "Regular Customer", stateCode: "23" })).body.id;

    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("posting", () => {
    it("posts an intra-state invoice: CGST+SGST, stock out, ledger debit, GST register", async () => {
      const res = await post("/invoices", {
        customerId: ids.retail,
        lines: [
          { productId: ids.parle, unitId: ids.BOX, qty: "2" },
          { productId: ids.surf, qty: "2" },
        ],
      });
      expect(res.status).toBe(201);
      const inv = res.body;
      expect(inv).toMatchObject({
        invoiceNumber: "INV/26-27/00001",
        invoiceDate: TEST_TODAY,
        dueDate: "2026-10-01",
        supplyType: "intra_state",
        placeOfSupply: "23",
        taxableTotal: "780.00",
        cgstTotal: "39.00",
        sgstTotal: "39.00",
        igstTotal: "0.00",
        grandTotal: "858.00",
        balanceDue: "858.00",
        paymentStatus: "unpaid",
        status: "posted",
      });
      expect(inv.taxLabels).toEqual({ central: "CGST", state: "SGST", integrated: "IGST" });
      expect(inv.amountInWords).toMatch(/Eight Hundred Fifty Eight/i);
      expect(inv.items[0]).toMatchObject({ qty: "2.000", qtyBase: "48.000", rate: "240.0000", taxableValue: "480.00", gstRate: "5.000", cgstAmount: "12.00" });

      expect(await stockOf(ids.parle)).toBe("452.000");
      expect(await stockOf(ids.surf)).toBe("8.000");
      const [cust] = await q<{ balance: string }>(`select balance from customers where id = $1`, [ids.retail]);
      expect(cust!.balance).toBe("858.00");
      const gst = await q(`select hsn_code, taxable_value, cgst_amount, return_period from gst_transactions where doc_id = $1 order by hsn_code`, [inv.id]);
      expect(gst).toEqual([
        { hsn_code: "1905", taxable_value: "480.00", cgst_amount: "12.00", return_period: "2026-09" },
        { hsn_code: "3402", taxable_value: "300.00", cgst_amount: "27.00", return_period: "2026-09" },
      ]);
      const [ledger] = await q(`select doc_type, debit from party_ledger_entries where doc_id = $1`, [inv.id]);
      expect(ledger).toEqual({ doc_type: "invoice", debit: "858.00" });
    });

    it("charges IGST to another state and uses the customer's rate list", async () => {
      const res = await post("/invoices", { customerId: ids.b2b, lines: [{ productId: ids.parle, unitId: ids.BOX, qty: "1" }] });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ supplyType: "inter_state", placeOfSupply: "27", taxableTotal: "220.00", igstTotal: "11.00", cgstTotal: "0.00", grandTotal: "231.00" });
      expect(res.body.partyGstin).toBe(gstin("27", "AABCP1234C"));
    });

    it("prices a pack without its own list price from the customer's price for one piece", async () => {
      const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
      const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
      const levels = Object.fromEntries((await get("/price-levels")).body.data.map((l: { name: string; id: string }) => [l.name, l.id]));
      const vim = await post("/products", {
        name: "Vim Bar 200g",
        hsnCode: "3402",
        taxCategoryId: taxes["GST 18%"],
        baseUnitId: units.PCS,
        sellingPrice: "10",
        units: [{ unitId: units.STRIP, conversionFactor: "10" }],
        prices: [{ priceLevelId: levels["Price B"], unitId: units.PCS, price: "9" }],
        openingStock: "100",
      });
      // Price B: 9 a piece, so 90 a strip of 10 (not the selling price of 10 x 10).
      const res = await post("/invoices", { customerId: ids.b2b, lines: [{ productId: vim.body.id, unitId: units.STRIP, qty: "2" }] });
      expect(res.status).toBe(201);
      expect(res.body.items[0]).toMatchObject({ qty: "2.000", qtyBase: "20.000", rate: "90.0000", taxableValue: "180.00" });
      // A retail customer on the default list pays the selling price times the strip.
      const retail = await post("/invoices", { customerId: ids.retail, lines: [{ productId: vim.body.id, unitId: units.STRIP, qty: "1" }] });
      expect(retail.body.items[0]).toMatchObject({ rate: "100.0000", taxableValue: "100.00" });
    });

    it("back-calculates tax on MRP-style inclusive prices", async () => {
      const res = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.coke, qty: "1" }] });
      expect(res.body).toMatchObject({ taxableTotal: "32.14", cgstTotal: "6.43", sgstTotal: "6.43", grandTotal: "45.00" });
    });

    it("rejects totals that differ from the server's and consumes no number", async () => {
      const before = (await get("/invoices?limit=1")).body.data[0].invoiceNumber;
      const bad = await post("/invoices", {
        customerId: ids.retail,
        lines: [{ productId: ids.surf, qty: "1" }],
        clientTotals: { grandTotal: "170.00" },
      });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatchObject({ code: "TOTALS_MISMATCH", params: { field: "grandTotal", expected: "177.00", received: "170.00" } });
      const ok = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "1" }], clientTotals: { grandTotal: "177.00" } });
      const seq = (n: string) => Number(n.split("/").at(-1));
      expect(seq(ok.body.invoiceNumber)).toBe(seq(before) + 1);
    });

    it("lets only permitted roles change list prices or back-date", async () => {
      const override = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "1", rate: "140" }] }, salesToken);
      expect(override.status).toBe(403);
      expect(override.body.error.params.permission).toBe("invoice.override_price");
      const discount = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "1", discountPercent: "5" }] }, salesToken);
      expect(discount.status).toBe(201);
      expect(discount.body.taxableTotal).toBe("142.50");

      const backdated = await post("/invoices", { customerId: ids.retail, invoiceDate: "2026-09-20", lines: [{ productId: ids.surf, qty: "1" }] }, salesToken);
      expect(backdated.body.error.params.permission).toBe("invoice.backdate");
      const future = await post("/invoices", { customerId: ids.retail, invoiceDate: "2026-09-25", lines: [{ productId: ids.surf, qty: "1" }] });
      expect(future.body.error.code).toBe("FUTURE_DATE_NOT_ALLOWED");
    });

    it("previews totals and warnings without saving", async () => {
      const count = async () => (await q<{ n: number }>(`select count(*)::int as n from invoices`))[0]!.n;
      const before = await count();
      const res = await post("/invoices/preview", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "50" }] });
      expect(res.status).toBe(200);
      expect(res.body.totals.grandTotal).toBe("8850.00");
      expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain("insufficient_stock");
      expect(await count()).toBe(before);
    });
  });

  describe("payments with the invoice", () => {
    it("settles fully, partly, or keeps the excess as an advance", async () => {
      const full = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "1" }], payment: { amount: "177", method: "cash" } });
      expect(full.body).toMatchObject({ paymentStatus: "paid", amountPaid: "177.00", balanceDue: "0.00" });
      expect(full.body.payment.paymentNumber).toBe("RCT/26-27/00001");
      expect(full.body.payments[0]).toMatchObject({ method: "cash", amount: "177.00" });

      const partial = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "1" }], payment: { amount: "100", method: "upi", reference: "UPI123" } });
      expect(partial.body).toMatchObject({ paymentStatus: "partial", amountPaid: "100.00", balanceDue: "77.00" });

      const excess = await post("/invoices", { customerId: ids.b2b, lines: [{ productId: ids.parle, qty: "10" }], payment: { amount: "500", method: "cash" } });
      expect(excess.body.paymentStatus).toBe("paid");
      expect(excess.body.payment.unallocated).not.toBe("0.00");
      const [pay] = await q<{ unallocated_amount: string }>(`select unallocated_amount from payments where id = $1`, [excess.body.payment.id]);
      expect(Number(pay!.unallocated_amount)).toBeGreaterThan(0);
    });
  });

  describe("policies", () => {
    it("blocks or warns on negative stock as configured", async () => {
      await put("/settings/stock.negative_policy", { value: "block" });
      const before = await stockOf(ids.surf);
      const blocked = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "999" }] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: "INSUFFICIENT_STOCK", params: { product: "Surf Excel 1kg" } });
      expect(await stockOf(ids.surf)).toBe(before);

      await put("/settings/stock.negative_policy", { value: "warn" });
      const warned = await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.surf, qty: "20" }] });
      expect(warned.status).toBe(201);
      expect(warned.body.warnings[0]).toMatchObject({ code: "insufficient_stock" });
      expect(Number(await stockOf(ids.surf))).toBeLessThan(0);
    });

    it("enforces the credit limit for users who cannot override it", async () => {
      await put("/settings/credit.policy", { value: { onLimitExceeded: "block", onOverdue: "warn", overdueGraceDays: 0 } });
      const blocked = await post("/invoices", { customerId: ids.credit, lines: [{ productId: ids.parle, qty: "100" }] }, salesToken);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: "CREDIT_BLOCKED", params: { reason: "credit_limit_exceeded", limit: "1000.00" } });
      const within = await post("/invoices", { customerId: ids.credit, lines: [{ productId: ids.parle, qty: "50" }] }, salesToken);
      expect(within.status).toBe(201);
      const overridden = await post("/invoices", { customerId: ids.credit, lines: [{ productId: ids.parle, qty: "100" }] });
      expect(overridden.status).toBe(201);
      expect(overridden.body.warnings.map((w: { code: string }) => w.code)).toContain("credit_limit_exceeded");
      await put("/settings/credit.policy", { value: { onLimitExceeded: "warn", onOverdue: "warn", overdueGraceDays: 0 } });
    });
  });

  describe("safety under retries and load", () => {
    it("is idempotent: the same Idempotency-Key never creates a second invoice", async () => {
      const key = "0190f1a0-1111-7aaa-8bbb-123456789abc";
      const body = { customerId: ids.retail, lines: [{ productId: ids.parle, qty: "1" }] };
      const first = await post("/invoices", body, owner.token, { "idempotency-key": key });
      const again = await post("/invoices", body, owner.token, { "idempotency-key": key });
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.headers["idempotent-replay"]).toBe("true");
      expect(again.body.id).toBe(first.body.id);
      const rows = await q(`select id from invoices where client_id = $1`, [key]);
      expect(rows).toHaveLength(1);
    });

    it("numbers concurrent invoices without gaps or duplicates and keeps stock exact", async () => {
      const before = Number(await stockOf(ids.parle));
      const results = await Promise.all(
        Array.from({ length: 12 }, () => post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.parle, qty: "3" }] })),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const all = (await q<{ invoice_number: string }>(`select invoice_number from invoices where status <> 'draft' order by invoice_number`)).map((r) =>
        Number(r.invoice_number.split("/").at(-1)),
      );
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
      expect(Number(await stockOf(ids.parle))).toBe(before - 36);
      const [check] = await q<{ ledger: string; balance: string }>(
        `select (select sum(qty_in - qty_out) from stock_ledger where product_id = $1)::text as ledger,
                (select sum(qty) from stock_balances where product_id = $1)::text as balance`,
        [ids.parle],
      );
      expect(check!.ledger).toBe(check!.balance);
    });
  });

  describe("cancellation", () => {
    it("reverses stock, ledger and GST rows, keeps the number and turns payments into an advance", async () => {
      const inv = (await post("/invoices", { customerId: ids.b2b, lines: [{ productId: ids.parle, unitId: ids.BOX, qty: "1" }], payment: { amount: "100", method: "cash" } })).body;
      const stockBefore = await stockOf(ids.parle);
      const [balBefore] = await q<{ balance: string }>(`select balance from customers where id = $1`, [ids.b2b]);

      expect((await post(`/invoices/${inv.id}/cancel`, { reason: "Wrong party" }, salesToken)).status).toBe(403);
      const res = await post(`/invoices/${inv.id}/cancel`, { reason: "Wrong party" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "cancelled", invoiceNumber: inv.invoiceNumber, cancelReason: "Wrong party", amountPaid: "0.00" });
      expect(Number(await stockOf(ids.parle))).toBe(Number(stockBefore) + 24);
      const [balAfter] = await q<{ balance: string }>(`select balance from customers where id = $1`, [ids.b2b]);
      expect(Number(balAfter!.balance)).toBeCloseTo(Number(balBefore!.balance) - 231, 2);
      const gst = await q<{ is_cancelled: boolean }>(`select is_cancelled from gst_transactions where doc_id = $1`, [inv.id]);
      expect(gst.every((g) => g.is_cancelled)).toBe(true);
      const [pay] = await q<{ unallocated_amount: string }>(`select unallocated_amount from payments where id = $1`, [inv.payment.id]);
      expect(pay!.unallocated_amount).toBe("100.00");
      expect((await post(`/invoices/${inv.id}/cancel`, { reason: "Again" })).body.error.code).toBe("INVOICE_NOT_POSTED");
    });

    it("refuses to cancel once the GST period is locked", async () => {
      const inv = (await post("/invoices", { customerId: ids.retail, lines: [{ productId: ids.parle, qty: "1" }] })).body;
      await q(`insert into gst_return_periods (business_id, return_type, period, status) values ($1, 'GSTR1', '2026-09', 'locked')`, [owner.businessId]);
      const res = await post(`/invoices/${inv.id}/cancel`, { reason: "Too late" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("GST_PERIOD_LOCKED");
      await q(`delete from gst_return_periods where business_id = $1`, [owner.businessId]);
      invalidateAccess();
    });
  });

  describe("reading invoices", () => {
    it("lists with filters and pages, and hides cost from sales staff", async () => {
      const open = await get(`/invoices?customerId=${ids.retail}&paymentStatus=open&limit=5`);
      expect(open.body.data.length).toBe(5);
      expect(open.body.data.every((i: { balanceDue: string }) => Number(i.balanceDue) > 0)).toBe(true);
      const next = await get(`/invoices?customerId=${ids.retail}&paymentStatus=open&limit=5&cursor=${open.body.nextCursor}`);
      expect(next.body.data[0].id).not.toBe(open.body.data[4].id);
      const byNumber = await get("/invoices?q=00001");
      expect(byNumber.body.data[0].invoiceNumber).toBe("INV/26-27/00001");

      const detailOwner = await get(`/invoices/${byNumber.body.data[0].id}`);
      expect(detailOwner.body.costTotal).toBeDefined();
      expect(detailOwner.body.items[0].unitCost).toBe("8.0000");
      const detailSales = await get(`/invoices/${byNumber.body.data[0].id}`, salesToken);
      expect(detailSales.body.costTotal).toBeUndefined();
      expect(detailSales.body.items[0].unitCost).toBeUndefined();
    });
  });

  describe("suggestions from purchase history", () => {
    it("explains reorders and frequent items, skips what is already in the cart, and never adds anything", async () => {
      for (const date of ["2026-08-20", "2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17"]) {
        const lines = [{ productId: ids.parle, unitId: ids.BOX, qty: "2" }, ...(date >= "2026-09-03" ? [{ productId: ids.coke, qty: "6" }] : [])];
        const res = await post("/invoices", { customerId: ids.history, invoiceDate: date, lines });
        expect(res.status).toBe(201);
      }
      const res = await get(`/customers/${ids.history}/suggestions`);
      expect(res.status).toBe(200);
      expect(res.body.summary.invoiceCount).toBe(5);
      const parle = res.body.suggestions.find((s: { productId: string }) => s.productId === ids.parle);
      expect(parle).toMatchObject({ group: "reorder", suggestedQty: "48" });
      expect(parle.reasons.map((r: { code: string }) => r.code)).toContain("due");
      const coke = res.body.suggestions.find((s: { productId: string }) => s.productId === ids.coke);
      expect(coke).toBeTruthy();
      expect(res.body.reorder.find((r: { productId: string }) => r.productId === ids.parle)).toMatchObject({ lastQty: "48", typicalIntervalDays: 7, status: "due" });

      const withCart = await get(`/customers/${ids.history}/suggestions?cart=${ids.parle}`);
      expect(withCart.body.suggestions.find((s: { productId: string }) => s.productId === ids.parle)).toBeUndefined();

      const count = (await q<{ n: number }>(`select count(*)::int as n from invoices where customer_id = $1`, [ids.history]))[0]!.n;
      expect(count).toBe(5);
    });

    it("returns the customer insight the billing screen runs the same engine on", async () => {
      const res = await get(`/customers/${ids.history}/insight`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ invoiceCount: 5, overdueCount: 5, lastPurchase: "2026-09-17", behaviour: { rating: "risky" } });
      const parle = res.body.stats.find((s: { productId: string }) => s.productId === ids.parle);
      expect(parle).toMatchObject({ orderCount: 5, orderShare: 1, lastQty: "48", typicalIntervalDays: 7 });
      expect(res.body.openInvoices).toHaveLength(5);
      expect(res.body.summary.typicalVisitIntervalDays).toBe(7);
    });
  });
});
