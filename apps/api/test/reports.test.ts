import { gstinCheckChar } from "@vyapaar/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toCsv } from "../src/modules/reports/reports.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe("CSV export", () => {
  it("escapes quotes and neutralises spreadsheet formulas", () => {
    const csv = toCsv(
      [
        { key: "name", label: "Name" },
        { key: "amount", label: "Amount" },
      ],
      [
        { name: '=HYPERLINK("http://x")', amount: "-120.50" },
        { name: "Sharma, Ramesh", amount: "10" },
      ],
    );
    expect(csv).toBe('Name,Amount\r\n"\'=HYPERLINK(""http://x"")",-120.50\r\n"Sharma, Ramesh",10\r\n');
  });
});

describe.skipIf(!hasDatabase)("dashboard, reports and search", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Report Traders", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { gstin: gstin("23", "AAPFR1234K") } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.brand = (await post("/brands", { name: "Parle" })).body.id;
    ids.biscuit = (
      await post("/products", { name: "Parle-G 100g", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], brandId: ids.brand, baseUnitId: units.PCS, sellingPrice: "10", minStock: "500", openingStock: "400", openingStockCost: "8" })
    ).body.id;
    ids.soap = (await post("/products", { name: "Lifebuoy Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "1000", openingStock: "5", openingStockCost: "700" })).body.id;
    ids.shop = (await post("/customers", { name: "Anand Stores", mobile: "9826011111", stateCode: "23", creditDays: 10 })).body.id;
    ids.b2b = (await post("/customers", { name: "Bhopal Mart", customerType: "b2b", stateCode: "23", gstin: gstin("23", "AABCB9999C") })).body.id;
    ids.far = (await post("/customers", { name: "=Evil Formula Co", stateCode: "27" })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Parle Depot", stateCode: "23", gstin: gstin("23", "AAACP5555K") })).body.id;

    // Sales across the month (back-dated by the owner) and today.
    await post("/invoices", { customerId: ids.shop, invoiceDate: "2026-08-20", lines: [{ productId: ids.biscuit, qty: "100" }] }); // 1050, due 08-30
    await post("/invoices", { customerId: ids.shop, invoiceDate: "2026-09-05", lines: [{ productId: ids.biscuit, qty: "50" }] }); // 525, due 09-15
    await post("/invoices", { customerId: ids.b2b, invoiceDate: "2026-09-10", lines: [{ productId: ids.soap, qty: "2" }] }); // 2360
    await post("/invoices", { customerId: ids.b2b, lines: [{ productId: ids.biscuit, qty: "20" }], payment: { amount: "210", method: "upi" } }); // today 210 paid
    await post("/invoices", { customerId: ids.far, lines: [{ productId: ids.soap, qty: "110" }] }); // inter-state, 1,29,800 -> B2CL
    const cancelled = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.biscuit, qty: "10" }] });
    await post(`/invoices/${cancelled.body.id}/cancel`, { reason: "Test cancel" });
    await post("/payments", { direction: "in", customerId: ids.shop, amount: "500", method: "cash" });
    await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "PD-1", supplierInvoiceDate: "2026-09-15", lines: [{ productId: ids.biscuit, qty: "240", rate: "8" }] });

    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("summarises the business on the dashboard", async () => {
    const res = await get("/dashboard?range=thisMonth");
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.period).toMatchObject({ from: "2026-09-01", to: "2026-09-24", previous: { from: "2026-08-01", to: "2026-08-24" } });
    expect(d.today).toMatchObject({ sales: "130010.00", invoices: 2, collections: "710.00" });
    expect(d.current.sales).toBe("132895.00");
    expect(d.previous.sales).toBe("1050.00");
    expect(d.current.grossProfit).toBeDefined();
    expect(d.payable.total).toBe("2016.00");
    // Overdue, all within 30 days: 550 (1050 less the 500 receipt), 525 and 2360 (no credit days).
    expect(d.receivable.aging[0]).toMatchObject({ label: "0-30", amount: "3435.00", count: 3 });
    expect(d.trend).toHaveLength(30);
    expect(d.trend.at(-1)).toMatchObject({ from: "2026-09-24", to: "2026-09-24", sales: "130010.00" });
    expect(d.month.current.sales).toBe("132895.00");
    expect(d.topBrands[0]).toMatchObject({ name: "-" });
    const monthly = await get("/dashboard?range=thisMonth&grain=monthly");
    expect(monthly.body.trend.map((b: { from: string }) => b.from)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(monthly.body.trend.at(-1)).toMatchObject({ to: "2026-09-24", sales: "132895.00" });
    const yearly = await get("/dashboard?grain=yearly");
    expect(yearly.body.trend.map((b: { from: string }) => b.from)).toEqual(["2024-04-01", "2025-04-01", "2026-04-01"]);
    const weekly = await get("/dashboard?grain=weekly");
    expect(weekly.body.trend).toHaveLength(12);
    expect(weekly.body.trend.at(-1)).toMatchObject({ from: "2026-09-18", to: "2026-09-24" });
    expect(d.topCustomers[0].name).toBe("=Evil Formula Co");
    expect(d.topProducts.map((p: { name: string }) => p.name)).toEqual(["Lifebuoy Soap", "Parle-G 100g"]);
    expect(d.attention).toMatchObject({ lowStock: 1, outOfStock: 1, overdueCustomers: 2 });

    const sales = await get("/dashboard?range=thisMonth", salesToken);
    expect(sales.status).toBe(200);
    expect(sales.body.current.grossProfit).toBeUndefined();
    expect(sales.body.payable).toBeUndefined();
  });

  it("reports sales by period, customer, product and brand, excluding cancelled invoices", async () => {
    const byDay = await get("/reports/sales?from=2026-09-01&to=2026-09-24&groupBy=day");
    expect(byDay.body.rows.map((r: { label: string; total: string }) => [r.label, r.total])).toEqual([
      ["2026-09-05", "525.00"],
      ["2026-09-10", "2360.00"],
      ["2026-09-24", "130010.00"],
    ]);
    expect(byDay.body.totals.total).toBe("132895.00");
    const byMonth = await get("/reports/sales?from=2026-08-01&to=2026-09-24&groupBy=month");
    expect(byMonth.body.rows.map((r: { label: string }) => r.label)).toEqual(["2026-08-01", "2026-09-01"]);
    const byProduct = await get("/reports/sales?from=2026-08-01&to=2026-09-24&groupBy=product");
    expect(byProduct.body.rows[1]).toMatchObject({ label: "Parle-G 100g", qty: "170.000", taxable: "1700.00" });
    const byBrand = await get("/reports/sales?from=2026-08-01&to=2026-09-24&groupBy=brand");
    expect(byBrand.body.rows.map((r: { label: string }) => r.label).sort()).toEqual(["No brand", "Parle"]);
    const oneCustomer = await get(`/reports/sales?from=2026-08-01&to=2026-09-24&groupBy=customer&customerId=${ids.shop}`);
    expect(oneCustomer.body.rows).toHaveLength(1);
    expect(oneCustomer.body.rows[0]).toMatchObject({ invoices: 2, total: "1575.00" });
    expect((await get("/reports/sales?from=2026-09-24&to=2026-09-01")).body.error.code).toBe("INVALID_PERIOD");
  });

  it("reports collections, purchases and outstanding with aging", async () => {
    const coll = await get("/reports/collections?from=2026-09-01&to=2026-09-24&groupBy=method");
    expect(coll.body.rows.map((r: { label: string; amount: string }) => [r.label, r.amount])).toEqual([
      ["cash", "500.00"],
      ["upi", "210.00"],
    ]);
    const purchases = await get("/reports/purchases?from=2026-09-01&to=2026-09-24&groupBy=supplier");
    expect(purchases.body.rows[0]).toMatchObject({ label: "Parle Depot", bills: 1, total: "2016.00" });

    const outstanding = await get("/reports/outstanding?party=customer");
    const shop = outstanding.body.rows.find((r: { name: string }) => r.name === "Anand Stores");
    expect(shop).toMatchObject({ total: "1075.00", notDue: "0.00", documents: 2, oldestDueDate: "2026-08-30" });
    expect(shop.buckets[0]).toMatchObject({ label: "0-30", amount: "1075.00", count: 2 });
    expect(outstanding.body.bucketLabels).toEqual(["0-30", "31-60", "61-90", "90+"]);
  });

  it("exports CSV only for roles with report.export", async () => {
    const csv = await t.app.inject({ method: "GET", url: "/api/v1/reports/outstanding?party=customer&format=csv", headers: { authorization: `Bearer ${owner.token}` } });
    expect(csv.statusCode).toBe(200);
    expect(String(csv.headers["content-type"])).toContain("text/csv");
    expect(String(csv.headers["content-disposition"])).toContain("outstanding-customer-2026-09-24.csv");
    const raw = csv.body;
    expect(raw.startsWith("﻿Customer,Mobile,Bills,Not due")).toBe(true);
    expect(raw).toContain("'=Evil Formula Co");
    expect((await get("/reports/sales?from=2026-09-01&to=2026-09-24", salesToken)).status).toBe(403);
  });

  it("summarises GST for the month by section, rate and HSN", async () => {
    const res = await get("/reports/gst?period=2026-09");
    expect(res.status).toBe(200);
    const sections = res.body.outward.map((r: { section: string; gstRate: string; taxable: string }) => [r.section, r.gstRate, r.taxable]);
    expect(sections).toEqual([
      ["B2B", "5.000", "200.00"],
      ["B2B", "18.000", "2000.00"],
      ["B2CL", "18.000", "110000.00"],
      ["B2CS", "5.000", "500.00"],
    ]);
    expect(res.body.cancelledDocuments).toBe(1);
    expect(res.body.inward[0]).toMatchObject({ itcEligibility: "eligible", taxable: "1920.00", cgst: "48.00" });
    expect(res.body.hsnSummary.find((h: { hsnCode: string }) => h.hsnCode === "3401")).toMatchObject({ qty: "112.000", igst: "19800.00" });
    expect(res.body.estimate.eligibleItc.cgst).toBe("48.00");
  });

  it("searches everything the caller may see", async () => {
    const all = await get("/search?q=parle");
    expect(all.body.products.map((p: { name: string }) => p.name)).toEqual(["Parle-G 100g"]);
    expect(all.body.suppliers.map((s: { name: string }) => s.name)).toEqual(["Parle Depot"]);
    const byMobile = await get(`/search?q=${encodeURIComponent("+91 98260 11111")}`);
    expect(byMobile.body.customers[0].name).toBe("Anand Stores");
    const byNumber = await get("/search?q=INV/26-27/0000");
    expect(byNumber.body.invoices.length).toBeGreaterThan(0);
    const sales = await get("/search?q=parle", salesToken);
    expect(sales.body.products).toHaveLength(1);
    expect(sales.body.suppliers).toBeUndefined();
    expect(sales.body.payments).toBeDefined();
  });
});
