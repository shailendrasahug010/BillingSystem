import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Trade schemes: kept by those who set prices; the bill gives what it earns
 * (free goods as their own lines at 100% off, slab discounts on the lines)
 * and the server refuses what it did not earn, or holds a bill made offline
 * for review; orders keep their schemes when billed; the claim report adds
 * up what each scheme cost, less returns.
 */
describe.skipIf(!hasDatabase)("trade schemes", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token: string = owner.token, headers?: Record<string, string>) => call(t.app, "POST", url, { token, body, ...(headers ? { headers } : {}) });
  const patch = (url: string, body: unknown, token: string = owner.token) => call(t.app, "PATCH", url, { token, body });
  const get = (url: string, token: string = owner.token) => call(t.app, "GET", url, { token });
  const stockOf = async (id: string | undefined) => (await t.owner.query(`select coalesce(sum(qty), 0)::text as qty from stock_balances where product_id = $1`, [id])).rows[0].qty as string;
  const september = { validFrom: "2026-09-01", validTo: "2026-09-30" };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Scheme Distributors", stateCode: "23" });
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    ids.lifebuoy = (await post("/brands", { name: "Lifebuoy" })).body.id;
    const product = async (name: string, price: string, cost: string, brandId?: string) =>
      (await post("/products", { name, taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "500", openingStockCost: cost, ...(brandId ? { brandId } : {}) })).body.id as string;
    ids.soap = await product("Lifebuoy 100g", "35", "28", ids.lifebuoy);
    ids.lemon = await product("Lifebuoy Lemon", "40", "30", ids.lifebuoy);
    ids.shampoo = await product("Clinic Plus 180ml", "120", "90");
    ids.wholesale = (await post("/customer-categories", { name: "Wholesale" })).body.id;
    ids.gupta = (await post("/customers", { name: "Gupta Stores", stateCode: "23" })).body.id;
    ids.bulk = (await post("/customers", { name: "Bulk Traders", stateCode: "23", categoryId: ids.wholesale })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("keeps schemes of the business's own products, brands and customers, with slabs that give something", async () => {
    const tenPlusOne = await post("/schemes", { name: "Lifebuoy 10+1", kind: "free_goods", productIds: [ids.soap], slabs: [{ from: "10", freeQty: "1" }], ...september });
    expect(tenPlusOne.status).toBe(201);
    expect(tenPlusOne.body).toMatchObject({ kind: "free_goods", measure: "qty", repeat: true, freeProductId: null, status: "running", bills: 0, slabs: [{ from: "10.000", freeQty: "1.000" }] });
    ids.s1 = tenPlusOne.body.id;
    ids.s2 = (await post("/schemes", { name: "Lifebuoy slab", kind: "discount", brandIds: [ids.lifebuoy], slabs: [{ from: "24", discountPercent: "3" }, { from: "12", discountPercent: "2" }], ...september })).body.id;
    ids.s3 = (await post("/schemes", { name: "Shampoo on 24 soaps", kind: "free_goods", brandIds: [ids.lifebuoy], freeProductId: ids.shampoo, repeat: false, slabs: [{ from: "24", freeQty: "1" }], customerCategoryIds: [ids.wholesale], ...september })).body.id;
    ids.s4 = (await post("/schemes", { name: "Old offer", kind: "discount", productIds: [ids.soap], slabs: [{ from: "1", discountPercent: "5" }], validFrom: "2026-09-01", validTo: "2026-09-20" })).body.id;

    const slab = (await get(`/schemes/${ids.s2}`)).body;
    // Slabs kept from the lowest; a discount scheme does not repeat.
    expect(slab.slabs).toEqual([
      { from: "12.000", freeQty: null, discountPercent: "2.000", discountPerUnit: null },
      { from: "24.000", freeQty: null, discountPercent: "3.000", discountPerUnit: null },
    ]);
    expect(slab.repeat).toBe(false);
    expect((await get("/schemes?status=ended")).body.data.map((s: { name: string }) => s.name)).toEqual(["Old offer"]);
    expect((await get("/schemes?status=running")).body.data).toHaveLength(3);

    expect((await post("/schemes", { name: "Nothing", kind: "discount", slabs: [{ from: "1", discountPercent: "1" }], ...september })).body.error.code).toBe("SCHEME_NO_PRODUCTS");
    expect((await post("/schemes", { name: "Nothing free", kind: "free_goods", productIds: [ids.soap], slabs: [{ from: "5" }], ...september })).body.error.code).toBe("SCHEME_SLAB_BENEFIT");
    expect((await post("/schemes", { name: "Backwards", kind: "discount", productIds: [ids.soap], slabs: [{ from: "1", discountPercent: "1" }], validFrom: "2026-09-10", validTo: "2026-09-01" })).body.error.code).toBe("SCHEME_ENDS_BEFORE_START");
    const again = await post("/schemes", { name: "LIFEBUOY 10+1", kind: "free_goods", productIds: [ids.soap], slabs: [{ from: "10", freeQty: "1" }], ...september });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("DUPLICATE_NAME");
    const other = await signup(t, { legalName: "Other Agencies", stateCode: "23" });
    expect((await post("/schemes", { name: "Theirs", kind: "discount", productIds: [ids.soap], slabs: [{ from: "1", discountPercent: "1" }], ...september }, other.token)).body.error.code).toBe("REFERENCE_NOT_FOUND");
    expect((await get(`/schemes/${ids.s1}`, other.token)).status).toBe(404);
    ids.otherToken = other.token;
  });

  it("goes to devices with the catalogue: the running and coming ones", async () => {
    const schemes = (await get("/catalog")).body.schemes as Array<{ id: string; name: string; slabs: unknown[] }>;
    expect(schemes.map((s) => s.name).sort()).toEqual(["Lifebuoy 10+1", "Lifebuoy slab", "Shampoo on 24 soaps"]);
    expect(schemes.find((s) => s.id === ids.s1)).toMatchObject({ kind: "free_goods", productIds: [ids.soap], active: true, validFrom: "2026-09-01" });
  });

  it("bills what the bill earns: the goods free on a line of their own, the slab's discount on the line", async () => {
    // 25 soaps: 2 free (10+1 twice), and the brand's 3% slab (24 and over): 3% of 875.
    const res = await post("/invoices", {
      customerId: ids.gupta,
      lines: [
        { productId: ids.soap, qty: "25", scheme: { id: ids.s2, discount: "26.25" } },
        { productId: ids.soap, qty: "2", discountPercent: "100", scheme: { id: ids.s1, free: true } },
      ],
      clientTotals: { grandTotal: "1002.00" },
    });
    expect(res.status).toBe(201);
    ids.bill1 = res.body.id;
    expect(res.body.grandTotal).toBe("1002.00");
    expect(res.body.items).toEqual([
      expect.objectContaining({ productName: "Lifebuoy 100g", qty: "25.000", discountAmount: "26.25", taxableValue: "848.75", schemeId: ids.s2, schemeName: "Lifebuoy slab", schemeDiscount: "26.25", schemeFree: false }),
      expect.objectContaining({ productName: "Lifebuoy 100g", qty: "2.000", discountPercent: "100.000", grossAmount: "70.00", taxableValue: "0.00", lineTotal: "0.00", schemeId: ids.s1, schemeFree: true }),
    ]);
    // The free goods leave the godown too.
    expect(await stockOf(ids.soap)).toBe("473.000");
  });

  it("refuses what the bill did not earn, a scheme not running, and a free line with a price", async () => {
    const bill = (lines: unknown[]) => post("/invoices", { customerId: ids.gupta, lines });
    const more = await bill([{ productId: ids.soap, qty: "25", scheme: { id: ids.s2, discount: "30.00" } }]);
    expect(more.status).toBe(422);
    expect(more.body.error).toMatchObject({ code: "SCHEME_NOT_EARNED", params: { scheme: "Lifebuoy slab" } });
    expect((await bill([{ productId: ids.soap, qty: "25" }, { productId: ids.soap, qty: "3", scheme: { id: ids.s1, free: true } }])).body.error.code).toBe("SCHEME_NOT_EARNED");
    expect((await bill([{ productId: ids.soap, qty: "5", scheme: { id: ids.s4, discount: "8.75" } }])).body.error).toMatchObject({ code: "SCHEME_NOT_RUNNING", params: { scheme: "Old offer" } });
    expect((await bill([{ productId: ids.soap, qty: "10" }, { productId: ids.soap, qty: "1", discountPercent: "50", scheme: { id: ids.s1, free: true } }])).body.error.code).toBe("SCHEME_FREE_LINE");
    // For wholesale customers only.
    expect((await bill([{ productId: ids.soap, qty: "24" }, { productId: ids.shampoo, qty: "1", scheme: { id: ids.s3, free: true } }])).body.error.code).toBe("SCHEME_NOT_EARNED");
    // Another business's scheme is never on this business's bill.
    const other = ids.otherToken!;
    const taxes = Object.fromEntries((await get("/tax-categories", other)).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const units = Object.fromEntries((await get("/units", other)).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const theirSoap = (await post("/products", { name: "Their soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "30", openingStock: "50", openingStockCost: "20" }, other)).body.id;
    const theirShop = (await post("/customers", { name: "Their Shop", stateCode: "23" }, other)).body.id;
    const theirs = await post("/invoices", { customerId: theirShop, lines: [{ productId: theirSoap, qty: "10" }, { productId: theirSoap, qty: "1", scheme: { id: ids.s1, free: true } }] }, other);
    expect(theirs.body.error).toMatchObject({ code: "SCHEME_NOT_EARNED", params: { scheme: ids.s1 } });
  });

  it("gives a line to one free-goods scheme: the one worth more", async () => {
    // 12 + 12 soaps for a wholesaler: the shampoo (₹120) wins the lines over one free soap (₹35); the 3% slab on both.
    const lines = [
      { productId: ids.soap, qty: "12", scheme: { id: ids.s2, discount: "12.60" } },
      { productId: ids.lemon, qty: "12", scheme: { id: ids.s2, discount: "14.40" } },
      { productId: ids.shampoo, qty: "1", scheme: { id: ids.s3, free: true } },
    ];
    const both = await post("/invoices", { customerId: ids.bulk, lines: [...lines, { productId: ids.soap, qty: "1", scheme: { id: ids.s1, free: true } }] });
    expect(both.body.error).toMatchObject({ code: "SCHEME_NOT_EARNED", params: { scheme: "Lifebuoy 10+1" } });
    const res = await post("/invoices", { customerId: ids.bulk, lines });
    expect(res.status).toBe(201);
    ids.bill2 = res.body.id;
    expect(res.body.items.map((i: { schemeName: string; schemeFree: boolean }) => [i.schemeName, i.schemeFree])).toEqual([
      ["Lifebuoy slab", false],
      ["Lifebuoy slab", false],
      ["Shampoo on 24 soaps", true],
    ]);
  });

  it("holds a bill made offline that gave a scheme it did not earn", async () => {
    const device = (await post("/devices", { name: "Van tablet", platform: "android" })).body;
    const res = await post(
      "/invoices",
      { customerId: ids.gupta, invoiceDate: "2026-09-22", lines: [{ productId: ids.soap, qty: "5", scheme: { id: ids.s4, discount: "8.75" } }], offline: { deviceId: device.id, invoiceNumber: `${device.seriesCode}/26-27/0001`, savedAt: "2026-09-22T11:00:00+05:30" } },
      owner.token,
      { "idempotency-key": "0199a0d6-0000-7000-8000-00000000c501" },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reviewStatus: "needs_review", reviewReasons: [{ code: "scheme_changed", params: { scheme: "Old offer" } }] });
    expect(res.body.items[0]).toMatchObject({ schemeId: ids.s4, schemeDiscount: "8.75", discountAmount: "8.75" });
  });

  it("keeps an order's schemes when it is billed, even after the scheme is switched off", async () => {
    const order = await post("/sales-orders", {
      customerId: ids.gupta,
      lines: [
        { productId: ids.soap, qty: "12", scheme: { id: ids.s2, discount: "8.40" } },
        { productId: ids.soap, qty: "1", scheme: { id: ids.s1, free: true } },
      ],
    });
    expect(order.status).toBe(201);
    expect(order.body.items.map((i: { schemeId: string; schemeDiscount: string; schemeFree: boolean }) => [i.schemeId, i.schemeDiscount, i.schemeFree])).toEqual([
      [ids.s2, "8.40", false],
      [ids.s1, "0.00", true],
    ]);
    await post(`/sales-orders/${order.body.id}/status`, { status: "confirmed" });
    expect((await patch(`/schemes/${ids.s2}`, { isActive: false })).body).toMatchObject({ isActive: false, status: "off" });
    const billed = await post(`/sales-orders/${order.body.id}/invoice`, {});
    expect(billed.status).toBe(201);
    ids.bill3 = billed.body.id;
    expect(billed.body.items.map((i: { schemeId: string; schemeDiscount: string; schemeFree: boolean; taxableValue: string }) => [i.schemeId, i.schemeDiscount, i.schemeFree, i.taxableValue])).toEqual([
      [ids.s2, "8.40", false, "411.60"],
      [ids.s1, "0.00", true, "0.00"],
    ]);
    // Switched off, it no longer goes to devices.
    expect(((await get("/catalog")).body.schemes as Array<{ id: string }>).some((s) => s.id === ids.s2)).toBe(false);
    expect((await patch(`/schemes/${ids.s2}`, { isActive: true })).body.status).toBe("running");
  });

  it("adds up what each scheme cost, to claim from the company, less returns", async () => {
    // The free soaps of the first bill come back.
    const bill1 = (await get(`/invoices/${ids.bill1}`)).body;
    expect((await post(`/invoices/${ids.bill1}/returns`, { lines: [{ lineId: bill1.items[1].id, qty: "2" }] })).status).toBe(201);
    const claims = (await get("/reports/scheme-claims?from=2026-09-01&to=2026-09-30")).body;
    const row = (name: string) => claims.rows.find((r: { name: string }) => r.name === name);
    // 10+1: one free soap left (bill 3) at ₹28 cost, ₹35 billed.
    expect(row("Lifebuoy 10+1")).toMatchObject({ kind: "free_goods", bills: 2, freeLines: 2, freeCost: "28.00", freeValue: "35.00", discount: "0.00", claim: "28.00" });
    expect(row("Lifebuoy slab")).toMatchObject({ kind: "discount", bills: 3, freeLines: 0, discount: "61.65", claim: "61.65" });
    expect(row("Shampoo on 24 soaps")).toMatchObject({ freeCost: "90.00", freeValue: "120.00", claim: "90.00" });
    expect(row("Old offer")).toMatchObject({ discount: "8.75" });
    expect(claims.totals).toMatchObject({ freeCost: "118.00", discount: "70.40", claim: "188.40" });
    expect(claims.lines.filter((l: { schemeName: string }) => l.schemeName === "Shampoo on 24 soaps")).toEqual([
      expect.objectContaining({ customerName: "Bulk Traders", productName: "Clinic Plus 180ml", freeQty: "1.000", unit: "PCS", freeCost: "90.00" }),
    ]);
    const one = (await get(`/reports/scheme-claims?from=2026-09-01&to=2026-09-30&schemeId=${ids.s3}`)).body;
    expect(one.rows).toHaveLength(1);
    expect((await get(`/reports/scheme-claims?from=2026-09-30&to=2026-09-01`)).body.error.code).toBe("INVALID_PERIOD");
  });

  it("deletes only a scheme never given", async () => {
    const used = await call(t.app, "DELETE", `/schemes/${ids.s1}`, { token: owner.token });
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe("SCHEME_IN_USE");
    const spare = (await post("/schemes", { name: "Spare", kind: "discount", productIds: [ids.lemon], slabs: [{ from: "1", discountPerUnit: "1" }], validFrom: TEST_TODAY, validTo: null })).body;
    expect(spare).toMatchObject({ validTo: null, status: "running", slabs: [{ from: "1.000", discountPerUnit: "1.00" }] });
    expect((await call(t.app, "DELETE", `/schemes/${spare.id}`, { token: owner.token })).status).toBe(204);
    expect((await get(`/schemes/${spare.id}`)).status).toBe(404);
  });
});
