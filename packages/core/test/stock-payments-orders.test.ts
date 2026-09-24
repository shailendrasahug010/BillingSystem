import { describe, expect, it } from "vitest";
import {
  ageDocuments,
  allocateFefo,
  allocatePayment,
  allowedTransitions,
  applyMovement,
  assertTransition,
  deriveFulfilmentStatus,
  evaluateCredit,
  expiryState,
  InsufficientStockError,
  InvalidTransitionError,
  movingAverageCost,
  paymentBehaviour,
  stockLevel,
  type OpenDocument,
} from "../src/index.js";

describe("stock", () => {
  it("enforces the configurable negative-stock policy", () => {
    expect(applyMovement(5, { type: "sale", qty: 3 }, "block").balanceAfter.toNumber()).toBe(2);
    expect(() => applyMovement(5, { type: "sale", qty: 8 }, "block", "Parle-G")).toThrow(InsufficientStockError);
    const warned = applyMovement(5, { type: "sale", qty: 8 }, "warn");
    expect(warned.balanceAfter.toNumber()).toBe(-3);
    expect(warned.warning?.shortBy.toNumber()).toBe(3);
    expect(applyMovement(5, { type: "sale", qty: 8 }, "allow").warning).toBeNull();
    expect(applyMovement(5, { type: "purchase", qty: 10 }, "block").qtyIn.toNumber()).toBe(10);
  });

  it("allocates batches first-expiry-first-out and skips expired stock", () => {
    const batches = [
      { batchId: "b3", batchNumber: "B3", qty: 50, expiryDate: null },
      { batchId: "b1", batchNumber: "B1", qty: 10, expiryDate: "2026-10-31" },
      { batchId: "b0", batchNumber: "B0", qty: 99, expiryDate: "2026-09-01" }, // expired
      { batchId: "b2", batchNumber: "B2", qty: 20, expiryDate: "2026-12-31" },
    ];
    const { allocations, shortfall } = allocateFefo(batches, 25, { asOf: "2026-09-24" });
    expect(allocations.map((a) => [a.batchId, a.qty.toNumber()])).toEqual([
      ["b1", 10],
      ["b2", 15],
    ]);
    expect(shortfall.toNumber()).toBe(0);
    expect(allocateFefo(batches, 100, { asOf: "2026-09-24" }).shortfall.toNumber()).toBe(20);
  });

  it("updates weighted moving-average cost on purchase", () => {
    expect(movingAverageCost(100, 10, 50, 13).toFixed(4)).toBe("11.0000");
    expect(movingAverageCost(0, 10, 50, 13).toFixed(4)).toBe("13.0000");
    expect(movingAverageCost(-5, 10, 50, 13).toFixed(4)).toBe("13.0000");
  });

  it("classifies stock and expiry", () => {
    expect(stockLevel(0, 10)).toBe("out_of_stock");
    expect(stockLevel(8, 10)).toBe("low");
    expect(stockLevel(80, 10)).toBe("ok");
    expect(expiryState("2026-09-20", "2026-09-24")).toBe("expired");
    expect(expiryState("2026-10-10", "2026-09-24")).toBe("expiring_soon");
    expect(expiryState("2027-10-10", "2026-09-24")).toBe("ok");
  });
});

const open: OpenDocument[] = [
  { id: "i3", number: "INV-3", date: "2026-09-10", dueDate: "2026-09-25", balance: "5000" },
  { id: "i1", number: "INV-1", date: "2026-06-01", dueDate: "2026-06-16", balance: "1200" },
  { id: "i2", number: "INV-2", date: "2026-08-01", dueDate: "2026-08-16", balance: "3000" },
];

describe("payments", () => {
  it("allocates to the oldest due invoices first and keeps the rest as advance", () => {
    const r = allocatePayment("4500", open);
    expect(r.allocations.map((a) => [a.documentNumber, a.amount.toFixed(2)])).toEqual([
      ["INV-1", "1200.00"],
      ["INV-2", "3000.00"],
      ["INV-3", "300.00"],
    ]);
    expect(r.unallocated.toFixed(2)).toBe("0.00");
    expect(allocatePayment("10000", open).unallocated.toFixed(2)).toBe("800.00");
  });

  it("validates manual allocations", () => {
    const r = allocatePayment("2000", open, [{ documentId: "i3", amount: "1500" }]);
    expect(r.unallocated.toFixed(2)).toBe("500.00");
    expect(() => allocatePayment("2000", open, [{ documentId: "i1", amount: "1300" }])).toThrow(/exceeds balance/);
    expect(() => allocatePayment("0", open)).toThrow();
  });

  it("ages receivables into configurable buckets", () => {
    const r = ageDocuments(open, { asOf: "2026-09-24" });
    expect(r.buckets.map((b) => [b.label, b.amount.toFixed(2)])).toEqual([
      ["0-30", "5000.00"],
      ["31-60", "3000.00"],
      ["61-90", "0.00"],
      ["90+", "1200.00"],
    ]);
    const byDue = ageDocuments(open, { asOf: "2026-09-24", basis: "due_date" });
    expect(byDue.notDue.toFixed(2)).toBe("5000.00");
    expect(byDue.total.toFixed(2)).toBe("9200.00");
  });

  it("evaluates credit limit and overdue policy", () => {
    const warn = evaluateCredit({ creditLimit: 10000, outstanding: 9200, newAmount: 2000, openDocuments: open, asOf: "2026-09-24" });
    expect(warn.level).toBe("warn");
    expect(warn.reasons.map((r) => r.code)).toEqual(["credit_limit_exceeded", "overdue_invoices"]);
    expect(warn.availableCredit?.toFixed(2)).toBe("800.00");

    const block = evaluateCredit({
      creditLimit: 10000,
      outstanding: 9200,
      newAmount: 2000,
      asOf: "2026-09-24",
      policy: { onLimitExceeded: "block", onOverdue: "allow", overdueGraceDays: 0 },
    });
    expect(block.level).toBe("block");

    expect(evaluateCredit({ creditLimit: null, outstanding: 0, newAmount: 500, asOf: "2026-09-24" }).level).toBe("ok");
  });

  it("rates payment behaviour", () => {
    const docs = [
      { date: "2026-06-01", dueDate: "2026-06-16", settledOn: "2026-06-10" },
      { date: "2026-07-01", dueDate: "2026-07-16", settledOn: "2026-07-15" },
      { date: "2026-08-01", dueDate: "2026-08-16", settledOn: "2026-08-30" },
      { date: "2026-09-01", dueDate: "2026-09-16", settledOn: "2026-09-12" },
    ];
    const r = paymentBehaviour(docs, "2026-09-24");
    expect(r.avgDaysToPay).toBe(15.8); // (9 + 14 + 29 + 11) / 4
    expect(r.onTimeRatio).toBe(0.75);
    expect(r.rating).toBe("good");
    expect(paymentBehaviour(docs.slice(0, 1), "2026-09-24").rating).toBe("new");
  });
});

describe("order workflow", () => {
  it("follows the default workflow", () => {
    expect(allowedTransitions("draft")).toEqual(["pending", "cancelled"]);
    expect(allowedTransitions("confirmed")).toEqual(["packing", "packed", "cancelled"]);
    expect(allowedTransitions("packed")).toEqual(["packing", "dispatched", "cancelled"]);
    expect(allowedTransitions("dispatched")).toEqual(["delivered"]);
    expect(() => assertTransition("delivered", "cancelled")).toThrow(InvalidTransitionError);
  });

  it("lets a counter-sale business skip confirmation, packing and dispatch", () => {
    const simple = { requireConfirmation: false, usePacking: false, useDispatch: false };
    expect(allowedTransitions("draft", simple)).toEqual(["confirmed", "cancelled"]);
    expect(allowedTransitions("confirmed", simple)).toEqual(["delivered", "cancelled"]);
  });

  it("derives status from partial packing / dispatch / delivery", () => {
    const partial = [
      { orderedQty: 10, packedQty: 10 },
      { orderedQty: 5, packedQty: 2 },
    ];
    expect(deriveFulfilmentStatus("confirmed", partial)).toBe("packing");
    expect(deriveFulfilmentStatus("packing", [{ orderedQty: 10, packedQty: 10 }])).toBe("packed");
    expect(deriveFulfilmentStatus("packed", [{ orderedQty: 10, packedQty: 10, dispatchedQty: 10 }])).toBe("dispatched");
    expect(
      deriveFulfilmentStatus("dispatched", [{ orderedQty: 10, packedQty: 10, dispatchedQty: 10, deliveredQty: 10 }]),
    ).toBe("delivered");
    // A cancelled quantity no longer needs packing.
    expect(deriveFulfilmentStatus("packing", [{ orderedQty: 10, packedQty: 8, cancelledQty: 2 }])).toBe("packed");
  });
});
