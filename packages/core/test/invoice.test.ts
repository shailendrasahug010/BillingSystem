import { describe, expect, it } from "vitest";
import { calculateDocument, compareTotals, NO_TAX, taxAt, type DocumentLineInput } from "../src/index.js";

// A typical distributor invoice: MP business -> MP retailer (intra-state).
const lines: DocumentLineInput[] = [
  { key: "1", qty: 48, rate: "9.50", tax: taxAt(5), hsnCode: "1905", uqc: "PCS" }, // biscuits
  { key: "2", qty: 10, rate: "128.00", discountPercent: 2, tax: taxAt(18), hsnCode: "3402", uqc: "PCS" }, // detergent
  { key: "3", qty: 15, rate: "26.00", tax: { ...NO_TAX, kind: "nil_rated" }, hsnCode: "2501", uqc: "PCS" }, // salt
  { key: "4", qty: 12, rate: "38.00", tax: taxAt(40), hsnCode: "2202", uqc: "BTL" }, // aerated drink
];

describe("calculateDocument", () => {
  it("computes a multi-rate intra-state invoice exactly", () => {
    const t = calculateDocument({ lines, supplyType: "intra_state", chargeTax: true, amountPaid: 1000 });
    expect(t.lines.map((l) => l.total.toFixed(2))).toEqual(["478.80", "1480.20", "390.00", "638.40"]);
    expect(t.grossTotal.toFixed(2)).toBe("2582.00");
    expect(t.discountTotal.toFixed(2)).toBe("25.60");
    expect(t.taxableTotal.toFixed(2)).toBe("2556.40");
    expect(t.cgstTotal.toFixed(2)).toBe("215.50");
    expect(t.sgstTotal.toFixed(2)).toBe("215.50");
    expect(t.igstTotal.toFixed(2)).toBe("0.00");
    expect(t.totalBeforeRoundOff.toFixed(2)).toBe("2987.40");
    expect(t.roundOff.toFixed(2)).toBe("-0.40");
    expect(t.grandTotal.toFixed(2)).toBe("2987.00");
    expect(t.balanceDue.toFixed(2)).toBe("1987.00");
    expect(t.paymentStatus).toBe("partial");
    expect(t.lineCount).toBe(4);
  });

  it("builds the tax-rate breakup and HSN summary shown on the invoice", () => {
    const t = calculateDocument({ lines, supplyType: "intra_state", chargeTax: true });
    expect(t.rateBreakup.map((r) => [r.gstRate.toNumber(), r.taxable.toFixed(2), r.cgst.toFixed(2)])).toEqual([
      [0, "390.00", "0.00"],
      [5, "456.00", "11.40"],
      [18, "1254.40", "112.90"],
      [40, "456.00", "91.20"],
    ]);
    expect(t.hsnSummary.map((h) => h.hsnCode)).toEqual(["1905", "2202", "2501", "3402"]);
    expect(t.hsnSummary.find((h) => h.hsnCode === "2202")?.uqc).toBe("BTL");
  });

  it("switches to IGST for an inter-state customer with the same grand total", () => {
    const t = calculateDocument({ lines, supplyType: "inter_state", chargeTax: true });
    // Each component is rounded on its own: IGST 18% of 1254.40 = 225.79, whereas
    // CGST 9% + SGST 9% = 112.90 + 112.90 = 225.80. Round-off absorbs the paisa.
    expect(t.igstTotal.toFixed(2)).toBe("430.99");
    expect(t.cgstTotal.toFixed(2)).toBe("0.00");
    expect(t.grandTotal.toFixed(2)).toBe("2987.00");
  });

  it("apportions an invoice-level discount across lines before tax", () => {
    const t = calculateDocument({
      lines: [
        { key: "a", qty: 1, rate: 300, tax: taxAt(5) },
        { key: "b", qty: 1, rate: 700, tax: taxAt(18) },
      ],
      supplyType: "intra_state",
      chargeTax: true,
      documentDiscount: { amount: 100 },
    });
    expect(t.lines.map((l) => l.documentDiscountShare.toFixed(2))).toEqual(["30.00", "70.00"]);
    expect(t.lines.map((l) => l.taxable.toFixed(2))).toEqual(["270.00", "630.00"]);
    expect(t.taxTotal.toFixed(2)).toBe("126.90");
    expect(t.grandTotal.toFixed(2)).toBe("1027.00");
    expect(t.roundOff.toFixed(2)).toBe("0.10");
  });

  it("adds taxable and non-taxable charges", () => {
    const t = calculateDocument({
      lines: [{ key: "a", qty: 1, rate: 1000, tax: taxAt(18) }],
      supplyType: "intra_state",
      chargeTax: true,
      charges: [
        { key: "freight", label: "Freight", amount: 50, tax: taxAt(18) },
        { key: "loading", label: "Loading", amount: 20 },
      ],
      roundOff: { mode: "none", step: 1 },
    });
    expect(t.chargesTotal.toFixed(2)).toBe("70.00");
    expect(t.taxableTotal.toFixed(2)).toBe("1050.00");
    expect(t.cgstTotal.toFixed(2)).toBe("94.50");
    expect(t.grandTotal.toFixed(2)).toBe("1259.00");
  });

  it("records excess payment as an advance", () => {
    const t = calculateDocument({
      lines: [{ key: "a", qty: 1, rate: 100, tax: taxAt(0) }],
      supplyType: "intra_state",
      chargeTax: true,
      amountPaid: 150,
    });
    expect(t.paymentStatus).toBe("paid");
    expect(t.balanceDue.toFixed(2)).toBe("0.00");
    expect(t.excessPaid.toFixed(2)).toBe("50.00");
  });

  it("lets the server detect totals tampered with or computed differently offline", () => {
    const t = calculateDocument({ lines, supplyType: "intra_state", chargeTax: true });
    expect(compareTotals(t, { grandTotal: "2987.00", taxTotal: "431.00" })).toEqual([]);
    expect(compareTotals(t, { grandTotal: "2900.00" })).toEqual([
      { field: "grandTotal", expected: "2987.00", received: "2900.00" },
    ]);
  });
});
