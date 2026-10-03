import { WORKSPACE } from "../../data/db";
import type { Product } from "../../data/types";

/**
 * The units a line of a bill can be in, each with a letter: typed after the
 * quantity (2 then B: 2 boxes) or on the line's unit list, it changes the line
 * to that unit. A unit's letter is the one the business set under Settings,
 * else its symbol's first (BOX: B, STRIP: S, PCS: P).
 */
export interface SaleUnit {
  /** null: the product's own (stock) unit. */
  unitId: string | null;
  symbol: string;
  /** How many of the product's own unit it holds (1 for that unit). */
  factor: number;
  letter: string;
}

/** The unit new lines start in until the business sets one: strips, for products sold by the strip. */
export const DEFAULT_START_SYMBOL = "STRIP";

type Sellable = Pick<Product, "unit" | "unitId" | "packUnits">;

/** A unit's letter: the business's own for it, else its symbol's first. */
export function unitLetter(unitId: string | null | undefined, symbol: string): string {
  return (unitId ? WORKSPACE.unitLetters?.[unitId] : undefined) ?? (Array.from(symbol)[0] ?? "?").toUpperCase();
}

/** The units a line of the product can be in: its own first, then its packs from the smallest. */
export function saleUnits(product: Sellable): SaleUnit[] {
  const packs = (product.packUnits ?? [])
    .filter((u) => u.unitId !== product.unitId)
    .sort((a, b) => a.factor - b.factor)
    .map((u) => ({ unitId: u.unitId, symbol: u.symbol, factor: u.factor, letter: unitLetter(u.unitId, u.symbol) }));
  return [{ unitId: null, symbol: product.unit, factor: 1, letter: unitLetter(product.unitId, product.unit) }, ...packs];
}

/**
 * The unit a typed letter (any case) picks on a line now in `current`: the
 * first of the product's units with that letter, or, when the line is in one
 * of them already, the next (units sharing a letter take turns). Undefined
 * when none has it.
 */
export function unitByLetter(units: SaleUnit[], current: string | null, letter: string): SaleUnit | undefined {
  const matches = units.filter((u) => u.letter === letter.toUpperCase());
  if (matches.length === 0) return undefined;
  return matches[(matches.findIndex((u) => u.unitId === current) + 1) % matches.length];
}

/**
 * The pack a new line of the product starts in (Settings: "New lines start
 * in", strips until set) when the product is sold in it; null: its own unit.
 */
export function startUnit(product: Sellable): SaleUnit | null {
  const chosen = WORKSPACE.defaultUnit;
  if (chosen === "own") return null;
  const is = (unitId: string | null | undefined, symbol: string) => (chosen ? unitId === chosen : symbol === DEFAULT_START_SYMBOL);
  if (is(product.unitId, product.unit)) return null;
  return saleUnits(product).find((u) => u.unitId !== null && is(u.unitId, u.symbol)) ?? null;
}
