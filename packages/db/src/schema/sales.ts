import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, money, pk, qty, rate, tstz, versioned } from "./columns.js";
import { documentTotalsColumns, gstPartySnapshotColumns, taxLineColumns } from "./document-lines.js";
import {
  deliveryStatus,
  documentKind,
  documentStatus,
  orderStatus,
  packingStatus,
  paymentStatus,
} from "./enums.js";
import { batches, products, units } from "./catalog.js";
import { employees } from "./hr.js";
import { customers, priceLevels } from "./parties.js";
import { businessId, devices, documentSeries, files, warehouses } from "./platform.js";

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: pk(),
    businessId: businessId(),
    orderNumber: varchar({ length: 30 }),
    seriesId: uuid().references(() => documentSeries.id),
    financialYear: varchar({ length: 9 }).notNull(),
    orderDate: date({ mode: "string" }).notNull(),
    expectedDeliveryDate: date({ mode: "string" }),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    priceLevelId: uuid().references(() => priceLevels.id),
    salespersonId: uuid().references(() => employees.id),
    status: orderStatus().notNull().default("draft"),
    /** Where the order came from: counter, salesperson app, phone, WhatsApp... */
    source: varchar({ length: 20 }).notNull().default("app"),
    placeOfSupply: char({ length: 2 }).notNull(),
    ...documentTotalsColumns(),
    notes: text(),
    cancelledAt: tstz(),
    cancelReason: text(),
    deviceId: uuid().references(() => devices.id),
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("sales_orders_number_uq").on(t.businessId, t.financialYear, t.orderNumber),
    uniqueIndex("sales_orders_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("sales_orders_customer_idx").on(t.businessId, t.customerId, t.orderDate),
    index("sales_orders_status_idx").on(t.businessId, t.status, t.orderDate),
  ],
);

export const salesOrderItems = pgTable(
  "sales_order_items",
  {
    id: pk(),
    businessId: businessId(),
    orderId: uuid()
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    ...taxLineColumns(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    /** Fulfilment progress in base units; supports partial packing, dispatch, delivery and invoicing. */
    packedQty: qty().notNull().default("0"),
    dispatchedQty: qty().notNull().default("0"),
    deliveredQty: qty().notNull().default("0"),
    invoicedQty: qty().notNull().default("0"),
    cancelledQty: qty().notNull().default("0"),
  },
  (t) => [
    index("sales_order_items_order_idx").on(t.orderId),
    check("sales_order_items_qty_chk", sql`${t.qty} > 0`),
    check(
      "sales_order_items_progress_chk",
      sql`${t.packedQty} >= 0 and ${t.dispatchedQty} >= 0 and ${t.deliveredQty} >= 0 and ${t.invoicedQty} >= 0 and ${t.cancelledQty} >= 0`,
    ),
  ],
);

/**
 * Tax invoice / bill of supply. Drafts have no number; posting allocates the
 * number, writes stock ledger, party ledger and GST register rows in ONE
 * transaction. Posted invoices are never deleted: they are cancelled (voided),
 * which writes reversing entries and keeps the number.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    businessId: businessId(),
    invoiceNumber: varchar({ length: 16 }),
    seriesId: uuid().references(() => documentSeries.id),
    financialYear: varchar({ length: 9 }).notNull(),
    invoiceDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }),
    documentKind: documentKind().notNull().default("tax_invoice"),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    ...gstPartySnapshotColumns(),
    salesOrderId: uuid().references(() => salesOrders.id),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    priceLevelId: uuid().references(() => priceLevels.id),
    salespersonId: uuid().references(() => employees.id),
    status: documentStatus().notNull().default("draft"),
    ...documentTotalsColumns(),
    amountPaid: money().notNull().default("0"),
    balanceDue: money().notNull().default("0"),
    paymentStatus: paymentStatus().notNull().default("unpaid"),
    /** Cost of goods at posting (sum of qty_base x avg cost) for margin reports. */
    costTotal: money().notNull().default("0"),
    notes: text(),
    terms: text(),
    /** Language the invoice is printed in (can differ from the user's UI language). */
    printLocale: varchar({ length: 10 }).notNull().default("en"),
    // e-invoicing (IRP) and e-way bill; filled by integration adapters when enabled.
    irn: varchar({ length: 64 }),
    irnAckNumber: varchar({ length: 20 }),
    irnAckDate: tstz(),
    signedQrCode: text(),
    ewayBillNumber: varchar({ length: 12 }),
    ewayBillValidUntil: tstz(),
    postedAt: tstz(),
    postedBy: uuid(),
    cancelledAt: tstz(),
    cancelledBy: uuid(),
    cancelReason: text(),
    revision: integer().notNull().default(0),
    deviceId: uuid().references(() => devices.id),
    /** Idempotency key from the client (offline sync retries cannot create duplicates). */
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("invoices_number_uq").on(t.businessId, t.financialYear, t.invoiceNumber),
    uniqueIndex("invoices_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("invoices_customer_idx").on(t.businessId, t.customerId, t.invoiceDate),
    index("invoices_date_idx").on(t.businessId, t.invoiceDate),
    index("invoices_open_idx")
      .on(t.businessId, t.customerId, t.dueDate)
      .where(sql`${t.status} = 'posted' and ${t.balanceDue} > 0`),
    index("invoices_salesperson_idx").on(t.businessId, t.salespersonId, t.invoiceDate),
    check("invoices_posted_number_chk", sql`${t.status} = 'draft' or ${t.invoiceNumber} is not null`),
    check("invoices_totals_chk", sql`${t.grandTotal} >= 0 and ${t.amountPaid} >= 0 and ${t.balanceDue} >= 0`),
    check("invoices_number_format_chk", sql`${t.invoiceNumber} is null or ${t.invoiceNumber} ~ '^[A-Za-z0-9/-]{1,16}$'`),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: pk(),
    businessId: businessId(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    ...taxLineColumns(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    batchId: uuid().references(() => batches.id),
    orderItemId: uuid().references(() => salesOrderItems.id),
    /** Moving-average cost per base unit at posting time (margin reports). */
    unitCost: rate().notNull().default("0"),
    returnedQty: qty().notNull().default("0"),
  },
  (t) => [
    index("invoice_items_invoice_idx").on(t.invoiceId),
    index("invoice_items_product_idx").on(t.businessId, t.productId),
    check("invoice_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0`),
    check("invoice_items_amounts_chk", sql`${t.taxableValue} >= 0 and ${t.lineTotal} >= 0`),
  ],
);

/** Full snapshot of an invoice before each edit (who changed what, and the previous values). */
export const invoiceRevisions = pgTable(
  "invoice_revisions",
  {
    id: pk(),
    businessId: businessId(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    revision: integer().notNull(),
    snapshot: jsonb().notNull(),
    reason: text(),
    createdBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [unique("invoice_revisions_uq").on(t.invoiceId, t.revision)],
);

/** Status history for any workflow document (orders, packing, dispatch, leave, payroll...). */
export const statusHistory = pgTable(
  "status_history",
  {
    id: pk(),
    businessId: businessId(),
    entityType: varchar({ length: 30 }).notNull(),
    entityId: uuid().notNull(),
    fromStatus: varchar({ length: 30 }),
    toStatus: varchar({ length: 30 }).notNull(),
    note: text(),
    createdBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("status_history_entity_idx").on(t.entityType, t.entityId, t.createdAt)],
);

export const packings = pgTable(
  "packings",
  {
    id: pk(),
    businessId: businessId(),
    packingNumber: varchar({ length: 30 }),
    salesOrderId: uuid()
      .notNull()
      .references(() => salesOrders.id),
    status: packingStatus().notNull().default("in_progress"),
    boxCount: smallint().notNull().default(0),
    totalWeightKg: numeric({ precision: 10, scale: 3 }),
    packedBy: uuid().references(() => employees.id),
    packedAt: tstz(),
    notes: text(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("packings_number_uq").on(t.businessId, t.packingNumber),
    index("packings_order_idx").on(t.salesOrderId),
    check("packings_boxes_chk", sql`${t.boxCount} >= 0`),
  ],
);

export const packingItems = pgTable(
  "packing_items",
  {
    id: pk(),
    businessId: businessId(),
    packingId: uuid()
      .notNull()
      .references(() => packings.id, { onDelete: "cascade" }),
    orderItemId: uuid()
      .notNull()
      .references(() => salesOrderItems.id),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    batchId: uuid().references(() => batches.id),
    /** Base units packed in this packing session. */
    qty: qty().notNull(),
    boxNo: smallint(),
    scannedBarcode: varchar({ length: 64 }),
  },
  (t) => [index("packing_items_packing_idx").on(t.packingId), check("packing_items_qty_chk", sql`${t.qty} > 0`)],
);

/** One vehicle trip; can carry many orders on a route. */
export const dispatches = pgTable(
  "dispatches",
  {
    id: pk(),
    businessId: businessId(),
    dispatchNumber: varchar({ length: 30 }),
    dispatchDate: date({ mode: "string" }).notNull(),
    vehicleNumber: varchar({ length: 15 }),
    driverName: text(),
    driverMobile: varchar({ length: 15 }),
    driverEmployeeId: uuid().references(() => employees.id),
    transporterName: text(),
    transporterGstin: varchar({ length: 15 }),
    lrNumber: varchar({ length: 30 }),
    lrDate: date({ mode: "string" }),
    expectedDeliveryDate: date({ mode: "string" }),
    status: deliveryStatus().notNull().default("planned"),
    remarks: text(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("dispatches_number_uq").on(t.businessId, t.dispatchNumber),
    index("dispatches_date_idx").on(t.businessId, t.dispatchDate),
  ],
);

export const dispatchOrders = pgTable(
  "dispatch_orders",
  {
    id: pk(),
    businessId: businessId(),
    dispatchId: uuid()
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    /** Set when the goods were ordered first; a bill made at the counter travels without an order. */
    salesOrderId: uuid().references(() => salesOrders.id),
    packingId: uuid().references(() => packings.id),
    invoiceId: uuid().references(() => invoices.id),
    deliverySequence: smallint(),
    status: deliveryStatus().notNull().default("dispatched"),
    deliveredAt: tstz(),
    receivedBy: text(),
    podFileId: uuid().references(() => files.id),
    remarks: text(),
    ...auditColumns,
  },
  (t) => [
    // An order invoiced in parts can travel as several invoices on one trip; each invoice appears once.
    uniqueIndex("dispatch_orders_invoice_uq").on(t.dispatchId, t.invoiceId).where(sql`${t.invoiceId} is not null`),
    index("dispatch_orders_order_idx").on(t.salesOrderId),
    index("dispatch_orders_invoice_idx").on(t.invoiceId),
    check("dispatch_orders_document_chk", sql`${t.salesOrderId} is not null or ${t.invoiceId} is not null`),
  ],
);

/** Lines sold at a rate different from the price list (who changed it, from what, and why). */
export const priceOverrides = pgTable(
  "price_overrides",
  {
    id: pk(),
    businessId: businessId(),
    invoiceItemId: uuid()
      .notNull()
      .references(() => invoiceItems.id, { onDelete: "cascade" }),
    listRate: rate().notNull(),
    chargedRate: rate().notNull(),
    reason: text(),
    approvedBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("price_overrides_item_idx").on(t.invoiceItemId)],
);
