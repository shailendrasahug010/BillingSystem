import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

interface Pull {
  reset?: boolean;
  more: boolean;
  cursor: string;
  products: Array<{ id: string; name: string; stock: string; avgCost?: string }>;
  customers: Array<{ id: string; name: string; balance: string; overdue: string }>;
  suppliers: Array<{ id: string; name: string }>;
  removed: { product: string[]; customer: string[]; supplier: string[] };
  lists?: Record<string, Array<{ id: string; name?: string }>>;
  listsHash?: string;
}

/**
 * Phase 5.3, the pull feed: a device keeps its copy of the business current
 * with only what changed since it last asked, including changes whose
 * transaction commits after a pull began.
 */
describe.skipIf(!hasDatabase)("pull feed", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const patch = (url: string, body: unknown, token = owner.token) => call(t.app, "PATCH", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const pull = async (cursor?: string, extra: Record<string, string | number> = {}, token = owner.token): Promise<Pull> => {
    const qs = new URLSearchParams({ ...(cursor ? { cursor } : {}), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
    const res = await get(`/sync/pull?${qs}`, token);
    expect(res.status).toBe(200);
    return res.body as Pull;
  };
  /** Follows a pass to its end, as a device does. */
  const pullAll = async (cursor: string, extra: Record<string, string | number> = {}, token = owner.token) => {
    const pages: Pull[] = [];
    let c = cursor;
    for (;;) {
      const p = await pull(c, extra, token);
      pages.push(p);
      c = p.cursor;
      if (!p.more) break;
    }
    return { pages, cursor: c, products: pages.flatMap((p) => p.products), customers: pages.flatMap((p) => p.customers), suppliers: pages.flatMap((p) => p.suppliers), removed: pages.map((p) => p.removed) };
  };
  let cursor = "";
  let listsHash = "";

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Feed Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sunita", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.pcs = units.PCS;
    ids.gst5 = taxes["GST 5%"];
  });
  afterAll(async () => {
    await t?.close();
  });

  it("starts a device with a cursor and the lists, telling it to load everything", async () => {
    const first = await pull();
    expect(first).toMatchObject({ reset: true, more: false, products: [], customers: [], suppliers: [] });
    expect(Object.keys(first.lists!)).toEqual(expect.arrayContaining(["taxCategories", "priceLevels", "units", "brands", "categories", "warehouses", "routes", "expenseCategories"]));
    cursor = first.cursor;
    listsHash = first.listsHash!;
    expect((await get("/sync/pull?cursor=bm90LWEtY3Vyc29y")).body.error.code).toBe("INVALID_CURSOR");
  });

  it("then gives only what changed: new and changed records, once", async () => {
    ids.tea = (await post("/products", { name: "Tea 250g", taxCategoryId: ids.gst5, baseUnitId: ids.pcs, sellingPrice: "100", openingStock: "40", openingStockCost: "80" })).body.id;
    ids.shop = (await post("/customers", { name: "Kirana One", stateCode: "23", creditDays: 7 })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Wholesale Co", stateCode: "23", gstin: "23AAACM1234M1ZR" })).body.id;
    const changes = await pull(cursor, { lists: listsHash });
    expect(changes.reset).toBeUndefined();
    expect(changes.products).toEqual([expect.objectContaining({ id: ids.tea, name: "Tea 250g", stock: "40.000", avgCost: "80.0000" })]);
    expect(changes.customers).toEqual([expect.objectContaining({ id: ids.shop, name: "Kirana One", balance: "0.00" })]);
    expect(changes.suppliers).toEqual([expect.objectContaining({ id: ids.supplier, name: "Wholesale Co" })]);
    // The lists did not change: not sent again.
    expect(changes.lists).toBeUndefined();
    cursor = changes.cursor;
    // Nothing since.
    const quiet = await pull(cursor, { lists: listsHash });
    expect([quiet.products, quiet.customers, quiet.suppliers]).toEqual([[], [], []]);
    cursor = quiet.cursor;
  });

  it("follows bills, prices and stock, and sends a list again when it changes", async () => {
    expect((await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.tea, qty: "3" }] })).status).toBe(201);
    expect((await patch(`/products/${ids.tea}`, { sellingPrice: "110" })).status).toBe(200);
    await post("/brands", { name: "Tata" });
    const changes = await pull(cursor, { lists: listsHash });
    expect(changes.products).toEqual([expect.objectContaining({ id: ids.tea, stock: "37.000", sellingPrice: "110.0000" })]);
    expect(changes.customers).toEqual([expect.objectContaining({ id: ids.shop, balance: "315.00" })]);
    expect(changes.lists!.brands!.map((b) => b.name)).toContain("Tata");
    expect(changes.listsHash).not.toBe(listsHash);
    listsHash = changes.listsHash!;
    cursor = changes.cursor;
  });

  it("names what was deleted or made inactive, so the device drops it", async () => {
    ids.old = (await post("/products", { name: "Old Biscuit", taxCategoryId: ids.gst5, baseUnitId: ids.pcs, sellingPrice: "10" })).body.id;
    cursor = (await pull(cursor, { lists: listsHash })).cursor;
    expect((await call(t.app, "DELETE", `/products/${ids.old}`, { token: owner.token })).status).toBe(204);
    expect((await patch(`/suppliers/${ids.supplier}`, { isActive: false })).status).toBe(200);
    const changes = await pull(cursor, { lists: listsHash });
    expect(changes.removed).toEqual({ product: [ids.old], customer: [], supplier: [ids.supplier] });
    expect(changes.products).toEqual([]);
    cursor = changes.cursor;
  });

  it("never misses a change whose transaction commits after a pull began", async () => {
    const client = await t.owner.connect();
    try {
      await client.query("begin");
      await client.query(`update products set name = 'Tea 500g' where id = $1`, [ids.tea]);
      // A pull while that transaction is still open does not see it...
      const during = await pull(cursor, { lists: listsHash });
      expect(during.products).toEqual([]);
      await client.query("commit");
      // ...and the next one does.
      const after = await pull(during.cursor, { lists: listsHash });
      expect(after.products).toEqual([expect.objectContaining({ id: ids.tea, name: "Tea 500g" })]);
      cursor = after.cursor;
    } finally {
      client.release();
    }
  });

  it("pages through many changes without losing any", async () => {
    const made: string[] = [];
    for (let i = 1; i <= 7; i++) made.push((await post("/customers", { name: `Shop ${i}`, stateCode: "23" })).body.id);
    const { pages, customers, cursor: next } = await pullAll(cursor, { lists: listsHash, limit: 3 });
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.slice(0, -1).every((p) => p.more)).toBe(true);
    expect(new Set(customers.map((c) => c.id))).toEqual(new Set(made));
    // Lists only with the first page of a pass.
    expect(pages.slice(1).every((p) => p.listsHash === undefined)).toBe(true);
    cursor = next;
  });

  it("sends customers again when their bills fall overdue with the days", async () => {
    // The bill of 24 September is due on 1 October (7 days' credit).
    t.setToday("2026-10-03");
    try {
      const changes = await pull(cursor, { lists: listsHash });
      expect(changes.customers).toEqual([expect.objectContaining({ id: ids.shop, overdue: "315.00" })]);
      cursor = changes.cursor;
      // Once.
      expect((await pull(cursor, { lists: listsHash })).customers).toEqual([]);
    } finally {
      t.setToday(null);
    }
  });

  it("gives each role only what it may see", async () => {
    const start = (await pull(undefined, {}, salesToken)).cursor;
    const second = await post("/suppliers", { name: "Second Supplier", stateCode: "23", gstin: "23AAGFG5678G1ZA" });
    expect(second.status).toBe(201);
    const bought = await post("/purchases", { supplierId: second.body.id, supplierInvoiceNumber: "S/1", supplierInvoiceDate: "2026-09-24", lines: [{ productId: ids.tea, qty: "5", rate: "70" }] });
    expect(bought.body.error).toBeUndefined();
    const changes = await pull(start, {}, salesToken);
    // Sales sees the product (without its cost) but no suppliers.
    expect(changes.products).toEqual([expect.objectContaining({ id: ids.tea, stock: "42.000" })]);
    expect(changes.products[0]).not.toHaveProperty("avgCost");
    expect(changes.suppliers).toEqual([]);
    expect(changes.removed.supplier).toEqual([]);
    expect(changes.lists).not.toHaveProperty("expenseCategories");
  });

  it("starts the device over when the changes it needs were deleted", async () => {
    t.advance(31 * 86_400_000);
    const late = await pull(cursor, { lists: listsHash });
    expect(late.reset).toBe(true);
    // The lists it has are still current: only their hash comes.
    expect(late.listsHash).toBe(listsHash);
  });
});
