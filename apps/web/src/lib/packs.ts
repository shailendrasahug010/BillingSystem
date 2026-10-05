import { packsText, splitIntoPacks } from "@digitalbahi/core";
import type { Product } from "../data/types";

/**
 * Stock as cases and loose ("7 BOX 22 PCS") for a product bought or sold in
 * packs, or null when the plain quantity says it all (no pack, less than one
 * pack, a fraction or below zero).
 */
export function stockInPacks(qty: number | string, product: Pick<Product, "unit" | "packUnits"> | undefined, format: (n: number) => string): string | null {
  if (!product?.packUnits?.length) return null;
  const parts = splitIntoPacks(qty, product.unit, product.packUnits);
  return parts.length === 1 && parts[0]!.symbol === product.unit ? null : packsText(parts, format);
}
