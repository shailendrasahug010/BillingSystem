import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgTable, text, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, pk, rate, tstz, versioned } from "./columns.js";
import { documentTotalsColumns, gstPartySnapshotColumns, taxLineColumns } from "./document-lines.js";
import { documentStatus, noteReason, noteType, partyType, paymentStatus } from "./enums.js";
import { batches, products, units } from "./catalog.js";
import { customers, suppliers } from "./parties.js";
import { businessId, devices, documentSeries, warehouses } from "./platform.js";
import { purchases } from "./purchases.js";
import { invoices } from "./sales.js";

/**
 * Credit and debit notes for both sides:
 *  - customer credit note: sales return / post-sale discount (reduces receivable, outward GST)
 *  - customer debit note: price increase after invoicing
 *  - supplier side: purchase return / supplier credit note (reduces payable, inward GST)
 * When `affects_stock` is true, posting moves stock (sale_return / purchase_return).
 */
export const creditDebitNotes = pgTable(
  "credit_debit_notes",
  {
    id: pk(),
    businessId: businessId(),
    noteType: noteType().notNull(),
    partyType: partyType().notNull(),
    customerId: uuid().references(() => customers.id),
    supplierId: uuid().references(() => suppliers.id),
    noteNumber: varchar({ length: 16 }),
    /** Supplier's own note number when we record a note they issued. */
    partyNoteNumber: varchar({ length: 30 }),
    seriesId: uuid().references(() => documentSeries.id),
    financialYear: varchar({ length: 9 }).notNull(),
    noteDate: date({ mode: "string" }).notNull(),
    reason: noteReason().notNull(),
    invoiceId: uuid().references(() => invoices.id),
    purchaseId: uuid().references(() => purchases.id),
    affectsStock: boolean().notNull().default(false),
    warehouseId: uuid().references(() => warehouses.id),
    ...gstPartySnapshotColumns(),
    status: documentStatus().notNull().default("draft"),
    ...documentTotalsColumns(),
    /** Amount adjusted against invoices / refunded so far. */
    amountSettled: money().notNull().default("0"),
    settlementStatus: paymentStatus().notNull().default("unpaid"),
    notes: text(),
    /** A credit note to a registered buyer: the e-invoice IRN, acknowledgement and signed QR code from the IRP. */
    irn: varchar({ length: 64 }),
    irnAckNumber: varchar({ length: 20 }),
    irnAckDate: tstz(),
    signedQrCode: text(),
    postedAt: tstz(),
    cancelledAt: tstz(),
    cancelReason: text(),
    deviceId: uuid().references(() => devices.id),
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("credit_debit_notes_number_uq").on(t.businessId, t.financialYear, t.noteType, t.partyType, t.noteNumber),
    uniqueIndex("credit_debit_notes_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("credit_debit_notes_customer_idx").on(t.businessId, t.customerId, t.noteDate),
    index("credit_debit_notes_supplier_idx").on(t.businessId, t.supplierId, t.noteDate),
    check(
      "credit_debit_notes_party_chk",
      sql`(${t.partyType} = 'customer' and ${t.customerId} is not null and ${t.supplierId} is null)
       or (${t.partyType} = 'supplier' and ${t.supplierId} is not null and ${t.customerId} is null)`,
    ),
    check("credit_debit_notes_warehouse_chk", sql`not ${t.affectsStock} or ${t.warehouseId} is not null`),
  ],
);

export const creditDebitNoteItems = pgTable(
  "credit_debit_note_items",
  {
    id: pk(),
    businessId: businessId(),
    noteId: uuid()
      .notNull()
      .references(() => creditDebitNotes.id, { onDelete: "cascade" }),
    ...taxLineColumns(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    batchId: uuid().references(() => batches.id),
    unitCost: rate().notNull().default("0"),
    originalLineId: uuid(),
  },
  (t) => [index("credit_debit_note_items_note_idx").on(t.noteId), check("credit_debit_note_items_qty_chk", sql`${t.qty} > 0`)],
);
