import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("godowns and stock transfers", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const stockIn = async (warehouseId: string | undefined) => (await get(`/stock?warehouseId=${warehouseId}`)).body.data.find((r: { productId: string }) => r.productId === ids.soap)?.qty;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Two Godowns", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", openingStock: "100", openingStockCost: "30" })).body.id;
    ids.main = (await get("/warehouses")).body.data[0].id;
    ids.shop = (await post("/warehouses", { name: "Shop Godown", code: "shop", city: "Indore" })).body.id;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("moves stock out of one godown and into the other at the average cost", async () => {
    const res = await post("/stock/transfers", { fromWarehouseId: ids.main, toWarehouseId: ids.shop, notes: "For the counter", lines: [{ productId: ids.soap, qty: "20" }, { productId: ids.soap, qty: "10" }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ transferNumber: "STR/26-27/00001", from: { name: "Main Godown" }, to: { name: "Shop Godown" }, lines: [{ qty: "30.000", fromAfter: "70.000", toAfter: "30.000" }] });
    expect(await stockIn(ids.main)).toBe("70.000");
    expect(await stockIn(ids.shop)).toBe("30.000");
    const product = (await get(`/products/${ids.soap}`)).body;
    expect(product.avgCost).toBe("30.0000");
    expect(product.stock.total).toBe("100.000");
    const ledger = (await get(`/stock/ledger?productId=${ids.soap}&warehouseId=${ids.shop}`)).body;
    expect(ledger.entries).toEqual([expect.objectContaining({ type: "transfer_in", qtyIn: "30.000", refNumber: "STR/26-27/00001" })]);
    expect((await get("/stock/transfers")).body.data).toEqual([expect.objectContaining({ transferNumber: "STR/26-27/00001", from: "Main Godown", to: "Shop Godown", lines: 1, qty: "30.000" })]);
  });

  it("refuses the same godown, more than is there under 'block', and roles without inventory.transfer", async () => {
    const same = await post("/stock/transfers", { fromWarehouseId: ids.shop, toWarehouseId: ids.shop, lines: [{ productId: ids.soap, qty: "1" }] });
    expect(same.body.error.code).toBe("TRANSFER_SAME_GODOWN");
    await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "block" } });
    const over = await post("/stock/transfers", { fromWarehouseId: ids.shop, toWarehouseId: ids.main, lines: [{ productId: ids.soap, qty: "31" }] });
    expect(over.status).toBe(409);
    expect(await stockIn(ids.shop)).toBe("30.000");
    expect((await post("/stock/transfers", { fromWarehouseId: ids.shop, toWarehouseId: ids.main, lines: [{ productId: ids.soap, qty: "1" }] }, salesToken)).status).toBe(403);
  });
});
