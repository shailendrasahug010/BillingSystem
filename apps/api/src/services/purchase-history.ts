import {
  addDays,
  computeCustomerStats,
  daysBetween,
  dec,
  mineAssociations,
  paymentBehaviour,
  type AssociationRule,
  type Basket,
  type CustomerProductStats,
  type CustomerSummary,
  type PaymentBehaviour,
  type PurchaseLine,
} from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

/**
 * Purchase history (docs/07): what each customer buys and how often, kept in
 * customer_product_stats and customer_stats so the billing screen reads a few
 * indexed rows instead of a year of invoice lines.
 *
 * The figures for a customer are always worked out whole, from their posted
 * bills in the window (net of what they returned: a line returned in full
 * does not count as bought), by the same @digitalbahi/core functions the app
 * runs offline. The outbox worker does it a few seconds after a bill, payment or
 * note of theirs; the nightly job does it for everyone (the window moves on
 * each day) after checking the stored figures against a fresh computation.
 */

/** A customer's own "bought together" rules: few bills, so a pair must recur to count. */
export const CUSTOMER_ASSOCIATION_OPTIONS = { minPairCount: 3, minConfidence: 0.6, minLift: 1.05 } as const;
/** Store-wide rules are mined from this many days of bills (newest first, at most STORE_BASKET_LIMIT). */
export const STORE_BASKET_DAYS = 180;
export const STORE_BASKET_LIMIT = 50_000;
/** Stored figures are used while at most this many days old; older ones are worked out again on the spot. */
export const MAX_STALE_DAYS = 2;

/** One customer_product_stats row, with the numbers as the columns keep them. */
export interface StatsRow {
  productId: string;
  orderCount: number;
  orderShare: number;
  totalQty: string;
  avgQty: string;
  lastQty: string;
  lastRate: string | null;
  recentQtys: string[];
  firstPurchasedOn: string;
  lastPurchasedOn: string;
  typicalIntervalDays: number | null;
}

/** What is compared when checking stored figures: everything that depends only on the bills and the day. */
export interface PurchaseFigures {
  asOf: string;
  summary: CustomerSummary;
  /** Sorted by product id. */
  rows: StatsRow[];
  /** The customer's own rules, sorted by product then related product. */
  associations: AssociationRule[];
}

/** Purchase figures plus the money side kept in customer_stats. */
export interface CustomerFigures extends PurchaseFigures {
  totalSales: string;
  avgOrderValue: string;
  overdueAmount: string;
  behaviour: { avgDaysToPay: number | null; onTimeRatio: number | null; rating: PaymentBehaviour };
}

type InvoiceRow = {
  id: string;
  date: string;
  due_date: string;
  total: string;
  balance: string;
  settled_on: string | null;
};

export interface CustomerData {
  lines: PurchaseLine[];
  invoices: InvoiceRow[];
}

const RATING_SCORE: Record<PaymentBehaviour, number | null> = { excellent: 4, good: 3, slow: 2, risky: 1, new: null };
const SCORE_RATING: Record<number, PaymentBehaviour> = { 4: "excellent", 3: "good", 2: "slow", 1: "risky" };

const byRule = (a: AssociationRule, b: AssociationRule) => a.productId.localeCompare(b.productId) || a.relatedProductId.localeCompare(b.relatedProductId);

/**
 * The customer's posted bills (the window's lines, for purchase history) and
 * their bills in the window or still open (for payment behaviour), up to `until`.
 */
export async function loadCustomerData(tx: Tx, businessId: string, customerId: string, since: string, until: string, options: { invoices?: boolean } = {}): Promise<CustomerData> {
  // Returns (credit notes) lower what was bought; the rate stays the bill's.
  const lines = await tx.execute<{ invoice_id: string; invoice_date: string; product_id: string; qty: string; rate: string | null }>(sql`
    select i.id as invoice_id, i.invoice_date::text as invoice_date, ii.product_id,
           (case when ii.returned_qty = 0 then ii.qty_base else ((ii.qty - ii.returned_qty) * ii.conversion_factor)::numeric(15,3) end)::text as qty,
           (ii.taxable_value / nullif(ii.qty_base, 0))::numeric(15,4)::text as rate
    from invoices i join invoice_items ii on ii.invoice_id = i.id
    where i.business_id = ${businessId} and i.customer_id = ${customerId} and i.status = 'posted'
      and i.invoice_date >= ${since} and i.invoice_date <= ${until} and ii.qty > ii.returned_qty`);
  const purchaseLines: PurchaseLine[] = lines.rows.map((l) => ({ invoiceId: l.invoice_id, date: l.invoice_date, productId: l.product_id, qty: l.qty, ...(l.rate ? { rate: l.rate } : {}) }));
  if (options.invoices === false) return { lines: purchaseLines, invoices: [] };
  const invoices = await tx.execute<InvoiceRow>(sql`
    select i.id, i.invoice_date::text as date, coalesce(i.due_date, i.invoice_date)::text as due_date,
           i.grand_total::text as total, i.balance_due::text as balance,
           case when i.balance_due = 0 then (
             select max(p.payment_date)::text from payment_allocations a join payments p on p.id = a.payment_id
             where a.invoice_id = i.id and a.reversed_at is null) end as settled_on
    from invoices i
    where i.business_id = ${businessId} and i.customer_id = ${customerId} and i.status = 'posted'
      and ((i.invoice_date >= ${since} and i.invoice_date <= ${until}) or i.balance_due > 0)
    order by i.invoice_date, i.id`);
  return { lines: purchaseLines, invoices: invoices.rows };
}

/** A product's statistics as the columns keep them (quantities to 3 places, rates to 4). */
export function toStatsRow(s: CustomerProductStats): StatsRow {
  return {
    productId: s.productId,
    orderCount: s.orderCount,
    orderShare: s.orderShare,
    totalQty: s.totalQty.toFixed(3),
    avgQty: s.avgQty.toFixed(3),
    lastQty: s.lastQty.toFixed(3),
    lastRate: s.lastRate === null ? null : s.lastRate.toFixed(4),
    recentQtys: s.recentQtys.map((q) => q.toFixed(3)),
    firstPurchasedOn: s.firstPurchasedOn,
    lastPurchasedOn: s.lastPurchasedOn,
    typicalIntervalDays: s.typicalIntervalDays,
  };
}

/** Back to the engine's shape; days since the last purchase are counted to `today`. */
export function fromStatsRow(r: StatsRow, today: string): CustomerProductStats {
  return {
    productId: r.productId,
    orderCount: r.orderCount,
    orderShare: r.orderShare,
    totalQty: dec(r.totalQty),
    avgQty: dec(r.avgQty),
    lastQty: dec(r.lastQty),
    lastRate: r.lastRate === null ? null : dec(r.lastRate),
    recentQtys: r.recentQtys.map((q) => dec(q)),
    firstPurchasedOn: r.firstPurchasedOn,
    lastPurchasedOn: r.lastPurchasedOn,
    daysSinceLast: daysBetween(r.lastPurchasedOn, today),
    typicalIntervalDays: r.typicalIntervalDays,
  };
}

/** The purchase side as of `asOf`: lines after it are not counted. */
export function purchaseFigures(data: CustomerData, asOf: string, windowDays: number): PurchaseFigures {
  const lines = data.lines.filter((l) => l.date <= asOf);
  const { summary, products } = computeCustomerStats(lines, { asOf, windowDays });
  const inWindow = lines.filter((l) => daysBetween(l.date, asOf) <= windowDays);
  const baskets = new Map<string, string[]>();
  for (const l of inWindow) baskets.set(l.invoiceId, [...(baskets.get(l.invoiceId) ?? []), l.productId]);
  return {
    asOf,
    summary,
    rows: [...products.values()].map(toStatsRow).sort((a, b) => a.productId.localeCompare(b.productId)),
    associations: mineAssociations(
      [...baskets].map(([id, productIds]) => ({ id, productIds })),
      CUSTOMER_ASSOCIATION_OPTIONS,
    ).sort(byRule),
  };
}

/** Purchase figures plus sales, overdue amount and payment behaviour as of `asOf`. */
export function customerFigures(data: CustomerData, asOf: string, windowDays: number): CustomerFigures {
  const since = addDays(asOf, -windowDays);
  const inWindow = data.invoices.filter((i) => i.date >= since && i.date <= asOf);
  const totalSales = inWindow.reduce((acc, i) => acc.plus(i.total), dec(0));
  const overdue = data.invoices.filter((i) => dec(i.balance).gt(0) && i.due_date < asOf).reduce((acc, i) => acc.plus(i.balance), dec(0));
  return {
    ...purchaseFigures(data, asOf, windowDays),
    totalSales: totalSales.toFixed(2),
    avgOrderValue: inWindow.length ? totalSales.dividedBy(inWindow.length).toFixed(2) : "0.00",
    overdueAmount: overdue.toFixed(2),
    behaviour: paymentBehaviour(
      inWindow.map((i) => ({ date: i.date, dueDate: i.due_date, settledOn: i.settled_on })),
      asOf,
    ),
  };
}

/** Serialises work on one customer's figures (the worker and the nightly job may both reach them). */
export async function lockCustomer(tx: Tx, customerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`purchase-history:${customerId}`}, 0))`);
}

/** Replaces the customer's stored figures. */
export async function writeFigures(tx: Tx, businessId: string, customerId: string, f: CustomerFigures): Promise<void> {
  const now = new Date().toISOString();
  await tx.delete(schema.customerProductStats).where(and(eq(schema.customerProductStats.businessId, businessId), eq(schema.customerProductStats.customerId, customerId)));
  if (f.rows.length) {
    await tx.insert(schema.customerProductStats).values(f.rows.map((r) => ({ businessId, customerId, ...r, updatedAt: now })));
  }
  const values = {
    businessId,
    invoiceCount: f.summary.invoiceCount,
    totalSales: f.totalSales,
    avgOrderValue: f.avgOrderValue,
    firstInvoiceOn: f.summary.firstInvoiceOn,
    lastInvoiceOn: f.summary.lastInvoiceOn,
    typicalVisitIntervalDays: f.summary.typicalVisitIntervalDays,
    avgDaysToPay: f.behaviour.avgDaysToPay,
    onTimeRatio: f.behaviour.onTimeRatio,
    paymentRating: RATING_SCORE[f.behaviour.rating],
    overdueAmount: f.overdueAmount,
    associations: f.associations,
    asOf: f.asOf,
    updatedAt: now,
  };
  await tx
    .insert(schema.customerStats)
    .values({ customerId, ...values })
    .onConflictDoUpdate({ target: schema.customerStats.customerId, set: values });
}

/** Works the customer's figures out again from their bills and stores them. */
export async function refreshCustomer(tx: Tx, businessId: string, customerId: string, asOf: string, windowDays: number): Promise<CustomerFigures> {
  await lockCustomer(tx, customerId);
  const data = await loadCustomerData(tx, businessId, customerId, addDays(asOf, -windowDays), asOf);
  const figures = customerFigures(data, asOf, windowDays);
  await writeFigures(tx, businessId, customerId, figures);
  return figures;
}

/** The customer's stored figures, or null when none were worked out yet. */
export async function readStoredFigures(tx: Tx, customerId: string): Promise<(PurchaseFigures & { rating: PaymentBehaviour | null }) | null> {
  const [cs] = await tx.select().from(schema.customerStats).where(eq(schema.customerStats.customerId, customerId));
  if (!cs || !cs.asOf) return null;
  const rows = await tx
    .select()
    .from(schema.customerProductStats)
    .where(eq(schema.customerProductStats.customerId, customerId))
    .orderBy(schema.customerProductStats.productId);
  return {
    asOf: cs.asOf,
    summary: {
      invoiceCount: cs.invoiceCount,
      firstInvoiceOn: cs.firstInvoiceOn,
      lastInvoiceOn: cs.lastInvoiceOn,
      typicalVisitIntervalDays: cs.typicalVisitIntervalDays,
    },
    rows: rows.map((r) => ({
      productId: r.productId,
      orderCount: r.orderCount,
      orderShare: r.orderShare,
      totalQty: r.totalQty,
      avgQty: r.avgQty,
      lastQty: r.lastQty,
      lastRate: r.lastRate,
      recentQtys: r.recentQtys,
      firstPurchasedOn: r.firstPurchasedOn,
      lastPurchasedOn: r.lastPurchasedOn,
      typicalIntervalDays: r.typicalIntervalDays,
    })),
    associations: [...cs.associations].sort(byRule),
    rating: cs.paymentRating === null ? null : (SCORE_RATING[cs.paymentRating] ?? null),
  };
}

/** What the suggestion engine needs about a customer's buying. */
export interface PurchaseHistory {
  summary: CustomerSummary;
  stats: Map<string, CustomerProductStats>;
  customerAssociations: AssociationRule[];
  /** stored: read from the tables; live: worked out now (none stored, or too old). */
  source: "stored" | "live";
}

/**
 * The customer's purchase history for the billing screen: the stored figures
 * when they are recent, otherwise worked out on the spot (nothing is written
 * then; the worker or the nightly job will store them).
 */
export async function purchaseHistory(tx: Tx, businessId: string, customerId: string, today: string, windowDays: number): Promise<PurchaseHistory> {
  const stored = await readStoredFigures(tx, customerId);
  let figures: PurchaseFigures;
  let source: PurchaseHistory["source"];
  const age = stored ? daysBetween(stored.asOf, today) : -1;
  if (stored && age >= 0 && age <= MAX_STALE_DAYS) {
    figures = stored;
    source = "stored";
  } else {
    figures = purchaseFigures(await loadCustomerData(tx, businessId, customerId, addDays(today, -windowDays), today, { invoices: false }), today, windowDays);
    source = "live";
  }
  return {
    summary: figures.summary,
    stats: new Map(figures.rows.map((r) => [r.productId, fromStatsRow(r, today)])),
    customerAssociations: figures.associations,
    source,
  };
}

/** Bills of the last STORE_BASKET_DAYS (newest first), as baskets of product ids. */
export async function storeBaskets(tx: Tx, businessId: string, today: string, limit = STORE_BASKET_LIMIT): Promise<Basket[]> {
  const rows = await tx.execute<{ invoice_id: string; product_ids: string[] }>(sql`
    select i.id as invoice_id, array_agg(distinct ii.product_id) as product_ids
    from invoices i join invoice_items ii on ii.invoice_id = i.id
    where i.business_id = ${businessId} and i.status = 'posted'
      and i.invoice_date >= ${addDays(today, -STORE_BASKET_DAYS)} and i.invoice_date <= ${today}
    group by i.id, i.invoice_date
    order by i.invoice_date desc, i.id
    limit ${limit}`);
  return rows.rows.map((r) => ({ id: r.invoice_id, productIds: r.product_ids }));
}

/** Store-wide rules mined on request (before the first nightly run), kept briefly per business. */
const ON_DEMAND_TTL_MS = 15 * 60_000;
const ON_DEMAND_BASKETS = 3000;
const onDemand = new Map<string, { at: number; rules: AssociationRule[] }>();

/**
 * Store-wide "bought together" rules: product_associations as the nightly job
 * left them, when it ran in the last week; before that, mined from the last
 * few thousand bills on request.
 */
export async function storeAssociations(tx: Tx, businessId: string, today: string): Promise<AssociationRule[]> {
  const [run] = await tx
    .select({ asOf: schema.analyticsRuns.asOf })
    .from(schema.analyticsRuns)
    .where(and(eq(schema.analyticsRuns.businessId, businessId), eq(schema.analyticsRuns.job, "nightly"), eq(schema.analyticsRuns.status, "completed"), gte(schema.analyticsRuns.asOf, addDays(today, -7))))
    .orderBy(desc(schema.analyticsRuns.asOf))
    .limit(1);
  if (run) {
    const rows = await tx
      .select({
        productId: schema.productAssociations.productId,
        relatedProductId: schema.productAssociations.relatedProductId,
        pairCount: schema.productAssociations.pairCount,
        support: schema.productAssociations.support,
        confidence: schema.productAssociations.confidence,
        lift: schema.productAssociations.lift,
      })
      .from(schema.productAssociations)
      .where(eq(schema.productAssociations.businessId, businessId));
    return rows.sort(byRule);
  }
  const hit = onDemand.get(businessId);
  if (hit && Date.now() - hit.at < ON_DEMAND_TTL_MS) return hit.rules;
  const rules = mineAssociations(await storeBaskets(tx, businessId, today, ON_DEMAND_BASKETS)).sort(byRule);
  onDemand.set(businessId, { at: Date.now(), rules });
  return rules;
}

/** Replaces the business's store-wide rules with ones mined from its recent bills. */
export async function mineStoreAssociations(tx: Tx, businessId: string, today: string): Promise<number> {
  const rules = mineAssociations(await storeBaskets(tx, businessId, today));
  await tx.delete(schema.productAssociations).where(eq(schema.productAssociations.businessId, businessId));
  const now = new Date().toISOString();
  for (let i = 0; i < rules.length; i += 1000) {
    await tx.insert(schema.productAssociations).values(rules.slice(i, i + 1000).map((r) => ({ businessId, ...r, computedAt: now })));
  }
  onDemand.delete(businessId);
  return rules.length;
}
