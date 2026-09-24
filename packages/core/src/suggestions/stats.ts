import { dec, type Dec, type DecimalInput, sum } from "../money/decimal.js";
import { daysBetween } from "../dates.js";

/**
 * Purchase-history statistics for one customer, per product.
 *
 * In production these are maintained incrementally in `customer_product_stats`
 * (updated by an outbox job after each invoice posts, fully rebuilt nightly),
 * so the invoice screen reads one small indexed table instead of scanning
 * years of invoice lines. The same functions compute them in tests and on the
 * client for offline use.
 */
export interface PurchaseLine {
  invoiceId: string;
  /** ISO date of the invoice. */
  date: string;
  productId: string;
  qty: DecimalInput;
  rate?: DecimalInput;
}

export interface CustomerProductStats {
  productId: string;
  /** Number of distinct invoices containing the product. */
  orderCount: number;
  /** Share of the customer's invoices (in the window) that contain the product, 0..1. */
  orderShare: number;
  totalQty: Dec;
  avgQty: Dec;
  lastQty: Dec;
  lastRate: Dec | null;
  firstPurchasedOn: string;
  lastPurchasedOn: string;
  daysSinceLast: number;
  /** Median gap in days between purchase dates; null until there are >= 2 gaps. */
  typicalIntervalDays: number | null;
  /** Quantities of the most recent purchases, newest first (max 5). */
  recentQtys: Dec[];
}

export interface CustomerSummary {
  invoiceCount: number;
  firstInvoiceOn: string | null;
  lastInvoiceOn: string | null;
  /** Median days between the customer's invoices. */
  typicalVisitIntervalDays: number | null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function gaps(sortedDates: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) out.push(daysBetween(sortedDates[i - 1]!, sortedDates[i]!));
  return out;
}

export interface StatsOptions {
  asOf: string;
  /** Only history within this many days counts (default 365). Old habits fade. */
  windowDays?: number;
}

export function computeCustomerStats(
  lines: readonly PurchaseLine[],
  options: StatsOptions,
): { summary: CustomerSummary; products: Map<string, CustomerProductStats> } {
  const windowDays = options.windowDays ?? 365;
  const inWindow = lines.filter((l) => {
    const age = daysBetween(l.date, options.asOf);
    return age >= 0 && age <= windowDays;
  });

  const invoiceDates = new Map<string, string>();
  for (const l of inWindow) invoiceDates.set(l.invoiceId, l.date);
  const invoiceCount = invoiceDates.size;
  const visitDates = [...new Set(invoiceDates.values())].sort();

  const byProduct = new Map<string, PurchaseLine[]>();
  for (const l of inWindow) {
    const list = byProduct.get(l.productId) ?? [];
    list.push(l);
    byProduct.set(l.productId, list);
  }

  const products = new Map<string, CustomerProductStats>();
  for (const [productId, productLines] of byProduct) {
    // Collapse multiple lines of the same product on one invoice.
    const perInvoice = new Map<string, { date: string; qty: Dec; rate: Dec | null }>();
    for (const l of productLines) {
      const prev = perInvoice.get(l.invoiceId);
      perInvoice.set(l.invoiceId, {
        date: l.date,
        qty: (prev?.qty ?? dec(0)).plus(dec(l.qty)),
        rate: l.rate !== undefined ? dec(l.rate) : (prev?.rate ?? null),
      });
    }
    const purchases = [...perInvoice.values()].sort((a, b) => b.date.localeCompare(a.date));
    const dates = [...new Set(purchases.map((p) => p.date))].sort();
    const totalQty = sum(purchases.map((p) => p.qty));
    const latest = purchases[0]!;
    const intervals = gaps(dates);
    products.set(productId, {
      productId,
      orderCount: purchases.length,
      orderShare: invoiceCount ? purchases.length / invoiceCount : 0,
      totalQty,
      avgQty: totalQty.dividedBy(purchases.length),
      lastQty: latest.qty,
      lastRate: latest.rate,
      firstPurchasedOn: dates[0]!,
      lastPurchasedOn: dates.at(-1)!,
      daysSinceLast: daysBetween(dates.at(-1)!, options.asOf),
      typicalIntervalDays: intervals.length >= 2 ? median(intervals) : null,
      recentQtys: purchases.slice(0, 5).map((p) => p.qty),
    });
  }

  return {
    summary: {
      invoiceCount,
      firstInvoiceOn: visitDates[0] ?? null,
      lastInvoiceOn: visitDates.at(-1) ?? null,
      typicalVisitIntervalDays: median(gaps(visitDates)),
    },
    products,
  };
}

/**
 * Suggested reorder quantity: median of the last three purchases (robust to a
 * one-off bulk order), rounded up to the order multiple (e.g. a case of 24).
 */
export function suggestedQty(stats: CustomerProductStats, orderMultiple?: DecimalInput | null): Dec {
  const recent = stats.recentQtys.slice(0, 3).map((q) => q.toNumber());
  const base = dec(median(recent) ?? stats.lastQty.toNumber());
  if (!orderMultiple || dec(orderMultiple).lte(0)) return base.toDecimalPlaces(3);
  const m = dec(orderMultiple);
  return base.dividedBy(m).ceil().times(m);
}
