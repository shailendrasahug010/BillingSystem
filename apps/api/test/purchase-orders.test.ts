import { gstinCheckChar } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

/**
 * Buying: what to order (stock, pace of sales, what is on order), an order
 * to the supplier priced like a bill, goods received before the bill (stock
 * in at the order's cost, counted on the order), the bill for them (the
 * cost follows the bill; stock does not come in twice), the rest of the
 * order coming with a bill, and cancelling each step.
 */
describe.skipIf(!hasDatabase)("purchase orders, goods received, bills", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows[0] as T;
  const stockOf = async (productId: string | undefined) => (await one<{ qty: string }>(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1`, [productId])).qty;
  const avgCost = async (productId: string | undefined) => Number((await one<{ avg_cost: string }>(`select avg_cost::text from products where id = $1`, [productId])).avg_cost);
  /** What the stock ledger says the product's stock is worth. */
  const ledgerValue = async (productId: string | undefined) => Number((await one<{ v: string }>(`select coalesce(sum((qty_in - qty_out) * unit_cost), 0)::text as v from stock_ledger where product_id = $1`, [productId])).v);
  const order = async () => (await get(`/purchase-orders/${ids.po}`)).body;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Mehta Distributors", stateCode: "23", gstin: gstin("23", "AAPFM1234M") });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.CTN = units.CTN;
    ids.hul = (await post("/suppliers", { name: "HUL Distributor", stateCode: "23", gstin: gstin("23", "AAACH1234H"), creditDays: 15 })).body.id;
    ids.other = (await post("/suppliers", { name: "Local Wholesaler", stateCode: "23", gstRegistration: "unregistered" })).body.id;
    // Soap sells (40 of 50 gone this month) and comes in cartons of 12; oil does not sell but must not run out; tea does neither.
    ids.soap = (
      await post("/products", {
        name: "Lifebuoy 100g",
        taxCategoryId: taxes["GST 18%"],
        baseUnitId: units.PCS,
        sellingPrice: "40",
        purchasePrice: "28",
        openingStock: "50",
        openingStockCost: "28",
        preferredSupplierId: ids.hul,
        units: [{ unitId: units.CTN, conversionFactor: "12", isDefaultPurchase: true }],
      })
    ).body.id;
    ids.oil = (await post("/products", { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", purchasePrice: "100", minStock: "5", preferredSupplierId: ids.hul })).body.id;
    ids.tea = (await post("/products", { name: "Tata Tea 250g", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "90", purchasePrice: "70", preferredSupplierId: ids.hul })).body.id;
    ids.customer = (await post("/customers", { name: "Gupta Stores", stateCode: "23" })).body.id;
    const sale = await post("/invoices", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "40" }] });
    expect(sale.status).toBe(201);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("suggests what to order: the sales of the lead and cover days, the minimum stock, in the carton it is bought in", async () => {
    const res = await get(`/purchase-orders/reorder?supplierId=${ids.hul}&days=30&lead=7&cover=15`);
    expect(res.status).toBe(200);
    // Soap: 40 in 30 days, 22 days wanted (29.3), 10 left: 19.3 short, two cartons. Oil: none left, minimum 5.
    expect(res.body.data).toEqual([
      expect.objectContaining({ productId: ids.oil, reason: "out", onHand: "0.000", suggestBase: "5.000", qty: "5.000", unit: "PCS", supplierName: "HUL Distributor" }),
      expect.objectContaining({ productId: ids.soap, reason: "runs_out", onHand: "10.000", daysLeft: "7.5", suggestBase: "24.000", qty: "2.000", unitId: ids.CTN, unitSymbol: "CTN", factor: "12.000" }),
    ]);
    expect((await get(`/purchase-orders/reorder?supplierId=${ids.other}`)).body.data).toEqual([]);
  });

  it("places an order priced like a bill, which then counts as on order", async () => {
    const res = await post("/purchase-orders", {
      supplierId: ids.hul,
      expectedDate: "2026-09-30",
      lines: [
        { productId: ids.soap, unitId: ids.CTN, qty: "2", rate: "360", discountPercent: "5" },
        { productId: ids.oil, qty: "5", rate: "100" },
      ],
      clientTotals: { grandTotal: "1332.00" },
    });
    expect(res.status).toBe(201);
    // 2 × 360 less 5% = 684 + 18% GST; 500 + 5%: 1,332.12, rounded.
    expect(res.body).toMatchObject({ orderNumber: "PO/26-27/00001", status: "open", taxableTotal: "1184.00", cgstTotal: "74.06", sgstTotal: "74.06", grandTotal: "1332.00", expectedDate: "2026-09-30" });
    expect(res.body.items.map((i: { orderedBase: string; remainingBase: string }) => [i.orderedBase, i.remainingBase])).toEqual([
      ["24.000", "24.000"],
      ["5.000", "5.000"],
    ]);
    ids.po = res.body.id;
    ids.poSoap = res.body.items[0].id;
    ids.poOil = res.body.items[1].id;
    expect((await get(`/purchase-orders/reorder?supplierId=${ids.hul}`)).body.data).toEqual([]);
    expect((await get("/purchase-orders?status=pending")).body.data).toEqual([expect.objectContaining({ id: ids.po, lines: 2, pendingLines: 2, partyName: "HUL Distributor" })]);
  });

  it("takes goods in before the bill at the order's cost, and counts them on the order", async () => {
    const res = await post("/goods-receipts", {
      supplierId: ids.hul,
      purchaseOrderId: ids.po,
      challanNumber: "DC-881",
      lines: [
        { productId: ids.soap, unitId: ids.CTN, qty: "1", purchaseOrderItemId: ids.poSoap },
        { productId: ids.oil, qty: "3", purchaseOrderItemId: ids.poOil },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ receiptNumber: "GRN/26-27/00001", status: "received", orderNumber: "PO/26-27/00001", challanNumber: "DC-881", totalValue: "642.00" });
    // A carton at 360 less 5%: 28.50 a piece.
    expect(res.body.items.map((i: { rate: string; discountPercent: string; unitCost: string }) => [i.rate, i.discountPercent, i.unitCost])).toEqual([
      ["360.0000", "5.000", "28.5000"],
      ["100.0000", "0.000", "100.0000"],
    ]);
    ids.grn = res.body.id;
    ids.grnSoap = res.body.items[0].id;
    ids.grnOil = res.body.items[1].id;
    expect(await stockOf(ids.soap)).toBe("22.000");
    expect(await stockOf(ids.oil)).toBe("3.000");
    expect(await avgCost(ids.soap)).toBeCloseTo((10 * 28 + 12 * 28.5) / 22, 3);
    const o = await order();
    expect(o.status).toBe("partly_received");
    expect(o.items.map((i: { receivedBase: string }) => i.receivedBase)).toEqual(["12.000", "3.000"]);
    expect(o.receipts).toEqual([expect.objectContaining({ id: ids.grn, status: "received" })]);
  });

  it("bills the goods received at the supplier's rate: no stock twice, the cost follows the bill", async () => {
    const open = (await get(`/suppliers/${ids.hul}/open-purchases`)).body;
    expect(open.receipts.map((g: { id: string }) => g.id)).toEqual([ids.grn]);
    expect(open.orders.map((o: { id: string }) => o.id)).toEqual([ids.po]);
    const res = await post("/purchases", {
      supplierId: ids.hul,
      supplierInvoiceNumber: "HUL-5501",
      supplierInvoiceDate: TEST_TODAY,
      lines: [
        { productId: ids.soap, unitId: ids.CTN, qty: "1", rate: "372", goodsReceiptItemId: ids.grnSoap },
        { productId: ids.oil, qty: "3", rate: "100", goodsReceiptItemId: ids.grnOil },
      ],
    });
    expect(res.status).toBe(201);
    ids.bill1 = res.body.id;
    expect(res.body.receipts).toEqual([expect.objectContaining({ id: ids.grn, receiptNumber: "GRN/26-27/00001" })]);
    expect(res.body.orders).toEqual([expect.objectContaining({ id: ids.po })]);
    expect(await stockOf(ids.soap)).toBe("22.000");
    expect(await stockOf(ids.oil)).toBe("3.000");
    // The carton cost 372 (31 a piece), not 342: the 12 pieces on hand are worth 30 more.
    expect(await avgCost(ids.soap)).toBeCloseTo((10 * 28 + 12 * 31) / 22, 3);
    expect(await ledgerValue(ids.soap)).toBeCloseTo(10 * 28 + 12 * 31, 2);
    expect((await get(`/goods-receipts/${ids.grn}`)).body).toMatchObject({ status: "billed", purchase: { id: ids.bill1, supplierInvoiceNumber: "HUL-5501" } });
    // The order counted these goods when they came, not again with the bill.
    expect((await order()).items.map((i: { receivedBase: string }) => i.receivedBase)).toEqual(["12.000", "3.000"]);
  });

  it("brings the rest of the order with a bill, which completes the order", async () => {
    const res = await post("/purchases", {
      supplierId: ids.hul,
      supplierInvoiceNumber: "HUL-5502",
      supplierInvoiceDate: TEST_TODAY,
      lines: [
        { productId: ids.soap, unitId: ids.CTN, qty: "1", rate: "372", purchaseOrderItemId: ids.poSoap },
        { productId: ids.oil, qty: "2", rate: "100", purchaseOrderItemId: ids.poOil },
      ],
    });
    expect(res.status).toBe(201);
    ids.bill2 = res.body.id;
    expect(await stockOf(ids.soap)).toBe("34.000");
    expect(await stockOf(ids.oil)).toBe("5.000");
    const o = await order();
    expect(o.status).toBe("received");
    expect(o.items.map((i: { remainingBase: string }) => i.remainingBase)).toEqual(["0.000", "0.000"]);
    expect(o.bills.map((b: { id: string }) => b.id)).toEqual([ids.bill2]);
    expect((await get("/purchase-orders?status=pending")).body.data).toEqual([]);
  });

  it("refuses what does not fit: a receipt billed twice or in part, changed lines, an order that is complete", async () => {
    const again = await post("/purchases", {
      supplierId: ids.hul,
      supplierInvoiceNumber: "HUL-5503",
      supplierInvoiceDate: TEST_TODAY,
      lines: [{ productId: ids.oil, qty: "3", rate: "100", goodsReceiptItemId: ids.grnOil }, { productId: ids.soap, unitId: ids.CTN, qty: "1", rate: "372", goodsReceiptItemId: ids.grnSoap }],
    });
    expect(again.body.error.code).toBe("GOODS_RECEIPT_BILLED");
    const more = await post("/goods-receipts", { supplierId: ids.hul, purchaseOrderId: ids.po, lines: [{ productId: ids.oil, qty: "1", purchaseOrderItemId: ids.poOil }] });
    expect(more.body.error.code).toBe("PURCHASE_ORDER_NOT_OPEN");
    // Goods without an order, from the order's supplier: tea and oil.
    const grn2 = await post("/goods-receipts", { supplierId: ids.hul, lines: [{ productId: ids.tea, qty: "10", rate: "70" }, { productId: ids.oil, qty: "1" }] });
    expect(grn2.status).toBe(201);
    expect(grn2.body.items.map((i: { unitCost: string }) => i.unitCost)).toEqual(["70.0000", "100.0000"]);
    ids.grn2 = grn2.body.id;
    const [teaLine, oilLine] = grn2.body.items as Array<{ id: string }>;
    const part = await post("/purchases", { supplierId: ids.hul, supplierInvoiceNumber: "HUL-5504", supplierInvoiceDate: TEST_TODAY, lines: [{ productId: ids.tea, qty: "10", rate: "70", goodsReceiptItemId: teaLine!.id }] });
    expect(part.body.error.code).toBe("RECEIPT_NOT_WHOLE");
    const changed = await post("/purchases", {
      supplierId: ids.hul,
      supplierInvoiceNumber: "HUL-5504",
      supplierInvoiceDate: TEST_TODAY,
      lines: [
        { productId: ids.tea, qty: "12", rate: "70", goodsReceiptItemId: teaLine!.id },
        { productId: ids.oil, qty: "1", rate: "100", goodsReceiptItemId: oilLine!.id },
      ],
    });
    expect(changed.body.error).toMatchObject({ code: "RECEIPT_LINE_CHANGED", field: "lines[0].qty" });
    const elsewhere = await post("/purchases", {
      supplierId: ids.other,
      supplierInvoiceNumber: "LW-1",
      supplierInvoiceDate: TEST_TODAY,
      lines: [
        { productId: ids.tea, qty: "10", rate: "70", goodsReceiptItemId: teaLine!.id },
        { productId: ids.oil, qty: "1", rate: "100", goodsReceiptItemId: oilLine!.id },
      ],
    });
    expect(elsewhere.body.error.code).toBe("RECEIPT_OTHER_SUPPLIER");
    expect((await post(`/purchase-orders/${ids.po}/cancel`, {})).body.error.code).toBe("PURCHASE_ORDER_RECEIVED");
  });

  it("cancels a bill made from received goods (they stay, waiting for a bill) and then the receipt (they go)", async () => {
    const cancelled = await post(`/purchases/${ids.bill1}/cancel`, { reason: "Wrong rate" });
    expect(cancelled.status).toBe(200);
    expect(await stockOf(ids.soap)).toBe("34.000");
    expect((await get(`/goods-receipts/${ids.grn}`)).body).toMatchObject({ status: "received", purchase: null });
    // Back to the receipt's cost for the 12 pieces that came on it.
    expect(await ledgerValue(ids.soap)).toBeCloseTo(10 * 28 + 12 * 28.5 + 12 * 31, 2);
    const gone = await post(`/goods-receipts/${ids.grn}/cancel`, { reason: "Sent back" });
    expect(gone.status).toBe(200);
    expect(gone.body.status).toBe("cancelled");
    // Oil: 6 (the second receipt's one is still in) less the 3 that came on this one.
    expect(await stockOf(ids.soap)).toBe("22.000");
    expect(await stockOf(ids.oil)).toBe("3.000");
    const o = await order();
    expect(o.status).toBe("partly_received");
    expect(o.items.map((i: { receivedBase: string }) => i.receivedBase)).toEqual(["12.000", "2.000"]);
    expect((await post(`/goods-receipts/${ids.grn}/cancel`, { reason: "Again" })).body.error.code).toBe("GOODS_RECEIPT_CANCELLED");
    // The second bill brought its goods itself: cancelling it takes them back off the order.
    expect((await post(`/purchases/${ids.bill2}/cancel`, { reason: "Duplicate" })).status).toBe(200);
    expect((await order()).items.map((i: { receivedBase: string }) => i.receivedBase)).toEqual(["0.000", "0.000"]);
    expect((await order()).status).toBe("open");
  });

  it("closes an order no more will come against, cancels one nothing came against, and keeps them to the business", async () => {
    const closed = await post(`/purchase-orders/${ids.po}/close`, { reason: "Out of stock at the company" });
    expect(closed.body).toMatchObject({ status: "closed", cancelReason: "Out of stock at the company" });
    expect((await post("/goods-receipts", { supplierId: ids.hul, purchaseOrderId: ids.po, lines: [{ productId: ids.oil, qty: "1", purchaseOrderItemId: ids.poOil }] })).body.error.code).toBe("PURCHASE_ORDER_NOT_OPEN");
    const po2 = await post("/purchase-orders", { supplierId: ids.hul, lines: [{ productId: ids.tea, qty: "20", rate: "70" }] });
    expect(po2.body.orderNumber).toBe("PO/26-27/00002");
    expect((await post(`/purchase-orders/${po2.body.id}/cancel`, { reason: "Ordered twice" })).body.status).toBe("cancelled");
    expect((await get("/purchase-orders?status=all")).body.data.map((o: { status: string }) => o.status)).toEqual(["cancelled", "closed"]);
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    expect((await get(`/purchase-orders/${ids.po}`, other.token)).status).toBe(404);
    expect((await get(`/goods-receipts/${ids.grn2}`, other.token)).status).toBe(404);
    expect((await get("/goods-receipts", other.token)).body.data).toEqual([]);
  });
});
