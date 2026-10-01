import { describe, expect, it } from "vitest";
import { abcClasses, addYears, changePercent, comparisonPeriod, daysSalesOutstanding, inventoryTurnover, sharePercent } from "../src/index.js";

describe("insights: periods compared", () => {
  it("compares with as many days just before, or with the same dates a year earlier", () => {
    expect(comparisonPeriod("2026-04-01", "2026-04-30", "previous")).toEqual({ from: "2026-03-02", to: "2026-03-31" });
    expect(comparisonPeriod("2026-09-24", "2026-09-24", "previous")).toEqual({ from: "2026-09-23", to: "2026-09-23" });
    expect(comparisonPeriod("2026-04-01", "2027-03-31", "previous")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(comparisonPeriod("2026-04-01", "2026-04-30", "last_year")).toEqual({ from: "2025-04-01", to: "2025-04-30" });
  });

  it("moves 29 February to 28 February in a year without it", () => {
    expect(addYears("2028-02-29", -1)).toBe("2027-02-28");
    expect(addYears("2028-02-29", -4)).toBe("2024-02-29");
    expect(comparisonPeriod("2028-02-01", "2028-02-29", "last_year")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  it("gives the change in percent, nothing when there was nothing before", () => {
    expect(changePercent("1150", "1000")).toBe("15.0");
    expect(changePercent("800", "1000")).toBe("-20.0");
    expect(changePercent("50", "0")).toBeNull();
    // A loss getting smaller is an improvement.
    expect(changePercent("-50", "-100")).toBe("50.0");
    expect(sharePercent("250", "1000")).toBe("25.0");
    expect(sharePercent("1", "0")).toBeNull();
  });
});

describe("insights: ABC classes", () => {
  const rows = [
    { name: "D", sales: "50" },
    { name: "A", sales: "600" },
    { name: "C", sales: "150" },
    { name: "B", sales: "200" },
    { name: "Returned more than bought", sales: "-20" },
    { name: "Nothing", sales: "0" },
  ];

  it("sorts largest first: A up to 80% (the row crossing it included), B to 95%, C after", () => {
    const out = abcClasses(rows, (r) => r.sales);
    expect(out.map((r) => [r.name, r.share, r.cumulative, r.abc])).toEqual([
      ["A", "60.0", "60.0", "A"],
      ["B", "20.0", "80.0", "A"],
      ["C", "15.0", "95.0", "B"],
      ["D", "5.0", "100.0", "C"],
      ["Nothing", "0.0", "100.0", "C"],
      ["Returned more than bought", "0.0", "100.0", "C"],
    ]);
  });

  it("puts everything in C when nothing was sold", () => {
    expect(abcClasses([{ s: "0" }, { s: "0" }], (r) => r.s).map((r) => r.abc)).toEqual(["C", "C"]);
    expect(abcClasses([], (r: { s: string }) => r.s)).toEqual([]);
  });
});

describe("insights: stock and receivables", () => {
  it("turns cost of goods sold and stock values into turnover and days of stock", () => {
    // ₹30,000 sold at cost in 30 days on ₹15,000 average stock: turned twice, 15 days of stock.
    expect(inventoryTurnover("30000", "10000", "20000", 30)).toEqual({ averageInventory: "15000.00", turnover: "2.00", daysOfInventory: "15" });
    expect(inventoryTurnover("0", "10000", "10000", 30)).toEqual({ averageInventory: "10000.00", turnover: null, daysOfInventory: null });
    expect(inventoryTurnover("500", "0", "0", 30).turnover).toBeNull();
  });

  it("gives days sales outstanding from what is owed and the billing", () => {
    // ₹90,000 billed in 30 days is ₹3,000 a day; ₹45,000 owed is 15 days of it.
    expect(daysSalesOutstanding("45000", "90000", 30)).toBe("15");
    expect(daysSalesOutstanding("45000", "0", 30)).toBeNull();
  });
});
