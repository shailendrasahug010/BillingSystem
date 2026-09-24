import { dec, type Dec, type DecimalInput } from "../money/decimal.js";
import { daysBetween } from "../dates.js";
import { stockLevel } from "../inventory/stock.js";
import type { AssociationRule } from "./associations.js";
import { suggestedQty, type CustomerProductStats, type CustomerSummary } from "./stats.js";

/**
 * Explainable, extensible product suggestions for the invoice / order screen.
 *
 * Rules the engine guarantees:
 *  - It only RECOMMENDS. Nothing is ever added to a document automatically.
 *  - Every suggestion carries machine-readable reasons (code + params) that the
 *    UI renders through i18n, e.g. "Usually every 7 days · last bought 6 days ago".
 *  - Products already in the cart and inactive products are never suggested.
 *  - Out-of-stock products are demoted and flagged, not hidden (the salesperson
 *    may still want to take the order).
 *
 * New suggestion types are added by writing a provider; the engine merges,
 * scores and ranks whatever the providers return.
 */
export type SuggestionGroup = "reorder" | "frequent" | "together" | "last_order";

export type ReasonCode =
  | "due"
  | "overdue"
  | "lapsed"
  | "frequent"
  | "together"
  | "last_order"
  | "out_of_stock"
  | "low_stock";

export interface SuggestionReason {
  code: ReasonCode;
  params: Record<string, string | number>;
}

export interface SuggestionProduct {
  id: string;
  name: string;
  active: boolean;
  stockQty: DecimalInput;
  minStock?: DecimalInput | null;
  /** Case / pack multiple used to round suggested quantities. */
  orderMultiple?: DecimalInput | null;
}

export interface SuggestionContext {
  asOf: string;
  summary: CustomerSummary;
  stats: ReadonlyMap<string, CustomerProductStats>;
  /** Store-wide "bought together" rules. */
  associations?: readonly AssociationRule[];
  /** Rules mined from this customer's own invoices (their personal combinations). */
  customerAssociations?: readonly AssociationRule[];
  cartProductIds: readonly string[];
  products: ReadonlyMap<string, SuggestionProduct>;
}

export interface Candidate {
  productId: string;
  group: SuggestionGroup;
  /** 0..1 strength within the provider. */
  score: number;
  reasons: SuggestionReason[];
  suggestedQty?: Dec;
}

export interface SuggestionProvider {
  id: SuggestionGroup;
  suggest(ctx: SuggestionContext): Candidate[];
}

export interface Suggestion {
  productId: string;
  productName: string;
  group: SuggestionGroup;
  score: number;
  suggestedQty: Dec | null;
  reasons: SuggestionReason[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type ReorderStatus = "upcoming" | "due" | "overdue" | "lapsed";

/** Where a regular purchase is in its cycle. ratio = days since last / typical interval. */
export function reorderStatus(daysSinceLast: number, intervalDays: number): { status: ReorderStatus | null; ratio: number } {
  const ratio = intervalDays > 0 ? daysSinceLast / intervalDays : 0;
  if (ratio < 0.75) return { status: "upcoming", ratio };
  if (ratio <= 1.15) return { status: "due", ratio };
  if (ratio <= 2.5) return { status: "overdue", ratio };
  if (ratio <= 6) return { status: "lapsed", ratio };
  return { status: null, ratio };
}

export const reorderProvider: SuggestionProvider = {
  id: "reorder",
  suggest(ctx) {
    const out: Candidate[] = [];
    for (const s of ctx.stats.values()) {
      if (s.typicalIntervalDays === null || s.typicalIntervalDays <= 0) continue;
      const { status, ratio } = reorderStatus(s.daysSinceLast, s.typicalIntervalDays);
      if (!status || status === "upcoming") continue;
      const params = { intervalDays: Math.round(s.typicalIntervalDays), daysSince: s.daysSinceLast };
      const score = status === "due" ? 0.8 + 0.2 * Math.min(1, ratio) : status === "overdue" ? 1 - (ratio - 1.15) * 0.15 : 0.35;
      const multiple = ctx.products.get(s.productId)?.orderMultiple ?? null;
      out.push({
        productId: s.productId,
        group: "reorder",
        score: round2(score),
        reasons: [{ code: status, params }],
        suggestedQty: suggestedQty(s, multiple),
      });
    }
    return out;
  },
};

export const frequentProvider: SuggestionProvider = {
  id: "frequent",
  suggest(ctx) {
    const total = ctx.summary.invoiceCount;
    if (total < 2) return [];
    const out: Candidate[] = [];
    for (const s of ctx.stats.values()) {
      if (s.orderCount < 2 || s.orderShare < 0.25) continue;
      const multiple = ctx.products.get(s.productId)?.orderMultiple ?? null;
      out.push({
        productId: s.productId,
        group: "frequent",
        score: round2(s.orderShare),
        reasons: [{ code: "frequent", params: { count: s.orderCount, total } }],
        suggestedQty: suggestedQty(s, multiple),
      });
    }
    return out;
  },
};

export const togetherProvider: SuggestionProvider = {
  id: "together",
  suggest(ctx) {
    if (ctx.cartProductIds.length === 0) return [];
    const cart = new Set(ctx.cartProductIds);
    const best = new Map<string, Candidate>();
    const consider = (rules: readonly AssociationRule[] | undefined, scope: "customer" | "all", boost: number) => {
      for (const rule of rules ?? []) {
        if (!cart.has(rule.productId) || cart.has(rule.relatedProductId)) continue;
        const score = Math.min(1, rule.confidence * boost);
        const prev = best.get(rule.relatedProductId);
        if (prev && prev.score >= score) continue;
        const stats = ctx.stats.get(rule.relatedProductId);
        best.set(rule.relatedProductId, {
          productId: rule.relatedProductId,
          group: "together",
          score: round2(score),
          reasons: [
            {
              code: "together",
              params: {
                withProductId: rule.productId,
                withProductName: ctx.products.get(rule.productId)?.name ?? "",
                percent: Math.round(rule.confidence * 100),
                scope,
              },
            },
          ],
          ...(stats ? { suggestedQty: suggestedQty(stats, ctx.products.get(rule.relatedProductId)?.orderMultiple) } : {}),
        });
      }
    };
    consider(ctx.associations, "all", 1);
    consider(ctx.customerAssociations, "customer", 1.2);
    return [...best.values()];
  },
};

export const lastOrderProvider: SuggestionProvider = {
  id: "last_order",
  suggest(ctx) {
    const last = ctx.summary.lastInvoiceOn;
    if (!last) return [];
    const daysAgo = daysBetween(last, ctx.asOf);
    const out: Candidate[] = [];
    for (const s of ctx.stats.values()) {
      if (s.lastPurchasedOn !== last) continue;
      out.push({
        productId: s.productId,
        group: "last_order",
        score: 0.5,
        reasons: [{ code: "last_order", params: { daysAgo, qty: s.lastQty.toString() } }],
        suggestedQty: s.lastQty,
      });
    }
    return out;
  },
};

export const DEFAULT_PROVIDERS: readonly SuggestionProvider[] = [
  reorderProvider,
  frequentProvider,
  togetherProvider,
  lastOrderProvider,
];

export const DEFAULT_WEIGHTS: Readonly<Record<SuggestionGroup, number>> = {
  reorder: 1,
  frequent: 0.6,
  together: 0.5,
  last_order: 0.3,
};

export interface SuggestOptions {
  providers?: readonly SuggestionProvider[];
  weights?: Partial<Record<SuggestionGroup, number>>;
  limit?: number;
  /** Multiplier applied to out-of-stock products (default 0.5). */
  outOfStockFactor?: number;
}

export function suggestProducts(ctx: SuggestionContext, options: SuggestOptions = {}): Suggestion[] {
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const cart = new Set(ctx.cartProductIds);
  const merged = new Map<string, { best: number; group: SuggestionGroup; score: number; reasons: SuggestionReason[]; qty: Dec | null }>();

  for (const provider of providers) {
    for (const c of provider.suggest(ctx)) {
      if (cart.has(c.productId)) continue;
      const product = ctx.products.get(c.productId);
      if (!product || !product.active) continue;
      const weighted = c.score * (weights[c.group] ?? 0);
      if (weighted <= 0) continue;
      const entry = merged.get(c.productId) ?? { best: -1, group: c.group, score: 0, reasons: [], qty: null };
      entry.score += weighted;
      if (weighted > entry.best) {
        entry.best = weighted;
        entry.group = c.group;
      }
      for (const r of c.reasons) if (!entry.reasons.some((x) => x.code === r.code)) entry.reasons.push(r);
      entry.qty ??= c.suggestedQty ?? null;
      merged.set(c.productId, entry);
    }
  }

  const factor = options.outOfStockFactor ?? 0.5;
  const result: Suggestion[] = [];
  for (const [productId, e] of merged) {
    const product = ctx.products.get(productId)!;
    const level = stockLevel(product.stockQty, product.minStock);
    let score = e.score;
    const reasons = [...e.reasons];
    if (level === "out_of_stock") {
      score *= factor;
      reasons.push({ code: "out_of_stock", params: {} });
    } else if (level === "low") {
      reasons.push({ code: "low_stock", params: { qty: dec(product.stockQty).toString() } });
    }
    result.push({ productId, productName: product.name, group: e.group, score: round2(score), suggestedQty: e.qty, reasons });
  }
  result.sort((a, b) => b.score - a.score || a.productName.localeCompare(b.productName));
  return options.limit ? result.slice(0, options.limit) : result;
}

export interface ReorderRow {
  productId: string;
  lastQty: Dec;
  lastPurchasedOn: string;
  daysSinceLast: number;
  typicalIntervalDays: number | null;
  status: ReorderStatus | "irregular";
  /** Negative when overdue. null for irregular purchases. */
  dueInDays: number | null;
  suggestedQty: Dec;
}

/**
 * The "Reorder suggestions" table: every product the customer buys repeatedly,
 * with last qty, last purchase and suggested qty, most urgent first.
 */
export function buildReorderList(ctx: Pick<SuggestionContext, "stats" | "products">): ReorderRow[] {
  const rank: Record<ReorderRow["status"], number> = { overdue: 0, due: 1, upcoming: 2, lapsed: 3, irregular: 4 };
  const rows: ReorderRow[] = [];
  for (const s of ctx.stats.values()) {
    if (s.orderCount < 2) continue;
    const product = ctx.products.get(s.productId);
    if (product && !product.active) continue;
    const interval = s.typicalIntervalDays;
    const status = interval ? reorderStatus(s.daysSinceLast, interval).status : null;
    if (interval && !status) continue;
    rows.push({
      productId: s.productId,
      lastQty: s.lastQty,
      lastPurchasedOn: s.lastPurchasedOn,
      daysSinceLast: s.daysSinceLast,
      typicalIntervalDays: interval,
      status: status ?? "irregular",
      dueInDays: interval ? Math.round(interval - s.daysSinceLast) : null,
      suggestedQty: suggestedQty(s, product?.orderMultiple),
    });
  }
  return rows.sort(
    (a, b) => rank[a.status] - rank[b.status] || (a.dueInDays ?? 0) - (b.dueInDays ?? 0) || b.daysSinceLast - a.daysSinceLast,
  );
}
