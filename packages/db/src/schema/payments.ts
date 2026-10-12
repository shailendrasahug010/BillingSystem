import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, money, pk, tstz, versioned } from "./columns.js";
import {
  chequeStatus,
  documentStatus,
  partyType,
  paymentAccountType,
  paymentDirection,
  paymentMethod,
} from "./enums.js";
import { employees } from "./hr.js";
import { creditDebitNotes } from "./notes.js";
import { customers, suppliers } from "./parties.js";
import { businessId, devices, documentSeries } from "./platform.js";
import { purchases } from "./purchases.js";
import { invoices } from "./sales.js";

/** Cash drawer, bank accounts, UPI handles: where money actually lands (cash book / bank book). */
export const paymentAccounts = pgTable(
  "payment_accounts",
  {
    id: pk(),
    businessId: businessId(),
    /** Name of the account (Cash, SBI current, Shop UPI ...), unique in the business. */
    name: text().notNull(),
    /** Cash, bank, UPI, wallet or card. */
    type: paymentAccountType().notNull(),
    /** Bank of the account. */
    bankName: text(),
    /** Last 4 digits of the account number. */
    accountNumberLast4: varchar({ length: 4 }),
    /** IFSC of the branch. */
    ifsc: varchar({ length: 11 }),
    /** UPI ID, printed on bills for customers to pay to. */
    upiId: text(),
    /** Balance when the account was brought into the app. */
    openingBalance: money().notNull().default("0"),
    /** Account offered first for new payments. */
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [unique("payment_accounts_name_uq").on(t.businessId, t.name)],
);

/**
 * Money in (customer collection) or out (supplier payment, salary, refund).
 * Posted payments are cancelled, never deleted; a cancellation writes
 * reversing party-ledger entries and releases its allocations.
 */
export const payments = pgTable(
  "payments",
  {
    id: pk(),
    businessId: businessId(),
    /** Receipt or voucher number from its series, unique per year and direction. */
    paymentNumber: varchar({ length: 30 }),
    /** Number series the payment was numbered from. */
    seriesId: uuid().references(() => documentSeries.id),
    /** Financial year of the payment (2026-27); its number is unique within it. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** in: money received (receipt); out: money paid (voucher). */
    direction: paymentDirection().notNull(),
    /** Who paid or was paid: customer, supplier, employee or other. */
    partyType: partyType().notNull(),
    /** The customer, for receipts and refunds. */
    customerId: uuid().references(() => customers.id),
    /** The supplier, for supplier payments. */
    supplierId: uuid().references(() => suppliers.id),
    /** The employee, for salary and advances. */
    employeeId: uuid().references(() => employees.id),
    /** Name of the party when it is none of the above. */
    otherPartyName: text(),
    /** Date the money was received or paid. */
    paymentDate: date({ mode: "string" }).notNull(),
    /** Amount of the payment. */
    amount: money().notNull(),
    /** Cash, UPI, bank transfer, cheque, card or other. */
    method: paymentMethod().notNull(),
    /** Account the money went into or came out of. */
    paymentAccountId: uuid().references(() => paymentAccounts.id),
    /** UTR / UPI reference / cheque number / card slip. */
    referenceNumber: varchar({ length: 40 }),
    /** Date written on the cheque. */
    chequeDate: date({ mode: "string" }),
    /** Bank the cheque is drawn on. */
    chequeBank: text(),
    /** Pending, deposited, cleared or bounced; a bounced cheque reverses the payment. */
    chequeStatus: chequeStatus(),
    /**
     * Income tax the customer deducted at source and pays the government for us (TDS, e.g. 0.1% on buying
     * goods): with the amount received it settles their bills. Claimed against the business's own tax.
     */
    tdsAmount: money().notNull().default("0"),
    /** What it was deducted under: goods (393(1), old 194Q), contract, commission, professional, rent, other. */
    tdsSection: varchar({ length: 20 }),
    /** The customer's TDS certificate (Form 16A) number, once it comes. */
    tdsCertificate: varchar({ length: 40 }),
    /** Part not yet applied to any bill: an advance or on-account amount, used against later bills. */
    unallocatedAmount: money().notNull().default("0"),
    /** Posted or cancelled. */
    status: documentStatus().notNull().default("posted"),
    notes: text(),
    /** Employee who collected the money (collection reports). */
    collectedById: uuid().references(() => employees.id),
    /** Reserved for a photo of the receipt (not filled). */
    receiptFileId: uuid(),
    /** When the payment was cancelled (it is kept; its ledger entries are reversed and its allocations released). */
    cancelledAt: tstz(),
    /** User who cancelled the payment. */
    cancelledBy: uuid(),
    /** Why it was cancelled. */
    cancelReason: text(),
    /** Device the payment was made on, when it was made offline. */
    deviceId: uuid().references(() => devices.id),
    /** Id the app gave the payment when it was made: a retried or offline save with the same id returns the saved payment instead of making a second one. */
    clientId: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    unique("payments_number_uq").on(t.businessId, t.financialYear, t.direction, t.paymentNumber),
    uniqueIndex("payments_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    index("payments_customer_idx").on(t.businessId, t.customerId, t.paymentDate),
    index("payments_supplier_idx").on(t.businessId, t.supplierId, t.paymentDate),
    index("payments_date_idx").on(t.businessId, t.paymentDate, t.method),
    check("payments_amount_chk", sql`${t.amount} > 0 and ${t.tdsAmount} >= 0 and ${t.unallocatedAmount} >= 0 and ${t.unallocatedAmount} <= ${t.amount} + ${t.tdsAmount}`),
    index("payments_tds_idx").on(t.businessId, t.paymentDate).where(sql`${t.tdsAmount} > 0`),
    check(
      "payments_party_chk",
      sql`(${t.partyType} = 'customer' and ${t.customerId} is not null)
       or (${t.partyType} = 'supplier' and ${t.supplierId} is not null)
       or (${t.partyType} = 'employee' and ${t.employeeId} is not null)
       or (${t.partyType} = 'other')`,
    ),
  ],
);

/** Which invoices / bills / notes a payment settles (partial payments, many-to-many). */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: pk(),
    businessId: businessId(),
    /** The payment. */
    paymentId: uuid()
      .notNull()
      .references(() => payments.id),
    /** The invoice it pays (exactly one of invoice, purchase or note is set). */
    invoiceId: uuid().references(() => invoices.id),
    /** The purchase bill it pays. */
    purchaseId: uuid().references(() => purchases.id),
    /** The credit or debit note it settles. */
    noteId: uuid().references(() => creditDebitNotes.id),
    /** Amount applied. */
    amount: money().notNull(),
    /** When it was applied. */
    allocatedAt: tstz().notNull().defaultNow(),
    /** User who applied it. */
    allocatedBy: uuid(),
    /** When the allocation was undone (cancelled payment or bounced cheque). */
    reversedAt: tstz(),
  },
  (t) => [
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_invoice_idx").on(t.invoiceId),
    index("payment_allocations_purchase_idx").on(t.purchaseId),
    check("payment_allocations_target_chk", sql`num_nonnulls(${t.invoiceId}, ${t.purchaseId}, ${t.noteId}) = 1`),
    check("payment_allocations_amount_chk", sql`${t.amount} > 0`),
  ],
);

/**
 * PARTY LEDGER — customer and supplier account statements. Append-only like
 * the stock ledger. Customer: invoice = debit, payment/credit note = credit.
 * Supplier: purchase = credit, payment/debit note = debit.
 */
export const partyLedgerEntries = pgTable(
  "party_ledger_entries",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    businessId: businessId(),
    /** customer or supplier. */
    partyType: partyType().notNull(),
    /** The customer, for customer entries. */
    customerId: uuid().references(() => customers.id),
    /** The supplier, for supplier entries. */
    supplierId: uuid().references(() => suppliers.id),
    /** Date of the entry (the document's date). */
    entryDate: date({ mode: "string" }).notNull(),
    /** Source document: invoice, payment, credit_note, purchase, opening ... */
    docType: varchar({ length: 30 }).notNull(),
    /** Id of the source document. */
    docId: uuid(),
    /** Number of the source document, for statements. */
    docNumber: varchar({ length: 40 }),
    /** Debit amount: what a customer owes more (or what we owe a supplier less). */
    debit: money().notNull().default("0"),
    /** Credit amount: what a customer owes less (or what we owe a supplier more). */
    credit: money().notNull().default("0"),
    /** Line shown on the statement. */
    narration: text(),
    /** Set on entries that reverse an earlier one (cancellations). */
    reversesEntryId: bigint({ mode: "number" }),
    createdBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index("party_ledger_customer_idx").on(t.businessId, t.customerId, t.entryDate, t.id),
    index("party_ledger_supplier_idx").on(t.businessId, t.supplierId, t.entryDate, t.id),
    index("party_ledger_doc_idx").on(t.docType, t.docId),
    check(
      "party_ledger_amount_chk",
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and ((${t.debit} > 0) <> (${t.credit} > 0))`,
    ),
    check(
      "party_ledger_party_chk",
      sql`(${t.partyType} = 'customer' and ${t.customerId} is not null and ${t.supplierId} is null)
       or (${t.partyType} = 'supplier' and ${t.supplierId} is not null and ${t.customerId} is null)`,
    ),
  ],
);

/**
 * A collector's visit when the money did not come: a note ("shop closed") or
 * the customer's promise to pay by a date (and how much, if they said).
 * Shown on Outstanding; a promise stays open until the customer next pays.
 */
export const collectionNotes = pgTable(
  "collection_notes",
  {
    id: pk(),
    businessId: businessId(),
    /** The customer visited. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** promise | note */
    kind: varchar({ length: 10 }).notNull(),
    note: text(),
    /** How much the customer said they would pay, if they said. */
    promisedAmount: money(),
    /** Date the customer promised to pay by (required for a promise). */
    promisedOn: date({ mode: "string" }),
    /** Date of the visit. */
    visitedOn: date({ mode: "string" }).notNull(),
    ...auditColumns,
  },
  (t) => [
    check("collection_notes_kind_chk", sql`${t.kind} in ('promise', 'note')`),
    check("collection_notes_promise_chk", sql`${t.kind} <> 'promise' or ${t.promisedOn} is not null`),
    index("collection_notes_customer_idx").on(t.businessId, t.customerId, t.createdAt),
  ],
);
