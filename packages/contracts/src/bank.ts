import { z } from "zod";
import { Id, IsoDate, PageQuery } from "./common.js";

/** A line of a bank statement as the browser read it (core's readBankStatement). */
export const StatementLineInput = z.strictObject({
  row: z.number().int().positive(),
  date: IsoDate,
  narration: z.string().max(500),
  reference: z.string().max(80),
  amount: z
    .number()
    .finite()
    .refine((n) => n !== 0),
  /** The bank's balance after the line, when the statement shows one. */
  balance: z.number().finite().nullable().optional(),
});

/** A statement imported for one of the business's bank or UPI accounts; lines already saved from an earlier one are skipped. */
export const BankStatementBody = z.strictObject({
  paymentAccountId: Id,
  fileName: z.string().trim().max(200).optional(),
  lines: z.array(StatementLineInput).min(1).max(5000),
});
export type BankStatementBody = z.infer<typeof BankStatementBody>;

/**
 * What to do with a line. receipt / payment: record it for a customer or
 * supplier; link: it is a receipt, payment, expense or transfer already in
 * the books; bank_charge / interest: the bank's own (an expense, or interest
 * received); cash_deposit / cash_withdrawal: moved from or to the cash
 * drawer; ignore; undo: back to open (what it made stays, to cancel by hand).
 */
export const BankLineAction = z.union([
  z.strictObject({ lineId: Id, action: z.literal("receipt"), customerId: Id, invoiceId: Id.optional() }),
  z.strictObject({ lineId: Id, action: z.literal("payment"), supplierId: Id }),
  z.strictObject({ lineId: Id, action: z.literal("link"), documentType: z.enum(["payment", "expense", "transfer"]), documentId: Id }),
  z.strictObject({ lineId: Id, action: z.enum(["bank_charge", "interest", "cash_deposit", "cash_withdrawal"]) }),
  z.strictObject({ lineId: Id, action: z.literal("ignore"), note: z.string().trim().max(300).optional() }),
  z.strictObject({ lineId: Id, action: z.literal("undo") }),
]);
export type BankLineAction = z.infer<typeof BankLineAction>;

export const BankReconcileBody = z.strictObject({ actions: z.array(BankLineAction).min(1).max(200) });

export const BankLineListQuery = PageQuery.extend({
  accountId: Id,
  status: z.enum(["open", "reconciled", "ignored", "all"]).default("open"),
  statementId: Id.optional(),
});

export const BrsQuery = z.object({ accountId: Id, statementId: Id.optional() });

export type BankLineKind = "receipt" | "payment" | "bank_charge" | "interest" | "cash_deposit" | "cash_withdrawal" | "other";

/** A line as the reconciliation screen shows it. */
export interface BankLineView {
  id: string;
  statementId: string;
  row: number;
  date: string;
  narration: string;
  reference: string | null;
  /** Money in (positive) or out (negative). */
  amount: string;
  runningBalance: string | null;
  status: "open" | "reconciled" | "ignored";
  kind: BankLineKind | null;
  suggestion: {
    status: "recorded" | "matched" | "likely" | "unmatched";
    partyKind: "customer" | "supplier" | null;
    partyId: string | null;
    partyName: string | null;
    reasons: string[];
    billNumber?: string | null;
    kind?: string | null;
  } | null;
  /** What it was reconciled with. */
  document: { type: "payment" | "expense" | "transfer"; id: string; number: string | null; label: string | null; madeFromLine: boolean } | null;
  note: string | null;
}

export interface BankStatementView {
  id: string;
  paymentAccountId: string;
  fileName: string | null;
  periodFrom: string;
  periodTo: string;
  closingBalance: string | null;
  linesAdded: number;
  linesKnown: number;
  createdAt: string;
  /** Lines of it still open, reconciled and ignored. */
  open: number;
  reconciled: number;
  ignored: number;
}

/** A receipt, payment, expense or transfer of the account that the bank has not shown yet. */
export interface BrsBookEntry {
  type: "payment" | "expense" | "transfer";
  id: string;
  date: string;
  number: string | null;
  label: string | null;
  /** in: the books have it as money in (the bank should show a credit). */
  direction: "in" | "out";
  amount: string;
  reference: string | null;
}

/**
 * Bank reconciliation statement, as at a statement's last date: the bank's
 * balance, the books' balance of the account, and what explains the
 * difference (lines the books do not have yet, entries the bank has not
 * shown yet). `difference` is what is left unexplained (0.00 when it all
 * agrees; null when the statement shows no balance).
 */
export interface BrsView {
  accountId: string;
  accountName: string;
  asOf: string | null;
  statementId: string | null;
  bankBalance: string | null;
  /** The account's balance when it was brought into the app (where the books start). */
  openingBalance: string;
  booksBalance: string;
  notInBooks: { credits: string; debits: string; count: number; lines: BankLineView[] };
  notInBank: { receipts: string; payments: string; count: number; entries: BrsBookEntry[] };
  difference: string | null;
}
