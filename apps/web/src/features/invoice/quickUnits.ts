import { WORKSPACE } from "../../data/db";
import type { Product } from "../../data/types";

/**
 * The unit buttons on a bill's lines: three units with a letter each (B for
 * BOX, C for CTN, S for STRIP unless the business set others under Settings).
 * A line of a product sold in one of them changes to it with one click on
 * the letter, or with the letter typed after the quantity.
 */
export interface QuickUnit {
  alias: string;
  /** null when the business has no such unit (a demo): the symbol is matched instead. */
  unitId: string | null;
  symbol: string;
}

export const DEFAULT_QUICK_UNITS: ReadonlyArray<readonly [symbol: string, alias: string]> = [
  ["BOX", "B"],
  ["CTN", "C"],
  ["STRIP", "S"],
];

/** The three buttons (null for one left out). */
export function quickUnits(): Array<QuickUnit | null> {
  const symbolOf = (unitId: string) => WORKSPACE.units.get(unitId) ?? "";
  if (WORKSPACE.quickUnits) return WORKSPACE.quickUnits.map((q) => (q ? { alias: q.alias, unitId: q.unitId, symbol: symbolOf(q.unitId) } : null));
  const idOf = (symbol: string) => [...WORKSPACE.units].find(([, s]) => s === symbol)?.[0] ?? null;
  return DEFAULT_QUICK_UNITS.map(([symbol, alias]) => ({ alias, symbol, unitId: idOf(symbol) }));
}

/**
 * What a button does on a line of this product: the unit to change to (null:
 * the product's own unit) and how many of that unit it holds; undefined when
 * the product is not sold in it.
 */
export function quickTarget(product: Pick<Product, "unitId" | "unit" | "packUnits">, q: QuickUnit): { unitId: string | null; factor: number } | undefined {
  if (q.unitId ? q.unitId === product.unitId : q.symbol === product.unit) return { unitId: null, factor: 1 };
  const pack = product.packUnits?.find((u) => (q.unitId ? u.unitId === q.unitId : u.symbol === q.symbol));
  return pack ? { unitId: pack.unitId, factor: pack.factor } : undefined;
}

/** The button a typed letter stands for (any case), if there is one. */
export const quickByLetter = (slots: Array<QuickUnit | null>, letter: string) => slots.find((q) => q !== null && q.alias === letter.toUpperCase()) ?? undefined;
