import { describe, expect, it } from "vitest";
import { inStockAlternative } from "./alternatives";

const item = (id: string, brandId: string, rate: number, stock: number, category = "Biscuits") => ({ id, brandId, category, rate, stock });

describe("an in-stock product for one that is out", () => {
  const out = item("parle-g", "parle", 10, 0);
  const catalogue = [out, item("krack", "parle", 12, 50), item("good-day", "britannia", 10, 80), item("marie", "britannia", 30, 90), item("salt", "tata", 10, 99, "Salt")];

  it("is the same brand first, then the nearest price, in the same category", () => {
    expect(inStockAlternative(out, 5, catalogue)?.id).toBe("krack");
    expect(inStockAlternative(out, 5, catalogue, new Set(["krack"]))?.id).toBe("good-day");
  });

  it("needs enough stock and a price not far off", () => {
    expect(inStockAlternative(out, 60, catalogue)?.id).toBe("good-day");
    expect(inStockAlternative(out, 100, catalogue)).toBeNull();
  });
});
