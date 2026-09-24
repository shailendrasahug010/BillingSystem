import { describe, expect, it } from "vitest";
import { apportion, applyRoundOff, dec, roundAmount, sum, toAmountString } from "../src/index.js";

describe("money", () => {
  it("avoids floating point errors", () => {
    expect(sum(["0.1", "0.2"]).toString()).toBe("0.3");
    expect(toAmountString(dec("0.1").plus("0.2"))).toBe("0.30");
  });

  it("rounds half-up to paise", () => {
    expect(roundAmount("2.345").toFixed(2)).toBe("2.35");
    expect(roundAmount("2.344").toFixed(2)).toBe("2.34");
    expect(roundAmount("-2.345").toFixed(2)).toBe("-2.35");
  });

  it("apportions without losing a paisa", () => {
    const parts = apportion("100.00", [1, 1, 1]);
    expect(parts.map((p) => p.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
    expect(sum(parts).toFixed(2)).toBe("100.00");

    const uneven = apportion("10.00", ["333.33", "166.67", "500"]);
    expect(sum(uneven).toFixed(2)).toBe("10.00");
    expect(uneven.map((p) => p.toFixed(2))).toEqual(["3.33", "1.67", "5.00"]);
  });

  it("apportions negative totals and zero weights", () => {
    expect(sum(apportion("-7.01", [1, 2, 3])).toFixed(2)).toBe("-7.01");
    expect(apportion("5", [0, 0]).map((p) => p.toFixed(2))).toEqual(["5.00", "0.00"]);
  });

  it("applies configurable round-off", () => {
    const nearest = applyRoundOff("1234.49");
    expect(nearest.rounded.toFixed(2)).toBe("1234.00");
    expect(nearest.roundOff.toFixed(2)).toBe("-0.49");

    const up = applyRoundOff("1234.50");
    expect(up.rounded.toFixed(2)).toBe("1235.00");
    expect(up.roundOff.toFixed(2)).toBe("0.50");

    expect(applyRoundOff("1234.49", { mode: "none", step: 1 }).roundOff.toFixed(2)).toBe("0.00");
    expect(applyRoundOff("1234.20", { mode: "up", step: 1 }).rounded.toFixed(2)).toBe("1235.00");
    expect(applyRoundOff("1234.80", { mode: "down", step: 1 }).rounded.toFixed(2)).toBe("1234.00");
    expect(applyRoundOff("1234.30", { mode: "nearest", step: "0.5" }).rounded.toFixed(2)).toBe("1234.50");
  });
});
