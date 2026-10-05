import { describe, expect, it } from "vitest";
import { parseSpokenItem, unitForWord } from "./spoken";

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
});
