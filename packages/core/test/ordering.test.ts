import { describe, expect, it } from "vitest";
import { orderLineProgress, orderStatusFromLines, receivedUnitCost, reorderAdvice } from "../src/index.js";

const plan = { leadDays: 7, coverDays: 15 };

describe("reorder advice", () => {
  it("orders the sales of the lead and cover days less what is on hand and on order, in whole cases", () => {
    // 60 sold in 30 days: 2 a day; 22 days wanted: 44; 10 on hand, 6 on order: 28 short; cases of 12: 36.
    const a = reorderAdvice({ onHand: 10, onOrder: 6, soldInWindow: 60, windowDays: 30, packFactor: 12 }, plan);
    expect(a.perDay.toNumber()).toBe(2);
    expect(a.daysLeft?.toNumber()).toBe(5);
    expect(a.target.toNumber()).toBe(44);
    expect(a.shortBy.toNumber()).toBe(28);
    expect(a.suggestBase.toNumber()).toBe(36);
    expect(a.suggestPacks.toNumber()).toBe(3);
    expect(a.reason).toBe("runs_out");
  });

  it("keeps at least the minimum stock and orders at least the usual quantity", () => {
    // Sells 1 a day (22 wanted), minimum 40: 40 wanted, 15 on hand: 25 short; usually ordered 48 at a time.
    const a = reorderAdvice({ onHand: 15, onOrder: 0, soldInWindow: 30, windowDays: 30, minStock: 40, reorderQty: 48 }, plan);
    expect(a.target.toNumber()).toBe(40);
    expect(a.suggestBase.toNumber()).toBe(48);
    expect(a.reason).toBe("below_min");
  });

  it("says when none is left, counting stock sold ahead as owed", () => {
    const a = reorderAdvice({ onHand: -4, onOrder: 0, soldInWindow: 30, windowDays: 30 }, plan);
    expect(a.shortBy.toNumber()).toBe(26);
    expect(a.daysLeft?.toNumber()).toBe(0);
    expect(a.reason).toBe("out");
  });

  it("suggests nothing when enough is on hand or on order, or when it does not sell and has no minimum", () => {
    expect(reorderAdvice({ onHand: 30, onOrder: 20, soldInWindow: 60, windowDays: 30 }, plan).suggestBase.toNumber()).toBe(0);
    const still = reorderAdvice({ onHand: 0, onOrder: 0, soldInWindow: 0, windowDays: 30 }, plan);
    expect(still.suggestBase.toNumber()).toBe(0);
    expect(still.reason).toBeNull();
    expect(still.daysLeft).toBeNull();
    // A minimum alone still asks for stock.
    expect(reorderAdvice({ onHand: 2, onOrder: 0, soldInWindow: 0, windowDays: 30, minStock: 10 }, plan).suggestBase.toNumber()).toBe(8);
  });

  it("rounds a loose product up to whole units and ignores returns that outweigh sales", () => {
    expect(reorderAdvice({ onHand: 0, onOrder: 0, soldInWindow: 10, windowDays: 30 }, { leadDays: 3, coverDays: 4 }).suggestBase.toNumber()).toBe(3);
    expect(reorderAdvice({ onHand: 5, onOrder: 0, soldInWindow: -6, windowDays: 30 }, plan).perDay.toNumber()).toBe(0);
  });
});

describe("purchase order progress", () => {
  it("counts bought and free goods in base units, and nothing below zero left", () => {
    const p = orderLineProgress({ qty: 10, freeQty: 1, conversionFactor: 12, receivedQty: 60 });
    expect([p.ordered.toNumber(), p.received.toNumber(), p.remaining.toNumber()]).toEqual([132, 60, 72]);
    expect(orderLineProgress({ qty: 2, conversionFactor: 1, receivedQty: 5 }).remaining.toNumber()).toBe(0);
  });

  it("is open, partly received or received from its lines", () => {
    const line = (receivedQty: number) => ({ qty: 4, freeQty: 0, conversionFactor: 6, receivedQty });
    expect(orderStatusFromLines([line(0), line(0)])).toBe("open");
    expect(orderStatusFromLines([line(24), line(0)])).toBe("partly_received");
    expect(orderStatusFromLines([line(24), line(30)])).toBe("received");
  });
});

describe("cost of goods received before their bill", () => {
  it("is the rate less its discount, spread over the free goods too", () => {
    // 10 cases + 2 free of 12 at ₹120 a case, 5% off: ₹1,140 over 144 pieces.
    expect(receivedUnitCost({ qty: 10, freeQty: 2, conversionFactor: 12, rate: 120, discountPercent: 5 }).toFixed(4)).toBe("7.9167");
    expect(receivedUnitCost({ qty: 3, conversionFactor: 1, rate: "45.5" }).toFixed(2)).toBe("45.50");
  });
});
