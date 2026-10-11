import { describe, expect, it } from "vitest";
import { applySchemes, checkSchemeClaims, schemeRuleProblem, type SchemeLine, type SchemeRule } from "../src/index.js";

const DAY = "2026-10-11";
function scheme(p: Partial<SchemeRule> & Pick<SchemeRule, "id" | "kind" | "slabs">): SchemeRule {
  return {
    name: p.id,
    measure: "qty",
    productIds: [],
    brandIds: [],
    categoryIds: [],
    repeat: true,
    freeProductId: null,
    validFrom: "2026-10-01",
    validTo: "2026-10-31",
    customerCategoryIds: [],
    priceLevelIds: [],
    active: true,
    ...p,
  };
}
const line = (key: string, productId: string, qtyBase: number, value: number, brandId: string | null = null): SchemeLine => ({ key, productId, brandId, qtyBase, value });
const prices: Record<string, number> = { soap: 35, soap2: 40, shampoo: 120 };
const unitValue = (id: string) => prices[id] ?? null;

describe("free goods", () => {
  const tenPlusOne = scheme({ id: "s1", kind: "free_goods", productIds: ["soap"], slabs: [{ from: 10, freeQty: 1 }] });

  it("gives one free for every ten, and says how many more earn the next", () => {
    const r = applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 25, 875)], schemes: [tenPlusOne], unitValue });
    expect(r.free.map((f) => [f.schemeId, f.productId, f.qty.toFixed(3)])).toEqual([["s1", "soap", "2.000"]]);
    expect(r.applied[0]!.benefit.toFixed(2)).toBe("70.00");
    expect(r.hints.map((h) => [h.scheme.id, h.short.toString()])).toEqual([["s1", "5"]]);
  });

  it("gives once a slab is reached when it does not repeat; slabs pick the highest reached", () => {
    const slabs = scheme({ id: "s2", kind: "free_goods", productIds: ["soap"], repeat: false, slabs: [{ from: 24, freeQty: 3 }, { from: 10, freeQty: 1 }] });
    const at = (qty: number) => applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", qty, qty * 35)], schemes: [slabs] }).free[0]?.qty.toString() ?? "0";
    expect([at(9), at(10), at(23), at(24), at(60)]).toEqual(["0", "1", "1", "3", "3"]);
  });

  it("counts each product by itself when the free goods are the product bought", () => {
    const brand = scheme({ id: "s3", kind: "free_goods", brandIds: ["lifebuoy"], slabs: [{ from: 10, freeQty: 1 }] });
    const r = applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 12, 420, "lifebuoy"), line("b", "soap2", 8, 320, "lifebuoy")], schemes: [brand], unitValue });
    expect(r.free.map((f) => [f.productId, f.qty.toString()])).toEqual([["soap", "1"]]);
    // soap2 is 2 short of its own ten.
    expect(r.hints.find((h) => h.productId === "soap2")?.short.toString()).toBe("2");
  });

  it("counts the products together for a named free product", () => {
    const combo = scheme({ id: "s4", kind: "free_goods", brandIds: ["lifebuoy"], freeProductId: "shampoo", slabs: [{ from: 12, freeQty: 1 }] });
    const r = applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 7, 245, "lifebuoy"), line("b", "soap2", 6, 240, "lifebuoy")], schemes: [combo], unitValue });
    expect(r.free.map((f) => [f.productId, f.qty.toString()])).toEqual([["shampoo", "1"]]);
    expect(r.applied[0]!.lineKeys).toEqual(["a", "b"]);
  });
});

describe("discounts", () => {
  it("takes the highest slab's percent off each line of the scheme", () => {
    const slab = scheme({ id: "d1", kind: "discount", brandIds: ["lifebuoy"], slabs: [{ from: 5, discountPercent: 2 }, { from: 10, discountPercent: 3.5 }] });
    const r = applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 6, 210, "lifebuoy"), line("b", "soap2", 6, 240, "lifebuoy"), line("c", "shampoo", 2, 240)], schemes: [slab] });
    expect([...r.discountByLine].map(([k, d]) => [k, d.schemeId, d.amount.toFixed(2)])).toEqual([
      ["a", "d1", "7.35"],
      ["b", "d1", "8.40"],
    ]);
    // At 12, the top slab is reached: nothing more to earn.
    expect(r.hints).toEqual([]);
  });

  it("takes rupees off each unit, and counts by value when told to", () => {
    const perUnit = scheme({ id: "d2", kind: "discount", productIds: ["soap"], slabs: [{ from: 100, discountPerUnit: 3 }] });
    expect(applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 120, 4200)], schemes: [perUnit] }).discountByLine.get("a")?.amount.toFixed(2)).toBe("360.00");
    const byValue = scheme({ id: "d3", kind: "discount", measure: "value", productIds: ["soap", "shampoo"], slabs: [{ from: 5000, discountPercent: 1 }] });
    const short = applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 100, 3500), line("b", "shampoo", 10, 1200)], schemes: [byValue] });
    expect(short.discountByLine.size).toBe(0);
    expect(short.hints[0]?.short.toFixed(2)).toBe("300.00");
    const made = applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 100, 3500), line("b", "shampoo", 15, 1800)], schemes: [byValue] });
    expect([...made.discountByLine.values()].map((d) => d.amount.toFixed(2))).toEqual(["35.00", "18.00"]);
  });

  it("gives a line one discount: the better scheme first, the other on what is left", () => {
    const brandWide = scheme({ id: "d4", kind: "discount", brandIds: ["lifebuoy"], slabs: [{ from: 1, discountPercent: 2 }] });
    const soapOnly = scheme({ id: "d5", kind: "discount", productIds: ["soap"], slabs: [{ from: 1, discountPercent: 5 }] });
    const lines = [line("a", "soap", 10, 350, "lifebuoy"), line("b", "soap2", 10, 400, "lifebuoy")];
    const r = applySchemes({ date: DAY, customer: null, lines, schemes: [brandWide, soapOnly] });
    expect([...r.discountByLine].map(([k, d]) => [k, d.schemeId, d.amount.toFixed(2)])).toEqual([
      ["a", "d5", "17.50"],
      ["b", "d4", "8.00"],
    ]);
    // Said no to the better one: the brand's scheme takes both lines.
    const declined = applySchemes({ date: DAY, customer: null, lines, schemes: [brandWide, soapOnly], declined: ["d5"] });
    expect([...declined.discountByLine.values()].map((d) => d.schemeId)).toEqual(["d4", "d4"]);
    expect(declined.available.map((s) => s.id).sort()).toEqual(["d4", "d5"]);
  });

  it("never takes more than the line comes to", () => {
    const big = scheme({ id: "d6", kind: "discount", productIds: ["soap"], slabs: [{ from: 1, discountPerUnit: 50 }] });
    expect(applySchemes({ date: DAY, customer: null, lines: [line("a", "soap", 2, 70)], schemes: [big] }).discountByLine.get("a")?.amount.toFixed(2)).toBe("70.00");
  });
});

describe("who and when", () => {
  const base = { kind: "discount" as const, productIds: ["soap"], slabs: [{ from: 1, discountPercent: 2 }] };
  const lines = [line("a", "soap", 10, 350)];

  it("runs from its first day to its last, while it is on", () => {
    const s = scheme({ id: "w1", ...base, validFrom: "2026-10-05", validTo: "2026-10-11" });
    expect(applySchemes({ date: "2026-10-04", customer: null, lines, schemes: [s] }).applied).toEqual([]);
    expect(applySchemes({ date: "2026-10-05", customer: null, lines, schemes: [s] }).applied.length).toBe(1);
    expect(applySchemes({ date: "2026-10-12", customer: null, lines, schemes: [s] }).applied).toEqual([]);
    expect(applySchemes({ date: DAY, customer: null, lines, schemes: [{ ...s, active: false }] }).applied).toEqual([]);
    expect(applySchemes({ date: "2027-01-01", customer: null, lines, schemes: [{ ...s, validTo: null }] }).applied.length).toBe(1);
  });

  it("is for the customers of its categories or rate lists only, when it names any", () => {
    const s = scheme({ id: "w2", ...base, customerCategoryIds: ["wholesalers"], priceLevelIds: ["modern-trade"] });
    const given = (customer: { categoryId?: string | null; priceLevelId?: string | null } | null) => applySchemes({ date: DAY, customer, lines, schemes: [s] }).applied.length;
    expect([given(null), given({ categoryId: "retail" }), given({ categoryId: "wholesalers" }), given({ categoryId: null, priceLevelId: "modern-trade" })]).toEqual([0, 0, 1, 1]);
  });
});

describe("checking a bill's schemes", () => {
  const tenPlusOne = scheme({ id: "c1", kind: "free_goods", productIds: ["soap"], slabs: [{ from: 10, freeQty: 1 }] });
  const twoPercent = scheme({ id: "c2", kind: "discount", productIds: ["soap"], slabs: [{ from: 10, discountPercent: 2 }] });
  const fivePercent = scheme({ id: "c3", kind: "discount", productIds: ["soap"], slabs: [{ from: 10, discountPercent: 5 }] });
  const input = { date: DAY, customer: null, lines: [line("L1", "soap", 20, 700)], schemes: [tenPlusOne, twoPercent, fivePercent], unitValue };

  it("passes what the bill earned, or less", () => {
    expect(checkSchemeClaims(input, { discounts: [{ lineKey: "L1", schemeId: "c3", amount: "35.00" }], free: [{ schemeId: "c1", productId: "soap", qty: "2" }] })).toEqual([]);
    expect(checkSchemeClaims(input, { discounts: [], free: [{ schemeId: "c1", productId: "soap", qty: "1" }] })).toEqual([]);
    // The 5% one left off: the 2% one in its place is what the bill screen gave.
    expect(checkSchemeClaims(input, { discounts: [{ lineKey: "L1", schemeId: "c2", amount: "14.00" }], free: [] })).toEqual([]);
  });

  it("finds more than was earned, a scheme not earned, and one not running", () => {
    expect(checkSchemeClaims(input, { discounts: [{ lineKey: "L1", schemeId: "c3", amount: "36.00" }], free: [] })).toEqual([{ schemeId: "c3", reason: "too_much", lineKey: "L1", claimed: "36.00", allowed: "35.00" }]);
    expect(checkSchemeClaims(input, { discounts: [], free: [{ schemeId: "c1", productId: "soap", qty: "3" }] })[0]).toMatchObject({ reason: "too_much", allowed: "2.000" });
    expect(checkSchemeClaims(input, { discounts: [], free: [{ schemeId: "c1", productId: "shampoo", qty: "1" }] })[0]).toMatchObject({ reason: "not_earned" });
    expect(checkSchemeClaims({ ...input, date: "2026-11-01" }, { discounts: [{ lineKey: "L1", schemeId: "c3", amount: "35.00" }], free: [] })).toEqual([{ schemeId: "c3", reason: "not_in_force" }]);
    expect(checkSchemeClaims(input, { discounts: [{ lineKey: "L1", schemeId: "gone", amount: "1.00" }], free: [] })).toEqual([{ schemeId: "gone", reason: "unknown" }]);
  });
});

describe("a scheme as entered", () => {
  const ok = { name: "x", kind: "discount" as const, measure: "qty" as const, productIds: ["soap"], brandIds: [], categoryIds: [], slabs: [{ from: 10, discountPercent: 2 }], repeat: true, freeProductId: null, validFrom: "2026-10-01", validTo: null, customerCategoryIds: [], priceLevelIds: [] };
  it("needs products, slabs that give something, and an end after its start", () => {
    expect(schemeRuleProblem(ok)).toBeNull();
    expect(schemeRuleProblem({ ...ok, productIds: [] })).toBe("SCHEME_NO_PRODUCTS");
    expect(schemeRuleProblem({ ...ok, slabs: [] })).toBe("SCHEME_NO_SLABS");
    expect(schemeRuleProblem({ ...ok, validTo: "2026-09-30" })).toBe("SCHEME_ENDS_BEFORE_START");
    expect(schemeRuleProblem({ ...ok, slabs: [{ from: 0, discountPercent: 2 }] })).toBe("SCHEME_SLAB_FROM");
    expect(schemeRuleProblem({ ...ok, slabs: [{ from: 10, discountPercent: 2 }, { from: 10, discountPercent: 3 }] })).toBe("SCHEME_SLAB_TWICE");
    expect(schemeRuleProblem({ ...ok, slabs: [{ from: 10 }] })).toBe("SCHEME_SLAB_BENEFIT");
    expect(schemeRuleProblem({ ...ok, kind: "free_goods", slabs: [{ from: 10, discountPercent: 2 }] })).toBe("SCHEME_SLAB_BENEFIT");
    expect(schemeRuleProblem({ ...ok, slabs: [{ from: 10, discountPercent: 120 }] })).toBe("DISCOUNT_PERCENT_RANGE");
  });
});
