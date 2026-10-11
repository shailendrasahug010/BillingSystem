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
    /** credit (lowers what the party owes, or what we owe a supplier is lowered by their credit) or debit. */
    noteType: noteType().notNull(),
    /** customer (our note on a sale) or supplier (a note on a purchase). */
    partyType: partyType().notNull(),
    /** The customer, for notes on sales. */
    customerId: uuid().references(() => customers.id),
    /** The supplier, for notes on purchases. */
    supplierId: uuid().references(() => suppliers.id),
    /** Number from the note series (up to 16 characters, as GST requires), unique per year, type and party side. */
    noteNumber: varchar({ length: 16 }),
    /** Supplier's own note number when we record a note they issued. */
    partyNoteNumber: varchar({ length: 30 }),
    /** Number series the note was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the note (2026-27); its number is unique within it. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** Date of the note (decides the GST period). */
    noteDate: date({ mode: "string" }).notNull(),
    /** Sales return, purchase return, discount, rate difference, damage or other. */
    reason: noteReason().notNull(),
    /** The invoice the note is against (customer notes). */
    invoiceId: uuid().references(() => invoices.id),
    /** The purchase bill the note is against (supplier notes). */
    purchaseId: uuid().references(() => purchases.id),
    /** Whether goods move: returns bring stock in (or send it back to the supplier); discounts and rate differences move only value. */
    affectsStock: boolean().notNull().default(false),
    /** Godown the returned goods go into or leave from (required when affects_stock). */
    warehouseId: uuid().references(() => warehouses.id),
    ...gstPartySnapshotColumns(),
    /** Draft, posted or cancelled. */
    status: documentStatus().notNull().default("draft"),
    ...documentTotalsColumns(),
    /** Amount adjusted against invoices / refunded so far. */
    amountSettled: money().notNull().default("0"),
    /** How much of the note is used: unpaid (none), partial or paid (all adjusted or refunded). */
    settlementStatus: paymentStatus().notNull().default("unpaid"),
    notes: text(),
    /** A credit note to a registered buyer: the e-invoice IRN, acknowledgement and signed QR code from the IRP. */
    irn: varchar({ length: 64 }),
    /** Acknowledgement number from the IRP. */
    irnAckNumber: varchar({ length: 20 }),
    /** Acknowledgement date and time from the IRP. */
    irnAckDate: tstz(),
    /** Signed QR code text from the IRP, printed as a QR code. */
    signedQrCode: text(),
    /** When the note was posted (numbered, and its stock, ledger and GST entries written). */
    postedAt: tstz(),
    /** When the note was cancelled. A cancelled note is kept with its number; cancelling reverses its stock, ledger and GST entries. */
    cancelledAt: tstz(),
    /** Why it was cancelled. */
    cancelReason: text(),
    /** Device the note was made on, when it was made offline. */
    deviceId: uuid().references(() => devices.id),
    /** Id the app gave the note when it was made: a retried or offline save with the same id returns the saved note instead of making a second one. */
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
    /** The note. */
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
    /** The batch returned, for products kept by batch. */
    batchId: uuid().references(() => batches.id),
    /** Cost per base unit of returned goods (for stock value and margin). */
    unitCost: rate().notNull().default("0"),
    /** The invoice or purchase line this line returns or re-prices. */
    originalLineId: uuid(),
  },
  (t) => [index("credit_debit_note_items_note_idx").on(t.noteId), check("credit_debit_note_items_qty_chk", sql`${t.qty} > 0`)],
);

/**
 * A credit note not against one bill (goods returned without their bill)
 * settles the customer's open bills, oldest due first, like a payment does;
 * each bill it went to, and how much. Cancelling the note gives it back.
 */
export const noteAllocations = pgTable(
  "note_allocations",
  {
    id: pk(),
    businessId: businessId(),
    noteId: uuid()
      .notNull()
      .references(() => creditDebitNotes.id),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    amount: money().notNull(),
    /** When it was given back (the note cancelled). */
    reversedAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("note_allocations_note_idx").on(t.noteId), index("note_allocations_invoice_idx").on(t.invoiceId), check("note_allocations_amount_chk", sql`${t.amount} > 0`)],
);
