import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processOutbox, retryDelayMs } from "../src/services/outbox-worker.js";
import { runNightlyAnalytics } from "../src/services/nightly-analytics.js";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.1, the purchase-history service: the outbox worker keeps each
 * customer's figures after their bills, the billing screen reads them, and
 * the nightly job rebuilds them, checks them for drift, mines "bought
 * together" rules and checks cached balances against their ledgers.
 */
describe.skipIf(!hasDatabase)("purchase history", () => {
  let t: TestApp;
  let owner: Session;
  let logDir: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const deps = () => t.app.deps;
  const statsOf = (customerId: string) =>
    q<{ product_id: string; order_count: number; total_qty: string; last_qty: string; typical_interval_days: number | null; recent_qtys: string[] }>(
      `select product_id, order_count, total_qty::text, last_qty::text, typical_interval_days, recent_qtys::text[] from customer_product_stats where customer_id = $1 order by product_id`,
      [customerId],
    );
  const bill = async (customerId: string, date: string, lines: Array<[string, string]>) => {
    const res = await post("/invoices", { customerId, invoiceDate: date, lines: lines.map(([productId, qty]) => ({ productId, qty })) });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };
  const pending = async () => (await q<{ n: number }>(`select count(*)::int as n from outbox_events where processed_at is null`))[0]!.n;
  /** The insight without the field that says where it came from. */
  const insight = async (customerId: string) => {
    const res = await get(`/customers/${customerId}/insight`);
    expect(res.status).toBe(200);
    const { source, ...rest } = res.body;
    return { source, rest };
  };

  beforeAll(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), "digitalbahi-log-"));
    t = await createTestApp({ logDir });
    owner = await signup(t, { legalName: "Gupta Distributors", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const product = async (name: string, price: string) =>
      (await post("/products", { name, hsnCode: "0401", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "1000", openingStockCost: "1" })).body.id as string;
    ids.milk = await product("Toned Milk 500ml", "28");
    ids.bread = await product("Bread 400g", "40");
    ids.butter = await product("Butter 100g", "56");
    ids.tea = await product("Tea 250g", "120");
    ids.sugar = await product("Sugar 1kg", "45");
    ids.salt = await product("Salt 1kg", "22");
    const customer = async (name: string) => (await post("/customers", { name, stateCode: "23", creditDays: 7 })).body.id as string;
    ids.regular = await customer("ABC General Store");
    for (let i = 1; i <= 6; i++) ids[`shop${i}`] = await customer(`Shop ${i}`);
  });
  afterAll(async () => {
    await t?.close();
    await rm(logDir, { recursive: true, force: true });
  });

  describe("the outbox worker", () => {
    it("keeps a customer's figures a few seconds after each bill, the same as working them out live", async () => {
      // A weekly customer: milk and bread every week, butter in the last three.
      for (const [n, date] of ["2026-08-20", "2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17"].entries()) {
        await bill(ids.regular!, date, [[ids.milk!, "24"], [ids.bread!, "10"], ...(n >= 2 ? ([[ids.butter!, "5"]] as Array<[string, string]>) : [])]);
      }
      expect(await pending()).toBeGreaterThanOrEqual(5);
      const live = await insight(ids.regular!);
      expect(live.source).toBe("live");

      const done = await processOutbox(deps());
      expect(done).toMatchObject({ failed: 0 });
      expect(done.processed).toBeGreaterThanOrEqual(5);
      expect(await pending()).toBe(0);

      const rows = await statsOf(ids.regular!);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.product_id === ids.milk)).toMatchObject({ order_count: 5, total_qty: "120.000", last_qty: "24.000", typical_interval_days: 7, recent_qtys: ["24.000", "24.000", "24.000", "24.000", "24.000"] });
      expect(rows.find((r) => r.product_id === ids.butter)).toMatchObject({ order_count: 3, typical_interval_days: 7 });
      const [cs] = await q(`select invoice_count, first_invoice_on::text, last_invoice_on::text, typical_visit_interval_days, as_of::text, overdue_amount::text from customer_stats where customer_id = $1`, [ids.regular]);
      expect(cs).toMatchObject({ invoice_count: 5, first_invoice_on: "2026-08-20", last_invoice_on: "2026-09-17", typical_visit_interval_days: 7, as_of: TEST_TODAY });
      expect(Number(cs!.overdue_amount)).toBeGreaterThan(0);

      // The billing screen now reads the stored figures, and gets the same answer.
      const stored = await insight(ids.regular!);
      expect(stored.source).toBe("stored");
      expect(stored.rest).toEqual(live.rest);
    });

    it("updates the figures when a bill is cancelled and when the customer pays", async () => {
      const extra = await bill(ids.regular!, "2026-09-20", [[ids.salt!, "2"]]);
      await processOutbox(deps());
      expect((await statsOf(ids.regular!)).map((r) => r.product_id)).toContain(ids.salt);

      expect((await post(`/invoices/${extra.id}/cancel`, { reason: "Wrong shop" })).status).toBe(200);
      await processOutbox(deps());
      expect((await statsOf(ids.regular!)).map((r) => r.product_id)).not.toContain(ids.salt);
      expect((await q(`select invoice_count from customer_stats where customer_id = $1`, [ids.regular]))[0]).toMatchObject({ invoice_count: 5 });

      const before = (await q<{ overdue_amount: string }>(`select overdue_amount::text from customer_stats where customer_id = $1`, [ids.regular]))[0]!.overdue_amount;
      expect((await post("/payments", { direction: "in", customerId: ids.regular, amount: "500", method: "cash" })).status).toBe(201);
      await processOutbox(deps());
      const after = (await q<{ overdue_amount: string }>(`select overdue_amount::text from customer_stats where customer_id = $1`, [ids.regular]))[0]!.overdue_amount;
      expect(Number(after)).toBeCloseTo(Number(before) - 500, 2);
    });

    it("sets a failing customer's events aside and tries them again later, without holding up the rest", async () => {
      await bill(ids.shop1!, "2026-09-22", [[ids.tea!, "1"]]);
      // The worker cannot write figures for now (privileges on this test database only).
      await q(`revoke insert on customer_product_stats from digitalbahi_app_test`);
      try {
        const failed = await processOutbox(deps());
        expect(failed).toMatchObject({ processed: 0, failed: 1 });
      } finally {
        await q(`grant insert on customer_product_stats to digitalbahi_app_test`);
      }
      const [ev] = await q<{ attempts: number; last_error: string; processed_at: string | null; available_at: Date }>(
        `select attempts, last_error, processed_at, available_at from outbox_events where processed_at is null`,
      );
      expect(ev).toMatchObject({ attempts: 1, processed_at: null });
      expect(ev!.last_error).toContain("permission denied");
      expect(ev!.available_at.getTime()).toBeGreaterThan(Date.now() + retryDelayMs(1) - 5_000);

      // Not before its time; then it goes through.
      expect(await processOutbox(deps())).toMatchObject({ processed: 0, failed: 0 });
      t.advance(retryDelayMs(1) + 1_000);
      expect(await processOutbox(deps())).toMatchObject({ processed: 1, failed: 0 });
      expect(await statsOf(ids.shop1!)).toHaveLength(1);
      await deps().errors.flush();
      const log = await readFile(path.join(logDir, (await readdir(logDir)).find((f) => f.endsWith(".jsonl"))!), "utf8");
      expect(log).toContain("outbox worker (purchase history of a customer)");
    });
  });

  describe("the billing screen", () => {
    it("uses stored figures while they are recent and works them out live otherwise, with the same suggestions", async () => {
      const stored = await get(`/customers/${ids.regular}/suggestions`);
      expect(stored.body.source).toBe("stored");
      const milk = stored.body.suggestions.find((s: { productId: string }) => s.productId === ids.milk);
      expect(milk).toMatchObject({ group: "reorder" });
      expect(milk.reasons.map((r: { code: string }) => r.code)).toContain("due");

      // Figures from three weeks ago are not trusted.
      await q(`update customer_stats set as_of = '2026-09-01' where customer_id = $1`, [ids.regular]);
      const live = await get(`/customers/${ids.regular}/suggestions`);
      expect(live.body.source).toBe("live");
      const { source: _a, ...a } = stored.body;
      const { source: _b, ...b } = live.body;
      expect(b).toEqual(a);
      await q(`update customer_stats set as_of = $2 where customer_id = $1`, [ids.regular, TEST_TODAY]);
    });

    it("gives a customer's reorder table, and the customers due to reorder", async () => {
      const table = await get(`/customers/${ids.regular}/reorder`);
      expect(table.status).toBe(200);
      expect(table.body.rows.find((r: { productId: string }) => r.productId === ids.milk)).toMatchObject({ status: "due", typicalIntervalDays: 7, suggestedQty: "24" });

      const due = await get("/reorder/due");
      expect(due.status).toBe(200);
      const abc = due.body.customers.find((c: { customerId: string }) => c.customerId === ids.regular);
      expect(abc).toMatchObject({ name: "ABC General Store", due: 3, overdue: 0 });
      expect(abc.products.map((p: { productName: string }) => p.productName)).toEqual(expect.arrayContaining(["Toned Milk 500ml", "Bread 400g", "Butter 100g"]));
      expect((await get(`/reorder/due?routeId=${ids.regular}`)).body.customers).toEqual([]);
    });
  });

  describe("the nightly job", () => {
    it("rebuilds the figures, finds no drift, mines bought-together rules and finds the balances right", async () => {
      // Tea and sugar go together across shops; salt alone elsewhere.
      for (let i = 1; i <= 6; i++) await bill(ids[`shop${i}`]!, "2026-09-21", [[ids.tea!, "2"], [ids.sugar!, "5"]]);
      for (let i = 2; i <= 5; i++) await bill(ids[`shop${i}`]!, "2026-09-23", [[ids.salt!, "3"]]);

      expect(await runNightlyAnalytics(deps(), { hour: 0 })).toEqual({ runs: 1, failed: 0 });
      const [run] = await q<{ status: string; as_of: string; details: Record<string, any> }>(`select status, as_of::text, details from analytics_runs where business_id = $1`, [owner.businessId]);
      expect(run).toMatchObject({ status: "completed", as_of: TEST_TODAY });
      expect(run!.details.drift).toMatchObject({ customers: 0, rows: 0 });
      expect(run!.details.drift.checked).toBeGreaterThanOrEqual(2);
      expect(run!.details.customers).toBe(7);
      expect(run!.details.balances).toEqual({
        customers: { mismatched: 0, examples: [] },
        suppliers: { mismatched: 0, examples: [] },
        stock: { mismatched: 0, examples: [] },
      });
      expect(run!.details.outbox.processed).toBeGreaterThanOrEqual(10);

      const rules = await q<{ product_id: string; related_product_id: string; pair_count: number; confidence: number }>(
        `select product_id, related_product_id, pair_count, confidence from product_associations where business_id = $1`,
        [owner.businessId],
      );
      // Every sugar bill had tea; tea was also bought alone once (6 of 7).
      expect(rules).toContainEqual(expect.objectContaining({ product_id: ids.sugar, related_product_id: ids.tea, pair_count: 6, confidence: 1 }));
      expect(rules).toContainEqual(expect.objectContaining({ product_id: ids.tea, related_product_id: ids.sugar, pair_count: 6, confidence: 6 / 7 }));
      // The billing screen now gets the stored rules.
      const ins = await get(`/customers/${ids.shop1}/insight`);
      expect(ins.body.storeAssociations).toContainEqual(expect.objectContaining({ productId: ids.tea, relatedProductId: ids.sugar, pairCount: 6 }));

      // Once a day.
      expect(await runNightlyAnalytics(deps(), { hour: 0 })).toEqual({ runs: 0, failed: 0 });
    });

    it("reports drift and mismatched balances the next night, and rebuilds the figures", async () => {
      // Figures changed behind the worker's back, and a cached balance off by a rupee.
      await q(`update customer_product_stats set order_count = 99 where customer_id = $1 and product_id = $2`, [ids.regular, ids.milk]);
      await q(`update customers set balance = balance + 1 where id = $1`, [ids.shop2]);
      t.setToday("2026-09-25");
      try {
        expect(await runNightlyAnalytics(deps(), { hour: 0 })).toEqual({ runs: 1, failed: 0 });
      } finally {
        t.setToday(null);
        await q(`update customers set balance = balance - 1 where id = $1`, [ids.shop2]);
      }
      const [run] = await q<{ details: Record<string, any> }>(`select details from analytics_runs where business_id = $1 and as_of = '2026-09-25'`, [owner.businessId]);
      expect(run!.details.drift).toMatchObject({ customers: 1, rows: 1, examples: [{ customerId: ids.regular, products: [ids.milk], summary: false, associations: false }] });
      expect(run!.details.balances.customers).toMatchObject({ mismatched: 1, examples: [{ key: ids.shop2, ledger: expect.any(String) }] });
      expect((await statsOf(ids.regular!)).find((r) => r.product_id === ids.milk)).toMatchObject({ order_count: 5 });

      await deps().errors.flush();
      const files = (await readdir(logDir)).filter((f) => f.endsWith(".jsonl"));
      const log = (await Promise.all(files.map((f) => readFile(path.join(logDir, f), "utf8")))).join("");
      expect(log).toContain("purchase history of 1 customer(s) had drifted");
      expect(log).toContain("1 cached customers balance(s) differ from the ledger");
    });
  });

  describe("feedback on suggestions", () => {
    it("records what was offered and taken per bill, and sums it up", async () => {
      const session = "0199a0b2-7c3d-7e4f-8a5b-6c7d8e9f0a1b";
      const shown = [
        { productId: ids.milk, group: "reorder", rank: 1, reasons: ["due"] },
        { productId: ids.bread, group: "reorder", rank: 2, reasons: ["due"] },
        { productId: ids.tea, group: "together", rank: 7, reasons: ["together"] },
      ];
      const first = await post("/suggestions/feedback", { id: session, customerId: ids.regular, shown, added: [shown[0]] });
      expect(first.status).toBe(204);
      // Sent again when the bill is saved: replaced, not counted twice.
      const inv = await bill(ids.regular!, TEST_TODAY, [[ids.milk!, "24"], [ids.bread!, "10"], [ids.salt!, "1"]]);
      expect((await post("/suggestions/feedback", { id: session, customerId: ids.regular, invoiceId: inv.id, shown, added: shown.slice(0, 2) })).status).toBe(204);

      // Feedback is dated by when it was sent (the real clock); bills by their date (TEST_TODAY).
      const sum = await get(`/suggestions/feedback/summary?from=${TEST_TODAY}&to=2099-12-31`);
      expect(sum.status).toBe(200);
      expect(sum.body).toMatchObject({ sessions: 1, savedBills: 1, shown: 3, added: 2, acceptance: 0.667, linesFromSuggestions: 2 });
      expect(sum.body.byGroup).toContainEqual({ group: "reorder", shown: 2, added: 2, acceptance: 1 });
      expect(sum.body.byGroup).toContainEqual({ group: "together", shown: 1, added: 0, acceptance: 0 });
      expect(sum.body.byRank).toContainEqual({ ranks: "1-3", shown: 2, added: 2, acceptance: 1 });
      expect(sum.body.invoiceLines).toBe(3);

      const bad = await post("/suggestions/feedback", { id: "0199a0b2-7c3d-7e4f-8a5b-6c7d8e9f0a1c", customerId: owner.userId, shown: [], added: [] });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatchObject({ code: "REFERENCE_NOT_FOUND", field: "customerId" });
    });
  });

  describe("several businesses", () => {
    it("handles each business's events in its own scope", async () => {
      const other = await signup(t, { legalName: "Other Traders", stateCode: "27" });
      const units = Object.fromEntries((await get("/units", other.token)).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
      const taxes = Object.fromEntries((await get("/tax-categories", other.token)).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
      const product = (await post("/products", { name: "Atta 5kg", hsnCode: "1101", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "250", openingStock: "50" }, other.token)).body.id;
      const customer = (await post("/customers", { name: "Pune Kirana", stateCode: "27" }, other.token)).body.id;
      expect((await post("/invoices", { customerId: customer, lines: [{ productId: product, qty: "2" }] }, other.token)).status).toBe(201);
      await bill(ids.shop3!, TEST_TODAY, [[ids.butter!, "1"]]);

      expect((await processOutbox(deps())).failed).toBe(0);
      expect(await pending()).toBe(0);
      const rows = await q<{ business_id: string }>(`select business_id from customer_product_stats where customer_id = $1`, [customer]);
      expect(rows).toEqual([{ business_id: other.businessId }]);
      expect((await get(`/customers/${customer}/reorder`)).status).toBe(404);
      expect((await get(`/customers/${customer}/reorder`, other.token)).body.source).toBe("stored");
    });
  });
});
