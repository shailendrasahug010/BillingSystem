import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE } from "../../data/db";
import { dec } from "@digitalbahi/core";
import { saleUnits, startUnit, unitByLetter, usualPick } from "./units";

const soap = { unit: "PCS", unitId: "u-pcs", packUnits: [{ unitId: "u-ctn", symbol: "CTN", factor: 144 }, { unitId: "u-box", symbol: "BOX", factor: 24 }] };
const tablets = { unit: "PCS", unitId: "u-pcs", packUnits: [{ unitId: "u-strip", symbol: "STRIP", factor: 10 }, { unitId: "u-box", symbol: "BOX", factor: 100 }] };
const oil = { unit: "BTL", unitId: "u-btl", packUnits: [{ unitId: "u-box", symbol: "BOX", factor: 12 }, { unitId: "u-bag", symbol: "BAG", factor: 48 }] };

describe("the units of a bill's line", () => {
  afterEach(() => {
    WORKSPACE.unitLetters = null;
    WORKSPACE.defaultUnit = null;
  });

  it("are the product's own unit, then its packs from the smallest, each with its symbol's first letter", () => {
    expect(saleUnits(soap)).toEqual([
      { unitId: null, symbol: "PCS", factor: 1, letter: "P" },
      { unitId: "u-box", symbol: "BOX", factor: 24, letter: "B" },
      { unitId: "u-ctn", symbol: "CTN", factor: 144, letter: "C" },
    ]);
    expect(saleUnits({ unit: "KG" })).toEqual([{ unitId: null, symbol: "KG", factor: 1, letter: "K" }]);
  });

  it("take the letters the business set", () => {
    WORKSPACE.unitLetters = { "u-ctn": "K", "u-pcs": "N" };
    expect(saleUnits(soap).map((u) => `${u.letter} ${u.symbol}`)).toEqual(["N PCS", "B BOX", "K CTN"]);
  });

  it("are picked by their letter in any case; one no unit has does nothing", () => {
    const units = saleUnits(soap);
    expect(unitByLetter(units, null, "b")?.unitId).toBe("u-box");
    expect(unitByLetter(units, "u-box", "C")?.unitId).toBe("u-ctn");
    // Back to the product's own unit.
    expect(unitByLetter(units, "u-ctn", "p")?.unitId).toBeNull();
    // Pressed again: stays.
    expect(unitByLetter(units, "u-box", "b")?.unitId).toBe("u-box");
    expect(unitByLetter(units, null, "s")).toBeUndefined();
  });

  it("sharing a letter take turns", () => {
    const units = saleUnits(oil);
    // BTL (own), BOX and BAG all start with B.
    expect(unitByLetter(units, null, "b")?.symbol).toBe("BOX");
    expect(unitByLetter(units, "u-box", "b")?.symbol).toBe("BAG");
    expect(unitByLetter(units, "u-bag", "b")?.symbol).toBe("BTL");
  });

  it("start new lines in strips when the product is sold by the strip, until the business chooses", () => {
    expect(startUnit(tablets)).toMatchObject({ unitId: "u-strip", factor: 10, letter: "S" });
    expect(startUnit(soap)).toBeNull();
    // Sold by the strip as its own unit: that is where it starts anyway.
    expect(startUnit({ unit: "STRIP", unitId: "u-strip" })).toBeNull();
    WORKSPACE.defaultUnit = "u-box";
    expect(startUnit(soap)).toMatchObject({ unitId: "u-box", factor: 24 });
    expect(startUnit(tablets)).toMatchObject({ unitId: "u-box", factor: 100 });
    WORKSPACE.defaultUnit = "own";
    expect(startUnit(tablets)).toBeNull();
  });
});

describe("the unit and count a shop usually takes", () => {
  const bought = (...qtys: number[]) => ({ orderCount: qtys.length, recentQtys: qtys.map((q) => dec(q)) });

  it("is the middle of its last bills, in the biggest pack that holds it whole", () => {
    expect(usualPick(soap, bought(120, 96, 120))).toEqual({ unitId: "u-box", qty: 5, symbol: "BOX", factor: 24 });
    expect(usualPick(soap, bought(288, 288))).toEqual({ unitId: "u-ctn", qty: 2, symbol: "CTN", factor: 144 });
    expect(usualPick(tablets, bought(20, 30, 20))).toEqual({ unitId: "u-strip", qty: 2, symbol: "STRIP", factor: 10 });
    expect(usualPick(oil, bought(5, 7))).toEqual({ unitId: null, qty: 6, symbol: "BTL", factor: 1 });
    expect(usualPick({ unit: "KG" }, bought(2.5, 2.5))).toEqual({ unitId: null, qty: 2.5, symbol: "KG", factor: 1 });
  });

  it("waits for two bills", () => {
    expect(usualPick(soap, bought(120))).toBeNull();
    expect(usualPick(soap, undefined)).toBeNull();
  });
});
