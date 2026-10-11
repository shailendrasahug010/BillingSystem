import { sql } from "drizzle-orm";
import { boolean, check, date, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { products } from "./catalog.js";
import { auditColumns, pk } from "./columns.js";
import { suppliers } from "./parties.js";
import { businessId } from "./platform.js";

/** free_goods: buy so much, get goods free; discount: so much off by slab. */
export const schemeKind = pgEnum("scheme_kind", ["free_goods", "discount"]);
/** What a scheme's slabs count: stock units of its products, or their value in rupees. */
export const schemeMeasure = pgEnum("scheme_measure", ["qty", "value"]);

/** A slab as stored (amounts as text, as the API takes them). */
export interface SchemeSlabRow {
  from: string;
  freeQty?: string | null;
  discountPercent?: string | null;
  discountPerUnit?: string | null;
}

/**
 * Trade schemes on sales (company schemes passed on to customers): free
 * goods and discounts by slab, on products, brands or categories, for a
 * period and for every customer or some. Bills say which scheme gave each
 * free line and each scheme discount (invoice_items.scheme_id), which is
 * what the claim to the company is made from.
 */
export const schemes = pgTable(
  "schemes",
  {
    id: pk(),
    businessId: businessId(),
    /** Name as staff and bills show it ("Lifebuoy 10+1", "Diwali 2% on Parle"). */
    name: varchar({ length: 120 }).notNull(),
    kind: schemeKind().notNull(),
    measure: schemeMeasure().notNull().default("qty"),
    /** The products it is on: these products, and any product of these brands or categories. */
    productIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    brandIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    categoryIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** [{from, freeQty | discountPercent, discountPerUnit}]: the highest slab reached counts. */
    slabs: jsonb().$type<SchemeSlabRow[]>().notNull(),
    /** Free goods given again for each further slab's worth (buy 10 get 1: 20 get 2). */
    repeat: boolean().notNull().default(true),
    /** The product given free; empty: each product bought, given free on itself. */
    freeProductId: uuid().references(() => products.id),
    /** First and last day it runs (no last day: until it is ended). */
    validFrom: date({ mode: "string" }).notNull(),
    validTo: date({ mode: "string" }),
    /** Only for customers of these categories or rate lists (both empty: every customer). */
    customerCategoryIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    priceLevelIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** The company that pays for the scheme (the claim goes to it), and its own code for it. */
    supplierId: uuid().references(() => suppliers.id),
    reference: varchar({ length: 60 }),
    notes: text(),
    /** Switched off: no longer given (bills already made keep it). */
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("schemes_business_idx").on(t.businessId, t.validTo),
    uniqueIndex("schemes_name_uq").on(t.businessId, sql`lower(${t.name})`),
    check("schemes_validity_chk", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);
