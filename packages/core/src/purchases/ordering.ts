import { dec, type Dec, type DecimalInput, roundRate, ZERO } from "../money/decimal.js";

/**
 * Buying side of stock: how much of a product to order from its supplier,
 * how far a purchase order line has come, and the cost goods received
 * before their bill come in at.
 */

export interface ReorderInput {
  /** Stock on hand, in the base unit (negative when sold ahead of stock). */
  onHand: DecimalInput;
  /** Base units still to come on open purchase orders. */
  onOrder: DecimalInput;
  /** Base units sold in the window, less those returned. */
  soldInWindow: DecimalInput;
  /** Days the sales are counted over. */
  windowDays: number;
  /** The product's minimum stock, when it has one (base unit). */
  minStock?: DecimalInput | null;
  /** The quantity it is usually ordered in, when set (base unit). */
  reorderQty?: DecimalInput | null;
  /** Base units in the pack it is bought in (a case of 24: 24); 1 when bought loose. */
  packFactor?: DecimalInput | null;
}

export interface ReorderOptions {
  /** Days the supplier takes to deliver. */
  leadDays: number;
  /** Days of sales the order should last once it arrives. */
  coverDays: number;
}

export type ReorderReason = "out" | "below_min" | "runs_out";

export interface ReorderAdvice {
  /** Average base units sold a day. */
  perDay: Dec;
  /** Days the stock on hand lasts at that pace (null when it does not sell). */
  daysLeft: Dec | null;
  /** Stock wanted: the sales of the lead and cover days, and at least the minimum stock. */
  target: Dec;
  /** What is missing from it after the stock on hand and on order (0 when nothing is). */
  shortBy: Dec;
  /** What to order, in base units: the shortfall, at least the usual reorder quantity, in whole packs. */
  suggestBase: Dec;
  /** The same in packs. */
  suggestPacks: Dec;
  /** Why it is suggested: none left, below the minimum, or it runs out before the next delivery lasts. */
  reason: ReorderReason | null;
}

/**
 * What to order of a product. The stock wanted is its sales over the lead
 * time and the days the order should last (at the window's pace), and never
 * less than its minimum stock; what is on hand and already on order counts
 * against it. Something that does not sell and has no minimum is not
 * suggested, even when none is left.
 */
export function reorderAdvice(input: ReorderInput, options: ReorderOptions): ReorderAdvice {
  const days = Math.max(1, Math.floor(input.windowDays));
  const sold = dec(input.soldInWindow);
  const perDay = sold.gt(0) ? sold.dividedBy(days) : ZERO;
  const onHand = dec(input.onHand);
  const onOrder = dec(input.onOrder).gt(0) ? dec(input.onOrder) : ZERO;
  const min = input.minStock === null || input.minStock === undefined ? null : dec(input.minStock);
  const horizon = Math.max(0, options.leadDays) + Math.max(0, options.coverDays);
  const need = perDay.times(horizon);
  const target = min && min.gt(need) ? min : need;
  const available = onHand.plus(onOrder);
  const shortBy = target.gt(available) ? target.minus(available) : ZERO;
  const daysLeft = perDay.gt(0) ? (onHand.gt(0) ? onHand.dividedBy(perDay) : ZERO) : null;
  const pack = input.packFactor && dec(input.packFactor).gt(0) ? dec(input.packFactor) : dec(1);

  let suggestBase = ZERO;
  if (shortBy.gt(0)) {
    const usual = input.reorderQty && dec(input.reorderQty).gt(0) ? dec(input.reorderQty) : ZERO;
    const want = usual.gt(shortBy) ? usual : shortBy;
    suggestBase = want.dividedBy(pack).ceil().times(pack);
  }
  let reason: ReorderReason | null = null;
  if (suggestBase.gt(0)) {
    if (onHand.lte(0)) reason = "out";
    else if (min && onHand.lte(min)) reason = "below_min";
    else reason = "runs_out";
  }
  return { perDay, daysLeft, target, shortBy, suggestBase, suggestPacks: suggestBase.dividedBy(pack), reason };
}

/** How far a purchase order line has come, in base units (bought and free together). */
export function orderLineProgress(line: { qty: DecimalInput; freeQty?: DecimalInput | null; conversionFactor: DecimalInput; receivedQty: DecimalInput }): { ordered: Dec; received: Dec; remaining: Dec } {
  const ordered = dec(line.qty).plus(dec(line.freeQty ?? 0)).times(dec(line.conversionFactor));
  const received = dec(line.receivedQty);
  const remaining = ordered.gt(received) ? ordered.minus(received) : ZERO;
  return { ordered, received, remaining };
}

/** A purchase order's status from its lines: received when nothing is left to come, partly received once something came. */
export function orderStatusFromLines(lines: ReadonlyArray<{ qty: DecimalInput; freeQty?: DecimalInput | null; conversionFactor: DecimalInput; receivedQty: DecimalInput }>): "open" | "partly_received" | "received" {
  const progress = lines.map((l) => orderLineProgress(l));
  if (progress.length && progress.every((p) => p.remaining.isZero())) return "received";
  return progress.some((p) => p.received.gt(0)) ? "partly_received" : "open";
}

/**
 * The cost per base unit goods received before their bill come in at: the
 * expected rate less its discount, spread over the free goods as well
 * (10 + 2 free at ₹120 a case of 12: ₹1,200 over 144 pieces).
 */
export function receivedUnitCost(line: { qty: DecimalInput; freeQty?: DecimalInput | null; conversionFactor: DecimalInput; rate: DecimalInput; discountPercent?: DecimalInput | null }): Dec {
  const qty = dec(line.qty);
  const units = qty.plus(dec(line.freeQty ?? 0)).times(dec(line.conversionFactor));
  if (units.lte(0)) return ZERO;
  const discount = dec(line.discountPercent ?? 0);
  const value = qty.times(dec(line.rate)).times(dec(100).minus(discount)).dividedBy(100);
  return roundRate(value.dividedBy(units));
}
