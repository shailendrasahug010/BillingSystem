import { gstinCheckChar } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("purchases, inventory and payments", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown, token = owner.token, headers?: Record<string, string>) =>
    call(t.app, "POST", url, { token, body, ...(headers ? { headers } : {}) });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await q<T>(text, params))[0]!;
  const stockOf = async (productId: string | undefined) => (await one<{ qty: string }>(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1`, [productId])).qty;
  const balanceOf = async (table: "customers" | "suppliers", id: string | undefined) => (await one<{ balance: string }>(`select balance from ${table} where id = $1`, [id])).balance;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Ops Distributors", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { gstin: gstin("23", "AAPFO1234K") } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.BOX = units.BOX;
    ids.parle = (
      await post("/products", {
        name: "Parle-G 100g",
        hsnCode: "1905",
        taxCategoryId: taxes["GST 5%"],
        baseUnitId: units.PCS,
        sellingPrice: "10",
        units: [{ unitId: units.BOX, conversionFactor: "24", isDefaultPurchase: true }],
      })
    ).body.id;
    ids.ors = (
      await post("/products", { name: "ORS Sachet", hsnCode: "3004", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "20", trackBatches: true, trackExpiry: true })
    ).body.id;
    ids.local = (await post("/suppliers", { name: "Local Stockist", stateCode: "23", gstin: gstin("23", "AAACL1234K"), creditDays: 15 })).body.id;
    ids.mumbai = (await post("/suppliers", { name: "Mumbai Depot", stateCode: "27", gstin: gstin("27", "AAACM1234K") })).body.id;
    ids.small = (await post("/suppliers", { name: "Small Maker", stateCode: "23", gstRegistration: "composition", gstin: gstin("23", "AAACS1234K") })).body.id;
    ids.customer = (await post("/customers", { name: "Collect Kirana", stateCode: "23", creditDays: 7 })).body.id;

    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("purchases", () => {
    it("posts a bill: stock in, landed cost into the average, supplier credit, inward GST", async () => {
      const res = await post("/purchases", {
        supplierId: ids.local,
        supplierInvoiceNumber: "LS/1001",
        supplierInvoiceDate: "2026-09-20",
        lines: [{ productId: ids.parle, unitId: ids.BOX, qty: "10", rate: "200" }],
        charges: [{ label: "Freight", amount: "100" }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        purchaseNumber: "PUR/26-27/00001",
        supplyType: "intra_state",
        taxableTotal: "2000.00",
        cgstTotal: "50.00",
        sgstTotal: "50.00",
        grandTotal: "2200.00",
        dueDate: "2026-10-05",
        receivedDate: "2026-09-24",
      });
      expect(res.body.items[0]).toMatchObject({ qtyBase: "240.000", landedUnitCost: "8.7500" });
      expect(await stockOf(ids.parle)).toBe("240.000");
      const product = await one<{ avg_cost: string; purchase_price: string }>(`select avg_cost, purchase_price from products where id = $1`, [ids.parle]);
      expect(product).toEqual({ avg_cost: "8.7500", purchase_price: "8.3333" });
      expect(await balanceOf("suppliers", ids.local)).toBe("2200.00");
      const gst = await one(`select direction, itc_eligibility, cgst_amount, return_period from gst_transactions where doc_id = $1`, [res.body.id]);
      expect(gst).toEqual({ direction: "inward", itc_eligibility: "eligible", cgst_amount: "50.00", return_period: "2026-09" });
    });

    it("refuses the same supplier bill twice", async () => {
      const again = await post("/purchases", {
        supplierId: ids.local,
        supplierInvoiceNumber: "LS/1001",
        supplierInvoiceDate: "2026-09-20",
        lines: [{ productId: ids.parle, qty: "1", rate: "8" }],
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("DUPLICATE_SUPPLIER_BILL");
    });

    it("updates the moving average cost with each receipt", async () => {
      await post("/purchases", {
        supplierId: ids.mumbai,
        supplierInvoiceNumber: "MD-77",
        supplierInvoiceDate: "2026-09-21",
        lines: [{ productId: ids.parle, unitId: ids.BOX, qty: "10", rate: "222" }],
      });
      // 240 @ 8.75 + 240 @ 9.25 -> 9.00
      expect((await one<{ avg_cost: string }>(`select avg_cost from products where id = $1`, [ids.parle])).avg_cost).toBe("9.0000");
      const detail = (await get("/purchases?q=MD-77")).body.data[0];
      const full = await get(`/purchases/${detail.id}`);
      expect(full.body).toMatchObject({ supplyType: "inter_state", igstTotal: "111.00", cgstTotal: "0.00", grandTotal: "2331.00" });
    });

    it("takes no GST from a composition supplier", async () => {
      const res = await post("/purchases", {
        supplierId: ids.small,
        supplierInvoiceNumber: "SM-5",
        supplierInvoiceDate: "2026-09-22",
        lines: [{ productId: ids.parle, qty: "24", rate: "8" }],
      });
      expect(res.body).toMatchObject({ taxableTotal: "192.00", cgstTotal: "0.00", grandTotal: "192.00" });
    });

    it("records reverse-charge GST without adding it to the supplier's bill", async () => {
      const res = await post("/purchases", {
        supplierId: ids.local,
        supplierInvoiceNumber: "LS-RCM-1",
        supplierInvoiceDate: "2026-09-22",
        isReverseCharge: true,
        lines: [{ productId: ids.parle, qty: "100", rate: "9" }],
      });
      expect(res.body).toMatchObject({ grandTotal: "900.00", cgstTotal: "22.50", sgstTotal: "22.50", isReverseCharge: true });
      const gst = await one(`select is_reverse_charge, cgst_amount from gst_transactions where doc_id = $1`, [res.body.id]);
      expect(gst).toEqual({ is_reverse_charge: true, cgst_amount: "22.50" });
    });

    it("requires batch and expiry for tracked products and stores the batch", async () => {
      const missing = await post("/purchases", {
        supplierId: ids.local,
        supplierInvoiceNumber: "LS-B1",
        supplierInvoiceDate: "2026-09-23",
        lines: [{ productId: ids.ors, qty: "50", rate: "15" }],
      });
      expect(missing.body.error.code).toBe("BATCH_REQUIRED");
      const ok = await post("/purchases", {
        supplierId: ids.local,
        supplierInvoiceNumber: "LS-B1",
        supplierInvoiceDate: "2026-09-23",
        lines: [{ productId: ids.ors, qty: "50", rate: "15", batchNumber: "B2609", expiryDate: "2027-06-30", mrp: "22" }],
      });
      expect(ok.status).toBe(201);
      const batch = await one<{ id: string; expiry_date: string }>(`select id, expiry_date::text from batches where product_id = $1`, [ids.ors]);
      expect(batch.expiry_date).toBe("2027-06-30");
      const ledger = await one(`select batch_id, qty_in from stock_ledger where product_id = $1`, [ids.ors]);
      expect(ledger).toEqual({ batch_id: batch.id, qty_in: "50.000" });
    });

    it("cancels a bill: stock back out, supplier debited, GST rows flagged", async () => {
      const bill = (
        await post("/purchases", {
          supplierId: ids.small,
          supplierInvoiceNumber: "SM-9",
          supplierInvoiceDate: "2026-09-23",
          lines: [{ productId: ids.parle, qty: "10", rate: "8" }],
          payment: { amount: "30", method: "cash" },
        })
      ).body;
      expect(bill.paymentStatus).toBe("partial");
      const stockBefore = Number(await stockOf(ids.parle));
      const supplierBefore = Number(await balanceOf("suppliers", ids.small));
      const res = await post(`/purchases/${bill.id}/cancel`, { reason: "Returned whole lot" });
      expect(res.body.status).toBe("cancelled");
      expect(Number(await stockOf(ids.parle))).toBe(stockBefore - 10);
      expect(Number(await balanceOf("suppliers", ids.small))).toBe(supplierBefore - 80);
      const flags = await q<{ is_cancelled: boolean }>(`select is_cancelled from gst_transactions where doc_id = $1`, [bill.id]);
      expect(flags.every((f) => f.is_cancelled)).toBe(true);
      // The same bill number can be entered again once the wrong entry is cancelled.
      const reentered = await post("/purchases", { supplierId: ids.small, supplierInvoiceNumber: "SM-9", supplierInvoiceDate: "2026-09-23", lines: [{ productId: ids.parle, qty: "5", rate: "8" }] });
      expect(reentered.status).toBe(201);
    });
  });

  describe("inventory", () => {
    it("shows stock with value to permitted roles and a ledger with running balance", async () => {
      const stock = await get("/stock?q=parle");
      expect(stock.body.data[0]).toMatchObject({ name: "Parle-G 100g", level: "ok" });
      expect(stock.body.data[0].value).toBeDefined();
      expect((await get("/stock", salesToken)).status).toBe(403);

      const ledger = await get(`/stock/ledger?productId=${ids.parle}`);
      const entries = ledger.body.entries as Array<{ type: string; balance: string }>;
      expect(entries[0]).toMatchObject({ type: "purchase", balance: "240.000" });
      expect(ledger.body.closing).toBe(await stockOf(ids.parle));
    });

    it("adjusts stock only through reasoned, numbered ledger entries", async () => {
      const before = Number(await stockOf(ids.parle));
      const wrongWay = await post("/stock/adjustments", { reason: "damage", lines: [{ productId: ids.parle, qtyChange: "5" }] });
      expect(wrongWay.body.error.code).toBe("ADJUSTMENT_DIRECTION_INVALID");
      const damage = await post("/stock/adjustments", { reason: "damage", notes: "Rat damage", lines: [{ productId: ids.parle, qtyChange: "-5", note: "torn packs" }] });
      expect(damage.status).toBe(201);
      expect(damage.body.adjustmentNumber).toBe("ADJ/26-27/00001");
      const count = await post("/stock/adjustments", { reason: "count_correction", lines: [{ productId: ids.parle, qtyChange: "3" }] });
      expect(count.body.lines[0]).toMatchObject({ change: "3.000" });
      expect(Number(await stockOf(ids.parle))).toBe(before - 2);
      const types = await q<{ movement_type: string }>(`select movement_type from stock_ledger where ref_type = 'adjustment' order by id`);
      expect(types.map((x) => x.movement_type)).toEqual(["damaged", "adjustment_in"]);

      await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "block" } });
      const tooMuch = await post("/stock/adjustments", { reason: "theft", lines: [{ productId: ids.parle, qtyChange: "-99999" }] });
      expect(tooMuch.body.error.code).toBe("INSUFFICIENT_STOCK");
      await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "warn" } });
    });
  });

  describe("payments", () => {
    const invoice = async (date: string, qty: string) =>
      (await post("/invoices", { customerId: ids.customer, invoiceDate: date, lines: [{ productId: ids.parle, qty }] })).body as { id: string; grandTotal: string; invoiceNumber: string };

    it("allocates a receipt to the oldest due invoices first", async () => {
      const a = await invoice("2026-09-01", "40"); // 420
      const b = await invoice("2026-09-10", "40"); // 420
      const c = await invoice("2026-09-20", "40"); // 420
      expect(a.grandTotal).toBe("420.00");
      const res = await post("/payments", { direction: "in", customerId: ids.customer, amount: "600", method: "upi", referenceNumber: "UPI-9" });
      expect(res.status).toBe(201);
      expect(res.body.allocations.map((x: { documentNumber: string; amount: string }) => [x.documentNumber, x.amount])).toEqual([
        [a.invoiceNumber, "420.00"],
        [b.invoiceNumber, "180.00"],
      ]);
      const statuses = await q<{ id: string; payment_status: string; balance_due: string }>(`select id, payment_status, balance_due from invoices where id = any($1) order by invoice_date`, [[a.id, b.id, c.id]]);
      expect(statuses.map((s) => [s.payment_status, s.balance_due])).toEqual([
        ["paid", "0.00"],
        ["partial", "240.00"],
        ["unpaid", "420.00"],
      ]);
      expect(await balanceOf("customers", ids.customer)).toBe("660.00");
    });

    it("validates explicit allocations and cheque details", async () => {
      const open = (await get(`/invoices?customerId=${ids.customer}&paymentStatus=open`)).body.data;
      const target = open.find((i: { balanceDue: string }) => i.balanceDue === "240.00");
      const over = await post("/payments", { direction: "in", customerId: ids.customer, amount: "500", method: "cash", allocations: [{ documentId: target.id, amount: "300" }] });
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe("ALLOCATION_EXCEEDS_BALANCE");
      const noChequeNo = await post("/payments", { direction: "in", customerId: ids.customer, amount: "100", method: "cheque" });
      expect(noChequeNo.body.error.code).toBe("CHEQUE_NUMBER_REQUIRED");
    });

    it("reverses a bounced cheque and re-opens what it paid", async () => {
      const cheque = await post("/payments", { direction: "in", customerId: ids.customer, amount: "240", method: "cheque", referenceNumber: "000123", chequeBank: "SBI" });
      expect(cheque.body).toMatchObject({ chequeStatus: "pending" });
      expect(await balanceOf("customers", ids.customer)).toBe("420.00");
      const bounced = await post(`/payments/${cheque.body.id}/cheque`, { status: "bounced", reason: "Insufficient funds" });
      expect(bounced.body).toMatchObject({ status: "cancelled", chequeStatus: "bounced" });
      expect(bounced.body.allocations[0].reversedAt).toBeTruthy();
      expect(await balanceOf("customers", ids.customer)).toBe("660.00");
      const again = await post(`/payments/${cheque.body.id}/cheque`, { status: "cleared" });
      expect(again.status).toBe(409);
    });

    it("keeps an advance and applies it to a later invoice", async () => {
      const advance = await post("/payments", { direction: "in", customerId: ids.customer, amount: "1000", method: "bank_transfer" });
      expect(advance.body.unallocatedAmount).toBe("340.00");
      expect(await balanceOf("customers", ids.customer)).toBe("-340.00");
      const later = await invoice("2026-09-24", "20"); // 210
      const applied = await post(`/payments/${advance.body.id}/allocate`, {});
      expect(applied.body.unallocatedAmount).toBe("130.00");
      const paid = await one<{ payment_status: string }>(`select payment_status from invoices where id = $1`, [later.id]);
      expect(paid.payment_status).toBe("paid");
      expect((await post(`/payments/${advance.body.id}/allocate`, {})).body.error.code).toBe("NO_OPEN_DOCUMENTS");
    });

    it("cancels a receipt and re-opens its invoices", async () => {
      const pay = await post("/payments", { direction: "in", customerId: ids.customer, amount: "10", method: "cash" });
      const before = await balanceOf("customers", ids.customer);
      const cancelled = await post(`/payments/${pay.body.id}/cancel`, { reason: "Entered twice" });
      expect(cancelled.body.status).toBe("cancelled");
      expect(Number(await balanceOf("customers", ids.customer))).toBe(Number(before) + 10);
      expect((await post(`/payments/${pay.body.id}/cancel`, { reason: "again" })).body.error.code).toBe("PAYMENT_NOT_POSTED");
    });

    it("pays suppliers against their bills; sales staff cannot", async () => {
      const denied = await post("/payments", { direction: "out", supplierId: ids.local, amount: "100", method: "cash" }, salesToken);
      expect(denied.status).toBe(403);
      const before = Number(await balanceOf("suppliers", ids.local));
      const res = await post("/payments", { direction: "out", supplierId: ids.local, amount: "1000", method: "bank_transfer", referenceNumber: "NEFT-1" });
      // PAY/…/00001 was the cash paid with bill SM-9.
      expect(res.body.paymentNumber).toBe("PAY/26-27/00002");
      expect(res.body.allocations[0]).toMatchObject({ documentNumber: "LS/1001", amount: "1000.00" });
      expect(Number(await balanceOf("suppliers", ids.local))).toBe(before - 1000);
    });

    it("is idempotent with an Idempotency-Key", async () => {
      const key = "0190f1a0-2222-7aaa-8bbb-123456789abc";
      const body = { direction: "in", customerId: ids.customer, amount: "5", method: "cash" };
      const first = await post("/payments", body, owner.token, { "idempotency-key": key });
      const second = await post("/payments", body, owner.token, { "idempotency-key": key });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
    });

    it("produces a statement whose closing balance equals the account balance", async () => {
      const statement = await get(`/customers/${ids.customer}/ledger`);
      const types = statement.body.entries.map((e: { docType: string }) => e.docType);
      expect(types).toEqual(expect.arrayContaining(["invoice", "payment_in", "cheque_bounce", "payment_in_cancel"]));
      expect(statement.body.closing).toBe(await balanceOf("customers", ids.customer));
    });
  });

  it("keeps every cached balance equal to its ledger", async () => {
    const parties = await q<{ id: string }>(`
      select c.id from customers c
      where c.balance <> coalesce((select sum(debit - credit) from party_ledger_entries e where e.customer_id = c.id), 0)
      union all
      select s.id from suppliers s
      where s.balance <> coalesce((select sum(credit - debit) from party_ledger_entries e where e.supplier_id = s.id), 0)`);
    expect(parties).toEqual([]);
    const stock = await q<{ id: string }>(`
      select b.id from stock_balances b
      where b.qty <> coalesce((select sum(qty_in - qty_out) from stock_ledger l
        where l.product_id = b.product_id and l.warehouse_id = b.warehouse_id and l.batch_id is not distinct from b.batch_id), 0)`);
    expect(stock).toEqual([]);
    const docs = await q<{ id: string }>(`
      select i.id from invoices i
      where i.status = 'posted' and i.amount_paid <> coalesce((select sum(amount) from payment_allocations a where a.invoice_id = i.id and a.reversed_at is null), 0)`);
    expect(docs).toEqual([]);
  });
});
