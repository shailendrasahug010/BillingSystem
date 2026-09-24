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
    seriesId: uuid().references(() => documentSeries.id),
    financialYear: varchar({ length: 9 }).notNull(),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    supplierInvoiceNumber: varchar({ length: 30 }).notNull(),
    supplierInvoiceDate: date({ mode: "string" }).notNull(),
    receivedDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    ...gstPartySnapshotColumns(),
    itcEligibility: itcEligibility().notNull().default("eligible"),
    status: documentStatus().notNull().default("draft"),
    ...documentTotalsColumns(),
    amountPaid: money().notNull().default("0"),
    balanceDue: money().notNull().default("0"),
    paymentStatus: paymentStatus().notNull().default("unpaid"),
    notes: text(),
    attachmentFileId: uuid(),
    postedAt: tstz(),
    postedBy: uuid(),
    cancelledAt: tstz(),
    cancelledBy: uuid(),
    cancelReason: text(),
    deviceId: uuid().references(() => devices.id),
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
    batchId: uuid().references(() => batches.id),
    batchNumber: varchar({ length: 40 }),
    mfgDate: date({ mode: "string" }),
    expiryDate: date({ mode: "string" }),
    mrp: rate(),
    /** Unit cost per base unit including apportioned freight/charges (landed cost), used for avg cost. */
    landedUnitCost: rate().notNull().default("0"),
    returnedQty: qty().notNull().default("0"),
  },
  (t) => [
    index("purchase_items_purchase_idx").on(t.purchaseId),
    index("purchase_items_product_idx").on(t.businessId, t.productId),
    check("purchase_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0`),
  ],
);
