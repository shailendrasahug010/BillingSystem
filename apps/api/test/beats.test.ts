import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processOutbox } from "../src/services/outbox-worker.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.4, beats: a salesperson's routes for the day (TEST_TODAY is a
 * Thursday), the customers in route order with what is due to be bought
 * again, calls counted from the day's documents and recorded visits, the
 * buying of each customer for offline suggestions, and the report of each
 * salesperson's day against the plan.
 */
describe.skipIf(!hasDatabase)("beats", () => {
  let t: TestApp;
  let owner: Session;
  let ravi: string;
  const ids = {} as Record<"soap" | "tea" | "ravi" | "sunil" | "vijay" | "rau" | "palasia" | "anand" | "bansal" | "chouhan" | "dubey" | "ekta", string>;
  const as = (token: string) => ({
    get: (url: string) => call(t.app, "GET", url, { token }),
    post: (url: string, body: unknown, headers: Record<string, string> = {}) => call(t.app, "POST", url, { token, body, headers }),
    put: (url: string, body: unknown) => call(t.app, "PUT", url, { token, body }),
  });
  const o = () => as(owner.token);
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Agrawal Distributors", stateCode: "23" });
    const units = Object.fromEntries((await o().get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await o().get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await o().post("/products", { name: "Lux Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "1000" })).body.id;
    ids.tea = (await o().post("/products", { name: "Taaza Tea", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", openingStock: "500" })).body.id;
    // Ravi: an employee who signs in (same mobile) as a salesperson; Sunil has no sign-in.
    const raviMobile = nextMobile();
    ids.ravi = (await o().post("/employees", { name: "Ravi Salesman", mobile: raviMobile, joiningDate: "2025-04-01" })).body.id;
    ids.sunil = (await o().post("/employees", { name: "Sunil Salesman", mobile: nextMobile(), joiningDate: "2025-04-01" })).body.id;
    const roles = Object.fromEntries((await o().get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    expect((await o().post("/members", { name: "Ravi Salesman", mobile: raviMobile, roleId: roles.sales })).status).toBe(201);
    await call(t.app, "POST", "/auth/otp", { body: { mobile: raviMobile, purpose: "login" } });
    ravi = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile: raviMobile, otp: t.otp.last(raviMobile) } })).body.accessToken;
    // Routes: Vijay Nagar on Mondays and Thursdays (Ravi), Rau on Tuesdays (Ravi), Palasia on Thursdays (Sunil).
    const route = async (name: string, visitDays: number[], salespersonId: string) => (await o().post("/routes", { name, visitDays, salespersonId })).body.id as string;
    ids.vijay = await route("Vijay Nagar", [1, 4], ids.ravi);
    ids.rau = await route("Rau", [2], ids.ravi);
    ids.palasia = await route("Palasia", [4], ids.sunil);
    const customer = async (name: string, routeId: string) => (await o().post("/customers", { name, stateCode: "23", routeId, creditDays: 7 })).body.id as string;
    ids.anand = await customer("Anand Kirana", ids.vijay);
    ids.bansal = await customer("Bansal Stores", ids.vijay);
    ids.chouhan = await customer("Chouhan General", ids.vijay);
    ids.dubey = await customer("Dubey Traders", ids.palasia);
    ids.ekta = await customer("Ekta Mart", ids.rau);
    // Anand buys tea every 7 days; the last time 8 days ago: due again.
    for (const date of ["2026-08-20", "2026-08-27", "2026-09-03", "2026-09-10", "2026-09-16"]) {
      expect((await o().post("/invoices", { customerId: ids.anand, invoiceDate: date, lines: [{ productId: ids.tea, qty: "6" }] })).status).toBe(201);
    }
    await processOutbox(t.app.deps);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("puts customers on a route in the order they are called on", async () => {
    const res = await as(ravi).put(`/routes/${ids.vijay}/order`, { customerIds: [ids.chouhan, ids.anand] });
    expect(res.status).toBe(200);
    const rows = await q<{ name: string; route_sequence: number | null }>(`select name, route_sequence from customers where route_id = $1 order by name`, [ids.vijay]);
    expect(rows).toEqual([
      { name: "Anand Kirana", route_sequence: 2 },
      { name: "Bansal Stores", route_sequence: null },
      { name: "Chouhan General", route_sequence: 1 },
    ]);
    expect((await as(ravi).put(`/routes/${ids.vijay}/order`, { customerIds: [randomUUID()] })).status).toBe(400);
    // The list as the route: Ekta moves onto it, the rest leave; then back as it was.
    const asList = await as(ravi).put(`/routes/${ids.vijay}/order`, { customerIds: [ids.ekta, ids.anand], others: "remove" });
    expect(asList.body).toEqual({ routeId: ids.vijay, customers: 2, removed: 2 });
    expect(await q(`select name, route_sequence from customers where route_id = $1 order by route_sequence`, [ids.vijay])).toEqual([
      { name: "Ekta Mart", route_sequence: 1 },
      { name: "Anand Kirana", route_sequence: 2 },
    ]);
    await as(ravi).put(`/routes/${ids.rau}/order`, { customerIds: [ids.ekta], others: "remove" });
    await as(ravi).put(`/routes/${ids.vijay}/order`, { customerIds: [ids.chouhan, ids.anand, ids.bansal], others: "remove" });
    await as(ravi).put(`/routes/${ids.vijay}/order`, { customerIds: [ids.chouhan, ids.anand] });
    expect(await q(`select name, route_id = $1 as on_route, route_sequence from customers where route_id in ($1, $2) order by name`, [ids.vijay, ids.rau])).toEqual([
      { name: "Anand Kirana", on_route: true, route_sequence: 2 },
      { name: "Bansal Stores", on_route: true, route_sequence: null },
      { name: "Chouhan General", on_route: true, route_sequence: 1 },
      { name: "Ekta Mart", on_route: false, route_sequence: 1 },
    ]);
  });

  it("gives Ravi his Thursday route in that order, with what is due to be bought again", async () => {
    const res = await as(ravi).get("/beats/today");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: TEST_TODAY, weekday: 4, routes: [{ id: ids.vijay, name: "Vijay Nagar", salesperson: "Ravi Salesman", customers: 3 }] });
    expect(res.body.customers.map((c: { name: string }) => c.name)).toEqual(["Chouhan General", "Anand Kirana", "Bansal Stores"]);
    const anand = res.body.customers.find((c: { id: string }) => c.id === ids.anand);
    expect(anand).toMatchObject({ lastCallOn: "2026-09-16", daysSinceCall: 8, today: null });
    expect(anand.reorder.products).toEqual([expect.objectContaining({ productId: ids.tea, productName: "Taaza Tea", suggestedQty: "6" })]);
    expect(res.body.summary).toMatchObject({ planned: 3, called: 0, productive: 0 });
    // Another day's route on request; the owner, with no route of his own, sees every route for today.
    expect((await as(ravi).get(`/beats/today?routeId=${ids.rau}`)).body.customers.map((c: { name: string }) => c.name)).toEqual(["Ekta Mart"]);
    expect((await o().get("/beats/today")).body.routes.map((r: { name: string }) => r.name)).toEqual(["Palasia", "Vijay Nagar"]);
  });

  it("counts a call from a bill made that day or a visit recorded, and keeps a visit sent twice once", async () => {
    expect((await as(ravi).post("/invoices", { customerId: ids.bansal, lines: [{ productId: ids.soap, qty: "12" }] })).status).toBe(201);
    const visit = randomUUID();
    const noOrder = { customerId: ids.chouhan, routeId: ids.vijay, outcome: "no_order", reason: "shop_closed", note: "Shutter down at 11" };
    const first = await as(ravi).post("/visits", noOrder, { "idempotency-key": visit });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ outcome: "no_order", reason: "shop_closed", visitDate: TEST_TODAY });
    expect((await as(ravi).post("/visits", noOrder, { "idempotency-key": visit })).status).toBe(200);
    expect(await q(`select 1 from customer_visits`)).toHaveLength(1);
    expect((await as(ravi).post("/visits", { customerId: ids.chouhan, outcome: "no_order" }, { "idempotency-key": randomUUID() })).status).toBe(400);
    expect((await as(ravi).post("/visits", { customerId: ids.chouhan, outcome: "visited" })).status).toBe(400);

    const beat = (await as(ravi).get("/beats/today")).body;
    const today = Object.fromEntries(beat.customers.map((c: { name: string; today: unknown }) => [c.name, c.today]));
    // 12 soaps at 35 with 18% GST: 495.60, rounded off to 496.
    expect(today["Bansal Stores"]).toMatchObject({ outcome: "bill", billed: "496.00" });
    expect(today["Chouhan General"]).toMatchObject({ outcome: "no_order", reason: "shop_closed" });
    expect(today["Anand Kirana"]).toBeNull();
    expect(beat.summary).toEqual({ planned: 3, called: 2, productive: 1, billed: "496.00", ordered: "0.00", collected: "0.00" });
  });

  it("carries each customer's buying for suggestions without a connection", async () => {
    const beat = (await as(ravi).get("/beats/today?insights=1")).body;
    expect(Object.keys(beat.insights).sort()).toEqual([ids.anand, ids.bansal, ids.chouhan].sort());
    expect(beat.insights[ids.anand]).toMatchObject({ summary: { invoiceCount: 5 }, stats: [expect.objectContaining({ productId: ids.tea, orderCount: 5 })] });
    expect(beat.storeAssociations).toEqual(expect.any(Array));
  });

  it("sets each salesperson's day against the plan for the manager", async () => {
    const report = async () => {
      const res = await o().get(`/reports/beats?from=${TEST_TODAY}&to=${TEST_TODAY}`);
      expect(res.status).toBe(200);
      return res.body.rows;
    };
    expect(await report()).toEqual([
      expect.objectContaining({ salesperson: "Ravi Salesman", planned: 3, called: 2, missed: 1, productive: 1, offPlan: 0, billed: "496.00", noOrderReasons: { shop_closed: 1 } }),
      expect.objectContaining({ salesperson: "Sunil Salesman", planned: 1, called: 0, missed: 1, productive: 0 }),
    ]);
    // Sunil has no sign-in: the office enters the order he phones in from Dubey's (2 teas, 252 with 5% GST),
    // and it counts on his plan. Ravi checks in at Ekta, whose route is on Tuesdays: off his plan.
    expect((await o().post("/sales-orders", { customerId: ids.dubey, lines: [{ productId: ids.tea, qty: "2" }] })).status).toBe(201);
    expect((await as(ravi).post("/visits", { customerId: ids.ekta, outcome: "visited" }, { "idempotency-key": randomUUID() })).status).toBe(201);
    expect(await report()).toEqual([
      expect.objectContaining({ salesperson: "Ravi Salesman", planned: 3, called: 2, missed: 1, productive: 1, offPlan: 1 }),
      expect.objectContaining({ salesperson: "Sunil Salesman", planned: 1, called: 1, missed: 0, productive: 1, ordered: "252.00", billed: "0.00" }),
    ]);
    expect((await as(ravi).get(`/reports/beats?from=${TEST_TODAY}&to=${TEST_TODAY}`)).status).toBe(403);
    expect((await o().get(`/reports/beats?from=2026-01-01&to=${TEST_TODAY}`)).status).toBe(400);
  });
});
