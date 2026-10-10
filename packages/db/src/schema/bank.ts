import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, pk, tstz } from "./columns.js";
import { documentStatus } from "./enums.js";
import { expenses } from "./expenses.js";
import { paymentAccounts, payments } from "./payments.js";
import { businessId } from "./platform.js";

/**
 * Money moved between the business's own accounts: cash deposited in the
 * bank, cash drawn from it, or one bank account to another. It changes
 * neither a party's balance nor profit; the cash book and the bank book
 * show it.
 */
export const accountTransfers = pgTable(
  "account_transfers",
  {
    id: pk(),
    businessId: businessId(),
    /** Date the money moved. */
    transferDate: date({ mode: "string" }).notNull(),
    /** Account the money left (the cash drawer for a deposit). */
    fromAccountId: uuid()
      .notNull()
      .references(() => paymentAccounts.id),
    /** Account the money reached (the bank for a deposit). */
    toAccountId: uuid()
      .notNull()
      .references(() => paymentAccounts.id),
    /** Amount moved. */
    amount: money().notNull(),
    /** The bank's reference for it, when there is one. */
    reference: varchar({ length: 40 }),
    notes: text(),
    /** Posted or cancelled (kept, never deleted). */
    status: documentStatus().notNull().default("posted"),
    /** When it was cancelled. */
    cancelledAt: tstz(),
    /** User who cancelled it. */
    cancelledBy: uuid(),
    ...auditColumns,
  },
  (t) => [
    index("account_transfers_date_idx").on(t.businessId, t.transferDate),
    check("account_transfers_chk", sql`${t.amount} > 0 and ${t.fromAccountId} <> ${t.toAccountId}`),
  ],
);

/**
 * A bank statement as imported for one of the business's accounts (the CSV,
 * Excel or PDF from net banking, read in the browser). Its lines are kept
 * and reconciled one by one; an overlapping statement brings only the
 * lines not already saved.
 */
export const bankStatements = pgTable(
  "bank_statements",
  {
    id: pk(),
    businessId: businessId(),
    /** The account the statement is of. */
    paymentAccountId: uuid()
      .notNull()
      .references(() => paymentAccounts.id),
    /** Name of the file it was read from. */
    fileName: text(),
    /** First and last dates of its lines. */
    periodFrom: date({ mode: "string" }).notNull(),
    periodTo: date({ mode: "string" }).notNull(),
    /** The bank's balance after its last line, when the statement shows balances. */
    closingBalance: money(),
    /** Lines it brought that were not already saved from an earlier statement. */
    linesAdded: integer().notNull().default(0),
    /** Lines it had that an earlier statement had already brought. */
    linesKnown: integer().notNull().default(0),
    ...auditColumns,
  },
  (t) => [index("bank_statements_account_idx").on(t.businessId, t.paymentAccountId, t.periodTo)],
);

export const bankLineStatus = pgEnum("bank_line_status", ["open", "reconciled", "ignored"]);

/** What the app suggested for a line when it was read. */
export interface BankLineSuggestion {
  /** recorded: already in the books; matched / likely: a customer or supplier found; unmatched. */
  status: "recorded" | "matched" | "likely" | "unmatched";
  partyKind: "customer" | "supplier" | null;
  partyId: string | null;
  /** Why the party was suggested: upi, mobile, bill_number, name, bill, balance. */
  reasons: string[];
  /** The open bill whose number the narration carries. */
  billNumber?: string | null;
  /** The bank's own kind of line: bank_charge, interest, cash_deposit, cash_withdrawal. */
  kind?: string | null;
}

/**
 * One line of a bank statement and what it was reconciled with: a receipt
 * or payment (made from it, or one already in the books), an expense (bank
 * charges, interest paid) or a transfer (cash deposited or drawn); or
 * ignored. Open lines are the bank's side of the bank reconciliation
 * statement.
 */
export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: pk(),
    businessId: businessId(),
    /** The statement that brought it. */
    statementId: uuid()
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),
    /** The account it is a line of. */
    paymentAccountId: uuid()
      .notNull()
      .references(() => paymentAccounts.id),
    /** Its row in the statement. */
    rowNo: integer().notNull(),
    /** Date the bank booked it. */
    lineDate: date({ mode: "string" }).notNull(),
    /** The bank's description (who paid, UPI id, UTR …). */
    narration: text().notNull(),
    /** UTR, cheque or reference number when the bank gives one. */
    reference: varchar({ length: 80 }),
    /** Money in (positive) or out (negative). */
    amount: money().notNull(),
    /** The bank's balance after it, when the statement shows balances. */
    runningBalance: money(),
    /** Its identity across statements: date, amount, reference and narration, and which of identical lines it is. */
    fingerprint: varchar({ length: 64 }).notNull(),
    /** open, reconciled or ignored. */
    status: bankLineStatus().notNull().default("open"),
    /** What it turned out to be: receipt, payment, bank_charge, interest, cash_deposit, cash_withdrawal or other. */
    kind: varchar({ length: 20 }),
    /** The match suggested when it was read. */
    suggestion: jsonb().$type<BankLineSuggestion>(),
    /** The receipt or payment it is. */
    paymentId: uuid().references(() => payments.id),
    /** The expense it is (bank charges, interest paid). */
    expenseId: uuid().references(() => expenses.id),
    /** The transfer it is (cash deposited or drawn). */
    transferId: uuid().references(() => accountTransfers.id),
    /** Whether that receipt, payment, expense or transfer was made from this line (not one already in the books). */
    madeFromLine: boolean().notNull().default(false),
    /** Why it was ignored, or a remark. */
    note: text(),
    /** User who reconciled or ignored it. */
    reconciledBy: uuid(),
    /** When it was reconciled or ignored. */
    reconciledAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bank_statement_lines_fingerprint_uq").on(t.businessId, t.paymentAccountId, t.fingerprint),
    index("bank_statement_lines_statement_idx").on(t.statementId, t.rowNo),
    index("bank_statement_lines_account_idx").on(t.businessId, t.paymentAccountId, t.status, t.lineDate),
    index("bank_statement_lines_payment_idx").on(t.paymentId),
    index("bank_statement_lines_expense_idx").on(t.expenseId),
    index("bank_statement_lines_transfer_idx").on(t.transferId),
    check("bank_statement_lines_amount_chk", sql`${t.amount} <> 0`),
    check("bank_statement_lines_kind_chk", sql`${t.kind} is null or ${t.kind} in ('receipt', 'payment', 'bank_charge', 'interest', 'cash_deposit', 'cash_withdrawal', 'other')`),
  ],
);
