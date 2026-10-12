import { dec, type Dec, type DecimalInput, maxDec, pct, roundAmount, sum, ZERO } from "../money/decimal.js";

/**
 * Income tax collected at source (TCS) by the seller, added to the bill.
 * TCS on sale of goods in general (206C(1H)) was withdrawn from 1 April 2025;
 * what remains for a trader is TCS on specified goods: section 394(1) of the
 * Income-tax Act, 2025 (old 206C(1) and 206C(1F)). Papers and the quarterly
 * return still use the 1961 Act's numbers, so they are shown too.
 */

/** Goods a seller collects TCS on. */
export type TcsGoods = "liquor" | "tendu" | "timber_lease" | "timber" | "forest" | "scrap" | "minerals" | "motor_vehicle" | "luxury";
export const TCS_GOODS: readonly TcsGoods[] = ["liquor", "tendu", "timber_lease", "timber", "forest", "scrap", "minerals", "motor_vehicle", "luxury"];

/**
 * The 1961 Act's section of each, and the collection code the quarterly TCS
 * return (Form 27EQ) gives it (null where it has none of its own here).
 */
export const TCS_SECTION: Record<TcsGoods, { section: "206C(1)" | "206C(1F)"; code: string | null }> = {
  liquor: { section: "206C(1)", code: "6CA" },
  timber_lease: { section: "206C(1)", code: "6CB" },
  timber: { section: "206C(1)", code: "6CC" },
  forest: { section: "206C(1)", code: "6CD" },
  scrap: { section: "206C(1)", code: "6CE" },
  tendu: { section: "206C(1)", code: "6CI" },
  minerals: { section: "206C(1)", code: "6CJ" },
  motor_vehicle: { section: "206C(1F)", code: "6CL" },
  luxury: { section: "206C(1F)", code: null },
};

/** Percent with the buyer's PAN, tax year 2026-27: 2% on the specified goods, 1% on a motor vehicle or luxury goods over ₹10 lakh. */
export const TCS_RATES: Record<TcsGoods, number> = {
  liquor: 2,
  tendu: 2,
  timber_lease: 2,
  timber: 2,
  forest: 2,
  scrap: 2,
  minerals: 2,
  motor_vehicle: 1,
  luxury: 1,
};

/** Goods taxed only when one piece is worth more than the threshold (₹10 lakh): a motor vehicle, luxury goods. */
export const TCS_ABOVE_THRESHOLD: ReadonlySet<TcsGoods> = new Set<TcsGoods>(["motor_vehicle", "luxury"]);

export interface TcsRule {
  /** Percent by goods (with the buyer's PAN); goods left out take TCS_RATES'. */
  rates?: Partial<Record<TcsGoods, number>>;
  /** One piece's value (with GST) a motor vehicle or luxury goods must pass. */
  threshold?: DecimalInput;
}

export interface TcsBuyer {
  /** The buyer's PAN is known (entered, or inside their GSTIN). */
  hasPan: boolean;
  /** Gave a declaration that the goods are for making things (Form 27C), or is a government body: no TCS. */
  exempt: boolean;
}

export interface TcsLine {
  key: string;
  goods: TcsGoods | null | undefined;
  /** Pieces in the stock unit. */
  qtyBase: DecimalInput;
  /** The line's value with its GST and cess, after discounts. */
  total: DecimalInput;
}

export interface TcsPart {
  goods: TcsGoods;
  /** Percent applied. */
  rate: Dec;
  /** What it is on: the lines' value with GST. */
  base: Dec;
  /** The tax, to the rupee. */
  amount: Dec;
}

export interface TcsResult {
  parts: TcsPart[];
  amount: Dec;
}

/** Without the buyer's PAN: twice the rate, at least 5% (397(2), old 206CC). */
export function tcsNoPanRate(rate: DecimalInput): Dec {
  return maxDec(dec(rate).times(2), 5);
}

/** The percent a sale of these goods takes from this buyer under the rule. */
export function tcsRateFor(goods: TcsGoods, hasPan: boolean, rule: TcsRule = {}): Dec {
  const rate = dec(rule.rates?.[goods] ?? TCS_RATES[goods]);
  return hasPan ? rate : tcsNoPanRate(rate);
}

/**
 * TCS on a bill: per kind of goods, the rate on the value (with GST) of its
 * lines, rounded to the rupee. A motor vehicle or luxury goods count only
 * when one piece is worth more than the threshold. Nothing for an exempt
 * buyer, or a bill with none of the goods; null then.
 */
export function saleTcs(lines: readonly TcsLine[], buyer: TcsBuyer, rule: TcsRule = {}): TcsResult | null {
  if (buyer.exempt) return null;
  const threshold = dec(rule.threshold ?? 1_000_000);
  const bases = new Map<TcsGoods, Dec>();
  for (const line of lines) {
    if (!line.goods) continue;
    const total = roundAmount(line.total);
    if (total.lte(0)) continue;
    if (TCS_ABOVE_THRESHOLD.has(line.goods)) {
      const pieces = dec(line.qtyBase);
      const each = pieces.gt(0) ? total.dividedBy(pieces) : total;
      if (each.lte(threshold)) continue;
    }
    bases.set(line.goods, (bases.get(line.goods) ?? ZERO).plus(total));
  }
  const parts: TcsPart[] = TCS_GOODS.filter((g) => bases.has(g)).map((goods) => {
    const base = bases.get(goods)!;
    const rate = tcsRateFor(goods, buyer.hasPan, rule);
    return { goods, rate, base, amount: pct(base, rate).toDecimalPlaces(0) };
  });
  const amount = sum(parts.map((p) => p.amount));
  return parts.length && amount.gt(0) ? { parts: parts.filter((p) => p.amount.gt(0)), amount } : null;
}

/** "TCS 206C(1) @ 2%" for a bill's line of it. */
export function tcsLabel(part: { goods: TcsGoods; rate: DecimalInput }): string {
  return `TCS ${TCS_SECTION[part.goods].section} @ ${dec(part.rate).toString()}%`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** TCS collected in a month ("2026-09") is paid to the government by the 7th of the next month (March's by 7 April). */
export function tcsDueDate(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-07` : `${y}-${pad(m + 1)}-07`;
}
