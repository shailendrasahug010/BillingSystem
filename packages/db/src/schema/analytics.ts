import type { AssociationRule } from "@digitalbahi/core";
import { sql } from "drizzle-orm";
import { check, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, smallint, text, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { money, pk, qty, rate, timestamps, tstz } from "./columns.js";
import { brands, productCategories, products } from "./catalog.js";
import { employees } from "./hr.js";
import { customers } from "./parties.js";
import { businessId, users } from "./platform.js";
import { invoices } from "./sales.js";

/**
 * Derived tables. They are caches of the transactional tables, so they can be
 * dropped and regenerated at any time without data loss. The purchase-history
 * tables (customer_product_stats, customer_stats) are refreshed per customer
 * by the outbox worker a few seconds after each bill, payment or note, and all
 * of them, with product_associations, are rebuilt by the nightly job, which
 * first checks that what the worker kept matches a fresh computation.
 */

/** Per customer x product purchase history: powers invoice suggestions (see docs/07). */
export const customerProductStats = pgTable(
  "customer_product_stats",
  {
    businessId: businessId(),
    /** The customer. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** The product. */
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Invoices in the window that had the product (several lines on one invoice count once). */
    orderCount: integer().notNull(),
    /** Share of the customer's invoices in the window containing this product (0..1). */
    orderShare: doublePrecision().notNull(),
    /** Total quantity bought in the window (base units). */
    totalQty: qty().notNull(),
    /** Average quantity per invoice. */
    avgQty: qty().notNull(),
    /** Quantity on the most recent invoice. */
    lastQty: qty().notNull(),
    /** Rate on the most recent invoice (per base unit). */
    lastRate: rate(),
    /** Newest first, max 5 (median of the first three = suggested qty). */
    recentQtys: qty().array().notNull(),
    /** First invoice date in the window with the product. */
    firstPurchasedOn: date({ mode: "string" }).notNull(),
    /** Most recent invoice date with the product. */
    lastPurchasedOn: date({ mode: "string" }).notNull(),
    /** Median gap in days between purchases; empty with fewer than 3 purchases (two purchases are not a habit). */
    typicalIntervalDays: doublePrecision(),
    updatedAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.productId] }),
    index("customer_product_stats_last_idx").on(t.businessId, t.customerId, t.lastPurchasedOn),
  ],
);

/** Store-wide "frequently bought together" rules (A -> B). */
export const productAssociations = pgTable(
  "product_associations",
  {
    businessId: businessId(),
    /** Product A (already on the bill). */
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Product B (suggested with it). */
    relatedProductId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Bills in the window with both A and B. */
    pairCount: integer().notNull(),
    /** Share of all bills with both A and B. */
    support: doublePrecision().notNull(),
    /** Of the bills with A, the share that also had B ("37% of customers who buy A also buy this"). */
    confidence: doublePrecision().notNull(),
    /** Confidence divided by B's own share of bills: above 1 means a real affinity, not just that B is popular. */
    lift: doublePrecision().notNull(),
    /** When the rule was mined. */
    computedAt: tstz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.productId, t.relatedProductId] })],
);

/** Customer-level aggregates for lists and profiles (total sales, AOV, payment behaviour). */
export const customerStats = pgTable("customer_stats", {
  /** The customer (one row per customer). */
  customerId: uuid()
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  businessId: businessId(),
  /** Invoices in the window. */
  invoiceCount: integer().notNull().default(0),
  /** Value of those invoices. */
  totalSales: money().notNull().default("0"),
  /** Average invoice value. */
  avgOrderValue: money().notNull().default("0"),
  /** First invoice date in the window. */
  firstInvoiceOn: date({ mode: "string" }),
  /** Most recent invoice date. */
  lastInvoiceOn: date({ mode: "string" }),
  /** Median gap in days between invoices. */
  typicalVisitIntervalDays: doublePrecision(),
  /** Average days from invoice to full payment. */
  avgDaysToPay: doublePrecision(),
  /** Share of invoices paid by their due date (0..1). */
  onTimeRatio: doublePrecision(),
  /** Payment behaviour: 4 excellent, 3 good, 2 slow, 1 risky; empty with too few settled bills to tell. */
  paymentRating: smallint(),
  /** Amount past its due date. */
  overdueAmount: money().notNull().default("0"),
  /**
   * The customer's own "bought together" rules, mined from their bills with
   * stricter thresholds than the store-wide ones ("usually bought with bread
   * by this customer").
   */
  associations: jsonb().$type<AssociationRule[]>().notNull().default([]),
  /** The day these figures (and the customer's product stats) were worked out for; the window ends on it. */
  asOf: date({ mode: "string" }),
  updatedAt: tstz().notNull().defaultNow(),
});

/**
 * Runs of the nightly analytics job, one per business and day. Inserting the
 * row claims the run, so two API servers never both do it. `details` keeps
 * what it found: customers rebuilt, drift between the worker's figures and a
 * fresh computation, association rules mined, and cached balances that do not
 * match their ledgers.
 */
export const analyticsRuns = pgTable(
  "analytics_runs",
  {
    id: pk(),
    businessId: businessId(),
    /** Which job: nightly. */
    job: varchar({ length: 30 }).notNull(),
    /** The business day the run is for. */
    asOf: date({ mode: "string" }).notNull(),
    /** running, completed or failed. */
    status: varchar({ length: 12 }).notNull().default("running"),
    /** When the run was claimed and began. */
    startedAt: tstz().notNull().defaultNow(),
    /** When it completed or failed. */
    finishedAt: tstz(),
    /** What the run found, as JSON (counts, drift, mismatched balances with examples). */
    details: jsonb().notNull().default({}),
    /** Why it failed. */
    error: text(),
  },
  (t) => [
    unique("analytics_runs_uq").on(t.businessId, t.job, t.asOf),
    check("analytics_runs_status_chk", sql`${t.status} in ('running', 'completed', 'failed')`),
  ],
);

/** One suggestion as it was offered or taken on the billing screen. */
export interface SuggestionFeedbackItem {
  productId: string;
  /** The tab it was under: reorder, frequent, together or last_order. */
  group: string;
  /** Its position in the list, 1 = first. */
  rank: number;
  /** Reason codes shown with it (due, overdue, frequent ...). */
  reasons: string[];
}

/**
 * What the billing screen offered and what was taken, one row per bill being
 * made (the app makes the id, so a resend replaces instead of adding). Used to
 * measure whether suggestions help: acceptance by reason and position, and the
 * share of bill lines that came from them.
 */
export const suggestionFeedback = pgTable(
  "suggestion_feedback",
  {
    /** Made by the app for the bill being made. */
    id: uuid().primaryKey(),
    businessId: businessId(),
    /** The customer the bill was for. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** The person billing. */
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** The bill it ended in, once saved. */
    invoiceId: uuid().references(() => invoices.id),
    /** Suggestions offered (first appearance of each product, up to 50). */
    shown: jsonb().$type<SuggestionFeedbackItem[]>().notNull().default([]),
    /** Suggestions added to the bill. */
    added: jsonb().$type<SuggestionFeedbackItem[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [index("suggestion_feedback_created_idx").on(t.businessId, t.createdAt)],
);

/**
 * Daily sales per product (and brand/category snapshot): product-wise,
 * company-wise and category-wise reports read this instead of scanning
 * invoice lines. One row per business x day x product x salesperson. Each
 * day is worked out whole from its documents by the outbox worker (after a
 * bill, return or purchase on that day) and every day again by the nightly
 * job; the sales report by product and the home screen read it for past days.
 */
export const salesDailyProduct = pgTable(
  "sales_daily_product",
  {
    businessId: businessId(),
    /** The day. */
    day: date({ mode: "string" }).notNull(),
    /** The product. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** The product's brand on that day. */
    brandId: uuid().references(() => brands.id),
    /** The product's category on that day. */
    categoryId: uuid().references(() => productCategories.id),
    /** Salesperson of the invoices (returns: of the invoice returned against; purchases: none). */
    salespersonId: uuid().references(() => employees.id),
    /** Base units sold. */
    qtySold: qty().notNull().default("0"),
    /** Base units returned. */
    qtyReturned: qty().notNull().default("0"),
    /** Taxable value of the sales. */
    taxableValue: money().notNull().default("0"),
    /** GST on the sales. */
    taxAmount: money().notNull().default("0"),
    /** Cost of the goods sold. */
    costValue: money().notNull().default("0"),
    /** Invoices with the product. */
    invoiceCount: integer().notNull().default(0),
    /** Customers who bought it. */
    customerCount: integer().notNull().default(0),
    /** Base units bought in. */
    qtyPurchased: qty().notNull().default("0"),
    /** Value bought in. */
    purchaseValue: money().notNull().default("0"),
  },
  (t) => [
    unique("sales_daily_product_uq").on(t.businessId, t.day, t.productId, t.salespersonId).nullsNotDistinct(),
    index("sales_daily_product_brand_idx").on(t.businessId, t.brandId, t.day),
  ],
);

/**
 * Daily sales / collection per customer (customer-wise and salesperson-wise reports, dashboard trends).
 * Kept like sales_daily_product: billed by the bills' salesperson, collected by whoever collected the money.
 */
export const salesDailyCustomer = pgTable(
  "sales_daily_customer",
  {
    businessId: businessId(),
    /** The day. */
    day: date({ mode: "string" }).notNull(),
    /** The customer. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** Salesperson of the invoices (for money collected: who collected it). */
    salespersonId: uuid().references(() => employees.id),
    /** Invoices that day. */
    invoiceCount: integer().notNull().default(0),
    /** Taxable value billed. */
    taxableValue: money().notNull().default("0"),
    /** Total billed. */
    grandTotal: money().notNull().default("0"),
    /** Money received. */
    collected: money().notNull().default("0"),
    /** Value of returns. */
    returns: money().notNull().default("0"),
  },
  (t) => [
    unique("sales_daily_customer_uq").on(t.businessId, t.day, t.customerId, t.salespersonId).nullsNotDistinct(),
    index("sales_daily_customer_idx").on(t.businessId, t.customerId, t.day),
  ],
);
