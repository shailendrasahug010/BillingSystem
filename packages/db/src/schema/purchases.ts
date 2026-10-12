import { sql } from "drizzle-orm";
import { check, date, index, pgTable, smallint, text, unique, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { auditColumns, money, percent, pk, qty, rate, tstz, versioned } from "./columns.js";
import { documentTotalsColumns, gstPartySnapshotColumns, taxLineColumns } from "./document-lines.js";
import { documentStatus, goodsReceiptStatus, itcEligibility, paymentStatus, purchaseOrderStatus } from "./enums.js";
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
    /** The goods receipt line this bill line pays for: its stock came in with the receipt, the bill sets its cost. */
    goodsReceiptItemId: uuid().references((): AnyPgColumn => goodsReceiptItems.id),
    /** The purchase order line the goods were ordered on, when they came in with this bill (no receipt before it). */
    purchaseOrderItemId: uuid().references((): AnyPgColumn => purchaseOrderItems.id),
  },
  (t) => [
    index("purchase_items_purchase_idx").on(t.purchaseId),
    index("purchase_items_product_idx").on(t.businessId, t.productId),
    index("purchase_items_receipt_idx").on(t.goodsReceiptItemId).where(sql`${t.goodsReceiptItemId} is not null`),
    index("purchase_items_order_idx").on(t.purchaseOrderItemId).where(sql`${t.purchaseOrderItemId} is not null`),
    check("purchase_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0`),
  ],
);

/**
 * An order placed with a supplier. It moves no stock and no money: goods
 * received against it (a goods receipt, or a bill with the goods) count on
 * its lines, and it is received when everything came, or closed by hand when
 * no more will. Totals are what the order should cost at its rates.
 */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: pk(),
    businessId: businessId(),
    /** Number from the purchase order series. */
    orderNumber: varchar({ length: 30 }).notNull(),
    /** Number series the order was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the order (2026-27); its number is unique within it. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** Date the order was placed. */
    orderDate: date({ mode: "string" }).notNull(),
    /** When the goods are wanted. */
    expectedDate: date({ mode: "string" }),
    /** The supplier the order is placed with. */
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    /** Godown the goods are to be delivered to. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    ...gstPartySnapshotColumns(),
    /** Open, partly received, received, closed or cancelled. */
    status: purchaseOrderStatus().notNull().default("open"),
    ...documentTotalsColumns(),
    notes: text(),
    /** When the order was closed with goods still to come (no more expected). */
    closedAt: tstz(),
    /** User who closed the order. */
    closedBy: uuid(),
    /** When the order was cancelled (only before anything came). */
    cancelledAt: tstz(),
    /** User who cancelled the order. */
    cancelledBy: uuid(),
    /** Why it was closed or cancelled. */
    cancelReason: text(),
    /** Id the app gave the order when it was made: a retried save with the same id returns the saved order. */
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("purchase_orders_number_uq").on(t.businessId, t.financialYear, t.orderNumber),
    uniqueIndex("purchase_orders_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("purchase_orders_supplier_idx").on(t.businessId, t.supplierId, t.orderDate),
    index("purchase_orders_status_idx").on(t.businessId, t.status, t.orderDate),
  ],
);

export const purchaseOrderItems = pgTable(
  "purchase_order_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The order. */
    purchaseOrderId: uuid()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    ...taxLineColumns(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    /** Base units received so far against the line (bought and free), by goods receipts and by bills that brought the goods. */
    receivedQty: qty().notNull().default("0"),
  },
  (t) => [
    index("purchase_order_items_order_idx").on(t.purchaseOrderId),
    index("purchase_order_items_product_idx").on(t.businessId, t.productId),
    check("purchase_order_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0 and ${t.receivedQty} >= 0`),
  ],
);

/**
 * Goods received from a supplier before (or without yet) their bill: the
 * stock comes in at once, at the order's rate (else the last purchase rate),
 * and the bill entered later for these goods sets their cost. A receipt is
 * billed in one bill; until then it can be cancelled (the goods go out again).
 */
export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: pk(),
    businessId: businessId(),
    /** Number from the goods receipt series (GRN). */
    receiptNumber: varchar({ length: 30 }).notNull(),
    /** Number series the receipt was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the receipt. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** Date the goods came in (the stock comes in on this date). */
    receivedDate: date({ mode: "string" }).notNull(),
    /** The supplier who sent the goods. */
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id),
    /** Supplier's name when the goods came (snapshot). */
    partyName: text().notNull(),
    /** The order the goods came against, when there was one. */
    purchaseOrderId: uuid().references(() => purchaseOrders.id),
    /** Godown the goods were put in. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** The supplier's delivery challan or lorry receipt number, as written on their papers. */
    challanNumber: varchar({ length: 30 }),
    /** Received (waiting for the bill), billed or cancelled. */
    status: goodsReceiptStatus().notNull().default("received"),
    /** The purchase bill the goods were billed in. */
    purchaseId: uuid().references(() => purchases.id),
    /** What the goods are worth at the rates they came in at (before GST). */
    totalValue: money().notNull().default("0"),
    notes: text(),
    /** When the receipt was cancelled (its goods went back out). */
    cancelledAt: tstz(),
    /** User who cancelled the receipt. */
    cancelledBy: uuid(),
    /** Why it was cancelled. */
    cancelReason: text(),
    /** Id the app gave the receipt when it was made: a retried save with the same id returns the saved receipt. */
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("goods_receipts_number_uq").on(t.businessId, t.financialYear, t.receiptNumber),
    uniqueIndex("goods_receipts_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("goods_receipts_supplier_idx").on(t.businessId, t.supplierId, t.status),
    index("goods_receipts_date_idx").on(t.businessId, t.receivedDate),
    index("goods_receipts_order_idx").on(t.purchaseOrderId).where(sql`${t.purchaseOrderId} is not null`),
    index("goods_receipts_purchase_idx").on(t.purchaseId).where(sql`${t.purchaseId} is not null`),
  ],
);

export const goodsReceiptItems = pgTable(
  "goods_receipt_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The receipt. */
    goodsReceiptId: uuid()
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    /** Position of the line on the receipt. */
    lineNo: smallint().notNull(),
    /** The product received. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** Product name when it came in (snapshot). */
    productName: text().notNull(),
    /** The unit the quantity is in (a case, a piece ...). */
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    /** Base units in one of the line's unit. */
    conversionFactor: qty().notNull().default("1"),
    /** Quantity received, in the line's unit. */
    qty: qty().notNull(),
    /** Quantity received free (a scheme), in the line's unit. */
    freeQty: qty().notNull().default("0"),
    /** qty x conversion factor. */
    qtyBase: qty().notNull(),
    /** Expected rate per unit of the line's unit (the order's, else the last purchase rate), before GST. */
    rate: rate().notNull().default("0"),
    /** Expected discount in percent. */
    discountPercent: percent().notNull().default("0"),
    /** Cost per base unit the stock came in at (rate less discount, spread over the free goods too); the bill corrects it. */
    unitCost: rate().notNull().default("0"),
    /** The order line the goods came against. */
    purchaseOrderItemId: uuid().references(() => purchaseOrderItems.id),
    /** The batch the goods came in as. */
    batchId: uuid().references(() => batches.id),
    /** Batch number as printed on the goods. */
    batchNumber: varchar({ length: 40 }),
    /** Manufacturing date of the batch. */
    mfgDate: date({ mode: "string" }),
    /** Expiry date of the batch. */
    expiryDate: date({ mode: "string" }),
    /** MRP printed on the goods. */
    mrp: rate(),
  },
  (t) => [
    index("goods_receipt_items_receipt_idx").on(t.goodsReceiptId),
    index("goods_receipt_items_product_idx").on(t.businessId, t.productId),
    index("goods_receipt_items_order_idx").on(t.purchaseOrderItemId).where(sql`${t.purchaseOrderItemId} is not null`),
    check("goods_receipt_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0`),
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
