import { describe, expect, it } from "vitest";
import { accessKey, applyPull, pageChanges, type PullPage } from "./feed";
import type { Catalog, CustomerRow, SupplierRow, WorkspaceData } from "./live";

const product = (id: string, name: string, stock = "0") => ({ id, name, stock }) as unknown as Catalog["products"][number];
const customer = (id: string, name: string, balance = "0.00") => ({ id, name, balance }) as unknown as CustomerRow;
const supplier = (id: string, name: string) => ({ id, name }) as unknown as SupplierRow;

const data: WorkspaceData = {
  catalog: { products: [product("p1", "Atta"), product("p2", "Tea", "10")], taxCategories: [], priceLevels: [], units: [], brands: [{ id: "b1", name: "Old" }], categories: [] },
  customers: [customer("c1", "Kirana"), customer("c2", "Mart")],
  routes: [],
  suppliers: [supplier("s1", "Wholesale")],
  warehouses: [],
};

const page = (p: Partial<PullPage>): PullPage => ({ more: false, cursor: "x", products: [], customers: [], suppliers: [], removed: { product: [], customer: [], supplier: [] }, ...p });

describe("the pull feed on the device", () => {
  it("replaces changed records, adds new ones in name order and drops removed ones", () => {
    const next = applyPull(data, page({ products: [product("p2", "Tea", "7"), product("p3", "Biscuit")], customers: [customer("c1", "Kirana", "315.00")], removed: { product: ["p1"], customer: [], supplier: ["s1"] } }));
    expect(next.catalog!.products.map((p) => [p.id, p.stock])).toEqual([["p3", "0"], ["p2", "7"]]);
    expect(next.customers.map((c) => [c.id, c.balance])).toEqual([["c1", "315.00"], ["c2", "0.00"]]);
    expect(next.suppliers).toEqual([]);
    // The copy given is left as it was.
    expect(data.catalog!.products.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("takes lists only when sent, and keeps the rest", () => {
    const next = applyPull(data, page({ lists: { brands: [{ id: "b2", name: "Tata" }], routes: [{ id: "r1", name: "Dewas" }] } }));
    expect(next.catalog!.brands).toEqual([{ id: "b2", name: "Tata" }]);
    expect(next.routes).toEqual([{ id: "r1", name: "Dewas" }]);
    expect(next.catalog!.units).toBe(data.catalog!.units);
    expect(applyPull(data, page({}))).toEqual(data);
  });

  it("knows an empty page changes nothing, and compares access in any order", () => {
    expect(pageChanges(page({}))).toBe(false);
    expect(pageChanges(page({ removed: { product: [], customer: ["c1"], supplier: [] } }))).toBe(true);
    expect(pageChanges(page({ lists: {} }))).toBe(true);
    expect(accessKey(["product.view", "customer.view"])).toBe(accessKey(["customer.view", "product.view"]));
  });
});
