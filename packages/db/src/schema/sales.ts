import { sql } from "drizzle-orm";
import {
  boolean,
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
  invoiceReviewStatus,
  orderStatus,
  packingStatus,
  paymentStatus,
} from "./enums.js";
import { batches, products, units } from "./catalog.js";
import { schemes } from "./schemes.js";
import { employees } from "./hr.js";
import { customers, priceLevels } from "./parties.js";
import { businessId, devices, documentSeries, files, users, warehouses } from "./platform.js";
import { tdsChallans } from "./tax.js";

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: pk(),
    businessId: businessId(),
    /** Number from the order series, given when the order is saved. */
    orderNumber: varchar({ length: 30 }),
    /** Number series the order was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the order (2026-27); its number is unique within it. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** Date of the order. */
    orderDate: date({ mode: "string" }).notNull(),
    /** When the customer expects the goods. */
    expectedDeliveryDate: date({ mode: "string" }),
    /** Number of the quotation the order started as (kept when the customer accepts it). */
    quotationNumber: varchar({ length: 30 }),
    /** A quotation's offer holds until this date. */
    validUntil: date({ mode: "string" }),
    /** Delivery challan for goods sent before the bill: its number, given once. */
    challanNumber: varchar({ length: 30 }),
    /** Date of the delivery challan (the day it was first printed). */
    challanDate: date({ mode: "string" }),
    /** The customer who ordered. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** Godown the order is packed from. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** Price list the order was priced on. */
    priceLevelId: uuid().references(() => priceLevels.id),
    /** Salesperson who took the order. */
    salespersonId: uuid().references(() => employees.id),
    /** Draft, pending, confirmed, packing, packed, dispatched, delivered or cancelled (steps per business; moves are recorded in status_history). */
    status: orderStatus().notNull().default("draft"),
    /** Where the order came from: counter, salesperson app, phone, WhatsApp... */
    source: varchar({ length: 20 }).notNull().default("app"),
    /** GST state code of the place of supply. */
    placeOfSupply: char({ length: 2 }).notNull(),
    ...documentTotalsColumns(),
    notes: text(),
    /** When the order was cancelled. */
    cancelledAt: tstz(),
    /** Why it was cancelled. */
    cancelReason: text(),
    /** Device the order was made on, when it was made offline. */
    deviceId: uuid().references(() => devices.id),
    /** Id the app gave the order when it was made: a retried or offline save with the same id returns the saved order instead of making a second one. */
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
    /** The order. */
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
    /** Base units sent on a trip. */
    dispatchedQty: qty().notNull().default("0"),
    /** Base units delivered. */
    deliveredQty: qty().notNull().default("0"),
    /** Base units already billed (an order can be billed in parts). */
    invoicedQty: qty().notNull().default("0"),
    /** Base units no longer to be supplied. */
    cancelledQty: qty().notNull().default("0"),
    /** The scheme that gave this line's scheme discount, or the whole line free. */
    schemeId: uuid().references(() => schemes.id),
    /** Rupees of the line's discount that the scheme gave (part of discount_amount). */
    schemeDiscount: money().notNull().default("0"),
    /** Goods given free under the scheme: the whole line, at 100% discount. */
    schemeFree: boolean().notNull().default(false),
  },
  (t) => [
    index("sales_order_items_order_idx").on(t.orderId),
    check("sales_order_items_scheme_chk", sql`${t.schemeId} is not null or (not ${t.schemeFree} and ${t.schemeDiscount} = 0)`),
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
    /** GST invoice number (up to 16 letters, digits, / and -), unique in the financial year; empty while a draft. */
    invoiceNumber: varchar({ length: 16 }),
    /** Number series the invoice was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the invoice (2026-27); its number is unique within it. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** Date of the invoice (decides the GST period and the tax rules that apply). */
    invoiceDate: date({ mode: "string" }).notNull(),
    /** When payment is due: invoice date + the customer's credit days. */
    dueDate: date({ mode: "string" }),
    /** Tax invoice, or bill of supply (no GST charged: exempt goods or a composition dealer). */
    documentKind: documentKind().notNull().default("tax_invoice"),
    /** The customer billed. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    ...gstPartySnapshotColumns(),
    /** The order the invoice bills, when it was ordered first. */
    salesOrderId: uuid().references(() => salesOrders.id),
    /** Godown the goods left from. */
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** Price list the invoice was priced on. */
    priceLevelId: uuid().references(() => priceLevels.id),
    /** Salesperson credited with the sale (salesperson-wise reports). */
    salespersonId: uuid().references(() => employees.id),
    /** Draft, posted or cancelled. */
    status: documentStatus().notNull().default("draft"),
    ...documentTotalsColumns(),
    /** Paid so far against this invoice (payments allocated to it, and payment at the time of the invoice). */
    amountPaid: money().notNull().default("0"),
    /** Raised after the bill by debit notes (a rate difference, charges): owed on it besides its total. */
    debited: money().notNull().default("0"),
    /** Still to be paid: grand total less amount paid and returns / credit notes against it. */
    balanceDue: money().notNull().default("0"),
    /** Unpaid, partly paid or paid. */
    paymentStatus: paymentStatus().notNull().default("unpaid"),
    /** Cost of goods at posting (sum of qty_base x avg cost) for margin reports. */
    costTotal: money().notNull().default("0"),
    /** TCS collected on the bill (specified goods, 394(1)): part of the grand total, outside the GST value. */
    tcsAmount: money().notNull().default("0"),
    /** How the TCS was worked out: [{goods, rate, base, amount}] per kind of goods; null without it. */
    tcs: jsonb().$type<Array<{ goods: string; rate: string; base: string; amount: string }>>(),
    /** The challan that paid the TCS to the government. */
    tcsChallanId: uuid().references(() => tdsChallans.id),
    notes: text(),
    /** Terms and conditions printed at the foot of the invoice. */
    terms: text(),
    /** Language the invoice is printed in (can differ from the user's UI language). */
    printLocale: varchar({ length: 10 }).notNull().default("en"),
    /**
     * Zero-rated supply: an export or a supply to an SEZ unit, with or without payment
     * of IGST (EXPWP, EXPWOP, SEZWP, SEZWOP, as GSTR-1 names them); null for other sales.
     */
    zeroRatedType: varchar({ length: 6 }),
    /** Exports: the shipping bill and port (often known only after the invoice; can be added later). */
    shippingBillNumber: varchar({ length: 20 }),
    /** Date of the shipping bill. */
    shippingBillDate: date({ mode: "string" }),
    /** Port code of the shipping bill (6 characters). */
    portCode: varchar({ length: 6 }),
    /** Without payment of IGST: the letter of undertaking (ARN) it was made under, printed on the invoice. */
    lutArn: varchar({ length: 20 }),
    // e-invoicing (IRP) and e-way bill: entered from the portals' replies (or filled by an adapter).
    /** Invoice Reference Number from the e-invoice portal (IRP), 64 characters. */
    irn: varchar({ length: 64 }),
    /** Acknowledgement number the IRP gave with the IRN. */
    irnAckNumber: varchar({ length: 20 }),
    /** Acknowledgement date and time from the IRP. */
    irnAckDate: tstz(),
    /** Signed QR code text from the IRP; the QR code printed on the invoice is drawn from it. */
    signedQrCode: text(),
    /** E-way bill number (12 digits) for moving the goods. */
    ewayBillNumber: varchar({ length: 12 }),
    /** When the e-way bill was generated. */
    ewayBillDate: tstz(),
    /** Until when the e-way bill is valid. */
    ewayBillValidUntil: tstz(),
    /** When the invoice was posted (numbered, and its stock, ledger and GST entries written). */
    postedAt: tstz(),
    /** User who posted the invoice. */
    postedBy: uuid(),
    /** When the invoice was cancelled. A cancelled invoice is kept with its number; cancelling reverses its stock, ledger and GST entries. */
    cancelledAt: tstz(),
    /** User who cancelled the invoice. */
    cancelledBy: uuid(),
    /** Why it was cancelled. */
    cancelReason: text(),
    /** Reserved for editing posted invoices (stays 0: posted invoices are cancelled and made again). */
    revision: integer().notNull().default(0),
    /** Device the invoice was made on, when it was made offline. */
    deviceId: uuid().references(() => devices.id),
    /** Idempotency key from the client (offline sync retries cannot create duplicates). */
    clientId: uuid(),
    /**
     * A bill made offline that broke a rule by the time it reached the server
     * (a price changed meanwhile, the customer or a product was made inactive,
     * its GST month was locked, it was sent over a week late, or stock or
     * credit went past a limit set to block) is accepted, as the customer
     * already has it, and held for a manager: needs_review until someone with
     * invoice.review marks it reviewed. Null for every other bill.
     */
    reviewStatus: invoiceReviewStatus(),
    /** Why it was held: [{code, params}], codes price_changed, customer_inactive, product_inactive, period_locked, late_sync, stock_short, credit_limit, credit_overdue. */
    reviewReasons: jsonb().$type<Array<{ code: string; params?: Record<string, string | number> }>>(),
    /** User who marked it reviewed (or cancelled it while it was held). */
    reviewedBy: uuid(),
    /** When it was marked reviewed. */
    reviewedAt: tstz(),
    /** What the reviewer noted (for example the credit note issued for it). */
    reviewNote: text(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("invoices_number_uq").on(t.businessId, t.financialYear, t.invoiceNumber),
    index("invoices_review_idx").on(t.businessId, t.postedAt).where(sql`${t.reviewStatus} = 'needs_review'`),
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
    check("invoices_zero_rated_chk", sql`${t.zeroRatedType} is null or ${t.zeroRatedType} in ('EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP')`),
    check("invoices_tcs_chk", sql`${t.tcsAmount} >= 0 and ${t.tcsAmount} <= ${t.grandTotal}`),
    index("invoices_tcs_idx").on(t.businessId, t.invoiceDate).where(sql`${t.tcsAmount} > 0`),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: pk(),
    businessId: businessId(),
    /** The invoice. */
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
    /** The batch sold, for products kept by batch. */
    batchId: uuid().references(() => batches.id),
    /** The order line this line bills. */
    orderItemId: uuid().references(() => salesOrderItems.id),
    /** Moving-average cost per base unit at posting time (margin reports). */
    unitCost: rate().notNull().default("0"),
    /** Quantity already returned (credit notes); no more than was sold can be returned. */
    returnedQty: qty().notNull().default("0"),
    /** The scheme that gave this line's scheme discount, or the whole line free. */
    schemeId: uuid().references(() => schemes.id),
    /** Rupees of the line's discount that the scheme gave (part of discount_amount). */
    schemeDiscount: money().notNull().default("0"),
    /** Goods given free under the scheme: the whole line, at 100% discount. */
    schemeFree: boolean().notNull().default(false),
  },
  (t) => [
    index("invoice_items_invoice_idx").on(t.invoiceId),
    index("invoice_items_product_idx").on(t.businessId, t.productId),
    // The scheme claim report.
    index("invoice_items_scheme_idx").on(t.businessId, t.schemeId).where(sql`${t.schemeId} is not null`),
    check("invoice_items_scheme_chk", sql`${t.schemeId} is not null or (not ${t.schemeFree} and ${t.schemeDiscount} = 0)`),
    check("invoice_items_qty_chk", sql`${t.qty} > 0 and ${t.freeQty} >= 0`),
    check("invoice_items_amounts_chk", sql`${t.taxableValue} >= 0 and ${t.lineTotal} >= 0`),
  ],
);

/**
 * Full snapshot of an invoice before each edit (who changed what, and the previous values).
 * Not written yet: posted invoices are not edited but cancelled and made again.
 */
export const invoiceRevisions = pgTable(
  "invoice_revisions",
  {
    id: pk(),
    businessId: businessId(),
    /** The invoice. */
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    /** Revision number (1, 2 ...). */
    revision: integer().notNull(),
    /** The whole invoice with its lines as it was before the change. */
    snapshot: jsonb().notNull(),
    /** Why it was changed. */
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
    /** Kind of record: sales_order, packing, dispatch ... */
    entityType: varchar({ length: 30 }).notNull(),
    /** Id of the record. */
    entityId: uuid().notNull(),
    /** Status before (empty when the record was made). */
    fromStatus: varchar({ length: 30 }),
    /** Status after. */
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
    /** Number from the packing series. */
    packingNumber: varchar({ length: 30 }),
    /** The order being packed. */
    salesOrderId: uuid()
      .notNull()
      .references(() => salesOrders.id),
    /** In progress, packed or cancelled. */
    status: packingStatus().notNull().default("in_progress"),
    /** Number of boxes packed. */
    boxCount: smallint().notNull().default(0),
    /** Total weight in kg, when weighed. */
    totalWeightKg: numeric({ precision: 10, scale: 3 }),
    /** Employee who packed it. */
    packedBy: uuid().references(() => employees.id),
    /** When packing was finished. */
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
    /** The packing. */
    packingId: uuid()
      .notNull()
      .references(() => packings.id, { onDelete: "cascade" }),
    /** The order line packed. */
    orderItemId: uuid()
      .notNull()
      .references(() => salesOrderItems.id),
    /** The product packed. */
    productId: uuid()
      .notNull()
      .references(() => products.id),
    /** The batch picked (first-expiry-first). */
    batchId: uuid().references(() => batches.id),
    /** Base units packed in this packing session. */
    qty: qty().notNull(),
    /** Box the goods went into (1, 2 ...). */
    boxNo: smallint(),
    /** Barcode scanned when packing, when it was scanned. */
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
    /** Number from the dispatch series. */
    dispatchNumber: varchar({ length: 30 }),
    /** Date of the trip. */
    dispatchDate: date({ mode: "string" }).notNull(),
    /** Vehicle registration number (also for the e-way bill). */
    vehicleNumber: varchar({ length: 15 }),
    /** Driver's name. */
    driverName: text(),
    /** Driver's mobile number. */
    driverMobile: varchar({ length: 15 }),
    /** The driver, when an employee. */
    driverEmployeeId: uuid().references(() => employees.id),
    /** Transport company, when the goods go by a transporter. */
    transporterName: text(),
    /** Transporter's GSTIN (or transporter ID) for the e-way bill. */
    transporterGstin: varchar({ length: 15 }),
    /** Lorry receipt (LR / consignment note) number. */
    lrNumber: varchar({ length: 30 }),
    /** Date of the lorry receipt. */
    lrDate: date({ mode: "string" }),
    /** When the goods should arrive. */
    expectedDeliveryDate: date({ mode: "string" }),
    /** Planned, dispatched, in transit, delivered, partly delivered, returned or cancelled. */
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
    /** The trip. */
    dispatchId: uuid()
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    /** Set when the goods were ordered first; a bill made at the counter travels without an order. */
    salesOrderId: uuid().references(() => salesOrders.id),
    /** The packing travelling, when packed first. */
    packingId: uuid().references(() => packings.id),
    /** The bill travelling. */
    invoiceId: uuid().references(() => invoices.id),
    /** Stop number on the trip (delivery order). */
    deliverySequence: smallint(),
    /** Delivery status of this stop: dispatched, delivered, partly delivered or returned. */
    status: deliveryStatus().notNull().default("dispatched"),
    /** When the stop was marked delivered. */
    deliveredAt: tstz(),
    /** Name of the person who received the goods. */
    receivedBy: text(),
    /** Proof of delivery file (photo attachments were dropped; not filled). */
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

/**
 * Lines sold at a rate different from the price list (who changed it, from what, and why).
 * Not written yet.
 */
export const priceOverrides = pgTable(
  "price_overrides",
  {
    id: pk(),
    businessId: businessId(),
    /** The invoice line. */
    invoiceItemId: uuid()
      .notNull()
      .references(() => invoiceItems.id, { onDelete: "cascade" }),
    /** Rate on the price list. */
    listRate: rate().notNull(),
    /** Rate charged. */
    chargedRate: rate().notNull(),
    /** Why the rate was changed. */
    reason: text(),
    /** User who allowed the change. */
    approvedBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("price_overrides_item_idx").on(t.invoiceItemId)],
);

/**
 * A bill made again every week or month for a regular customer (rent, a
 * monthly supply, a service contract). The lines are copied from the bill it
 * was set up from and posted like any bill, dated the day it falls due. The
 * job moves `next_date` on after each bill; a bill that cannot be made
 * (credit or stock blocked) is tried again the next day.
 */
export const recurringInvoices = pgTable(
  "recurring_invoices",
  {
    id: pk(),
    businessId: businessId(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** The bill it was set up from. */
    sourceInvoiceId: uuid().references(() => invoices.id),
    /** weekly or monthly. */
    frequency: varchar({ length: 10 }).notNull(),
    /** Day of the month a monthly bill keeps to (1-31; shorter months use their last day). */
    anchorDay: smallint().notNull(),
    /** Date of the next bill. */
    nextDate: date({ mode: "string" }).notNull(),
    /** No bills after this date (empty: until stopped). */
    endDate: date({ mode: "string" }),
    /** The bill to post: the POST /invoices body without its date or payment. */
    template: jsonb().notNull().$type<Record<string, unknown>>(),
    isActive: boolean().notNull().default(true),
    /** The latest bill made. */
    lastInvoiceId: uuid().references(() => invoices.id),
    /** Bills made so far. */
    billsMade: integer().notNull().default(0),
    /** The day the job last tried it: a blocked bill is tried once a day, not on every run. */
    lastTriedOn: date({ mode: "string" }),
    /** Why the last try failed (an error code), cleared once a bill is made. */
    lastError: varchar({ length: 60 }),
    /** Whose name the bills are made in. */
    ownerId: uuid()
      .notNull()
      .references(() => users.id),
    ...auditColumns,
  },
  (t) => [
    index("recurring_invoices_due_idx").on(t.businessId, t.isActive, t.nextDate),
    index("recurring_invoices_customer_idx").on(t.businessId, t.customerId),
    check("recurring_invoices_frequency_chk", sql`${t.frequency} in ('weekly', 'monthly')`),
    check("recurring_invoices_day_chk", sql`${t.anchorDay} between 1 and 31`),
  ],
);

/**
 * Order links: a private web address for one customer (a shop), sent to them
 * on WhatsApp, where they see their own rates and place orders without
 * signing in, and (when the business chooses) their bills, what they owe, their
 * statement and a UPI link to pay. The orders land in Sales orders, waiting to
 * be confirmed. Only the key's hash is looked up; a new link replaces the old one.
 */
export const orderLinks = pgTable(
  "order_links",
  {
    id: pk(),
    businessId: businessId(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** SHA-256 of the key in the link (hex), to find the link by. */
    keyHash: char({ length: 64 }).notNull(),
    /** The key itself, encrypted, so the link can be copied again. */
    keySealed: text().notNull(),
    /** Whose name the orders are booked in. */
    ownerId: uuid()
      .notNull()
      .references(() => users.id),
    /** Turned off: the link no longer opens. */
    revokedAt: tstz(),
    lastUsedAt: tstz(),
    ordersPlaced: integer().notNull().default(0),
    /** The page also shows the shop its bills, what it owes, its statement and a way to pay (links made before this: off until turned on). */
    showsAccount: boolean().notNull().default(false),
    ...auditColumns,
  },
  (t) => [uniqueIndex("order_links_key_idx").on(t.keyHash), index("order_links_customer_idx").on(t.businessId, t.customerId)],
);
