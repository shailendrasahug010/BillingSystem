import { dec, type Dec, type DecimalInput, minDec, roundRate, ZERO } from "../money/decimal.js";
import { DomainError } from "../errors.js";
import { daysBetween } from "../dates.js";

/**
 * Stock rules. The stock ledger is append-only: every change to stock is a
 * movement row with a type, a reference document and a running balance.
 * `stock_balances` is a cache of the ledger kept in the same DB transaction.
 */
export const STOCK_MOVEMENT_TYPES = {
  opening: "in",
  purchase: "in",
  purchase_return: "out",
  sale: "out",
  sale_return: "in",
  adjustment_in: "in",
  adjustment_out: "out",
  transfer_in: "in",
  transfer_out: "out",
  damaged: "out",
  expired: "out",
  free_in: "in",
  free_out: "out",
  consumption: "out",
} as const;

export type StockMovementType = keyof typeof STOCK_MOVEMENT_TYPES;
export type StockDirection = (typeof STOCK_MOVEMENT_TYPES)[StockMovementType];

export function directionOf(type: StockMovementType): StockDirection {
  return STOCK_MOVEMENT_TYPES[type];
}

/** What to do when a sale would take stock below zero. Configurable per business (and per product). */
export type NegativeStockPolicy = "allow" | "warn" | "block";

export interface StockCheck {
  level: "ok" | "warn" | "block";
  available: Dec;
  requested: Dec;
  shortBy: Dec;
}

export class InsufficientStockError extends DomainError {
  constructor(productName: string, available: Dec, requested: Dec) {
    super("INSUFFICIENT_STOCK", `Only ${available.toString()} of ${productName} in stock`, {
      product: productName,
      available: available.toString(),
      requested: requested.toString(),
    });
  }
}

export function checkStock(available: DecimalInput, requested: DecimalInput, policy: NegativeStockPolicy): StockCheck {
  const a = dec(available);
  const r = dec(requested);
  const shortBy = r.gt(a) ? r.minus(a) : ZERO;
  if (shortBy.isZero() || policy === "allow") return { level: "ok", available: a, requested: r, shortBy };
  return { level: policy === "block" ? "block" : "warn", available: a, requested: r, shortBy };
}

export interface LedgerMovement {
  type: StockMovementType;
  qty: DecimalInput;
}

/** Apply one movement to a running balance, enforcing the negative-stock policy. */
export function applyMovement(
  balance: DecimalInput,
  movement: LedgerMovement,
  policy: NegativeStockPolicy,
  productName = "product",
): { qtyIn: Dec; qtyOut: Dec; balanceAfter: Dec; warning: StockCheck | null } {
  const qty = dec(movement.qty);
  if (qty.lte(0)) throw new DomainError("QTY_NOT_POSITIVE", "Stock movement quantity must be positive");
  const current = dec(balance);
  if (directionOf(movement.type) === "in") {
    return { qtyIn: qty, qtyOut: ZERO, balanceAfter: current.plus(qty), warning: null };
  }
  const check = checkStock(current, qty, policy);
  if (check.level === "block") throw new InsufficientStockError(productName, current, qty);
  return { qtyIn: ZERO, qtyOut: qty, balanceAfter: current.minus(qty), warning: check.level === "warn" ? check : null };
}

export function toBaseQty(qty: DecimalInput, conversionFactor: DecimalInput): Dec {
  return dec(qty).times(dec(conversionFactor));
}

/**
 * Weighted moving-average cost after a receipt. If stock on hand is zero or
 * negative the incoming cost simply becomes the new cost.
 */
export function movingAverageCost(
  onHandQty: DecimalInput,
  currentAvgCost: DecimalInput,
  receivedQty: DecimalInput,
  receivedUnitCost: DecimalInput,
): Dec {
  const onHand = dec(onHandQty);
  const received = dec(receivedQty);
  if (received.lte(0)) return roundRate(currentAvgCost);
  if (onHand.lte(0)) return roundRate(receivedUnitCost);
  const value = onHand.times(dec(currentAvgCost)).plus(received.times(dec(receivedUnitCost)));
  return roundRate(value.dividedBy(onHand.plus(received)));
}

export type StockLevel = "out_of_stock" | "low" | "ok";

export function stockLevel(qty: DecimalInput, minStock: DecimalInput | null | undefined): StockLevel {
  const q = dec(qty);
  if (q.lte(0)) return "out_of_stock";
  if (minStock !== null && minStock !== undefined && q.lte(dec(minStock))) return "low";
  return "ok";
}

export type ExpiryState = "expired" | "expiring_soon" | "ok" | "no_expiry";

export function expiryState(expiryDate: string | null | undefined, asOf: string, warnDays = 30): ExpiryState {
  if (!expiryDate) return "no_expiry";
  const days = daysBetween(asOf, expiryDate);
  if (days < 0) return "expired";
  if (days <= warnDays) return "expiring_soon";
  return "ok";
}

export interface BatchStock {
  batchId: string;
  batchNumber: string;
  qty: DecimalInput;
  expiryDate?: string | null;
}

export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  qty: Dec;
}

/**
 * First-Expiry-First-Out batch picking for sales and packing. Expired batches
 * are skipped unless explicitly allowed; batches without expiry go last.
 */
export function allocateFefo(
  batches: readonly BatchStock[],
  requested: DecimalInput,
  opts: { asOf: string; allowExpired?: boolean },
): { allocations: BatchAllocation[]; shortfall: Dec } {
  let remaining = dec(requested);
  const usable = batches
    .filter((b) => dec(b.qty).gt(0))
    .filter((b) => opts.allowExpired || expiryState(b.expiryDate, opts.asOf) !== "expired")
    .sort((a, b) => {
      const ae = a.expiryDate ?? "9999-12-31";
      const be = b.expiryDate ?? "9999-12-31";
      return ae.localeCompare(be) || a.batchNumber.localeCompare(b.batchNumber);
    });
  const allocations: BatchAllocation[] = [];
  for (const batch of usable) {
    if (remaining.lte(0)) break;
    const take = minDec(batch.qty, remaining);
    allocations.push({ batchId: batch.batchId, batchNumber: batch.batchNumber, qty: take });
    remaining = remaining.minus(take);
  }
  return { allocations, shortfall: remaining.gt(0) ? remaining : ZERO };
}
