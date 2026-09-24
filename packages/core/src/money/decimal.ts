import Decimal from "decimal.js";

/**
 * All financial arithmetic goes through this module. JavaScript numbers are
 * never used for money or quantities because 0.1 + 0.2 !== 0.3.
 *
 * Storage precision (mirrors the database column types):
 *   - amounts   NUMERIC(15,2)  -> 2 decimals (rupees.paise)
 *   - rates     NUMERIC(15,4)  -> 4 decimals (unit price can be fractional paise)
 *   - quantity  NUMERIC(15,3)  -> 3 decimals (kg / litre with grams / ml)
 *   - percent   NUMERIC(7,4)   -> tax and discount percentages
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Dec = InstanceType<typeof D>;

/** Anything that can be turned into a decimal. Strings are preferred at IO boundaries. */
export type DecimalInput = Dec | string | number;

export const AMOUNT_SCALE = 2;
export const RATE_SCALE = 4;
export const QTY_SCALE = 3;

export function dec(value: DecimalInput | null | undefined): Dec {
  if (value === null || value === undefined || value === "") return new D(0);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError(`Cannot convert non-finite number ${value} to decimal`);
  }
  return new D(value);
}

export const ZERO = dec(0);
export const HUNDRED = dec(100);

/** Round half-up to paise. This is the rounding used for every stored amount. */
export function roundAmount(value: DecimalInput): Dec {
  return dec(value).toDecimalPlaces(AMOUNT_SCALE, D.ROUND_HALF_UP);
}

export function roundRate(value: DecimalInput): Dec {
  return dec(value).toDecimalPlaces(RATE_SCALE, D.ROUND_HALF_UP);
}

export function roundQty(value: DecimalInput): Dec {
  return dec(value).toDecimalPlaces(QTY_SCALE, D.ROUND_HALF_UP);
}

export function sum(values: Iterable<DecimalInput>): Dec {
  let total = dec(0);
  for (const v of values) total = total.plus(dec(v));
  return total;
}

/** Percentage of a base amount, e.g. pct(1000, 18) = 180. Not rounded. */
export function pct(base: DecimalInput, percent: DecimalInput): Dec {
  return dec(base).times(dec(percent)).dividedBy(HUNDRED);
}

/** Serialise an amount for storage / API responses: always a fixed 2-decimal string. */
export function toAmountString(value: DecimalInput): string {
  return roundAmount(value).toFixed(AMOUNT_SCALE);
}

export function toRateString(value: DecimalInput): string {
  return roundRate(value).toFixed(RATE_SCALE);
}

export function toQtyString(value: DecimalInput): string {
  return roundQty(value).toFixed(QTY_SCALE);
}

export function isNegative(value: DecimalInput): boolean {
  return dec(value).isNegative() && !dec(value).isZero();
}

export function maxDec(a: DecimalInput, b: DecimalInput): Dec {
  return D.max(dec(a), dec(b));
}

export function minDec(a: DecimalInput, b: DecimalInput): Dec {
  return D.min(dec(a), dec(b));
}

/**
 * Split `total` across `weights` so that the parts sum exactly to `total`
 * (largest-remainder method at paise precision). Used to apportion an
 * invoice-level discount or freight across lines without losing a paisa.
 */
export function apportion(total: DecimalInput, weights: DecimalInput[]): Dec[] {
  const totalDec = roundAmount(total);
  if (totalDec.isNegative()) return apportion(totalDec.negated(), weights).map((p) => p.negated());
  const weightDecs = weights.map((w) => dec(w));
  const weightSum = sum(weightDecs);
  if (weights.length === 0) return [];
  if (weightSum.isZero()) {
    // Nothing to weight by: put everything on the first part.
    return weightDecs.map((_, i) => (i === 0 ? totalDec : dec(0)));
  }
  const totalPaise = totalDec.times(100);
  const raw = weightDecs.map((w) => totalPaise.times(w).dividedBy(weightSum));
  const floored = raw.map((r) => r.toDecimalPlaces(0, D.ROUND_FLOOR));
  let remainder = totalPaise.minus(sum(floored)).toNumber();
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(floored[i]!) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  const result = [...floored];
  for (let k = 0; remainder > 0 && order.length > 0; k = (k + 1) % order.length, remainder--) {
    const idx = order[k]!.i;
    result[idx] = result[idx]!.plus(1);
  }
  return result.map((p) => p.dividedBy(100));
}

export type RoundOffMode = "none" | "nearest" | "up" | "down";

export interface RoundOffConfig {
  mode: RoundOffMode;
  /** Rounding step in rupees, e.g. 1, 0.5, 0.1. */
  step: DecimalInput;
}

export const DEFAULT_ROUND_OFF: RoundOffConfig = { mode: "nearest", step: 1 };

/** Invoice round-off. Returns the rounded total and the (signed) round-off adjustment. */
export function applyRoundOff(
  total: DecimalInput,
  config: RoundOffConfig = DEFAULT_ROUND_OFF,
): { rounded: Dec; roundOff: Dec } {
  const t = roundAmount(total);
  const step = dec(config.step);
  if (config.mode === "none" || step.lte(0)) return { rounded: t, roundOff: dec(0) };
  const rounding =
    config.mode === "up" ? D.ROUND_CEIL : config.mode === "down" ? D.ROUND_FLOOR : D.ROUND_HALF_UP;
  const rounded = t.dividedBy(step).toDecimalPlaces(0, rounding).times(step);
  return { rounded: roundAmount(rounded), roundOff: roundAmount(rounded.minus(t)) };
}

export { D as DecimalClass };
