import { describe, expect, it } from "vitest";
import { calculateDocument, resolveTax, saleTcs, tcsDueDate, tcsLabel, tcsNoPanRate, tcsRateFor, type TaxCategory } from "../src/index.js";

const gst18: TaxCategory = {
  id: "t18",
  name: "GST 18%",
  kind: "taxable",
  rules: [{ id: "r18", effectiveFrom: "2017-07-01", effectiveTo: null, gstRate: "18", cessRate: "0", cessPerUnit: "0", condition: null, priority: 0 }],
};
const tax = resolveTax(gst18, { date: "2026-10-12" });
const line = (key: string, qty: string, rate: string) => ({ key, qty, rate, tax, hsnCode: "7204", uqc: "KGS" });

describe("TCS on specified goods (394(1), old 206C(1) and (1F))", () => {
  it("is 2% of the value with GST on scrap, to the rupee", () => {
    const tcs = saleTcs([{ key: "L1", goods: "scrap", qtyBase: "1000", total: "59000" }], { hasPan: true, exempt: false });
    expect(tcs && [tcs.amount.toString(), tcs.parts[0]!.rate.toString(), tcs.parts[0]!.base.toFixed(2)]).toEqual(["1180", "2", "59000.00"]);
    // ₹12,345.67 at 2% = ₹246.91, rounded to ₹247.
    expect(saleTcs([{ key: "L1", goods: "liquor", qtyBase: "10", total: "12345.67" }], { hasPan: true, exempt: false })!.amount.toString()).toBe("247");
  });

  it("is twice the rate, at least 5%, without the buyer's PAN", () => {
    expect(tcsNoPanRate(2).toString()).toBe("5");
    expect(tcsNoPanRate(4).toString()).toBe("8");
    expect(tcsRateFor("scrap", false).toString()).toBe("5");
    expect(saleTcs([{ key: "L1", goods: "scrap", qtyBase: "1", total: "10000" }], { hasPan: false, exempt: false })!.amount.toString()).toBe("500");
  });

  it("takes nothing from an exempt buyer or on other goods", () => {
    expect(saleTcs([{ key: "L1", goods: "scrap", qtyBase: "1", total: "10000" }], { hasPan: true, exempt: true })).toBeNull();
    expect(saleTcs([{ key: "L1", goods: null, qtyBase: "1", total: "10000" }], { hasPan: true, exempt: false })).toBeNull();
  });

  it("takes 1% on a motor vehicle only when one is worth more than ₹10 lakh", () => {
    const buyer = { hasPan: true, exempt: false };
    // Two cars at ₹8 lakh each: neither passes.
    expect(saleTcs([{ key: "L1", goods: "motor_vehicle", qtyBase: "2", total: "1600000" }], buyer)).toBeNull();
    // One at ₹12 lakh: 1% of all of it.
    expect(saleTcs([{ key: "L1", goods: "motor_vehicle", qtyBase: "1", total: "1200000" }], buyer)!.amount.toString()).toBe("12000");
  });

  it("keeps each kind of goods apart, at its own rate, and follows a business's own rates", () => {
    const tcs = saleTcs(
      [
        { key: "L1", goods: "scrap", qtyBase: "1", total: "10000" },
        { key: "L2", goods: "scrap", qtyBase: "1", total: "5000" },
        { key: "L3", goods: "minerals", qtyBase: "1", total: "20000" },
      ],
      { hasPan: true, exempt: false },
      { rates: { minerals: 1 } },
    )!;
    expect(tcs.parts.map((p) => [p.goods, p.base.toFixed(2), p.rate.toString(), p.amount.toString()])).toEqual([
      ["scrap", "15000.00", "2", "300"],
      ["minerals", "20000.00", "1", "200"],
    ]);
    expect(tcs.amount.toString()).toBe("500");
    expect(tcsLabel(tcs.parts[0]!)).toBe("TCS 206C(1) @ 2%");
  });

  it("is added to the bill after GST and before rounding, outside the GST value", () => {
    // 1,000 kg of scrap at ₹50: ₹50,000 + 18% = ₹59,000, TCS ₹1,180; with a ₹99.10 item, ₹60,296.94, rounded.
    const t = calculateDocument({
      lines: [line("L1", "1000", "50"), line("L2", "1", "99.10")],
      supplyType: "intra_state",
      chargeTax: true,
      tcs: { goods: { L1: "scrap" }, buyer: { hasPan: true, exempt: false } },
    });
    expect(t.tcsTotal.toString()).toBe("1180");
    expect(t.taxableTotal.toFixed(2)).toBe("50099.10");
    expect(t.totalBeforeRoundOff.toFixed(2)).toBe("60296.94");
    expect([t.roundOff.toFixed(2), t.grandTotal.toFixed(2)]).toEqual(["0.06", "60297.00"]);
    expect(t.rateBreakup.map((r) => r.taxable.toFixed(2))).toEqual(["50099.10"]);
    // Without it: the same bill less the TCS.
    const plain = calculateDocument({ lines: [line("L1", "1000", "50"), line("L2", "1", "99.10")], supplyType: "intra_state", chargeTax: true });
    expect([plain.tcs, plain.tcsTotal.toString(), plain.grandTotal.toFixed(2)]).toEqual([null, "0", "59117.00"]);
  });

  it("is paid to the government by the 7th of the next month, March's too", () => {
    expect(tcsDueDate("2026-09")).toBe("2026-10-07");
    expect(tcsDueDate("2026-12")).toBe("2027-01-07");
    expect(tcsDueDate("2027-03")).toBe("2027-04-07");
  });
});
