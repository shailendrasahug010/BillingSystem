import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  type AnyPgColumn,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, money, percent, pk, qty, rate, softDelete, versioned } from "./columns.js";
import { taxability } from "./enums.js";
import { priceLevels, suppliers } from "./parties.js";
import { businessId, files } from "./platform.js";

/** Manufacturer / brand ("Company" in distributor language): Parle, HUL, ITC, Nestlé... */
export const brands = pgTable(
  "brands",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    code: varchar({ length: 20 }),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
    ...softDelete,
  },
  (t) => [uniqueIndex("brands_name_uq").on(t.businessId, t.name).where(sql`${t.deletedAt} is null`)],
);

/** Category tree (category -> subcategory -> ...). */
export const productCategories = pgTable(
  "product_categories",
  {
    id: pk(),
    businessId: businessId(),
    parentId: uuid().references((): AnyPgColumn => productCategories.id),
    name: text().notNull(),
    sortOrder: smallint().notNull().default(0),
    ...auditColumns,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("product_categories_name_uq")
      .on(t.businessId, t.parentId, t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Units (PCS, BOX, KG...) with the GST Unit Quantity Code used in returns. */
export const units = pgTable(
  "units",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    symbol: varchar({ length: 10 }).notNull(),
    uqc: varchar({ length: 3 }).notNull(),
    /** Decimal places allowed in quantities (PCS 0, KGS 3). */
    decimals: smallint().notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    unique("units_symbol_uq").on(t.businessId, t.symbol),
    check("units_decimals_chk", sql`${t.decimals} between 0 and 3`),
  ],
);

/**
 * Tax categories: products point here instead of storing a GST rate, so a
 * government rate change is one new tax_rates row, not an edit to thousands of products.
 */
export const taxCategories = pgTable(
  "tax_categories",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    kind: taxability().notNull().default("taxable"),
    description: text(),
    ...auditColumns,
  },
  (t) => [unique("tax_categories_name_uq").on(t.businessId, t.name)],
);

/** Effective-dated GST rates per category, optionally conditional on unit value. See resolveTax in @vyapaar/core. */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: pk(),
    businessId: businessId(),
    taxCategoryId: uuid()
      .notNull()
      .references(() => taxCategories.id, { onDelete: "cascade" }),
    effectiveFrom: date({ mode: "string" }).notNull(),
    effectiveTo: date({ mode: "string" }),
    gstRate: percent().notNull(),
    cessRate: percent().notNull().default("0"),
    cessPerUnit: rate().notNull().default("0"),
    /** e.g. {"unitValueLte": 2500}. */
    condition: jsonb(),
    priority: smallint().notNull().default(0),
    /** Notification / circular reference, for the audit trail. */
    reference: text(),
    ...auditColumns,
  },
  (t) => [
    index("tax_rates_category_idx").on(t.taxCategoryId, t.effectiveFrom),
    check("tax_rates_gst_chk", sql`${t.gstRate} >= 0 and ${t.gstRate} <= 100`),
    check("tax_rates_cess_chk", sql`${t.cessRate} >= 0 and ${t.cessPerUnit} >= 0`),
    check("tax_rates_period_chk", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    /** Local-language name, printed on Hindi invoices and searchable. */
    nameLocal: text(),
    /** Extra search terms: nicknames, transliterations ("namak", "नमक"). */
    aliases: text().array(),
    code: varchar({ length: 30 }).notNull(),
    sku: varchar({ length: 40 }),
    hsnCode: varchar({ length: 8 }),
    taxCategoryId: uuid()
      .notNull()
      .references(() => taxCategories.id),
    brandId: uuid().references(() => brands.id),
    categoryId: uuid().references(() => productCategories.id),
    /** Stock is kept in this unit; other units convert via product_units. */
    baseUnitId: uuid()
      .notNull()
      .references(() => units.id),
    packSize: text(),
    /** Last purchase rate (per base unit). */
    purchasePrice: rate().notNull().default("0"),
    /** Weighted moving-average cost (per base unit), for margin and stock valuation. */
    avgCost: rate().notNull().default("0"),
    mrp: rate(),
    /** Default selling price (per base unit); price levels override it. */
    sellingPrice: rate().notNull().default("0"),
    pricesIncludeTax: boolean().notNull().default(false),
    minStock: qty(),
    reorderQty: qty(),
    preferredSupplierId: uuid().references(() => suppliers.id),
    trackBatches: boolean().notNull().default(false),
    trackExpiry: boolean().notNull().default(false),
    trackSerials: boolean().notNull().default(false),
    /** Variant support: variants share a parent and differ by attributes ({"size":"1kg"}). */
    parentProductId: uuid().references((): AnyPgColumn => products.id),
    variantAttributes: jsonb(),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
    ...softDelete,
    ...versioned,
  },
  (t) => [
    uniqueIndex("products_code_uq").on(t.businessId, t.code).where(sql`${t.deletedAt} is null`),
    uniqueIndex("products_sku_uq").on(t.businessId, t.sku).where(sql`${t.deletedAt} is null and ${t.sku} is not null`),
    index("products_brand_idx").on(t.businessId, t.brandId),
    index("products_category_idx").on(t.businessId, t.categoryId),
    index("products_hsn_idx").on(t.businessId, t.hsnCode),
    index("products_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    check("products_prices_chk", sql`${t.purchasePrice} >= 0 and ${t.sellingPrice} >= 0 and ${t.avgCost} >= 0`),
    check("products_mrp_chk", sql`${t.mrp} is null or ${t.mrp} >= 0`),
    check("products_hsn_chk", sql`${t.hsnCode} is null or ${t.hsnCode} ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'`),
  ],
);

/** Alternate units: 1 BOX = 24 PCS, 1 CASE = 12 BOX. */
export const productUnits = pgTable(
  "product_units",
  {
    id: pk(),
    businessId: businessId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    conversionFactor: qty().notNull(),
    isDefaultSale: boolean().notNull().default(false),
    isDefaultPurchase: boolean().notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    unique("product_units_uq").on(t.productId, t.unitId),
    check("product_units_factor_chk", sql`${t.conversionFactor} > 0`),
  ],
);

/** Several barcodes per product (manufacturer EAN, case barcode, internal label). */
export const productBarcodes = pgTable(
  "product_barcodes",
  {
    id: pk(),
    businessId: businessId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    unitId: uuid().references(() => units.id),
    barcode: varchar({ length: 64 }).notNull(),
    ...auditColumns,
  },
  (t) => [unique("product_barcodes_uq").on(t.businessId, t.barcode), index("product_barcodes_product_idx").on(t.productId)],
);

/** Price per price level and unit. */
export const productPrices = pgTable(
  "product_prices",
  {
    businessId: businessId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    priceLevelId: uuid()
      .notNull()
      .references(() => priceLevels.id, { onDelete: "cascade" }),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    price: rate().notNull(),
    discountPercent: percent().notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.priceLevelId, t.unitId] }),
    check("product_prices_price_chk", sql`${t.price} >= 0`),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: pk(),
    businessId: businessId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    fileId: uuid()
      .notNull()
      .references(() => files.id),
    sortOrder: smallint().notNull().default(0),
    ...auditColumns,
  },
  (t) => [index("product_images_product_idx").on(t.productId)],
);

export const batches = pgTable(
  "batches",
  {
    id: pk(),
    businessId: businessId(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    batchNumber: varchar({ length: 40 }).notNull(),
    mfgDate: date({ mode: "string" }),
    expiryDate: date({ mode: "string" }),
    mrp: rate(),
    purchaseRate: rate(),
    ...auditColumns,
  },
  (t) => [
    unique("batches_uq").on(t.productId, t.batchNumber),
    index("batches_expiry_idx").on(t.businessId, t.expiryDate),
    check("batches_dates_chk", sql`${t.expiryDate} is null or ${t.mfgDate} is null or ${t.expiryDate} >= ${t.mfgDate}`),
  ],
);
