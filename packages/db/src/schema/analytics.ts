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
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    orderCount: integer().notNull(),
    /** Share of the customer's invoices in the window containing this product (0..1). */
    orderShare: doublePrecision().notNull(),
    totalQty: qty().notNull(),
    avgQty: qty().notNull(),
    lastQty: qty().notNull(),
    lastRate: rate(),
    /** Newest first, max 5 (median of the first three = suggested qty). */
    recentQtys: qty().array().notNull(),
    firstPurchasedOn: date({ mode: "string" }).notNull(),
    lastPurchasedOn: date({ mode: "string" }).notNull(),
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
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    relatedProductId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    pairCount: integer().notNull(),
    support: doublePrecision().notNull(),
    confidence: doublePrecision().notNull(),
    lift: doublePrecision().notNull(),
    computedAt: tstz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.productId, t.relatedProductId] })],
);

/** Customer-level aggregates for lists and profiles (total sales, AOV, payment behaviour). */
export const customerStats = pgTable("customer_stats", {
  customerId: uuid()
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  businessId: businessId(),
  invoiceCount: integer().notNull().default(0),
  totalSales: money().notNull().default("0"),
  avgOrderValue: money().notNull().default("0"),
  firstInvoiceOn: date({ mode: "string" }),
  lastInvoiceOn: date({ mode: "string" }),
  typicalVisitIntervalDays: doublePrecision(),
  avgDaysToPay: doublePrecision(),
  onTimeRatio: doublePrecision(),
  paymentRating: smallint(),
  overdueAmount: money().notNull().default("0"),
  updatedAt: tstz().notNull().defaultNow(),
});

/**
 * Daily sales per product (and brand/category snapshot): product-wise,
 * company-wise and category-wise reports read this instead of scanning
 * invoice lines. One row per business x day x product x salesperson.
 */
export const salesDailyProduct = pgTable(
  "sales_daily_product",
  {
    businessId: businessId(),
    day: date({ mode: "string" }).notNull(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    brandId: uuid().references(() => brands.id),
    categoryId: uuid().references(() => productCategories.id),
    salespersonId: uuid().references(() => employees.id),
    qtySold: qty().notNull().default("0"),
    qtyReturned: qty().notNull().default("0"),
    taxableValue: money().notNull().default("0"),
    taxAmount: money().notNull().default("0"),
    costValue: money().notNull().default("0"),
    invoiceCount: integer().notNull().default(0),
    customerCount: integer().notNull().default(0),
    qtyPurchased: qty().notNull().default("0"),
    purchaseValue: money().notNull().default("0"),
  },
  (t) => [
    unique("sales_daily_product_uq").on(t.businessId, t.day, t.productId, t.salespersonId).nullsNotDistinct(),
    index("sales_daily_product_brand_idx").on(t.businessId, t.brandId, t.day),
  ],
);

/** Daily sales / collection per customer (customer-wise and salesperson-wise reports, dashboard trends). */
export const salesDailyCustomer = pgTable(
  "sales_daily_customer",
  {
    businessId: businessId(),
    day: date({ mode: "string" }).notNull(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    salespersonId: uuid().references(() => employees.id),
    invoiceCount: integer().notNull().default(0),
    taxableValue: money().notNull().default("0"),
    grandTotal: money().notNull().default("0"),
    collected: money().notNull().default("0"),
    returns: money().notNull().default("0"),
  },
  (t) => [
    unique("sales_daily_customer_uq").on(t.businessId, t.day, t.customerId, t.salespersonId).nullsNotDistinct(),
    index("sales_daily_customer_idx").on(t.businessId, t.customerId, t.day),
  ],
);
