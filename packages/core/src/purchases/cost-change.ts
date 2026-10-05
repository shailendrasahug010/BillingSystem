import { dec, type DecimalInput } from "../money/decimal.js";

export interface CostLine {
  productId: string;
  /** What the product cost before this bill, per base unit (its last purchase price). */
  oldCost: DecimalInput;
  /** What it costs on this bill, per base unit, before GST. */
  newCost: DecimalInput;
  /** Its selling rate now, per base unit. */
  rate: DecimalInput;
}

export interface CostRise {
  productId: string;
  oldCost: string;
  newCost: string;
  rate: string;
  /** Rise in percent, one decimal. */
  risePercent: string;
  /** Margin on the selling rate at the old and the new cost, in percent (null without a rate). */
  marginBefore: string | null;
  marginNow: string | null;
  /** A selling rate that keeps the margin the product had, rounded up to the next 10 paise. */
  suggestedRate: string;
}

const pct1 = (v: ReturnType<typeof dec>) => v.toDecimalPlaces(1).toFixed(1);

/**
 * The products a purchase bill makes dearer than before: cost up by at least
 * `minPercent` (default 0.5 %, so a paisa of rounding is not a "rise") over a
 * known earlier cost. For each, the margin then and now, and the selling rate
 * that keeps the old margin (the rate scaled by the cost rise).
 */
export function costRises(lines: readonly CostLine[], minPercent: DecimalInput = "0.5"): CostRise[] {
  const out: CostRise[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const before = dec(l.oldCost);
    const now = dec(l.newCost);
    if (seen.has(l.productId) || before.lte(0) || now.lte(before)) continue;
    const rise = now.minus(before).div(before).times(100);
    if (rise.lt(minPercent)) continue;
    seen.add(l.productId);
    const rate = dec(l.rate);
    const margin = (cost: ReturnType<typeof dec>) => (rate.gt(0) ? pct1(rate.minus(cost).div(rate).times(100)) : null);
    // Same margin on the new cost: rate × new / old, up to the next 10 paise.
    const suggested = rate.gt(0) ? rate.times(now).div(before).times(10).ceil().div(10) : now;
    out.push({
      productId: l.productId,
      oldCost: before.toFixed(2),
      newCost: now.toFixed(2),
      rate: rate.toFixed(2),
      risePercent: pct1(rise),
      marginBefore: margin(before),
      marginNow: margin(now),
      suggestedRate: suggested.toFixed(2),
    });
  }
  return out;
}
