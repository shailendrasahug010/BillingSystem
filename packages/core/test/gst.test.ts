import { describe, expect, it } from "vitest";
import {
  calculateTaxLine,
  dec,
  determineSupplyType,
  documentKindFor,
  findOverlappingRules,
  resolveTax,
  stateTaxComponent,
  taxAt,
  taxComponentLabels,
  TaxRuleNotFoundError,
  type TaxCategory,
} from "../src/index.js";

// Illustrative categories. Real rates are data maintained by the business.
const biscuits: TaxCategory = {
  id: "cat-biscuits",
  name: "Biscuits",
  kind: "taxable",
  rules: [
    { id: "r-old", effectiveFrom: "2017-07-01", effectiveTo: "2025-09-21", gstRate: 18 },
    { id: "r-new", effectiveFrom: "2025-09-22", gstRate: 5 },
  ],
};

const apparel: TaxCategory = {
  id: "cat-apparel",
  name: "Apparel",
  kind: "taxable",
  rules: [
    { id: "a-low", effectiveFrom: "2025-09-22", gstRate: 5, condition: { unitValueLte: 2500 } },
    { id: "a-high", effectiveFrom: "2025-09-22", gstRate: 18, condition: { unitValueGt: 2500 } },
  ],
};

describe("tax rate resolution", () => {
  it("uses the rate in force on the document date", () => {
    expect(resolveTax(biscuits, { date: "2025-09-21" }).gstRate.toNumber()).toBe(18);
    expect(resolveTax(biscuits, { date: "2025-09-22" }).gstRate.toNumber()).toBe(5);
    expect(resolveTax(biscuits, { date: "2026-09-24" }).ruleId).toBe("r-new");
  });

  it("supports value-conditional slabs", () => {
    expect(resolveTax(apparel, { date: "2026-01-01", unitValue: 999 }).gstRate.toNumber()).toBe(5);
    expect(resolveTax(apparel, { date: "2026-01-01", unitValue: 2500 }).gstRate.toNumber()).toBe(5);
    expect(resolveTax(apparel, { date: "2026-01-01", unitValue: 2501 }).gstRate.toNumber()).toBe(18);
    // Tax-inclusive price 2,625 = 2,500 + 5% -> still the lower slab.
    expect(
      resolveTax(apparel, { date: "2026-01-01", unitValue: 2625, unitValueIncludesTax: true }).gstRate.toNumber(),
    ).toBe(5);
  });

  it("returns zero tax for exempt / nil-rated categories", () => {
    const salt: TaxCategory = { id: "c-salt", name: "Salt", kind: "nil_rated", rules: [] };
    const r = resolveTax(salt, { date: "2026-01-01" });
    expect(r.kind).toBe("nil_rated");
    expect(r.gstRate.toNumber()).toBe(0);
  });

  it("fails loudly with a translatable error when no rule exists", () => {
    expect(() => resolveTax(biscuits, { date: "2017-06-30" })).toThrow(TaxRuleNotFoundError);
    try {
      resolveTax(biscuits, { date: "2017-06-30" });
    } catch (e) {
      expect((e as TaxRuleNotFoundError).code).toBe("TAX_RULE_NOT_FOUND");
      expect((e as TaxRuleNotFoundError).params).toEqual({ category: "Biscuits", date: "2017-06-30" });
    }
  });

  it("detects overlapping rules before they are saved", () => {
    expect(findOverlappingRules(biscuits.rules)).toEqual([]);
    expect(
      findOverlappingRules([
        { id: "x", effectiveFrom: "2025-01-01", gstRate: 12 },
        { id: "y", effectiveFrom: "2025-06-01", gstRate: 5 },
      ]),
    ).toEqual([{ ruleIdA: "x", ruleIdB: "y" }]);
  });
});

describe("supply type and components", () => {
  it("is intra-state when supplier and place of supply match", () => {
    expect(determineSupplyType({ supplierStateCode: "23", placeOfSupplyStateCode: "23" })).toBe("intra_state");
    expect(determineSupplyType({ supplierStateCode: "23", placeOfSupplyStateCode: "27" })).toBe("inter_state");
  });

  it("treats SEZ and exports as inter-state", () => {
    expect(
      determineSupplyType({ supplierStateCode: "27", placeOfSupplyStateCode: "27", recipientRegistration: "sez" }),
    ).toBe("inter_state");
    expect(determineSupplyType({ supplierStateCode: "27", placeOfSupplyStateCode: "96", isExport: true })).toBe(
      "inter_state",
    );
  });

  it("uses UTGST for union territories without a legislature", () => {
    expect(stateTaxComponent("04")).toBe("UTGST"); // Chandigarh
    expect(stateTaxComponent("38")).toBe("UTGST"); // Ladakh
    expect(stateTaxComponent("07")).toBe("SGST"); // Delhi
    expect(taxComponentLabels("23").state).toBe("SGST");
  });

  it("issues a bill of supply for composition / unregistered businesses", () => {
    expect(documentKindFor("regular")).toBe("tax_invoice");
    expect(documentKindFor("composition")).toBe("bill_of_supply");
  });
});

describe("line tax calculation", () => {
  const intra = { supplyType: "intra_state" as const, chargeTax: true };
  const inter = { supplyType: "inter_state" as const, chargeTax: true };

  it("splits GST into equal CGST and SGST for intra-state", () => {
    const r = calculateTaxLine({ qty: 10, rate: "45.50", tax: taxAt(18) }, intra);
    expect(r.gross.toFixed(2)).toBe("455.00");
    expect(r.taxable.toFixed(2)).toBe("455.00");
    expect(r.cgstRate.toNumber()).toBe(9);
    expect(r.cgst.toFixed(2)).toBe("40.95");
    expect(r.sgst.toFixed(2)).toBe("40.95");
    expect(r.igst.toFixed(2)).toBe("0.00");
    expect(r.total.toFixed(2)).toBe("536.90");
  });

  it("charges IGST for inter-state", () => {
    const r = calculateTaxLine({ qty: 10, rate: "45.50", tax: taxAt(18) }, inter);
    expect(r.igst.toFixed(2)).toBe("81.90");
    expect(r.cgst.toFixed(2)).toBe("0.00");
    expect(r.total.toFixed(2)).toBe("536.90");
  });

  it("applies percent then flat discount before tax", () => {
    const r = calculateTaxLine(
      { qty: 24, rate: 10, discountPercent: 5, discountAmount: 2, tax: taxAt(5) },
      intra,
    );
    expect(r.gross.toFixed(2)).toBe("240.00");
    expect(r.discount.toFixed(2)).toBe("14.00");
    expect(r.taxable.toFixed(2)).toBe("226.00");
    expect(r.cgst.toFixed(2)).toBe("5.65");
    expect(r.total.toFixed(2)).toBe("237.30");
  });

  it("back-calculates taxable value from tax-inclusive (MRP) prices", () => {
    const r = calculateTaxLine({ qty: 1, rate: 118, rateIncludesTax: true, tax: taxAt(18) }, intra);
    expect(r.taxable.toFixed(2)).toBe("100.00");
    expect(r.cgst.toFixed(2)).toBe("9.00");
    expect(r.total.toFixed(2)).toBe("118.00");

    const odd = calculateTaxLine({ qty: 3, rate: 10, rateIncludesTax: true, tax: taxAt(5) }, intra);
    expect(odd.taxable.toFixed(2)).toBe("28.57");
    expect(odd.total.toFixed(2)).toBe("29.99"); // 1 paisa absorbed by invoice round-off
  });

  it("computes ad-valorem and per-unit cess", () => {
    const tax = { ...taxAt(28, 12), cessPerUnit: dec("0.50") };
    const r = calculateTaxLine({ qty: 2, rate: 100, conversionFactor: 10, tax }, inter);
    expect(r.qtyBase.toNumber()).toBe(20);
    expect(r.igst.toFixed(2)).toBe("56.00");
    expect(r.cess.toFixed(2)).toBe("34.00"); // 12% of 200 + 20 x 0.50
  });

  it("charges no tax on a bill of supply", () => {
    const r = calculateTaxLine({ qty: 1, rate: 100, tax: taxAt(18) }, { supplyType: "intra_state", chargeTax: false });
    expect(r.taxTotal.toFixed(2)).toBe("0.00");
    expect(r.total.toFixed(2)).toBe("100.00");
  });

  it("rejects invalid input with specific codes", () => {
    expect(() => calculateTaxLine({ qty: 0, rate: 1, tax: taxAt(5) }, intra)).toThrow(/greater than zero/);
    expect(() => calculateTaxLine({ qty: 1, rate: 10, discountAmount: 11, tax: taxAt(5) }, intra)).toThrow(
      /more than the line amount/,
    );
    expect(() => calculateTaxLine({ qty: 1, rate: 10, discountPercent: 101, tax: taxAt(5) }, intra)).toThrow();
  });
});
