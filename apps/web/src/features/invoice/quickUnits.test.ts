import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE } from "../../data/db";
import { quickByLetter, quickTarget, quickUnits } from "./quickUnits";

const soap = { unit: "PCS", unitId: "u-pcs", packUnits: [{ unitId: "u-box", symbol: "BOX", factor: 24 }, { unitId: "u-ctn", symbol: "CTN", factor: 144 }] };
const tablets = { unit: "PCS", unitId: "u-pcs", packUnits: [{ unitId: "u-strip", symbol: "STRIP", factor: 10 }] };

describe("the unit buttons on a bill's lines", () => {
  afterEach(() => {
    WORKSPACE.units.clear();
    WORKSPACE.quickUnits = null;
  });

  it("are BOX, CTN and STRIP as B, C and S until the business sets them", () => {
    for (const [id, symbol] of [["u-pcs", "PCS"], ["u-box", "BOX"], ["u-ctn", "CTN"], ["u-strip", "STRIP"], ["u-doz", "DOZ"]]) WORKSPACE.units.set(id!, symbol!);
    expect(quickUnits()).toEqual([
      { alias: "B", symbol: "BOX", unitId: "u-box" },
      { alias: "C", symbol: "CTN", unitId: "u-ctn" },
      { alias: "S", symbol: "STRIP", unitId: "u-strip" },
    ]);
    WORKSPACE.quickUnits = [{ unitId: "u-doz", alias: "D" }, null, { unitId: "u-pcs", alias: "P" }];
    expect(quickUnits()).toEqual([{ alias: "D", symbol: "DOZ", unitId: "u-doz" }, null, { alias: "P", symbol: "PCS", unitId: "u-pcs" }]);
  });

  it("change a line to a pack the product is sold in, or back to its own unit; the others do nothing for it", () => {
    for (const [id, symbol] of [["u-pcs", "PCS"], ["u-box", "BOX"], ["u-ctn", "CTN"], ["u-strip", "STRIP"]]) WORKSPACE.units.set(id!, symbol!);
    const [b, c, s] = quickUnits();
    expect(quickTarget(soap, b!)).toEqual({ unitId: "u-box", factor: 24 });
    expect(quickTarget(soap, c!)).toEqual({ unitId: "u-ctn", factor: 144 });
    expect(quickTarget(soap, s!)).toBeUndefined();
    expect(quickTarget(tablets, s!)).toEqual({ unitId: "u-strip", factor: 10 });
    // A button for the product's own unit takes the line back to it.
    expect(quickTarget(soap, { alias: "P", symbol: "PCS", unitId: "u-pcs" })).toEqual({ unitId: null, factor: 1 });
  });

  it("match by symbol where the business has no such unit (the demo)", () => {
    const [b] = quickUnits();
    expect(b).toEqual({ alias: "B", symbol: "BOX", unitId: null });
    expect(quickTarget({ unit: "PCS", packUnits: [{ unitId: "x", symbol: "BOX", factor: 12 }] }, b!)).toEqual({ unitId: "x", factor: 12 });
  });

  it("are found by their letter in any case", () => {
    const slots = quickUnits();
    expect(quickByLetter(slots, "c")?.symbol).toBe("CTN");
    expect(quickByLetter(slots, "S")?.symbol).toBe("STRIP");
    expect(quickByLetter(slots, "x")).toBeUndefined();
  });
});
