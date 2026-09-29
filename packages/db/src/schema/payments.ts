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
    name: text().notNull(),
    type: paymentAccountType().notNull(),
    bankName: text(),
    accountNumberLast4: varchar({ length: 4 }),
    ifsc: varchar({ length: 11 }),
    upiId: text(),
    openingBalance: money().notNull().default("0"),
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
    paymentNumber: varchar({ length: 30 }),
    seriesId: uuid().references(() => documentSeries.id),
    financialYear: varchar({ length: 9 }).notNull(),
    direction: paymentDirection().notNull(),
    partyType: partyType().notNull(),
    customerId: uuid().references(() => customers.id),
    supplierId: uuid().references(() => suppliers.id),
    employeeId: uuid().references(() => employees.id),
    otherPartyName: text(),
    paymentDate: date({ mode: "string" }).notNull(),
    amount: money().notNull(),
    method: paymentMethod().notNull(),
    paymentAccountId: uuid().references(() => paymentAccounts.id),
    /** UTR / UPI reference / cheque number / card slip. */
    referenceNumber: varchar({ length: 40 }),
    chequeDate: date({ mode: "string" }),
    chequeBank: text(),
    chequeStatus: chequeStatus(),
    unallocatedAmount: money().notNull().default("0"),
    status: documentStatus().notNull().default("posted"),
    notes: text(),
    collectedById: uuid().references(() => employees.id),
    receiptFileId: uuid(),
    cancelledAt: tstz(),
    cancelledBy: uuid(),
    cancelReason: text(),
    deviceId: uuid().references(() => devices.id),
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
    check("payments_amount_chk", sql`${t.amount} > 0 and ${t.unallocatedAmount} >= 0 and ${t.unallocatedAmount} <= ${t.amount}`),
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
    paymentId: uuid()
      .notNull()
      .references(() => payments.id),
    invoiceId: uuid().references(() => invoices.id),
    purchaseId: uuid().references(() => purchases.id),
    noteId: uuid().references(() => creditDebitNotes.id),
    amount: money().notNull(),
    allocatedAt: tstz().notNull().defaultNow(),
    allocatedBy: uuid(),
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
    partyType: partyType().notNull(),
    customerId: uuid().references(() => customers.id),
    supplierId: uuid().references(() => suppliers.id),
    entryDate: date({ mode: "string" }).notNull(),
    docType: varchar({ length: 30 }).notNull(),
    docId: uuid(),
    docNumber: varchar({ length: 40 }),
    debit: money().notNull().default("0"),
    credit: money().notNull().default("0"),
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
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** promise | note */
    kind: varchar({ length: 10 }).notNull(),
    note: text(),
    promisedAmount: money(),
    promisedOn: date({ mode: "string" }),
    visitedOn: date({ mode: "string" }).notNull(),
    ...auditColumns,
  },
  (t) => [
    check("collection_notes_kind_chk", sql`${t.kind} in ('promise', 'note')`),
    check("collection_notes_promise_chk", sql`${t.kind} <> 'promise' or ${t.promisedOn} is not null`),
    index("collection_notes_customer_idx").on(t.businessId, t.customerId, t.createdAt),
  ],
);
