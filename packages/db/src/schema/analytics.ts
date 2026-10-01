import { date, doublePrecision, index, integer, pgTable, primaryKey, smallint, unique, uuid } from "drizzle-orm/pg-core";
import { money, qty, rate, tstz } from "./columns.js";
import { brands, productCategories, products } from "./catalog.js";
import { employees } from "./hr.js";
import { customers } from "./parties.js";
import { businessId } from "./platform.js";

/**
 * Derived tables. They are caches of the transactional tables, rebuilt by
 * background jobs from the outbox (and fully recomputable nightly), so they
 * can be dropped and regenerated at any time without data loss.
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
  /** Payment behaviour score, 1 (poor) to 5 (excellent). */
  paymentRating: smallint(),
  /** Amount past its due date. */
  overdueAmount: money().notNull().default("0"),
  updatedAt: tstz().notNull().defaultNow(),
});

/**
 * Daily sales per product (and brand/category snapshot): product-wise,
 * company-wise and category-wise reports read this instead of scanning
 * invoice lines. One row per business x day x product x salesperson.
 * Not filled yet: reports read the documents directly.
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
    /** Salesperson of the invoices. */
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
 * Not filled yet: reports read the documents directly.
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
    /** Salesperson of the invoices. */
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
