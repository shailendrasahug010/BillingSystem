import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("recent bills kept on a device", () => {
  let t: TestApp;
  let owner: Session;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => call(t.app, "POST", url, { token: owner.token, body, headers });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const login = async (roleId: string, name: string) => {
    const mobile = nextMobile();
    await post("/members", { name, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Kept Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    for (const key of ["sales", "warehouse", "hr"]) tokens[key] = await login(roles[key], `${key} person`);
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "60" })).body.id;
    ids.shop = (await post("/customers", { name: "Gupta Kirana", stateCode: "23" })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Soap Depot", stateCode: "23", gstRegistration: "unregistered" })).body.id;
    ids.recent = (await post("/invoices", { customerId: ids.shop, invoiceDate: "2026-09-20", lines: [{ productId: ids.soap, qty: "3" }] })).body.id;
    ids.old = (await post("/invoices", { customerId: ids.shop, invoiceDate: "2026-08-01", lines: [{ productId: ids.soap, qty: "1" }] })).body.id;
    const cancelled = (await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "1" }] })).body.id;
    await post(`/invoices/${cancelled}/cancel`, { reason: "Wrong shop" });
    ids.purchase = (
      await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "SD/7", supplierInvoiceDate: "2026-09-22", lines: [{ productId: ids.soap, qty: "10", rate: "60" }] })
    ).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("gives the last 30 days of posted bills, as their own screens show them, for what the role may view", async () => {
    const res = await get("/offline/documents?days=30");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.since).toBe("2026-08-25");
    expect(res.body.invoices.map((i: { id: string }) => i.id)).toEqual([ids.recent]);
    const kept = res.body.invoices[0];
    expect(kept).toEqual((await get(`/invoices/${ids.recent}`)).body);
    expect(kept.items[0]).toMatchObject({ productId: ids.soap, qty: "3.000", returnedQty: "0.000", conversionFactor: "1.000" });
    expect(res.body.purchases.map((p: { id: string }) => p.id)).toEqual([ids.purchase]);
    expect(res.body.purchases[0]).toEqual((await get(`/purchases/${ids.purchase}`)).body);

    const sales = (await get("/offline/documents", tokens.sales)).body;
    expect(sales.purchases).toBeUndefined();
    expect(sales.invoices).toHaveLength(1);
    expect(sales.invoices[0].costTotal).toBeUndefined();
    expect(sales.invoices[0].items[0].unitCost).toBeUndefined();

    const warehouse = (await get("/offline/documents", tokens.warehouse)).body;
    expect(warehouse.invoices).toBeUndefined();
    expect(warehouse.purchases).toHaveLength(1);

    expect(Object.keys((await get("/offline/documents", tokens.hr)).body)).toEqual(["since"]);
  });

  it("takes a return made offline once, however often the device sends it", async () => {
    const line = (await get(`/invoices/${ids.recent}`)).body.items[0].id;
    const key = "0190d3c8-2222-7000-8000-000000000001";
    const body = { noteDate: "2026-09-24", reason: "sales_return", restock: true, lines: [{ lineId: line, qty: "1" }] };
    const first = await post(`/invoices/${ids.recent}/returns`, body, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const again = await post(`/invoices/${ids.recent}/returns`, body, { "idempotency-key": key });
    expect(again.body.noteNumber).toBe(first.body.noteNumber);
    const kept = (await get("/offline/documents")).body.invoices[0];
    expect(kept.items[0].returnedQty).toBe("1.000");
    expect(kept.returns).toHaveLength(1);
  });
});
