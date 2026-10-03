import type { BillFileLine } from "@digitalbahi/core";
import { describe, expect, it } from "vitest";
import type { Product } from "../../data/types";
import { lineFromItem, sameUnit, unitFor, unitNamed } from "./billImport";

const surf = {
  id: "p-surf",
  name: "Surf Excel 1 kg",
  unit: "PCS",
  unitId: "u-pcs",
  packUnits: [{ unitId: "u-case", symbol: "CASE", factor: 12 }],
  purchasePrice: 115,
  gstRate: 18,
  trackBatches: false,
  trackExpiry: false,
} as unknown as Product;

const line = (patch: Partial<BillFileLine> = {}): BillFileLine => ({
  row: 4,
  itemName: "SURF EXCEL EASY WASH 1KG",
  itemCode: "HU-1102",
  barcode: null,
  hsnCode: "3402",
  unit: null,
  qty: "2",
  freeQty: null,
  rate: "1380",
  discountPercent: "2.5",
  gstRate: "18",
  batchNumber: "B1",
  expiryDate: "2027-08-31",
  mfgDate: null,
  mrp: "140",
  ...patch,
});

describe("bill import lines", () => {
  it("treats the usual unit words as the same unit", () => {
    expect(sameUnit("Nos", "PCS")).toBe(true);
    expect(sameUnit("cs", "CASE")).toBe(true);
    expect(sameUnit("BOX", "CASE")).toBe(false);
    // "Piece" is PCS even where NOS comes first in the list; "Nos" is still NOS.
    const list = [{ symbol: "BAG" }, { symbol: "NOS" }, { symbol: "PCS" }, { symbol: "CTN" }];
    expect(["Piece", "Nos", "Bag", "Carton", "Strip"].map((w) => unitNamed(list, w)?.symbol)).toEqual(["PCS", "NOS", "BAG", "CTN", undefined]);
  });

  it("picks the remembered unit, else the unit on the bill, else the pack nearest the rate", () => {
    expect(unitFor(surf, { unitId: "u-case", file: line({ unit: "PCS" }) })).toBe("u-case");
    expect(unitFor(surf, { unitId: null, file: line({ unit: "nos", rate: "115" }) })).toBe("u-pcs");
    // 1380 is about a case of 12 at 115.
    expect(unitFor(surf, { unitId: null, file: line() })).toBe("u-case");
    expect(unitFor(surf, { unitId: null, file: line({ rate: "118" }) })).toBe("u-pcs");
    expect(unitFor(surf, { unitId: null, file: line({ rate: "400" }) })).toBe("u-pcs");
  });

  it("builds the entry line: GST as the bill charged it, batch only for batch products, supplier item kept", () => {
    expect(lineFromItem({ unitId: null, file: line() }, surf)).toEqual({
      productId: "p-surf",
      unitId: "u-case",
      qty: "2",
      freeQty: "",
      rate: "1380",
      discountPercent: "2.5",
      gstRate: "18",
      batchNumber: "",
      expiryDate: "",
      mfgDate: "",
      mrp: "140",
      supplierItem: { code: "HU-1102", name: "SURF EXCEL EASY WASH 1KG" },
      fileRow: 4,
    });
    const batchy = { ...surf, trackBatches: true } as Product;
    expect(lineFromItem({ unitId: null, file: line({ gstRate: "12", rate: null, unit: "PCS" }) }, batchy)).toMatchObject({ gstRate: "12", rate: "115", batchNumber: "B1", expiryDate: "2027-08-31" });
  });
});
