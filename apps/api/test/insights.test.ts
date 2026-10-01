import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

interface Metric {
  value: string | null;
  previous: string | null;
  change: string | null;
}

/**
 * Phase 5.5, business intelligence: September against August for a small
 * distributor whose every figure is worked out by hand below.
 *
 * Opening stock (1 July): tea 50 @ 60, soap 200 @ 30, oil 10 @ 150, idle soap 50 @ 10 = 11,000.
 * August: One buys 10 tea (1,000; cost 600), Three buys 20 soap (1,000; cost 600).
 * September: One buys 20 tea and 10 soap through Sam (2,500; cost 1,500), returns 2 soap (100; cost 60)
 * and pays 1,000; Two (new) buys 3 oil (600; cost 450). Three buys nothing.
 */
describe.skipIf(!hasDatabase)("insights (business intelligence)", () => {
  let t: TestApp;
  let owner: Session;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const at = async <T>(day: string, fn: () => Promise<T>) => {
    t.setToday(day);
    try {
      return await fn();
    } finally {
      t.setToday(null);
    }
  };
  const member = async (roleId: string) => {
    const mobile = nextMobile();
    await post("/members", { name: `Member ${mobile.slice(-3)}`, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };
  const SEPTEMBER = "from=2026-09-01&to=2026-09-30";

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Insight Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    await at("2026-07-01", async () => {
      const tata = (await post("/brands", { name: "Tata" })).body.id;
      const hul = (await post("/brands", { name: "HUL" })).body.id;
      const product = async (name: string, brandId: string | undefined, price: string, cost: string, stock: string, tax: string) =>
        (await post("/products", { name, brandId, taxCategoryId: taxes[tax], baseUnitId: units.PCS, sellingPrice: price, openingStock: stock, openingStockCost: cost })).body.id as string;
      ids.tea = await product("Tea 250g", tata, "100", "60", "50", "GST 5%");
      ids.soap = await product("Bath Soap", hul, "50", "30", "200", "GST 18%");
      ids.oil = await product("Mustard Oil 1L", undefined, "200", "150", "10", "GST 5%");
      ids.idle = await product("Old Soap", hul, "20", "10", "50", "GST 18%");
      for (const name of ["Kirana One", "Kirana Two", "Kirana Three"]) ids[name] = (await post("/customers", { name, stateCode: "23" })).body.id;
      ids.sam = (await post("/employees", { name: "Sam Sales", mobile: "9876500011", joiningDate: "2025-01-01" })).body.id;
    });
    const bill = async (customer: string, lines: Array<{ productId: string; qty: string }>, extra: Record<string, unknown> = {}) => {
      const res = await post("/invoices", { customerId: ids[customer], lines, ...extra });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };
    await at("2026-08-10", () => bill("Kirana One", [{ productId: ids.tea!, qty: "10" }]));
    await at("2026-08-20", () => bill("Kirana Three", [{ productId: ids.soap!, qty: "20" }]));
    const big = await at("2026-09-05", () => bill("Kirana One", [{ productId: ids.tea!, qty: "20" }, { productId: ids.soap!, qty: "10" }], { salespersonId: ids.sam }));
    await at("2026-09-12", () => bill("Kirana Two", [{ productId: ids.oil!, qty: "3" }]));
    await at("2026-09-15", () => post(`/invoices/${big.id}/returns`, { lines: [{ lineId: big.items[1].id, qty: "2" }] }));
    await at("2026-09-16", () => post("/payments", { direction: "in", customerId: ids["Kirana One"], amount: "1000", method: "cash" }));

    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    // Insights without margins, collections or dues.
    const viewer = (await post("/roles", { key: "bi_viewer", name: "Insights viewer", grants: ["report.view_bi", "report.view_sales"] })).body.id;
    tokens.viewer = await member(viewer);
    tokens.sales = await member(roles.sales);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("compares the month's measures with the month before", async () => {
    const res = await get(`/insights?${SEPTEMBER}`);
    expect(res.status).toBe(200);
    const b = res.body;
    // 30 days before 1 September: 2 to 31 August.
    expect(b.compare).toEqual({ basis: "previous", from: "2026-08-02", to: "2026-08-31" });
    const k = b.kpis as Record<string, Metric>;
    expect(k.netSales).toEqual({ value: "3000.00", previous: "2000.00", change: "50.0" });
    expect(k.grossMargin).toEqual({ value: "1110.00", previous: "800.00", change: "38.8" });
    // 37.0% against 40.0%: the change of a percent is in points.
    expect(k.marginPercent).toEqual({ value: "37.0", previous: "40.0", change: "-3.0" });
    expect(k.costOfGoodsSold).toEqual({ value: "1890.00", previous: "1200.00", change: "57.5" });
    expect(k.bills).toEqual({ value: "2", previous: "2", change: "0.0" });
    // With GST: 2,100 + 590 and 630 against 1,050 and 1,180.
    expect(k.averageBill).toEqual({ value: "1660.00", previous: "1115.00", change: "48.9" });
    expect(k.customersBilled).toEqual({ value: "2", previous: "2", change: "0.0" });
    expect(k.newCustomers).toEqual({ value: "1", previous: "2", change: "-50.0" });
    expect(k.returns).toEqual({ value: "100.00", previous: "0.00", change: null });
    // 100 of 3,100 sold before returns.
    expect(k.returnRate).toEqual({ value: "3.2", previous: "0.0", change: "3.2" });
    expect(k.collections).toEqual({ value: "1000.00", previous: "0.00", change: null });
    // 1,050 + 1,180 + 2,690 + 630 − 118 (the return with GST) − 1,000.
    expect(k.receivables).toEqual({ value: "4432.00", previous: "2230.00", change: "98.7" });
    // 4,432 owed against 3,320 billed in 30 days; 2,230 against 2,230.
    expect(k.daysSalesOutstanding).toEqual({ value: "40", previous: "30", change: "33.3" });
    // 11,000 − 1,200 (August) − 1,950 (September) + 60 (returned).
    expect(k.inventoryValue).toEqual({ value: "7910.00", previous: "9800.00", change: "-19.3" });
    // 1,890 over (9,800 + 7,910) / 2; August 1,200 over (11,000 + 9,800) / 2.
    expect(k.turnover).toEqual({ value: "0.21", previous: "0.12", change: "75.0" });
    expect(k.daysOfInventory).toEqual({ value: "141", previous: "260", change: "-45.8" });
  });

  it("gives the 12 months to the period's end", async () => {
    const trend = (await get(`/insights?${SEPTEMBER}`)).body.trend as Array<{ month: string; sales: string; margin: string }>;
    expect(trend).toHaveLength(12);
    expect(trend[0]).toEqual({ month: "2025-10", sales: "0.00", margin: "0.00" });
    expect(trend.slice(-2)).toEqual([
      { month: "2026-08", sales: "2000.00", margin: "800.00" },
      { month: "2026-09", sales: "3000.00", margin: "1110.00" },
    ]);
  });

  it("shows who the sales come from: share, ABC class, growth, new and lost customers", async () => {
    const { customers, companies, salespeople } = (await get(`/insights?${SEPTEMBER}`)).body;
    expect(customers.rows.map((r: Record<string, unknown>) => [r.name, r.sales, r.share, r.cumulative, r.abc, r.previousSales, r.change, r.status])).toEqual([
      ["Kirana One", "2400.00", "80.0", "80.0", "A", "1000.00", "140.0", "growing"],
      ["Kirana Two", "600.00", "20.0", "100.0", "B", "0.00", null, "new"],
      ["Kirana Three", "0.00", "0.0", "100.0", "C", "1000.00", "-100.0", "lost"],
    ]);
    expect(customers.rows[0]).toMatchObject({ code: "C0001", margin: "960.00", marginPercent: "40.0" });
    expect(customers).toMatchObject({ total: "3000.00", count: 2, newCount: 1, lostCount: 1, lostSales: "1000.00" });
    expect(customers.abc).toEqual({ A: { count: 1, sales: "2400.00", share: "80.0" }, B: { count: 1, sales: "600.00", share: "20.0" }, C: { count: 0, sales: "0.00", share: "0.0" } });
    expect(companies.rows.map((r: Record<string, unknown>) => [r.name, r.sales, r.share, r.abc, r.previousSales, r.change, r.status])).toEqual([
      ["Tata", "2000.00", "66.7", "A", "1000.00", "100.0", "growing"],
      ["", "600.00", "20.0", "A", "0.00", null, "new"],
      ["HUL", "400.00", "13.3", "B", "1000.00", "-60.0", "declining"],
    ]);
    expect(companies.rows[1].key).toBe("-");
    expect(salespeople.rows.map((r: Record<string, unknown>) => [r.name, r.sales])).toEqual([
      ["Sam Sales", "2400.00"],
      ["", "600.00"],
    ]);
  });

  it("shows how stock moves: fast, slow (more than 90 days of it) and dead (no sale in 90 days)", async () => {
    const m = (await get(`/insights?${SEPTEMBER}`)).body.movers;
    expect(m.fast.map((r: Record<string, unknown>) => [r.name, r.qtySold, r.sales, r.stock, r.daysOfCover])).toEqual([
      ["Tea 250g", "20.000", "2000.00", "20.000", "30"],
      ["Mustard Oil 1L", "3.000", "600.00", "7.000", "70"],
      ["Bath Soap", "8.000", "400.00", "172.000", "645"],
    ]);
    expect(m.slow.map((r: Record<string, unknown>) => [r.name, r.stockValue])).toEqual([["Bath Soap", "5160.00"]]);
    expect(m.dead.map((r: Record<string, unknown>) => [r.name, r.stock, r.stockValue, r.lastSold])).toEqual([["Old Soap", "50.000", "500.00", null]]);
    expect(m).toMatchObject({ slowCount: 1, deadCount: 1, slowValue: "5160.00", deadValue: "500.00", slowAfterDays: 90, deadAfterDays: 90 });
  });

  it("compares with the same dates a year earlier too", async () => {
    const b = (await get(`/insights?${SEPTEMBER}&compare=last_year`)).body;
    expect(b.compare).toEqual({ basis: "last_year", from: "2025-09-01", to: "2025-09-30" });
    expect(b.kpis.netSales).toEqual({ value: "3000.00", previous: "0.00", change: null });
    // Every customer is new against a year with no sales.
    expect(b.customers.newCount).toBe(2);
  });

  it("leaves out margins, stock values, collections and dues for a role that may not see them", async () => {
    const b = (await get(`/insights?${SEPTEMBER}`, tokens.viewer)).body;
    expect(Object.keys(b.kpis).sort()).toEqual(["averageBill", "bills", "customersBilled", "netSales", "newCustomers", "returnRate", "returns"]);
    expect(b.customers.rows[0]).not.toHaveProperty("margin");
    expect(b.movers.fast[0]).not.toHaveProperty("stockValue");
    expect(b.movers).not.toHaveProperty("deadValue");
    expect(b.trend[0]).not.toHaveProperty("margin");
    // A salesperson's role does not open insights.
    expect((await get(`/insights?${SEPTEMBER}`, tokens.sales)).status).toBe(403);
  });

  it("downloads each table as a file", async () => {
    const res = await t.app.inject({ method: "GET", url: `/api/v1/insights?${SEPTEMBER}&section=customers&format=csv`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split(/\r?\n/);
    expect(lines[0]).toContain("Customer");
    expect(lines.some((l) => l.includes("Kirana One") && l.includes("2400.00"))).toBe(true);
    const dead = await t.app.inject({ method: "GET", url: `/api/v1/insights?${SEPTEMBER}&section=dead&format=xlsx`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(dead.statusCode).toBe(200);
    expect(dead.headers["content-type"]).toContain("spreadsheetml");
    expect((await get(`/insights?${SEPTEMBER}&format=csv`)).body.error.code).toBe("SECTION_REQUIRED");
  });
});
