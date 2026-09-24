import { describe, expect, it } from "vitest";
import { trendBuckets } from "./data";

// The server computes the same buckets (apps/api/src/modules/reports/dashboard.ts); both must agree.
describe("dashboard trend buckets", () => {
  it("covers 30 days, 12 weeks, 6 months or 3 financial years ending today", () => {
    const daily = trendBuckets("daily", "2026-09-24");
    expect(daily).toHaveLength(30);
    expect(daily[0]).toEqual({ from: "2026-08-26", to: "2026-08-26" });
    const weekly = trendBuckets("weekly", "2026-09-24");
    expect(weekly.at(-1)).toEqual({ from: "2026-09-18", to: "2026-09-24" });
    expect(weekly[0]).toEqual({ from: "2026-07-03", to: "2026-07-09" });
    expect(trendBuckets("monthly", "2026-09-24").map((b) => [b.from, b.to])).toEqual([
      ["2026-04-01", "2026-04-30"],
      ["2026-05-01", "2026-05-31"],
      ["2026-06-01", "2026-06-30"],
      ["2026-07-01", "2026-07-31"],
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-24"],
    ]);
    expect(trendBuckets("yearly", "2026-02-10")).toEqual([
      { from: "2023-04-01", to: "2024-03-31" },
      { from: "2024-04-01", to: "2025-03-31" },
      { from: "2025-04-01", to: "2026-02-10" },
    ]);
  });
});
