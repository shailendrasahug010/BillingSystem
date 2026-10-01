import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, pk, qty, rate, tstz, versioned } from "./columns.js";
import { adjustmentReason, documentStatus, stockMovementType, transferStatus } from "./enums.js";
import { batches, products } from "./catalog.js";
import { businessId, warehouses } from "./platform.js";

/**
 * STOCK LEDGER — the single source of truth for stock. Append-only: the app
 * role has no UPDATE/DELETE privilege and a trigger rejects both. Corrections
 * are new rows (reversal or adjustment), so every unit is explainable:
 * date | transaction | in | out | balance.
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    businessId: businessId(),
    /** The product that moved. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** The godown it moved in or out of. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** The batch, for products kept by batch. */
    batchId: uuid().references(() => batches.id),
    /** Date of the movement (the document's date). */
    txnDate: date({ mode: "string" }).notNull(),
    /** What moved the stock: sale, purchase, return, adjustment, transfer, opening ... */
    movementType: stockMovementType().notNull(),
    /** Quantities in the product's base unit. */
    qtyIn: qty().notNull().default("0"),
    /** Quantity out, in the base unit (exactly one of qty_in / qty_out is above zero). */
    qtyOut: qty().notNull().default("0"),
    /** Running balance for (product, warehouse, batch) after this row. */
    balanceAfter: qty().notNull(),
    /** Cost per base unit: the landed cost for purchases, the moving-average cost at the time for sales and other issues. */
    unitCost: rate().notNull().default("0"),
    /** Source document: invoice, purchase, credit_note, adjustment, transfer, opening... */
    refType: varchar({ length: 30 }).notNull(),
    /** Id of the source document. */
    refId: uuid(),
    /** Id of the source document's line. */
    refLineId: uuid(),
    /** Number of the source document, for display (INV/26-27/00042). */
    refNumber: varchar({ length: 40 }),
    /** Why, for adjustments and corrections. */
    reason: text(),
    createdBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index("stock_ledger_product_idx").on(t.businessId, t.productId, t.warehouseId, t.id),
    index("stock_ledger_ref_idx").on(t.refType, t.refId),
    index("stock_ledger_date_idx").on(t.businessId, t.txnDate),
    check(
      "stock_ledger_direction_chk",
      sql`${t.qtyIn} >= 0 and ${t.qtyOut} >= 0 and ((${t.qtyIn} > 0) <> (${t.qtyOut} > 0))`,
    ),
  ],
);

/**
 * Current stock per product / warehouse / batch: a cache of the ledger updated
 * in the same transaction (SELECT ... FOR UPDATE on the row, then insert the
 * ledger row with the new balance). Reads are O(1); the nightly analytics job
 * checks that it equals SUM(qty_in - qty_out) and reports any difference.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    id: pk(),
    businessId: businessId(),
    /** The product. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** The godown. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** The batch (empty for products not kept by batch); one row per product, godown and batch. */
    batchId: uuid().references(() => batches.id),
    /** Quantity on hand in the base unit (can go below zero when the business allows selling before the purchase is entered). */
    qty: qty().notNull().default("0"),
    /** The last stock_ledger row applied to this balance. */
    lastLedgerId: bigint({ mode: "number" }),
    updatedAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    unique("stock_balances_uq").on(t.businessId, t.productId, t.warehouseId, t.batchId).nullsNotDistinct(),
    index("stock_balances_product_idx").on(t.productId),
  ],
);

export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: pk(),
    businessId: businessId(),
    /** Number from the adjustment series, given when it is posted. */
    adjustmentNumber: varchar({ length: 30 }),
    /** Date of the adjustment. */
    adjustmentDate: date({ mode: "string" }).notNull(),
    /** Godown whose stock is corrected. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** Count correction, damage, expiry, theft, sample, internal use or other. */
    reason: adjustmentReason().notNull(),
    notes: text(),
    /** Draft, posted (stock moved) or cancelled. */
    status: documentStatus().notNull().default("draft"),
    /** User who posted the adjustment. */
    approvedBy: uuid(),
    /** When it was posted. */
    postedAt: tstz(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [unique("stock_adjustments_number_uq").on(t.businessId, t.adjustmentNumber)],
);

export const stockAdjustmentItems = pgTable(
  "stock_adjustment_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The adjustment. */
    adjustmentId: uuid()
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: "cascade" }),
    /** The product corrected. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** The batch, for products kept by batch. */
    batchId: uuid().references(() => batches.id),
    /** Signed: positive adds stock, negative removes it. */
    qtyChange: qty().notNull(),
    /** System quantity at the time of a physical count (for count corrections). */
    systemQty: qty(),
    /** Cost per base unit used to value the change. */
    unitCost: rate().notNull().default("0"),
    note: text(),
  },
  (t) => [
    index("stock_adjustment_items_adj_idx").on(t.adjustmentId),
    check("stock_adjustment_items_nonzero_chk", sql`${t.qtyChange} <> 0`),
  ],
);

export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: pk(),
    businessId: businessId(),
    /** Number from the transfer series. */
    transferNumber: varchar({ length: 30 }),
    /** Date the goods left. */
    transferDate: date({ mode: "string" }).notNull(),
    /** Godown the goods leave. */
    fromWarehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** Godown the goods arrive at. */
    toWarehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** Draft, in transit, received or cancelled. */
    status: transferStatus().notNull().default("draft"),
    notes: text(),
    /** When the receiving godown confirmed them. */
    receivedAt: tstz(),
    /** User who confirmed the receipt. */
    receivedBy: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("stock_transfers_number_uq").on(t.businessId, t.transferNumber),
    check("stock_transfers_distinct_chk", sql`${t.fromWarehouseId} <> ${t.toWarehouseId}`),
  ],
);

export const stockTransferItems = pgTable(
  "stock_transfer_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The transfer. */
    transferId: uuid()
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    /** The product moved. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** The batch, for products kept by batch. */
    batchId: uuid().references(() => batches.id),
    /** Quantity sent, in the base unit. */
    qty: qty().notNull(),
    /** Quantity that arrived, when it differs. */
    receivedQty: qty(),
  },
  (t) => [index("stock_transfer_items_transfer_idx").on(t.transferId), check("stock_transfer_items_qty_chk", sql`${t.qty} > 0`)],
);
