import { describe, expect, it } from "vitest";
import { parseSpokenItem, parseTypedItem, unitForWord } from "./spoken";

describe("spoken items", () => {
  it("takes the quantity and unit from the end or the start", () => {
    expect(parseSpokenItem("Parle G 10 box")).toEqual({ name: "Parle G", qty: 10, unit: "BOX" });
    expect(parseSpokenItem("Lux soap das peti")).toEqual({ name: "Lux soap", qty: 10, unit: "BOX" });
    expect(parseSpokenItem("२ डिब्बा सरसों तेल")).toEqual({ name: "सरसों तेल", qty: 2, unit: "BOX" });
    expect(parseSpokenItem("Dolo 650 5 strips")).toEqual({ name: "Dolo 650", qty: 5, unit: "STRIP" });
    expect(parseSpokenItem("Surf excel 3")).toEqual({ name: "Surf excel", qty: 3, unit: null });
  });

  it("leaves a name alone when nothing else was said", () => {
    expect(parseSpokenItem("Maggi")).toEqual({ name: "Maggi", qty: null, unit: null });
    expect(parseSpokenItem("Dolo 650")).toEqual({ name: "Dolo", qty: 650, unit: null });
  });

  it("finds the product's unit for a word", () => {
    const units = [{ symbol: "PCS" }, { symbol: "BOX" }, { symbol: "LTR" }];
    expect(unitForWord(units, "BOX")).toEqual({ symbol: "BOX" });
    expect(unitForWord(units, "KG")).toBeUndefined();
    expect(unitForWord(units, null)).toBeUndefined();
  });

  it("reads the quantity and unit typed with a name", () => {
    expect(parseTypedItem("parle 10b")).toEqual({ name: "parle", qty: 10, unit: null, letter: "B" });
    expect(parseTypedItem("parle 10 box")).toEqual({ name: "parle", qty: 10, unit: "BOX", letter: null });
    expect(parseTypedItem("parle 10 b")).toEqual({ name: "parle", qty: 10, unit: null, letter: "B" });
    expect(parseTypedItem("10b parle")).toEqual({ name: "parle", qty: 10, unit: null, letter: "B" });
    expect(parseTypedItem("10 b parle g")).toEqual({ name: "parle g", qty: 10, unit: null, letter: "B" });
    expect(parseTypedItem("3 surf excel")).toEqual({ name: "surf excel", qty: 3, unit: null, letter: null });
    expect(parseTypedItem("surf 2.5")).toEqual({ name: "surf", qty: 2.5, unit: null, letter: null });
  });

  it("leaves typed names alone", () => {
    expect(parseTypedItem("parle g")).toEqual({ name: "parle g", qty: null, unit: null, letter: null });
    expect(parseTypedItem("parle g 10")).toEqual({ name: "parle g", qty: 10, unit: null, letter: null });
    expect(parseTypedItem("maggi")).toEqual({ name: "maggi", qty: null, unit: null, letter: null });
    expect(parseTypedItem("10")).toEqual({ name: "10", qty: null, unit: null, letter: null });
  });
});
