import { gstinCheckChar } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

/** A GSTIN with a valid check character for the given state. */
const gstin = (state: string, pan = "AAPFU0939F") => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("masters: settings, catalog, customers, suppliers", () => {
  let t: TestApp;
  let owner: Session;
  let units: Record<string, string>;
  let taxes: Record<string, string>;
  let levels: Record<string, string>;
  let salesToken: string;

  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const patch = (url: string, body: unknown, token = owner.token, headers?: Record<string, string>) =>
    call(t.app, "PATCH", url, { token, body, ...(headers ? { headers } : {}) });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Masters Traders", stateCode: "23" });
    units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    levels = Object.fromEntries((await get("/price-levels")).body.data.map((l: { name: string; id: string }) => [l.name, l.id]));

    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("business settings", () => {
    it("reads typed settings and validates changes per key", async () => {
      const all = await get("/settings");
      expect(all.body["stock.negative_policy"]).toBe("warn");
      expect(all.body["credit.policy"]).toEqual({ onLimitExceeded: "warn", onOverdue: "warn", overdueGraceDays: 0 });

      const ok = await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "block" } });
      expect(ok.status).toBe(200);
      expect((await get("/settings")).body["stock.negative_policy"]).toBe("block");
      await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "warn" } });

      const bad = await call(t.app, "PUT", "/settings/invoice.round_off", { token: owner.token, body: { value: { mode: "sideways", step: 1 } } });
      expect(bad.body.error.code).toBe("INVALID_SETTING_VALUE");
      const unknown = await call(t.app, "PUT", "/settings/rocket.fuel", { token: owner.token, body: { value: 1 } });
      expect(unknown.body.error.code).toBe("UNKNOWN_SETTING");
      const denied = await call(t.app, "PUT", "/settings/stock.negative_policy", { token: salesToken, body: { value: "allow" } });
      expect(denied.status).toBe(403);
    });

    it("updates the business profile with GSTIN checks", async () => {
      const mismatch = await patch("/business", { gstin: gstin("27") });
      expect(mismatch.body.error.code).toBe("GSTIN_STATE_MISMATCH");
      const ok = await patch("/business", { gstin: gstin("23"), city: "Indore", phone: "0731-400000" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ gstin: gstin("23"), city: "Indore", version: 2 });
    });

    it("validates number series patterns up front", async () => {
      const series = (await get("/document-series")).body.data;
      const invoice = series.find((s: { docType: string }) => s.docType === "invoice");
      const tooLong = await patch(`/document-series/${invoice.id}`, { pattern: "SHREETRADERS/{FY}/{SEQ:6}" });
      expect(tooLong.body.error.code).toBe("INVALID_SERIES_PATTERN");
      const noSeq = await patch(`/document-series/${invoice.id}`, { pattern: "INV/{FY}" });
      expect(noSeq.body.error.code).toBe("SERIES_PATTERN_NEEDS_SEQ");
      const ok = await patch(`/document-series/${invoice.id}`, { pattern: "ST/{FYS}/{SEQ:4}" });
      expect(ok.body.pattern).toBe("ST/{FYS}/{SEQ:4}");
    });

    it("keeps exactly one default godown", async () => {
      const created = await post("/warehouses", { name: "Branch Godown", code: "br1", isDefault: true });
      expect(created.status).toBe(201);
      expect(created.body.code).toBe("BR1");
      const list = (await get("/warehouses")).body.data;
      expect(list.filter((w: { isDefault: boolean }) => w.isDefault).map((w: { code: string }) => w.code)).toEqual(["BR1"]);
      const main = list.find((w: { code: string }) => w.code === "MAIN");
      await patch(`/warehouses/${main.id}`, { isDefault: true });
    });
  });

  describe("catalogue masters", () => {
    it("seeds GST buckets as dated rules and supports a rate change without editing products", async () => {
      const cats = (await get("/tax-categories")).body.data;
      expect(cats.map((c: { name: string }) => c.name).sort()).toEqual(["Exempt", "GST 18%", "GST 40%", "GST 5%", "Nil rated (0%)"]);
      const created = await post("/tax-categories", {
        name: "Biscuits",
        rules: [{ effectiveFrom: "2017-07-01", effectiveTo: "2025-09-21", gstRate: "18" }],
      });
      expect(created.status).toBe(201);
      const overlap = await post(`/tax-categories/${created.body.id}/rules`, { effectiveFrom: "2025-01-01", gstRate: "5" });
      expect(overlap.body.error.code).toBe("TAX_RULES_OVERLAP");
      const added = await post(`/tax-categories/${created.body.id}/rules`, { effectiveFrom: "2025-09-22", gstRate: "5", reference: "Rate rationalisation" });
      expect(added.status).toBe(201);
      expect(added.body.rules.map((r: { gstRate: string }) => r.gstRate)).toEqual(["18.000", "5.000"]);
      const taxableWithoutRule = await post("/tax-categories", { name: "Empty", rules: [] });
      expect(taxableWithoutRule.body.error.code).toBe("TAX_RULE_REQUIRED");
    });

    it("manages brands and a category tree without cycles", async () => {
      const brand = await post("/brands", { name: "Parle" });
      expect(brand.status).toBe(201);
      expect((await post("/brands", { name: "Parle" })).body.error.code).toBe("DUPLICATE_NAME");
      const food = await post("/categories", { name: "Food" });
      const biscuits = await post("/categories", { name: "Biscuits", parentId: food.body.id });
      const cycle = await patch(`/categories/${food.body.id}`, { parentId: biscuits.body.id });
      expect(cycle.body.error.code).toBe("CATEGORY_CYCLE");
      expect((await call(t.app, "DELETE", `/categories/${food.body.id}`, { token: owner.token })).body.error.code).toBe("IN_USE");
    });
  });

  describe("products", () => {
    let productId: string;
    let brandId: string;

    it("creates a product with pack units, rate lists, barcodes and opening stock", async () => {
      brandId = (await post("/brands", { name: "Britannia" })).body.id;
      const res = await post("/products", {
        name: "Good Day Butter 100g",
        nameLocal: "गुड डे बटर",
        aliases: ["goodday"],
        hsnCode: "1905",
        taxCategoryId: taxes["GST 5%"],
        brandId,
        baseUnitId: units.PCS,
        purchasePrice: "8.5",
        sellingPrice: "10",
        mrp: "10",
        minStock: "20",
        barcodes: ["8901063093019", "18901063093016"],
        units: [{ unitId: units.BOX, conversionFactor: "24", isDefaultSale: true }],
        prices: [
          { priceLevelId: levels["Price B"], unitId: units.PCS, price: "9.4" },
          { priceLevelId: levels["Price B"], unitId: units.BOX, price: "220" },
        ],
        openingStock: "100",
        openingStockCost: "8.25",
      });
      expect(res.status).toBe(201);
      productId = res.body.id;
      expect(res.body).toMatchObject({ code: "P00001", purchasePrice: "8.5000", avgCost: "8.2500" });
      expect(res.body.stock.total).toBe("100.000");
      expect(res.body.units[0]).toMatchObject({ symbol: "BOX", conversionFactor: "24.000" });
      expect(res.body.prices).toHaveLength(2);

      const ledger = await t.owner.query(`select movement_type, qty_in, balance_after, unit_cost from stock_ledger where product_id = $1`, [productId]);
      expect(ledger.rows).toEqual([{ movement_type: "opening", qty_in: "100.000", balance_after: "100.000", unit_cost: "8.2500" }]);
    });

    it("hides purchase cost from roles without product.view_cost", async () => {
      const detail = await get(`/products/${productId}`, salesToken);
      expect(detail.status).toBe(200);
      expect(detail.body.purchasePrice).toBeUndefined();
      expect(detail.body.avgCost).toBeUndefined();
      const list = await get("/products?q=good", salesToken);
      expect(list.body.data[0].purchasePrice).toBeUndefined();
      const snapshot = await get("/catalog", salesToken);
      expect(snapshot.body.products[0].avgCost).toBeUndefined();
    });

    it("never accepts another tenant's ids", async () => {
      const other = await signup(t, { legalName: "Other Tenant" });
      const foreignBrand = (await post("/brands", { name: "Foreign" }, other.token)).body.id;
      const res = await post("/products", { name: "Sneaky", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, brandId: foreignBrand });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "REFERENCE_NOT_FOUND", field: "brandId" });
      expect((await get(`/products/${productId}`, other.token)).status).toBe(404);
    });

    it("finds products by name, local name, alias, code and barcode; looks up case barcodes", async () => {
      for (const q of ["butter", "गुड", "goodday", "P00001", "8901063093019"]) {
        const res = await get(`/products?q=${encodeURIComponent(q)}`);
        expect(res.body.data.map((p: { id: string }) => p.id), q).toEqual([productId]);
      }
      const hit = await get("/products/lookup?barcode=8901063093019");
      expect(hit.body.product.id).toBe(productId);
      expect((await get("/products/lookup?barcode=0000")).status).toBe(404);
      const dup = await post("/products", { name: "Clash", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, barcodes: ["8901063093019"] });
      expect(dup.body.error.code).toBe("DUPLICATE_BARCODE");
    });

    it("pages through the list and filters by stock status", async () => {
      for (let i = 1; i <= 5; i++) {
        await post("/products", { name: `Test Item ${i}`, taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, minStock: "5", openingStock: String(i * 2) });
      }
      const first = await get("/products?q=test%20item&limit=2");
      expect(first.body.data.map((p: { name: string }) => p.name)).toEqual(["Test Item 1", "Test Item 2"]);
      const second = await get(`/products?q=test%20item&limit=2&cursor=${first.body.nextCursor}`);
      expect(second.body.data.map((p: { name: string }) => p.name)).toEqual(["Test Item 3", "Test Item 4"]);
      const low = await get("/products?stock=low&q=test");
      expect(low.body.data.map((p: { name: string }) => p.name)).toEqual(["Test Item 1", "Test Item 2"]);
      expect(low.body.data[0].stockStatus).toBe("low");
    });

    it("guards price changes, stale edits and the base unit", async () => {
      const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
      const editor = await post("/roles", { key: "catalog_editor", name: "Catalog editor", grants: ["product.view", "product.update"] });
      const mobile = nextMobile();
      await post("/members", { name: "Editor Eva", mobile, roleId: editor.body.id });
      expect(roles.sales).toBeTruthy();
      await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
      const eva = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;

      const price = await patch(`/products/${productId}`, { sellingPrice: "9" }, eva);
      expect(price.status).toBe(403);
      expect(price.body.error.params.permission).toBe("product.update_price");
      const rename = await patch(`/products/${productId}`, { packSize: "100 g" }, eva, { "if-match": "1" });
      expect(rename.status).toBe(200);
      expect(rename.body.version).toBe(2);
      // A partial update leaves everything it did not mention untouched.
      expect(rename.body).toMatchObject({ sellingPrice: "10.0000", mrp: "10.0000", isActive: true, aliases: ["goodday"] });
      expect(rename.body.barcodes).toHaveLength(2);
      expect(rename.body.prices).toHaveLength(2);
      expect(rename.body.units).toHaveLength(1);
      const stale = await patch(`/products/${productId}`, { packSize: "120 g" }, owner.token, { "if-match": "1" });
      expect(stale.body.error.code).toBe("VERSION_CONFLICT");
      const base = await patch(`/products/${productId}`, { baseUnitId: units.BOX });
      expect(base.body.error.code).toBe("BASE_UNIT_LOCKED");
      const del = await call(t.app, "DELETE", `/products/${productId}`, { token: owner.token });
      expect(del.body.error.code).toBe("PRODUCT_HAS_STOCK");

      const audit = await get(`/audit-logs?entityType=product&entityId=${productId}`);
      expect(audit.body.data.map((a: { action: string }) => a.action)).toEqual(["product.updated", "product.created"]);
    });

    it("serves an offline catalogue snapshot", async () => {
      const snap = await get("/catalog");
      const p = snap.body.products.find((x: { id: string }) => x.id === productId);
      expect(p.stock).toBe("100.000");
      expect(p.barcodes.map((b: { barcode: string }) => b.barcode).sort()).toEqual(["18901063093016", "8901063093019"]);
      expect(snap.body.taxCategories.length).toBeGreaterThanOrEqual(5);
      expect(snap.body.priceLevels.length).toBe(3);
    });
  });

  describe("customers", () => {
    it("creates retail and GST-registered customers with the right checks", async () => {
      const retail = await post("/customers", { name: "Sharma Kirana", mobile: "+91 98260 12345", stateCode: "23", city: "Indore" });
      expect(retail.status).toBe(201);
      expect(retail.body).toMatchObject({ code: "C0001", mobile: "9826012345", customerType: "b2c", gstRegistration: "consumer" });

      const noGstin = await post("/customers", { name: "Big Mart", customerType: "b2b", stateCode: "23" });
      expect(noGstin.body.error).toMatchObject({ code: "GSTIN_REQUIRED_FOR_B2B", field: "gstin" });
      const wrongState = await post("/customers", { name: "Big Mart", customerType: "b2b", stateCode: "23", gstin: gstin("27", "AABCB1234C") });
      expect(wrongState.body.error.code).toBe("GSTIN_STATE_MISMATCH");
      const b2b = await post("/customers", { name: "Big Mart", customerType: "b2b", stateCode: "23", gstin: gstin("23", "AABCB1234C") });
      expect(b2b.status).toBe(201);
      expect(b2b.body).toMatchObject({ gstRegistration: "regular", pan: "AABCB1234C" });
    });

    it("posts the opening balance to the ledger and shows a running statement", async () => {
      const c = await post("/customers", {
        name: "Gupta Stores",
        mobile: "9826099999",
        stateCode: "23",
        creditLimit: "20000",
        creditDays: 15,
        openingBalance: "5000",
      });
      expect(c.body.balance).toBe("5000.00");
      expect(c.body.summary).toMatchObject({ balance: "5000.00", creditAvailable: "15000.00", overdue: "0" });
      const ledger = await get(`/customers/${c.body.id}/ledger`);
      expect(ledger.body).toMatchObject({ opening: "0.00", closing: "5000.00", totalDebit: "5000.00" });
      expect(ledger.body.entries[0]).toMatchObject({ docType: "opening", debit: "5000.00", balance: "5000.00" });
      expect(ledger.body.from).toBe("2026-04-01");

      const dup = await post("/customers", { name: "Gupta General", mobile: "09826099999", stateCode: "23" });
      expect(dup.status).toBe(201);
      expect(dup.body.duplicates.map((d: { name: string }) => d.name)).toEqual(["Gupta Stores"]);

      const moved = await patch(`/customers/${c.body.id}`, { city: "Dewas" });
      expect(moved.body).toMatchObject({ city: "Dewas", creditDays: 15, creditLimit: "20000.00", customerType: "b2c", isActive: true });

      const blocked = await call(t.app, "DELETE", `/customers/${c.body.id}`, { token: owner.token });
      expect(blocked.body.error.code).toBe("PARTY_HAS_BALANCE");
      expect((await call(t.app, "DELETE", `/customers/${dup.body.id}`, { token: owner.token })).status).toBe(204);
      expect((await get(`/customers/${dup.body.id}`)).status).toBe(404);
    });

    it("lists, searches, sorts by outstanding and filters by route", async () => {
      const route = await post("/routes", { name: "Monday beat - Vijay Nagar", visitDays: [1] });
      expect(route.status).toBe(201);
      const onRoute = await post("/customers", { name: "Route Kirana", stateCode: "23", routeId: route.body.id, openingBalance: "100" });
      const byRoute = await get(`/customers?routeId=${route.body.id}`);
      expect(byRoute.body.data.map((c: { id: string }) => c.id)).toEqual([onRoute.body.id]);

      const outstanding = await get("/customers?sort=outstanding&outstanding=yes");
      expect(outstanding.body.data.map((c: { name: string }) => c.name)).toEqual(["Gupta Stores", "Route Kirana"]);
      const byMobile = await get(`/customers?q=${encodeURIComponent("+91 98260 12345")}`);
      expect(byMobile.body.data.map((c: { name: string }) => c.name)).toEqual(["Sharma Kirana"]);
      const paged = await get("/customers?limit=1&sort=outstanding");
      const next = await get(`/customers?limit=1&sort=outstanding&cursor=${paged.body.nextCursor}`);
      expect(next.body.data[0].name).toBe("Route Kirana");
      expect((await get("/customers", salesToken)).status).toBe(200);
    });
  });

  describe("suppliers", () => {
    it("encrypts bank account numbers and tracks payables", async () => {
      const res = await post("/suppliers", {
        name: "HUL Distributor Pvt",
        stateCode: "23",
        gstin: gstin("23", "AAACH1234K"),
        bankAccountNumber: "123456789012",
        bankIfsc: "sbin0001234",
        openingBalance: "12000",
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ code: "S0001", bankAccountNumberMasked: "XXXXXX9012", bankIfsc: "SBIN0001234", balance: "12000.00" });
      expect(res.body.bankAccountNumberEnc).toBeUndefined();
      const stored = await t.owner.query(`select bank_account_number_enc from suppliers where id = $1`, [res.body.id]);
      expect(stored.rows[0].bank_account_number_enc).toMatch(/^v1\./);
      expect(stored.rows[0].bank_account_number_enc).not.toContain("123456789012");

      const ledger = await get(`/suppliers/${res.body.id}/ledger`);
      expect(ledger.body.entries[0]).toMatchObject({ credit: "12000.00", balance: "12000.00" });
      expect((await get(`/suppliers/${res.body.id}`, salesToken)).status).toBe(403);
    });
  });
});
