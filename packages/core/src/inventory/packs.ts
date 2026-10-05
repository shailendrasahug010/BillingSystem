import { dec, type DecimalInput } from "../money/decimal.js";

/** A pack a product is bought or sold in: its symbol and how many base units it holds. */
export interface PackUnit {
  symbol: string;
  factor: number;
}

export interface PackPart {
  symbol: string;
  qty: number;
}

/**
 * Stock in the base unit as whole cases and loose pieces: 190 PCS with a box
 * of 24 is 7 BOX and 22 PCS. Only the largest pack counts (a strip of 6 inside
 * the box is not used), as distributors count cases and loose. Below one pack,
 * for a fractional or negative quantity, or with no pack, it is the base unit alone.
 */
export function splitIntoPacks(qty: DecimalInput, baseSymbol: string, packs: readonly PackUnit[] = []): PackPart[] {
  const q = dec(qty);
  const pack = [...packs].filter((p) => Number.isInteger(p.factor) && p.factor > 1).sort((a, b) => b.factor - a.factor)[0];
  if (!pack || q.lt(pack.factor) || !q.isInteger()) return [{ symbol: baseSymbol, qty: q.toNumber() }];
  const whole = q.dividedToIntegerBy(pack.factor);
  const loose = q.minus(whole.times(pack.factor));
  return [{ symbol: pack.symbol, qty: whole.toNumber() }, ...(loose.isZero() ? [] : [{ symbol: baseSymbol, qty: loose.toNumber() }])];
}

/** "7 BOX 22 PCS" (numbers formatted by the caller's locale). */
export function packsText(parts: readonly PackPart[], format: (n: number) => string = String): string {
  return parts.map((p) => `${format(p.qty)} ${p.symbol}`.trim()).join(" ");
}

export interface CountLine {
  productId: string;
  /** What the books say is there, in the base unit. */
  system: DecimalInput;
  /** What was counted on the shelf; empty when the product was not counted. */
  counted: string | null;
}

/**
 * The stock count as adjustment lines: counted minus the books for every
 * product that was counted and differs. Products left blank are not touched.
 */
export function countDifferences(lines: readonly CountLine[]): Array<{ productId: string; qtyChange: string }> {
  const out: Array<{ productId: string; qtyChange: string }> = [];
  for (const l of lines) {
    if (l.counted === null || l.counted.trim() === "") continue;
    const change = dec(l.counted.trim()).minus(dec(l.system));
    if (!change.isZero()) out.push({ productId: l.productId, qtyChange: change.toDecimalPlaces(3).toString() });
  }
  return out;
}
