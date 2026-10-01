import { addDays, daysBetween } from "../dates.js";
import { dec, type DecimalInput } from "../money/decimal.js";

/**
 * Business intelligence (Phase 5.5): the arithmetic behind the Insights
 * screen. The API gathers the figures (sales, cost, stock values, balances);
 * these turn them into the measures a distributor reads: change against an
 * earlier period, ABC classes, inventory turnover, days to collect.
 */

/** What a period is compared with: the period just before it, or the same dates a year earlier. */
export type CompareBasis = "previous" | "last_year";

/** Shifts a date by whole years; 29 February becomes 28 February in a year without it. */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const year = y + years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The period to compare with: "previous" is as many days ending the day
 * before `from` (April against March has 30 days against 30: 2 to 31 March);
 * "last_year" is the same calendar dates a year earlier.
 */
export function comparisonPeriod(from: string, to: string, basis: CompareBasis): { from: string; to: string } {
  if (basis === "last_year") return { from: addYears(from, -1), to: addYears(to, -1) };
  const days = daysBetween(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/** Change from `previous` to `current` in percent (one decimal); null when there was nothing before. */
export function changePercent(current: DecimalInput, previous: DecimalInput): string | null {
  const before = dec(previous);
  if (before.isZero()) return null;
  return dec(current).minus(before).times(100).dividedBy(before.abs()).toFixed(1);
}

/** `part` as a percent of `whole` (one decimal); null when the whole is zero or less. */
export function sharePercent(part: DecimalInput, whole: DecimalInput): string | null {
  const w = dec(whole);
  if (w.lte(0)) return null;
  return dec(part).times(100).dividedBy(w).toFixed(1);
}

export type AbcClass = "A" | "B" | "C";

export interface AbcRow {
  /** Share of the total, percent with one decimal. */
  share: string;
  /** Share of the total of this row and all larger ones. */
  cumulative: string;
  /** A: the largest rows making up the first 80%; B: the next 15%; C: the rest (and anything zero or below). */
  abc: AbcClass;
}

/**
 * ABC (Pareto) classes by value: rows sorted largest first; a row is A while
 * the share of the rows before it is under 80% (so the row that crosses 80% is
 * still A), B under 95%, C after that. Rows of zero or less are C.
 */
export function abcClasses<T>(rows: readonly T[], value: (row: T) => DecimalInput, limits: { a: number; b: number } = { a: 80, b: 95 }): Array<T & AbcRow> {
  const sorted = [...rows].sort((x, y) => dec(value(y)).comparedTo(dec(value(x))));
  const total = sorted.reduce((s, r) => (dec(value(r)).gt(0) ? s.plus(value(r)) : s), dec(0));
  let before = dec(0);
  return sorted.map((row) => {
    const v = dec(value(row));
    const positive = v.gt(0) && total.gt(0);
    const beforePct = positive ? before.times(100).dividedBy(total) : dec(100);
    if (positive) before = before.plus(v);
    const abc: AbcClass = !positive ? "C" : beforePct.lt(limits.a) ? "A" : beforePct.lt(limits.b) ? "B" : "C";
    return {
      ...row,
      share: positive ? v.times(100).dividedBy(total).toFixed(1) : "0.0",
      cumulative: total.gt(0) ? before.times(100).dividedBy(total).toFixed(1) : "0.0",
      abc,
    };
  });
}

/**
 * Inventory turnover for a period: cost of goods sold over the average of
 * the opening and closing stock value, and the days that stock lasts at the
 * period's pace. Null when there is no stock or nothing was sold.
 */
export function inventoryTurnover(cogs: DecimalInput, openingValue: DecimalInput, closingValue: DecimalInput, days: number) {
  const average = dec(openingValue).plus(closingValue).dividedBy(2);
  const cost = dec(cogs);
  const turnover = average.gt(0) && cost.gt(0) ? cost.dividedBy(average) : null;
  return {
    averageInventory: average.toFixed(2),
    turnover: turnover ? turnover.toFixed(2) : null,
    daysOfInventory: turnover ? dec(days).dividedBy(turnover).toFixed(0) : null,
  };
}

/** Days sales outstanding: what customers owe at the end, in days of the period's billing (with GST). */
export function daysSalesOutstanding(receivables: DecimalInput, billing: DecimalInput, days: number): string | null {
  const perDay = dec(billing).dividedBy(days);
  if (perDay.lte(0)) return null;
  return dec(receivables).dividedBy(perDay).toFixed(0);
}
