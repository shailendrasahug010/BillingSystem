import { describe, expect, it } from "vitest";
import { cashBook, costRises, countDifferences, inCashBook, packsText, splitIntoPacks } from "../src/index.js";

describe("stock in cases and loose", () => {
  const packs = [
    { symbol: "STRIP", factor: 6 },
    { symbol: "BOX", factor: 24 },
  ];
  it("counts whole boxes and the pieces left over", () => {
    expect(packsText(splitIntoPacks(190, "PCS", packs))).toBe("7 BOX 22 PCS");
    expect(packsText(splitIntoPacks("48", "PCS", packs))).toBe("2 BOX");
  });
  it("keeps the base unit below one box, for fractions, negatives and no packs", () => {
    expect(packsText(splitIntoPacks(20, "PCS", packs))).toBe("20 PCS");
    expect(packsText(splitIntoPacks("30.5", "KG", [{ symbol: "BAG", factor: 25 }]))).toBe("30.5 KG");
    expect(packsText(splitIntoPacks(-30, "PCS", packs))).toBe("-30 PCS");
    expect(packsText(splitIntoPacks(30, "PCS"))).toBe("30 PCS");
  });
});

describe("stock count", () => {
  it("adjusts only what was counted and differs", () => {
    expect(
      countDifferences([
        { productId: "a", system: "190", counted: "185" },
        { productId: "b", system: "12", counted: "12" },
        { productId: "c", system: "5", counted: "" },
        { productId: "d", system: "-2", counted: "3" },
        { productId: "e", system: "1.25", counted: "1.5" },
        { productId: "f", system: "4", counted: null },
      ]),
    ).toEqual([
      { productId: "a", qtyChange: "-5" },
      { productId: "d", qtyChange: "5" },
      { productId: "e", qtyChange: "0.25" },
    ]);
  });
});

describe("cost rises on a purchase bill", () => {
  it("finds the dearer items and the rate that keeps their margin", () => {
    const rises = costRises([
      { productId: "a", oldCost: "8", newCost: "8.8", rate: "9.75" },
      { productId: "b", oldCost: "10", newCost: "10.02", rate: "12" },
      { productId: "c", oldCost: "10", newCost: "9", rate: "12" },
      { productId: "d", oldCost: "0", newCost: "9", rate: "12" },
    ]);
    expect(rises).toHaveLength(1);
    expect(rises[0]).toMatchObject({ productId: "a", oldCost: "8.00", newCost: "8.80", risePercent: "10.0", marginBefore: "17.9", marginNow: "9.7", suggestedRate: "10.80" });
  });
});

describe("cash book", () => {
  it("runs the balance and closes each day", () => {
    const book = cashBook("1000", [
      { date: "2026-10-01", in: "500", out: "0" },
      { date: "2026-10-01", in: "0", out: "200" },
      { date: "2026-10-03", in: "0", out: "1500" },
    ]);
    expect(book.closing).toBe("-200.00");
    expect(book.rows.map((r) => r.balance)).toEqual(["1500.00", "1300.00", "-200.00"]);
    expect(book.days).toEqual([
      { date: "2026-10-01", opening: "1000.00", in: "500.00", out: "200.00", closing: "1300.00" },
      { date: "2026-10-03", opening: "1300.00", in: "0.00", out: "1500.00", closing: "-200.00" },
    ]);
    expect([inCashBook("cash", "cash"), inCashBook("cash", "upi"), inCashBook("bank", "cheque"), inCashBook("bank", "cash"), inCashBook("all", "card")]).toEqual([true, false, true, false, true]);
  });
});
