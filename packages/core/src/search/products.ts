/**
 * Product search ranking for the invoice screen.
 *
 * The whole active catalogue (thousands of products, ~1-2 MB) is cached on the
 * device, so search runs locally in a few milliseconds and keeps working
 * offline. Ranking combines text match quality with context:
 *   exact barcode / code  >  code prefix  >  name word prefix  >  substring,
 * boosted by how often THIS customer buys the product and demoted when out of stock.
 */
export interface SearchableProduct {
  id: string;
  name: string;
  code?: string | null;
  sku?: string | null;
  barcodes?: readonly string[];
  brand?: string | null;
  /** Local-language names and nicknames, e.g. ["नमक", "namak"]. */
  aliases?: readonly string[];
  active?: boolean;
  inStock?: boolean;
}

export interface SearchContext {
  /** productId -> share of this customer's invoices containing it (0..1). */
  customerAffinity?: ReadonlyMap<string, number>;
  /** productIds bought recently by this customer. */
  recentProductIds?: ReadonlySet<string>;
  limit?: number;
}

export type MatchField = "barcode" | "code" | "sku" | "name" | "alias" | "brand";

export interface SearchHit<T extends SearchableProduct> {
  product: T;
  score: number;
  matchedOn: MatchField;
}

/** Lower-case, turn punctuation into spaces, collapse whitespace. Devanagari marks are preserved. */
export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function scoreText(text: string, query: string, queryTokens: readonly string[]): number {
  const t = normalizeSearchText(text);
  if (!t) return 0;
  if (t === query) return 300;
  if (t.startsWith(query)) return 220;
  const words = t.split(" ");
  const tc = compact(t);
  let matched = 0;
  let prefixHits = 0;
  for (const token of queryTokens) {
    if (words.some((w) => w.startsWith(token))) {
      matched++;
      prefixHits++;
    } else if (t.includes(token)) {
      matched++;
    }
  }
  if (matched === queryTokens.length) return 120 + prefixHits * 20;
  // "parleg" should still find "Parle-G".
  if (tc.includes(compact(query))) return 90;
  return matched > 0 ? 20 * matched : 0;
}

export function searchProducts<T extends SearchableProduct>(
  rawQuery: string,
  products: readonly T[],
  ctx: SearchContext = {},
): SearchHit<T>[] {
  const query = normalizeSearchText(rawQuery);
  if (!query) return [];
  const tokens = query.split(" ");
  const upperRaw = rawQuery.trim().toUpperCase();
  const hits: SearchHit<T>[] = [];

  for (const p of products) {
    if (p.active === false) continue;
    let score = 0;
    let matchedOn: MatchField = "name";

    if (p.barcodes?.some((b) => b === rawQuery.trim())) {
      score = 1000;
      matchedOn = "barcode";
    } else if (p.code && p.code.toUpperCase() === upperRaw) {
      score = 900;
      matchedOn = "code";
    } else if (p.sku && p.sku.toUpperCase() === upperRaw) {
      score = 850;
      matchedOn = "sku";
    } else {
      const candidates: Array<[MatchField, number]> = [
        ["name", scoreText(p.name, query, tokens)],
        ["code", p.code && p.code.toUpperCase().startsWith(upperRaw) ? 400 : 0],
        ["sku", p.sku && p.sku.toUpperCase().startsWith(upperRaw) ? 350 : 0],
        ["alias", Math.max(0, ...(p.aliases ?? []).map((a) => scoreText(a, query, tokens) - 5))],
        ["brand", p.brand ? scoreText(p.brand, query, tokens) * 0.5 : 0],
      ];
      for (const [field, s] of candidates) {
        if (s > score) {
          score = s;
          matchedOn = field;
        }
      }
    }
    if (score <= 0) continue;

    const affinity = ctx.customerAffinity?.get(p.id) ?? 0;
    score += Math.round(affinity * 80);
    if (ctx.recentProductIds?.has(p.id)) score += 15;
    if (p.inStock === false) score -= 40;
    hits.push({ product: p, score, matchedOn });
  }

  hits.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
  return hits.slice(0, ctx.limit ?? 20);
}
