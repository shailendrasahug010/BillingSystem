import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("profit, P&L and product reports", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const RANGE = "from=2026-09-01&to=2026-09-30";

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Margin Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;

    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const hul = (await post("/brands", { name: "HUL" })).body.id;
    const parle = (await post("/brands", { name: "Parle" })).body.id;
    const product = async (name: string, brandId: string | undefined, price: string, cost: string, stock: string, tax = "GST 18%") =>
      (await post("/products", { name, brandId, taxCategoryId: taxes[tax], baseUnitId: units.PCS, sellingPrice: price, openingStock: stock, openingStockCost: cost })).body.id as string;
    ids.soap = await product("Bath Soap", hul, "100", "70", "100");
    ids.biscuit = await product("Biscuit", parle, "10", "8", "500", "GST 5%");
    ids.tea = await product("Tea Pack", undefined, "10", "6", "50", "GST 5%");
    ids.idle = await product("Old Stock Soap", hul, "50", "30", "20");
    const customer = (await post("/customers", { name: "Kirana One", stateCode: "23" })).body.id;
    const inv = (await post("/invoices", { customerId: customer, lines: [{ productId: ids.soap, qty: "10" }, { productId: ids.biscuit, qty: "100" }] })).body;
    await post("/invoices", { customerId: customer, lines: [{ productId: ids.tea, qty: "1" }] });
    await post(`/invoices/${inv.id}/returns`, { lines: [{ lineId: inv.items[0].id, qty: "2" }] });
    await post(`/invoices/${inv.id}/price-notes`, { reason: "discount", lines: [{ lineId: inv.items[1].id, amount: "50" }] });

    const cats = Object.fromEntries((await get("/expense-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    await post("/expenses", { categoryId: cats.Rent, amount: "5000", paymentMethod: "bank_transfer", expenseDate: "2026-09-05" });
    const emp = (await post("/employees", { name: "Ramesh Yadav", mobile: "9876500001", joiningDate: "2025-01-01" })).body.id;
    await call(t.app, "PUT", `/employees/${emp}/salary`, { token: owner.token, body: { effectiveFrom: "2025-01-01", basic: "3000" } });
    const run = (await post("/payroll/runs", { month: "2026-09" })).body.id;
    await post(`/payroll/runs/${run}/finalize`, {});
  });
  afterAll(async () => {
    await t?.close();
  });

  it("reports margin by product and by company, net of returns and discounts", async () => {
    const byProduct = (await get(`/reports/profit?${RANGE}&groupBy=product`)).body;
    // Soap: 10 sold, 2 returned -> 8 x (100 - 70). Biscuit: 1000 - 50 discount, cost 800. Tea: 10 - 6.
    expect(byProduct.rows.map((r: { label: string; qty: string; sales: string; cost: string; margin: string; marginPercent: string }) => [r.label, r.qty, r.sales, r.cost, r.margin, r.marginPercent])).toEqual([
      ["Bath Soap", "8.000", "800.00", "560.00", "240.00", "30.0"],
      ["Biscuit", "100.000", "950.00", "800.00", "150.00", "15.8"],
      ["Tea Pack", "1.000", "10.00", "6.00", "4.00", "40.0"],
    ]);
    expect(byProduct.totals).toEqual({ sales: "1760.00", cost: "1366.00", margin: "394.00", marginPercent: "22.4" });
    const byBrand = (await get(`/reports/profit?${RANGE}&groupBy=brand`)).body.rows.map((r: { label: string; margin: string }) => [r.label, r.margin]);
    expect(byBrand).toEqual([
      ["HUL", "240.00"],
      ["Parle", "150.00"],
      ["No brand", "4.00"],
    ]);
    expect((await get(`/reports/profit?${RANGE}`, salesToken)).status).toBe(403);
  });

  it("puts together a profit and loss: gross margin, expenses and salaries", async () => {
    const pnl = (await get(`/reports/pnl?${RANGE}`)).body;
    expect(pnl).toMatchObject({
      sales: "1760.00",
      costOfGoodsSold: "1366.00",
      grossProfit: "394.00",
      grossMarginPercent: "22.4",
      expenses: [{ category: "Rent", amount: "5000.00" }],
      expenseTotal: "5000.00",
      salaries: "3000.00",
      netProfit: "-7606.00",
    });
  });

  it("classifies products as fast, slow or not moving with stock value and days of cover", async () => {
    const rows = (await get(`/reports/products?${RANGE}`)).body.rows;
    const by = Object.fromEntries(rows.map((r: { name: string }) => [r.name, r]));
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["Biscuit", "Bath Soap", "Tea Pack", "Old Stock Soap"]);
    expect(by.Biscuit).toMatchObject({ movement: "fast", qtySold: "100.000", stock: "400.000" });
    expect(by["Bath Soap"]).toMatchObject({ movement: "fast", qtySold: "8.000", stock: "92.000", stockValue: "6440.00", daysOfCover: "345", margin: "240.00" });
    expect(by["Tea Pack"]).toMatchObject({ movement: "slow" });
    expect(by["Old Stock Soap"]).toMatchObject({ movement: "not_moving", qtySold: "0.000", stockValue: "600.00", daysOfCover: null });
    const csv = await t.app.inject({ method: "GET", url: `/api/v1/reports/products?${RANGE}&format=csv`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(csv.body).toContain("Bath Soap,HUL,8.000,800.00,240.00,6440.00,92.000,345,fast");
  });
});
