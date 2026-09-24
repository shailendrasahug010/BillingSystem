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
    productId: uuid()
      .notNull()
      .references(() => products.id),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    batchId: uuid().references(() => batches.id),
    txnDate: date({ mode: "string" }).notNull(),
    movementType: stockMovementType().notNull(),
    /** Quantities in the product's base unit. */
    qtyIn: qty().notNull().default("0"),
    qtyOut: qty().notNull().default("0"),
    /** Running balance for (product, warehouse, batch) after this row. */
    balanceAfter: qty().notNull(),
    unitCost: rate().notNull().default("0"),
    /** Source document: invoice, purchase, credit_note, adjustment, transfer, opening... */
    refType: varchar({ length: 30 }).notNull(),
    refId: uuid(),
    refLineId: uuid(),
    refNumber: varchar({ length: 40 }),
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
 * ledger row with the new balance). Reads are O(1); a nightly job re-checks
 * that it equals SUM(qty_in - qty_out).
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    id: pk(),
    businessId: businessId(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    batchId: uuid().references(() => batches.id),
    qty: qty().notNull().default("0"),
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
    adjustmentNumber: varchar({ length: 30 }),
    adjustmentDate: date({ mode: "string" }).notNull(),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    reason: adjustmentReason().notNull(),
    notes: text(),
    status: documentStatus().notNull().default("draft"),
    approvedBy: uuid(),
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
    adjustmentId: uuid()
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    batchId: uuid().references(() => batches.id),
    /** Signed: positive adds stock, negative removes it. */
    qtyChange: qty().notNull(),
    /** System quantity at the time of a physical count (for count corrections). */
    systemQty: qty(),
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
    transferNumber: varchar({ length: 30 }),
    transferDate: date({ mode: "string" }).notNull(),
    fromWarehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    toWarehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    status: transferStatus().notNull().default("draft"),
    notes: text(),
    receivedAt: tstz(),
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
    transferId: uuid()
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    batchId: uuid().references(() => batches.id),
    qty: qty().notNull(),
    receivedQty: qty(),
  },
  (t) => [index("stock_transfer_items_transfer_idx").on(t.transferId), check("stock_transfer_items_qty_chk", sql`${t.qty} > 0`)],
);
