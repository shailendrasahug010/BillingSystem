import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, pk, qty, rate, tstz, versioned } from "./columns.js";
import { documentTotalsColumns, gstPartySnapshotColumns, taxLineColumns } from "./document-lines.js";
import { documentStatus, itcEligibility, paymentStatus } from "./enums.js";
import { batches, products, units } from "./catalog.js";
import { suppliers } from "./parties.js";
import { businessId, devices, documentSeries, warehouses } from "./platform.js";

/**
 * Purchase bill entry. Posting it (one DB transaction) increases stock, updates
 * moving-average cost, credits the supplier ledger and writes inward GST rows.
 */
export const purchases = pgTable(
  "purchases",
  {
    id: pk(),
    businessId: businessId(),
    /** Internal reference number from our own series. */
    purchaseNumber: varchar({ length: 30 }),
    /** Number series the purchase was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the purchase (2026-27); its number is unique within it. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** The supplier who sent the bill. */
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    /** The supplier's bill number; the same supplier's bill cannot be entered twice in a year. */
    supplierInvoiceNumber: varchar({ length: 30 }).notNull(),
    /** Date on the supplier's bill (decides the GST period of the input credit). */
    supplierInvoiceDate: date({ mode: "string" }).notNull(),
    /** Date the goods were received (the stock comes in on this date). */
    receivedDate: date({ mode: "string" }).notNull(),
    /** When the bill is to be paid (bill date + the supplier's credit days). */
    dueDate: date({ mode: "string" }),
    /** Godown the goods were received into. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    ...gstPartySnapshotColumns(),
    /** Whether the GST on the bill can be claimed as input credit: eligible, ineligible (blocked), capital goods or input services. */
    itcEligibility: itcEligibility().notNull().default("eligible"),
    /** Draft, posted or cancelled. */
    status: documentStatus().notNull().default("draft"),
    ...documentTotalsColumns(),
    /** Paid so far against this bill (payments allocated to it, and payment at the time of the bill). */
    amountPaid: money().notNull().default("0"),
    /** Still to be paid: grand total less amount paid and returns / credit notes against it. */
    balanceDue: money().notNull().default("0"),
    /** Unpaid, partly paid or paid. */
    paymentStatus: paymentStatus().notNull().default("unpaid"),
    notes: text(),
    /** The supplier's bill as a file, when attached. */
    attachmentFileId: uuid(),
    /** When the purchase was posted (numbered, and its stock, ledger and GST entries written). */
    postedAt: tstz(),
    /** User who posted the purchase. */
    postedBy: uuid(),
    /** When the purchase was cancelled. A cancelled purchase is kept with its number; cancelling reverses its stock, ledger and GST entries. */
    cancelledAt: tstz(),
    /** User who cancelled the purchase. */
    cancelledBy: uuid(),
    /** Why it was cancelled. */
    cancelReason: text(),
    /** Device the purchase was made on, when it was made offline. */
    deviceId: uuid().references(() => devices.id),
    /** Id the app gave the purchase when it was made: a retried or offline save with the same id returns the saved purchase instead of making a second one. */
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("purchases_number_uq").on(t.businessId, t.financialYear, t.purchaseNumber),
    /** The same supplier bill cannot be entered twice. */
    uniqueIndex("purchases_supplier_bill_uq")
      .on(t.businessId, t.supplierId, t.supplierInvoiceNumber, t.financialYear)
      .where(sql`${t.status} <> 'cancelled'`),
    uniqueIndex("purchases_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("purchases_supplier_idx").on(t.businessId, t.supplierId, t.supplierInvoiceDate),
    index("purchases_date_idx").on(t.businessId, t.receivedDate),
    index("purchases_open_idx").on(t.businessId, t.supplierId).where(sql`${t.status} = 'posted' and ${t.balanceDue} > 0`),
    check("purchases_totals_chk", sql`${t.grandTotal} >= 0 and ${t.amountPaid} >= 0 and ${t.balanceDue} >= 0`),
  ],
);

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The purchase bill. */
    purchaseId: uuid()
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    ...taxLineColumns(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    /** The batch the goods came in as (made or found from the batch number). */
    batchId: uuid().references(() => batches.id),
    /** Batch number as printed on the bill. */
    batchNumber: varchar({ length: 40 }),
    /** Manufacturing date of the batch. */
    mfgDate: date({ mode: "string" }),
    /** Expiry date of the batch. */
    expiryDate: date({ mode: "string" }),
    /** MRP printed on the goods. */
    mrp: rate(),
    /** Unit cost per base unit including apportioned freight/charges (landed cost), used for avg cost. */
    landedUnitCost: rate().notNull().default("0"),
    /** Quantity already returned to the supplier (debit notes); no more than the bill quantity can be returned. */
    returnedQty: qty().notNull().default("0"),
  },
  (t) => [
    index("purchase_items_purchase_idx").on(t.purchaseId),
    index("purchase_items_product_idx").on(t.businessId, t.productId),
    check("purchase_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0`),
  ],
);

/**
 * How a supplier names our products on their bills ("SURF EXL 1KG", item code
 * "HU-1102"). Written when a bill imported from the supplier's file is saved,
 * so the next bill from the same supplier matches line by line on its own.
 * `itemKey` is "c:" + the normalised item code, or "n:" + the normalised name.
 */
export const supplierItems = pgTable(
  "supplier_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The supplier. */
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    /** Our product the supplier's item was matched to. */
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** The match key: c: + the normalised item code, or n: + the normalised name. */
    itemKey: varchar({ length: 210 }).notNull(),
    /** The supplier's item code, as on their bill. */
    itemCode: varchar({ length: 60 }),
    /** The supplier's item name, as on their bill. */
    itemName: text(),
    /** The unit this supplier bills the item in (a case), when not the stock unit. */
    unitId: uuid().references(() => units.id),
    /** Rate on the supplier's last bill with this item. */
    lastRate: rate(),
    /** When the item was last on one of the supplier's bills. */
    lastSeenAt: tstz().notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [unique("supplier_items_uq").on(t.businessId, t.supplierId, t.itemKey), index("supplier_items_product_idx").on(t.businessId, t.productId)],
);
