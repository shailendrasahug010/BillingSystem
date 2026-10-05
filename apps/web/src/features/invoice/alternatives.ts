import type { Product } from "../../data/types";

type Candidate = Pick<Product, "id" | "brandId" | "category" | "rate" | "stock" | "active">;

/**
 * An in-stock product to offer for one that is out: of the same category,
 * with enough stock for `need` of its own unit, priced within half again of
 * it; the same brand first, then the nearest price. None when nothing fits.
 */
export function inStockAlternative<T extends Candidate>(product: Candidate, need: number, catalogue: Iterable<T>, skip: ReadonlySet<string> = new Set()): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  for (const p of catalogue) {
    if (p.id === product.id || skip.has(p.id) || p.active === false || p.category !== product.category || p.stock < Math.max(need, 1)) continue;
    const gap = product.rate > 0 ? Math.abs(p.rate - product.rate) / product.rate : 0;
    if (gap > 0.5) continue;
    const score = gap + (p.brandId === product.brandId ? 0 : 1);
    if (score < bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}
