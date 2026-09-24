import { gstinCheckChar } from "@vyapaar/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("spreadsheet import", () => {
  let t: TestApp;
  let owner: Session;
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows[0] as T;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Import Traders", stateCode: "23" });
  });
  afterAll(async () => {
    await t?.close();
  });

  const products = [
    { name: "Parle-G 100g", gst: "5", hsn: "1905", unit: "pcs", case_unit: "BOX", case_size: "24", brand: "Parle", category: "Biscuits", mrp: "10", selling_price: "9.20", purchase_price: "8", opening_stock: "48", min_stock: "24", barcode: "8901719101045" },
    { name: "Monaco 75g", gst: "GST 18%", hsn: "1905", brand: "parle", selling_price: "₹1,020.50", barcode: "8901719104046;8901719104053" },
    { name: "Fresh Dhaniya", gst: "exempt", unit: "KG" },
  ];

  it("checks every row and imports nothing while any row is wrong", async () => {
    const res = await post("/products/import", {
      rows: [
        ...products,
        { name: "", gst: "18" },
        { name: "Mystery", gst: "7" },
        { name: "Bad Price", gst: "18", mrp: "ten" },
        { name: "Dup Barcode", gst: "18", barcode: "8901719101045" },
        { name: "Odd Unit", gst: "18", unit: "crate" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.errors).toEqual([
      { row: 4, column: "name", code: "IMPORT_REQUIRED" },
      { row: 5, column: "gst", code: "IMPORT_UNKNOWN_GST", params: { value: "7" } },
      { row: 6, column: "mrp", code: "IMPORT_INVALID" },
      { row: 7, column: "barcode", code: "DUPLICATE_BARCODE", params: { value: "8901719101045" } },
      { row: 8, column: "unit", code: "IMPORT_UNKNOWN_UNIT", params: { value: "crate" } },
    ]);
    expect((await one<{ n: number }>(`select count(*)::int as n from products where business_id = $1`, [owner.businessId])).n).toBe(0);
  });

  it("imports products with brands, categories, case units, barcodes and opening stock", async () => {
    const dry = await post("/products/import", { rows: products, dryRun: true });
    expect(dry.body).toMatchObject({ total: 3, created: 0, newBrands: 1, newCategories: 1, withOpeningStock: 1, errors: [] });
    const res = await post("/products/import", { rows: products });
    expect(res.body).toMatchObject({ created: 3, errors: [] });
    const catalog = (await get("/catalog")).body;
    const parle = catalog.products.find((p: { name: string }) => p.name === "Parle-G 100g");
    expect(parle).toMatchObject({ code: "P00001", hsnCode: "1905", sellingPrice: "9.2000", mrp: "10.0000", stock: "48.000", avgCost: "8.0000" });
    expect(parle.units).toEqual([expect.objectContaining({ conversionFactor: "24.000" })]);
    const monaco = catalog.products.find((p: { name: string }) => p.name === "Monaco 75g");
    expect(monaco.sellingPrice).toBe("1020.5000");
    expect(monaco.brandId).toBe(parle.brandId);
    expect(monaco.barcodes).toHaveLength(2);
    expect(catalog.brands).toHaveLength(1);
    const ledger = (await get(`/stock/ledger?productId=${parle.id}`)).body;
    expect(ledger.entries).toEqual([expect.objectContaining({ type: "opening", qtyIn: "48.000", balance: "48.000" })]);
    // Importing the same file again is refused (barcodes already exist).
    const again = await post("/products/import", { rows: products });
    expect(again.body.created).toBe(0);
    expect(again.body.errors[0]).toMatchObject({ row: 1, column: "barcode", code: "DUPLICATE_BARCODE" });
  });

  it("imports 5,000 products in one request", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ name: `Item ${i + 1}`, gst: i % 2 ? "18" : "5", hsn: "3401", selling_price: String(10 + (i % 90)), opening_stock: i % 3 ? "10" : "", purchase_price: "7" }));
    const started = Date.now();
    const res = await post("/products/import", { rows });
    const ms = Date.now() - started;
    expect(res.body).toMatchObject({ created: 5000, errors: [] });
    expect(ms).toBeLessThan(30_000);
    const count = await one<{ n: number; stocked: number }>(
      `select count(*)::int as n, (select count(*)::int from stock_balances where business_id = $1) as stocked from products where business_id = $1`,
      [owner.businessId],
    );
    expect(count).toEqual({ n: 5003, stocked: 1 + 3333 });
    const codes = await one<{ last: string }>(`select max(code) as last from products where business_id = $1`, [owner.businessId]);
    expect(codes.last).toBe("P05003");
  }, 60_000);

  it("imports customers: state from GSTIN, routes, rate lists, opening balances and advances", async () => {
    const rows = [
      { name: "Bhopal Mart", gstin: gstin("23", "AABCB9999C"), city: "Bhopal", credit_days: "15" },
      { name: "Sharma Kirana", contact_person: "Ramesh Sharma", mobile: "98260 12345", route: "Rajwada", price_level: "Wholesale", opening_balance: "1,500", credit_limit: "20000" },
      { name: "Advance Stores", mobile: "9826011111", state: "Maharashtra", opening_balance: "-250" },
    ];
    const res = await post("/customers/import", { rows });
    expect(res.body).toMatchObject({ created: 3, newRoutes: 1, withOpeningBalance: 2, errors: [] });
    const list = (await get("/customers?limit=10")).body.data as Array<Record<string, unknown>>;
    expect(list.find((c) => c.name === "Bhopal Mart")).toMatchObject({ customerType: "b2b", stateCode: "23", creditDays: 15 });
    expect(list.find((c) => c.businessName === "Sharma Kirana")).toMatchObject({ name: "Ramesh Sharma", mobile: "9826012345", balance: "1500.00", creditLimit: "20000.00" });
    expect(list.find((c) => c.businessName === "Advance Stores")).toMatchObject({ stateCode: "27", balance: "-250.00" });
    const routes = (await get("/routes")).body.data;
    expect(routes.map((r: { name: string }) => r.name)).toEqual(["Rajwada"]);
    const dup = await post("/customers/import", { rows: [{ name: "Copy", mobile: "9826012345" }, { name: "Bad GSTIN", gstin: "23AABCB9999C1Z0" }, { name: "Wrong state", gstin: gstin("23", "AABCW1111C"), state: "27" }] });
    expect(dup.body.errors).toEqual([
      { row: 1, column: "mobile", code: "IMPORT_DUPLICATE_PARTY", params: { value: "9826012345" } },
      { row: 2, column: "gstin", code: "INVALID_GSTIN", params: { issue: "invalid_checksum" } },
      { row: 3, column: "gstin", code: "GSTIN_STATE_MISMATCH", params: { gstinState: "23" } },
    ]);
  });
});
