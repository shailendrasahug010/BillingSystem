import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nightlyForBusiness } from "../src/services/nightly-analytics.js";
import { processOutbox } from "../src/services/outbox-worker.js";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.1, daily sales summaries: sales_daily_product and
 * sales_daily_customer are worked out whole for each day a bill, return,
 * payment or purchase falls on (by the outbox worker), every day again at
 * night (drift counted and fixed), and the sales report by product and the
 * home screen's top products and companies read them for past days once they
 * are complete, with the same answers as the bills give.
 */
describe.skipIf(!hasDatabase)("daily sales summaries", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const deps = () => t.app.deps;
  const report = async () => (await get(`/reports/sales?groupBy=product&from=2026-09-01&to=${TEST_TODAY}`)).body;
  const home = async () => {
    const d = (await get(`/dashboard?range=custom&from=2026-09-01&to=${TEST_TODAY}`)).body;
    return { topProducts: d.topProducts, topBrands: d.topBrands };
  };
  /** The report worked out from the bills alone (the summaries set aside). */
  const fromBills = async <T>(fn: () => Promise<T>): Promise<T> => {
    const marker = await q(`select * from analytics_runs where job = 'sales_summaries'`);
    await q(`delete from analytics_runs where job = 'sales_summaries'`);
    try {
      return await fn();
    } finally {
      for (const m of marker as Array<Record<string, unknown>>) {
        await q(`insert into analytics_runs (id, business_id, job, as_of, status, started_at, finished_at, details) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [m.id, m.business_id, m.job, m.as_of, m.status, m.started_at, m.finished_at, m.details]);
      }
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Mehta Distributors", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const brand = async (name: string) => (await post("/brands", { name })).body.id as string;
    ids.hul = await brand("HUL");
    ids.itc = await brand("ITC");
    const product = async (name: string, brandId: string, price: string) =>
      (await post("/products", { name, brandId, taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "500", openingStockCost: String(Number(price) * 0.8) })).body.id as string;
    ids.soap = await product("Lux Soap", ids.hul, "35");
    ids.tea = await product("Taaza Tea", ids.hul, "120");
    ids.atta = await product("Aashirvaad Atta", ids.itc, "260");
    const customer = async (name: string) => (await post("/customers", { name, stateCode: "23", creditDays: 15 })).body.id as string;
    ids.sharma = await customer("Sharma Kirana");
    ids.gupta = await customer("Gupta Stores");
    ids.supplier = (await post("/suppliers", { name: "HUL Depot", stateCode: "23", gstin: "23AAACM1234M1ZR", creditDays: 7 })).body.id;

    const bill = async (customerId: string, date: string, lines: Array<[string, string]>) => {
      const res = await post("/invoices", { customerId, invoiceDate: date, lines: lines.map(([productId, qty]) => ({ productId, qty })) });
      expect(res.status).toBe(201);
      return res.body;
    };
    ids.first = (await bill(ids.sharma, "2026-09-05", [[ids.soap, "24"], [ids.tea, "5"]])).id;
    await bill(ids.gupta, "2026-09-05", [[ids.soap, "12"]]);
    await bill(ids.sharma, "2026-09-12", [[ids.atta, "4"], [ids.soap, "6"]]);
    ids.cancelled = (await bill(ids.gupta, "2026-09-12", [[ids.tea, "2"]])).id;
    await bill(ids.gupta, TEST_TODAY, [[ids.atta, "2"]]);
    // A return of 4 soaps from the first bill, a payment, a purchase received.
    const first = (await get(`/invoices/${ids.first}`)).body;
    const soapLine = first.items.find((i: { productId: string }) => i.productId === ids.soap).id;
    expect((await post(`/invoices/${ids.first}/returns`, { noteDate: "2026-09-08", lines: [{ lineId: soapLine, qty: "4" }] })).status).toBe(201);
    expect((await post("/payments", { direction: "in", customerId: ids.sharma, amount: "500", method: "cash", paymentDate: "2026-09-08" })).status).toBe(201);
    const purchase = await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "HD/77", supplierInvoiceDate: "2026-09-03", receivedDate: "2026-09-03", lines: [{ productId: ids.soap, qty: "100", rate: "26" }] });
    expect(purchase.status).toBe(201);
    ids.purchase = purchase.body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("are kept for each day the documents fall on, a few seconds after them", async () => {
    await processOutbox(deps());
    const day = async (d: string) =>
      Object.fromEntries(
        (
          await q<{ product_id: string; qty_sold: string; qty_returned: string; invoice_count: number; customer_count: number; qty_purchased: string; taxable_value: string }>(
            `select product_id, qty_sold::text, qty_returned::text, invoice_count, customer_count, qty_purchased::text, taxable_value::text from sales_daily_product where day = $1`,
            [d],
          )
        ).map((r) => [r.product_id, r]),
      );
    const fifth = await day("2026-09-05");
    expect(fifth[ids.soap!]).toMatchObject({ qty_sold: "36.000", qty_returned: "0.000", invoice_count: 2, customer_count: 2, taxable_value: "1260.00" });
    expect(fifth[ids.tea!]).toMatchObject({ qty_sold: "5.000", invoice_count: 1 });
    expect((await day("2026-09-08"))[ids.soap!]).toMatchObject({ qty_sold: "0.000", qty_returned: "4.000", invoice_count: 0 });
    expect((await day("2026-09-03"))[ids.soap!]).toMatchObject({ qty_sold: "0.000", qty_purchased: "100.000" });
    const customers = await q<{ customer_id: string; day: string; invoice_count: number; collected: string; returns: string }>(
      `select customer_id, day::text, invoice_count, collected::text, returns::text from sales_daily_customer where customer_id = $1 order by day`,
      [ids.sharma],
    );
    expect(customers.map((c) => [c.day, c.invoice_count, c.collected, c.returns])).toEqual([
      ["2026-09-05", 1, "0.00", "0.00"],
      // The return note: 4 soaps, ₹140 + 18% GST, rounded off.
      ["2026-09-08", 0, "500.00", "165.00"],
      ["2026-09-12", 1, "0.00", "0.00"],
    ]);
  });

  it("are built whole at night, and the reports then read them with the same answers", async () => {
    const before = { report: await report(), home: await home() };
    expect(before.report.rows.map((r: { label: string }) => r.label)).toEqual(["Aashirvaad Atta", "Lux Soap", "Taaza Tea"]);
    const night = await nightlyForBusiness(deps(), owner.businessId, TEST_TODAY);
    expect(night.salesSummaries).toMatchObject({ drifted: 0, driftedDays: [] });
    expect(night.salesSummaries.productRows).toBeGreaterThan(5);
    expect(await q(`select 1 from analytics_runs where job = 'sales_summaries' and status = 'completed'`)).toHaveLength(1);
    expect(await report()).toEqual(before.report);
    expect(await home()).toEqual(before.home);
  });

  it("follow a back-dated bill and a cancelled one within a run of the worker", async () => {
    const res = await post("/invoices", { customerId: ids.gupta, invoiceDate: "2026-09-12", lines: [{ productId: ids.tea, qty: "3" }] });
    expect(res.status).toBe(201);
    expect((await post(`/invoices/${ids.cancelled}/cancel`, { reason: "Wrong shop" })).status).toBe(200);
    expect((await post(`/purchases/${ids.purchase}/cancel`, { reason: "Entered twice" })).status).toBe(200);
    await processOutbox(deps());
    const summary = await report();
    expect(summary).toEqual(await fromBills(report));
    expect(summary.rows.find((r: { key: string }) => r.key === ids.tea)).toMatchObject({ invoices: 2, qty: "8.000" });
    expect(await home()).toEqual(await fromBills(home));
    expect(await q(`select 1 from sales_daily_product where day = '2026-09-03' and qty_purchased > 0`)).toHaveLength(0);
  });

  it("are checked at night: rows changed behind the worker's back are counted and put right", async () => {
    await q(`update sales_daily_product set qty_sold = qty_sold + 1 where day = '2026-09-05' and product_id = $1`, [ids.soap]);
    await q(`delete from sales_daily_customer where day = '2026-09-12'`);
    const night = await nightlyForBusiness(deps(), owner.businessId, "2026-09-25");
    expect(night.salesSummaries.drifted).toBeGreaterThanOrEqual(3);
    expect(night.salesSummaries.driftedDays).toEqual(["2026-09-05", "2026-09-12"]);
    expect(await report()).toEqual(await fromBills(report));
  });
});
