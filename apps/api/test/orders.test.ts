import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("sales orders", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const stockOf = async (id: string | undefined) => (await t.owner.query(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1`, [id])).rows[0].qty as string;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Order Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "50", openingStockCost: "70" })).body.id;
    ids.biscuit = (await post("/products", { name: "Biscuit", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "100", openingStockCost: "8" })).body.id;
    ids.customer = (await post("/customers", { name: "Order Kirana", stateCode: "23", creditDays: 7 })).body.id;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("a salesperson books an order, priced like an invoice, with no stock or ledger effect", async () => {
    const res = await post("/sales-orders", { customerId: ids.customer, source: "salesperson", lines: [{ productId: ids.soap, qty: "10" }, { productId: ids.biscuit, qty: "20", freeQty: "2" }] }, salesToken);
    expect(res.status).toBe(201);
    ids.order = res.body.id;
    ids.soapLine = res.body.items[0].id;
    expect(res.body).toMatchObject({ orderNumber: "SO/26-27/00001", status: "pending", taxableTotal: "1200.00", grandTotal: "1390.00", customer: { name: "Order Kirana" }, nextStatuses: ["confirmed", "cancelled"] });
    expect(await stockOf(ids.soap)).toBe("50.000");
    expect((await get(`/customers/${ids.customer}`)).body.balance).toBe("0.00");
  });

  it("must be confirmed (by someone allowed) before it is invoiced", async () => {
    expect((await post(`/sales-orders/${ids.order}/invoice`, {})).body.error.code).toBe("ORDER_NOT_CONFIRMED");
    expect((await post(`/sales-orders/${ids.order}/status`, { status: "confirmed" }, salesToken)).status).toBe(403);
    const res = await post(`/sales-orders/${ids.order}/status`, { status: "confirmed" });
    expect(res.body).toMatchObject({ status: "confirmed", history: [expect.objectContaining({ toStatus: "pending" }), expect.objectContaining({ fromStatus: "pending", toStatus: "confirmed" })] });
  });

  it("invoices part of a line, then the rest, at the order's rates", async () => {
    const part = await post(`/sales-orders/${ids.order}/invoice`, { lines: [{ orderLineId: ids.soapLine, qty: "4" }] });
    expect(part.status).toBe(201);
    expect(part.body).toMatchObject({ salesOrderId: ids.order, grandTotal: "472.00" });
    expect(await stockOf(ids.soap)).toBe("46.000");
    let order = (await get(`/sales-orders/${ids.order}`)).body;
    expect(order.items[0]).toMatchObject({ invoicedQty: "4.000", remainingQty: "6.000" });
    const over = await post(`/sales-orders/${ids.order}/invoice`, { lines: [{ orderLineId: ids.soapLine, qty: "7" }] });
    expect(over.body.error).toMatchObject({ code: "ORDER_QTY_EXCEEDS", params: { max: "6.000" } });
    const demand = (await get("/sales-orders/demand")).body.data;
    expect(demand).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Soap", qty: "6.000", stock: "46.000", short: false })]));

    const rest = await post(`/sales-orders/${ids.order}/invoice`, {});
    expect(rest.body.items.map((i: { productName: string; qty: string; freeQty: string }) => [i.productName, i.qty, i.freeQty])).toEqual([
      ["Soap", "6.000", "0.000"],
      ["Biscuit", "20.000", "2.000"],
    ]);
    expect(await stockOf(ids.biscuit)).toBe("78.000");
    order = (await get(`/sales-orders/${ids.order}`)).body;
    expect(order.invoices).toHaveLength(2);
    expect(order.items.every((i: { remainingQty: string }) => i.remainingQty === "0.000")).toBe(true);
    expect((await post(`/sales-orders/${ids.order}/invoice`, {})).body.error.code).toBe("ORDER_FULLY_INVOICED");
    const list = (await get("/sales-orders?status=open")).body.data;
    expect(list[0]).toMatchObject({ orderNumber: "SO/26-27/00001", invoiced: "1.000", lines: 2 });
  });

  it("cancelling closes what is still open; a cancelled order cannot move again", async () => {
    const o = (await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "5" }] })).body;
    expect((await post(`/sales-orders/${o.id}/status`, { status: "cancelled" })).body.error.code).toBe("CANCEL_REASON_REQUIRED");
    const res = await post(`/sales-orders/${o.id}/status`, { status: "cancelled", note: "Customer changed mind" });
    expect(res.body).toMatchObject({ status: "cancelled", cancelReason: "Customer changed mind", nextStatuses: [] });
    expect(res.body.items[0]).toMatchObject({ cancelledQty: "5.000", remainingQty: "0.000" });
    expect((await post(`/sales-orders/${o.id}/status`, { status: "confirmed" })).body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });
});
