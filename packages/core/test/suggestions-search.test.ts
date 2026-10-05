import { describe, expect, it } from "vitest";
import {
  buildReorderList,
  computeCustomerStats,
  editDistance,
  mineAssociations,
  searchProducts,
  suggestProducts,
  type PurchaseLine,
  type SuggestionProduct,
} from "../src/index.js";

const asOf = "2026-09-24";

// "ABC General Store": weekly visits. Milk every visit, Parle-G fortnightly,
// Coca-Cola weekly until it stopped a month ago, Surf and Salt occasionally.
const invoices: Array<[string, string, Array<[string, number]>]> = [
  ["inv1", "2026-08-14", [["milk", 20], ["parle", 20], ["surf", 10], ["coke", 12]]],
  ["inv2", "2026-08-21", [["milk", 20], ["salt", 15], ["coke", 12]]],
  ["inv3", "2026-08-28", [["milk", 20], ["parle", 20], ["coke", 12]]],
  ["inv4", "2026-09-04", [["milk", 20], ["surf", 10]]],
  ["inv5", "2026-09-11", [["milk", 20], ["parle", 24]]],
  ["inv6", "2026-09-18", [["milk", 24], ["salt", 15]]],
];
const history: PurchaseLine[] = invoices.flatMap(([invoiceId, date, items]) =>
  items.map(([productId, qty]) => ({ invoiceId, date, productId, qty })),
);

const catalogue: SuggestionProduct[] = [
  { id: "milk", name: "Amul Taaza Milk 1L", active: true, stockQty: 200, minStock: 50 },
  { id: "parle", name: "Parle-G 100g", active: true, stockQty: 500, minStock: 100 },
  { id: "surf", name: "Surf Excel 1kg", active: true, stockQty: 30, minStock: 40 },
  { id: "salt", name: "Tata Salt 1kg", active: true, stockQty: 90, minStock: 20 },
  { id: "coke", name: "Coca-Cola 750ml", active: true, stockQty: 60, minStock: 24 },
  { id: "bread", name: "Bread 400g", active: true, stockQty: 40 },
  { id: "butter", name: "Amul Butter 100g", active: true, stockQty: 25 },
];
const products = new Map(catalogue.map((p) => [p.id, p]));

describe("customer purchase statistics", () => {
  const { summary, products: stats } = computeCustomerStats(history, { asOf });

  it("summarises the customer", () => {
    expect(summary.invoiceCount).toBe(6);
    expect(summary.lastInvoiceOn).toBe("2026-09-18");
    expect(summary.typicalVisitIntervalDays).toBe(7);
  });

  it("learns typical intervals and quantities per product", () => {
    const milk = stats.get("milk")!;
    expect(milk.orderCount).toBe(6);
    expect(milk.orderShare).toBe(1);
    expect(milk.typicalIntervalDays).toBe(7);
    expect(milk.daysSinceLast).toBe(6);
    expect(milk.lastQty.toNumber()).toBe(24);
    expect(milk.avgQty.toFixed(2)).toBe("20.67");

    expect(stats.get("parle")!.typicalIntervalDays).toBe(14);
    expect(stats.get("surf")!.typicalIntervalDays).toBeNull(); // only two purchases: not enough to claim a habit
  });
});

describe("suggestProducts", () => {
  const { summary, products: stats } = computeCustomerStats(history, { asOf });
  const base = { asOf, summary, stats, products, cartProductIds: [] as string[] };

  it("explains 'usually every 7 days, last bought 6 days ago'", () => {
    const [top] = suggestProducts(base);
    expect(top!.productId).toBe("milk");
    expect(top!.group).toBe("reorder");
    expect(top!.reasons[0]).toEqual({ code: "due", params: { intervalDays: 7, daysSince: 6 } });
    expect(top!.reasons.map((r) => r.code)).toEqual(["due", "frequent", "last_order"]);
    expect(top!.suggestedQty?.toNumber()).toBe(20); // median of the last three (24, 20, 20)
  });

  it("ranks due items first, then lapsed habits, then occasional items", () => {
    const order = suggestProducts(base).map((s) => s.productId);
    expect(order).toEqual(["milk", "parle", "coke", "salt", "surf"]);
    const coke = suggestProducts(base).find((s) => s.productId === "coke")!;
    expect(coke.reasons[0]).toEqual({ code: "lapsed", params: { intervalDays: 7, daysSince: 27 } });
  });

  it("never suggests what is already on the invoice, or inactive products", () => {
    const withCart = suggestProducts({ ...base, cartProductIds: ["milk"] }).map((s) => s.productId);
    expect(withCart).not.toContain("milk");
    const inactive = new Map(products);
    inactive.set("parle", { ...products.get("parle")!, active: false });
    expect(suggestProducts({ ...base, products: inactive }).map((s) => s.productId)).not.toContain("parle");
  });

  it("flags and demotes out-of-stock products instead of hiding them", () => {
    const oos = new Map(products);
    oos.set("parle", { ...products.get("parle")!, stockQty: 0 });
    const before = suggestProducts(base).find((s) => s.productId === "parle")!;
    const after = suggestProducts({ ...base, products: oos }).find((s) => s.productId === "parle")!;
    expect(after.reasons.map((r) => r.code)).toContain("out_of_stock");
    expect(after.score).toBeCloseTo(before.score / 2, 1);
    const low = suggestProducts(base).find((s) => s.productId === "surf")!;
    expect(low.reasons.map((r) => r.code)).toContain("low_stock");
  });

  it("builds the reorder table", () => {
    const rows = buildReorderList({ stats, products });
    expect(rows.map((r) => [r.productId, r.status, r.lastQty.toNumber(), r.daysSinceLast, r.suggestedQty.toNumber()])).toEqual([
      ["parle", "due", 24, 13, 20],
      ["milk", "due", 24, 6, 20],
      ["coke", "lapsed", 12, 27, 12],
      ["surf", "irregular", 10, 20, 10],
      ["salt", "irregular", 15, 6, 15],
    ]);
  });
});

describe("frequently bought together", () => {
  const baskets = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, productIds: ["bread", "butter"] })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i}`, productIds: ["bread", "milk"] })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, productIds: ["milk", "parle"] })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, productIds: ["salt"] })),
  ];

  it("mines rules with confidence and lift", () => {
    const rules = mineAssociations(baskets);
    const breadButter = rules.find((r) => r.productId === "bread" && r.relatedProductId === "butter")!;
    expect(breadButter.pairCount).toBe(6);
    expect(breadButter.confidence).toBe(0.75);
    expect(breadButter.lift).toBeCloseTo(0.75 / (6 / 20), 5);
    // bread -> milk only 2 times: below the minimum pair count.
    expect(rules.find((r) => r.productId === "bread" && r.relatedProductId === "milk")).toBeUndefined();
  });

  it("suggests the partner product once the first is on the invoice", () => {
    const { summary, products: stats } = computeCustomerStats(history, { asOf });
    const s = suggestProducts({
      asOf,
      summary,
      stats,
      products,
      cartProductIds: ["bread"],
      associations: mineAssociations(baskets),
    }).find((x) => x.productId === "butter")!;
    expect(s.group).toBe("together");
    expect(s.reasons[0]).toEqual({
      code: "together",
      params: { withProductId: "bread", withProductName: "Bread 400g", percent: 75, scope: "all" },
    });
  });
});

describe("searchProducts", () => {
  const items = [
    { id: "parle", name: "Parle-G Biscuit 100g", code: "PG100", barcodes: ["8901719101014"], brand: "Parle", inStock: true },
    { id: "monaco", name: "Parle Monaco Classic", code: "MON75", brand: "Parle", inStock: true },
    { id: "salt", name: "Tata Salt 1kg", code: "TS1", brand: "Tata", aliases: ["namak", "नमक"], inStock: true },
    { id: "surf", name: "Surf Excel Easy Wash 1kg", code: "SE1", brand: "Hindustan Unilever", inStock: false },
    { id: "old", name: "Parle Old Pack", code: "OLD", active: false },
  ];

  it("finds exact barcode and code matches first", () => {
    expect(searchProducts("8901719101014", items)[0]).toMatchObject({ matchedOn: "barcode", product: { id: "parle" } });
    expect(searchProducts("ts1", items)[0]).toMatchObject({ matchedOn: "code", product: { id: "salt" } });
    expect(searchProducts("PG1", items)[0]!.product.id).toBe("parle");
  });

  it("tolerates punctuation and spacing ('parleg' finds Parle-G)", () => {
    expect(searchProducts("parleg", items)[0]!.product.id).toBe("parle");
    expect(searchProducts("surf 1kg", items)[0]!.product.id).toBe("surf");
  });

  it("searches Hindi and transliterated aliases", () => {
    expect(searchProducts("नमक", items)[0]!.product.id).toBe("salt");
    expect(searchProducts("namak", items)[0]!.product.id).toBe("salt");
  });

  it("forgives a letter or two spelt wrong, below exact matches", () => {
    const more = [...items, { id: "britannia", name: "Britannia Good Day 100g", brand: "Britannia" }, { id: "colgate", name: "Colgate Strong Teeth 200g", brand: "Colgate" }];
    expect(searchProducts("britania", more)[0]!.product.id).toBe("britannia");
    expect(searchProducts("colget", more)[0]!.product.id).toBe("colgate");
    expect(searchProducts("parley", more).map((h) => h.product.id)).toEqual(expect.arrayContaining(["parle", "monaco"]));
    expect(searchProducts("tata slat", more)[0]!.product.id).toBe("salt");
    // Numbers and short words must match as typed.
    expect(searchProducts("monaco 76", more).map((h) => h.product.id)).not.toContain("parle");
    expect(searchProducts("xyzq", more)).toEqual([]);
  });

  it("counts edits, with a swap of two letters as one", () => {
    expect(editDistance("parle", "parle")).toBe(0);
    expect(editDistance("prale", "parle")).toBe(1);
    expect(editDistance("colget", "colgate")).toBe(2);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
  });

  it("boosts what this customer usually buys and hides inactive products", () => {
    const plain = searchProducts("parle", items).map((h) => h.product.id);
    expect(plain).not.toContain("old");
    const boosted = searchProducts("parle", items, { customerAffinity: new Map([["monaco", 0.9]]) });
    expect(boosted[0]!.product.id).toBe("monaco");
  });
});
