/**
 * "Frequently bought together" — pairwise association rules mined from invoice
 * baskets across ALL customers (a nightly job writes the result to
 * `product_associations`). For a pair A -> B:
 *
 *   support    = baskets with A and B / all baskets
 *   confidence = baskets with A and B / baskets with A      (P(B | A))
 *   lift       = confidence / (baskets with B / all baskets) (> 1 means real affinity,
 *                not just "B is popular")
 *
 * Only pairs above minimum pair count, confidence and lift are kept so the
 * table stays small (a few rows per product) and suggestions stay meaningful.
 */
export interface Basket {
  id: string;
  productIds: readonly string[];
}

export interface AssociationRule {
  productId: string;
  relatedProductId: string;
  pairCount: number;
  support: number;
  confidence: number;
  lift: number;
}

export interface MiningOptions {
  minPairCount?: number;
  minConfidence?: number;
  minLift?: number;
  /** Keep at most this many related products per product (highest lift x confidence first). */
  maxPerProduct?: number;
  /** Ignore very large baskets (stock-transfer-like invoices) that create noise. */
  maxBasketSize?: number;
}

export function mineAssociations(baskets: readonly Basket[], options: MiningOptions = {}): AssociationRule[] {
  const minPairCount = options.minPairCount ?? 5;
  const minConfidence = options.minConfidence ?? 0.25;
  const minLift = options.minLift ?? 1.3;
  const maxPerProduct = options.maxPerProduct ?? 10;
  const maxBasketSize = options.maxBasketSize ?? 60;

  const itemCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  let n = 0;
  for (const basket of baskets) {
    const items = [...new Set(basket.productIds)];
    if (items.length === 0 || items.length > maxBasketSize) continue;
    n++;
    for (const item of items) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const key = `${items[i]}\u0000${items[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  if (n === 0) return [];

  const byProduct = new Map<string, AssociationRule[]>();
  for (const [key, count] of pairCounts) {
    if (count < minPairCount) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const countA = itemCounts.get(a)!;
    const countB = itemCounts.get(b)!;
    const confidence = count / countA;
    const lift = confidence / (countB / n);
    if (confidence < minConfidence || lift < minLift) continue;
    const list = byProduct.get(a) ?? [];
    list.push({ productId: a, relatedProductId: b, pairCount: count, support: count / n, confidence, lift });
    byProduct.set(a, list);
  }

  const rules: AssociationRule[] = [];
  for (const list of byProduct.values()) {
    list.sort((x, y) => y.lift * y.confidence - x.lift * x.confidence || y.pairCount - x.pairCount);
    rules.push(...list.slice(0, maxPerProduct));
  }
  return rules.sort((x, y) => x.productId.localeCompare(y.productId) || y.confidence - x.confidence);
}
