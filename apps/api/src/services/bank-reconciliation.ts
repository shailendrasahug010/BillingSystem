import type { BankLineAction, BankLineView, BankStatementView, BrsBookEntry, BrsView } from "@digitalbahi/contracts";
import { classifyStatementLine, dec, matchStatementLine, statementLineKey, type PaymentMethod, type RecordedPayment, type StatementLine, type StatementParty } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { can } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import type { RequestCtx } from "../lib/context.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { nextDocumentNumber } from "./numbering.js";
import { recordOtherPayment, recordPayment } from "./payments.js";
import { getSetting } from "./settings.js";

/**
 * Bank reconciliation that is kept: statements imported per bank or UPI
 * account, each line matched (to a receipt or payment already in the books,
 * else to the customer or supplier it most likely is, else to the bank's own
 * kind of line) and reconciled by hand or in bulk, and the bank
 * reconciliation statement (BRS) as at a statement's end.
 */

type LineRow = typeof schema.bankStatementLines.$inferSelect;
type Suggestion = schema.BankLineSuggestion;

/** A receipt, payment, expense or transfer of the account that the bank may show. */
interface BookEntry {
  type: "payment" | "expense" | "transfer";
  id: string;
  direction: "in" | "out";
  date: string;
  amount: number;
  reference: string | null;
  /** For a transfer: the other account is the cash drawer. */
  cash: boolean;
  /** For a payment: whose (customer or supplier), and of what kind. */
  partyType: string | null;
  /** A payment not yet given an account (it takes the statement's when linked). */
  accountless: boolean;
}

const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const refKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "").replace(/^0+/, "");

/** How the money moved, from the narration: UPI, else a bank transfer (a cheque that reached the statement has cleared). */
export const methodOfLine = (narration: string): PaymentMethod => (/\bUPI\b/i.test(narration) ? "upi" : "bank_transfer");

/** The bank or UPI account a statement is of (never the cash drawer). */
export async function bankAccount(tx: Tx, businessId: string, accountId: string) {
  const pa = schema.paymentAccounts;
  const [account] = await tx
    .select({ id: pa.id, name: pa.name, type: pa.type, openingBalance: pa.openingBalance, isActive: pa.isActive })
    .from(pa)
    .where(and(eq(pa.id, accountId), eq(pa.businessId, businessId)));
  if (!account) throw notFound("payment_account");
  if (account.type === "cash") throw badRequest("BANK_ACCOUNT_REQUIRED", {}, "paymentAccountId");
  return account;
}

// ---------------------------------------------------------------- matching

/**
 * The customers and suppliers a statement's lines may be from or to, with
 * their open bills (amounts and numbers), and the payments already recorded
 * near the lines' dates.
 */
export async function matchingParties(tx: Tx, businessId: string, from: string, to: string): Promise<{ parties: StatementParty[]; recorded: Array<RecordedPayment & { id: string }> }> {
  const c = schema.customers;
  const s = schema.suppliers;
  const inv = schema.invoices;
  const pur = schema.purchases;
  const pay = schema.payments;
  const customers = await tx
    .select({ id: c.id, name: c.name, businessName: c.businessName, mobile: c.mobile, altMobile: c.altMobile, balance: c.balance })
    .from(c)
    .where(and(eq(c.businessId, businessId), eq(c.isActive, true), isNull(c.deletedAt)));
  const suppliers = await tx
    .select({ id: s.id, name: s.name, mobile: s.mobile, upiId: s.upiId, balance: s.balance })
    .from(s)
    .where(and(eq(s.businessId, businessId), eq(s.isActive, true), isNull(s.deletedAt)));
  const invoices = await tx
    .select({ party: inv.customerId, due: inv.balanceDue, number: inv.invoiceNumber })
    .from(inv)
    .where(and(eq(inv.businessId, businessId), eq(inv.status, "posted"), gt(inv.balanceDue, "0")));
  const purchases = await tx
    .select({ party: pur.supplierId, due: pur.balanceDue, number: pur.supplierInvoiceNumber })
    .from(pur)
    .where(and(eq(pur.businessId, businessId), eq(pur.status, "posted"), gt(pur.balanceDue, "0")));
  const payments = await tx
    .select({ id: pay.id, customerId: pay.customerId, supplierId: pay.supplierId, direction: pay.direction, date: pay.paymentDate, amount: pay.amount, reference: pay.referenceNumber })
    .from(pay)
    .where(and(eq(pay.businessId, businessId), ne(pay.status, "cancelled"), sql`${pay.paymentDate} between ${from} and ${to}`));
  const open = new Map<string, { amounts: number[]; numbers: string[] }>();
  for (const d of [...invoices, ...purchases]) {
    const o = open.get(d.party) ?? { amounts: [], numbers: [] };
    o.amounts.push(Number(d.due));
    if (d.number) o.numbers.push(d.number);
    open.set(d.party, o);
  }
  const parties: StatementParty[] = [
    ...customers.map((x) => ({
      id: x.id,
      kind: "customer" as const,
      name: x.businessName || x.name,
      aliases: x.businessName ? [x.name] : [],
      mobiles: [x.mobile, x.altMobile].filter((m): m is string => !!m),
      balance: Number(x.balance),
      openBills: open.get(x.id)?.amounts ?? [],
      billNumbers: open.get(x.id)?.numbers ?? [],
    })),
    ...suppliers.map((x) => ({
      id: x.id,
      kind: "supplier" as const,
      name: x.name,
      mobiles: x.mobile ? [x.mobile] : [],
      upiId: x.upiId,
      balance: Number(x.balance),
      openBills: open.get(x.id)?.amounts ?? [],
      billNumbers: open.get(x.id)?.numbers ?? [],
    })),
  ];
  const recorded = payments.flatMap((p) => {
    const partyId = p.customerId ?? p.supplierId;
    return partyId ? [{ id: p.id, partyId, direction: p.direction, date: p.date, amount: Number(p.amount), reference: p.reference }] : [];
  });
  return { parties, recorded };
}

/**
 * The account's receipts, payments, expenses and transfers in a period that
 * no statement line has been reconciled with yet: what a new line may
 * already be. Cash receipts never reach a bank.
 */
async function unmatchedBookEntries(tx: Tx, businessId: string, accountId: string, period: { from: string; to: string } | { id: string }): Promise<BookEntry[]> {
  const when = (column: SQL, id: SQL) => ("id" in period ? sql`${id} = ${period.id}::uuid` : sql`${column} between ${period.from} and ${period.to}`);
  const rows = await tx.execute<{ type: BookEntry["type"]; id: string; direction: "in" | "out"; date: string; amount: string; reference: string | null; cash: boolean; party_type: string | null; accountless: boolean }>(sql`
    select 'payment' as type, p.id, p.direction::text as direction, p.payment_date::text as date, p.amount::text as amount, p.reference_number as reference,
           false as cash, p.party_type::text as party_type, p.payment_account_id is null as accountless
    from payments p
    where p.business_id = ${businessId} and p.status = 'posted' and coalesce(p.cheque_status::text, '') <> 'bounced' and p.method <> 'cash'
      and (p.payment_account_id = ${accountId} or p.payment_account_id is null)
      and ${when(sql`p.payment_date`, sql`p.id`)}
      and not exists (select 1 from bank_statement_lines l where l.payment_id = p.id)
    union all
    select 'expense', e.id, 'out', e.expense_date::text, e.total_amount::text, e.reference_number, false, null, e.payment_account_id is null
    from expenses e
    where e.business_id = ${businessId} and e.status = 'posted' and e.payment_method <> 'cash'
      and (e.payment_account_id = ${accountId} or e.payment_account_id is null)
      and ${when(sql`e.expense_date`, sql`e.id`)}
      and not exists (select 1 from bank_statement_lines l where l.expense_id = e.id)
    union all
    select 'transfer', t.id, case when t.to_account_id = ${accountId} then 'in' else 'out' end, t.transfer_date::text, t.amount::text, t.reference,
           (select a.type = 'cash' from payment_accounts a where a.id = case when t.to_account_id = ${accountId} then t.from_account_id else t.to_account_id end), null, false
    from account_transfers t
    where t.business_id = ${businessId} and t.status = 'posted' and ${accountId} in (t.from_account_id, t.to_account_id)
      and ${when(sql`t.transfer_date`, sql`t.id`)}
      and not exists (select 1 from bank_statement_lines l where l.transfer_id = t.id)`);
  return rows.rows.map((r) => ({ type: r.type, id: r.id, direction: r.direction, date: r.date, amount: Number(r.amount), reference: r.reference, cash: Boolean(r.cash), partyType: r.party_type, accountless: Boolean(r.accountless) }));
}

/** The entry in the books a line most likely is: the same money the same way, by its reference, else the nearest date within three days. */
function findEntry(line: { date: string; amount: number; reference: string }, entries: BookEntry[], used: Set<string>): BookEntry | null {
  const direction = line.amount > 0 ? "in" : "out";
  const amount = Math.abs(line.amount);
  const same = entries.filter((e) => !used.has(e.id) && e.direction === direction && Math.abs(e.amount - amount) < 0.005);
  const ref = refKey(line.reference);
  const byRef = ref ? same.find((e) => refKey(e.reference) === ref) : undefined;
  if (byRef) return byRef;
  const near = same.filter((e) => daysApart(e.date, line.date) <= 3).sort((a, b) => daysApart(a.date, line.date) - daysApart(b.date, line.date));
  return near[0] ?? null;
}

/** What a line is, given the entry it is reconciled with. */
function kindOf(entry: BookEntry): string {
  if (entry.type === "transfer") return entry.cash ? (entry.direction === "in" ? "cash_deposit" : "cash_withdrawal") : "other";
  if (entry.type === "expense") return "payment";
  return entry.direction === "in" ? "receipt" : "payment";
}

// ---------------------------------------------------------------- importing

/**
 * Saves a statement's lines for an account and reconciles those already in
 * the books. A line an earlier statement brought (same date, amount,
 * reference and narration; the nth of identical lines) is skipped.
 */
export async function importStatement(
  tx: Tx,
  ctx: RequestCtx,
  input: { paymentAccountId: string; fileName?: string | undefined; lines: ReadonlyArray<StatementLine> },
): Promise<{ statementId: string; added: number; known: number; reconciled: number }> {
  const account = await bankAccount(tx, ctx.businessId, input.paymentAccountId);
  if (!account.isActive) throw badRequest("BANK_ACCOUNT_REQUIRED", {}, "paymentAccountId");
  const lines = [...input.lines];
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  // Most banks list the oldest first; some the newest first.
  const newestFirst = first.date > last.date;
  const chronological = newestFirst ? [...lines].reverse() : lines;
  const dates = lines.map((l) => l.date).sort();
  const withBalance = chronological.filter((l) => l.balance !== undefined && l.balance !== null);
  const closing = withBalance[withBalance.length - 1];

  const seen = new Map<string, number>();
  const prepared = lines.map((l) => {
    const key = statementLineKey(l);
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    return { line: l, fingerprint: createHash("sha256").update(`${key}#${nth}`).digest("hex") };
  });

  const statementId = uuidv7();
  await tx.insert(schema.bankStatements).values({
    id: statementId,
    businessId: ctx.businessId,
    paymentAccountId: account.id,
    fileName: input.fileName ?? null,
    periodFrom: dates[0]!,
    periodTo: dates[dates.length - 1]!,
    closingBalance: closing ? dec(closing.balance!).toFixed(2) : null,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  const b = schema.bankStatementLines;
  const added: LineRow[] = [];
  for (let i = 0; i < prepared.length; i += 500) {
    const rows = await tx
      .insert(b)
      .values(
        prepared.slice(i, i + 500).map(({ line, fingerprint }) => ({
          businessId: ctx.businessId,
          statementId,
          paymentAccountId: account.id,
          rowNo: line.row,
          lineDate: line.date,
          narration: line.narration.slice(0, 500),
          reference: line.reference ? line.reference.slice(0, 80) : null,
          amount: dec(line.amount).toFixed(2),
          runningBalance: line.balance === undefined || line.balance === null ? null : dec(line.balance).toFixed(2),
          fingerprint,
        })),
      )
      .onConflictDoNothing({ target: [b.businessId, b.paymentAccountId, b.fingerprint] })
      .returning();
    added.push(...rows);
  }

  let reconciled = 0;
  if (added.length) {
    const from = shift(dates[0]!, -3);
    const to = shift(dates[dates.length - 1]!, 3);
    const entries = await unmatchedBookEntries(tx, ctx.businessId, account.id, { from, to });
    const { parties } = await matchingParties(tx, ctx.businessId, from, to);
    const names = new Map(parties.map((p) => [p.id, p.kind]));
    const used = new Set<string>();
    const now = new Date().toISOString();
    for (const row of [...added].sort((x, y) => x.lineDate.localeCompare(y.lineDate) || x.rowNo - y.rowNo)) {
      const line = { row: row.rowNo, date: row.lineDate, narration: row.narration, reference: row.reference ?? "", amount: Number(row.amount) };
      const entry = findEntry(line, entries, used);
      if (entry) {
        used.add(entry.id);
        await linkEntry(tx, row, entry, account.id, { userId: ctx.userId, at: now, made: false });
        reconciled++;
        continue;
      }
      // Not in the books (the check above): who it most likely is, or the bank's own kind of line.
      const m = matchStatementLine(line, parties, []);
      const suggestion: Suggestion = {
        status: m.status,
        partyKind: m.partyId ? (names.get(m.partyId) ?? null) : null,
        partyId: m.partyId,
        reasons: m.reasons,
        ...(m.billNumber ? { billNumber: m.billNumber } : {}),
        kind: classifyStatementLine(line),
      };
      await tx.update(b).set({ suggestion }).where(eq(b.id, row.id));
    }
  }
  await tx
    .update(schema.bankStatements)
    .set({ linesAdded: added.length, linesKnown: lines.length - added.length })
    .where(eq(schema.bankStatements.id, statementId));
  await audit(tx, ctx, {
    action: "bank_statement.imported",
    entityType: "payment_account",
    entityId: account.id,
    entityLabel: account.name,
    changes: { file: input.fileName ?? null, lines: lines.length, added: added.length, reconciled },
  });
  return { statementId, added: added.length, known: lines.length - added.length, reconciled };
}

/** Reconciles a line with an entry; a payment without an account takes the statement's. */
async function linkEntry(tx: Tx, line: LineRow, entry: BookEntry, accountId: string, by: { userId: string; at: string; made: boolean }) {
  const b = schema.bankStatementLines;
  await tx
    .update(b)
    .set({
      status: "reconciled",
      kind: kindOf(entry),
      paymentId: entry.type === "payment" ? entry.id : null,
      expenseId: entry.type === "expense" ? entry.id : null,
      transferId: entry.type === "transfer" ? entry.id : null,
      madeFromLine: by.made,
      reconciledBy: by.userId,
      reconciledAt: by.at,
    })
    .where(eq(b.id, line.id));
  if (entry.accountless) {
    if (entry.type === "payment") await tx.update(schema.payments).set({ paymentAccountId: accountId }).where(and(eq(schema.payments.id, entry.id), isNull(schema.payments.paymentAccountId)));
    if (entry.type === "expense") await tx.update(schema.expenses).set({ paymentAccountId: accountId }).where(and(eq(schema.expenses.id, entry.id), isNull(schema.expenses.paymentAccountId)));
  }
}

// ---------------------------------------------------------------- reading

/** Lines as the screen shows them: the suggested party's name, and what each was reconciled with. */
export async function lineViews(tx: Tx, rows: LineRow[]): Promise<BankLineView[]> {
  const partyIds = [...new Set(rows.map((r) => r.suggestion?.partyId).filter((x): x is string => Boolean(x)))];
  const paymentIds = rows.map((r) => r.paymentId).filter((x): x is string => Boolean(x));
  const expenseIds = rows.map((r) => r.expenseId).filter((x): x is string => Boolean(x));
  const transferIds = rows.map((r) => r.transferId).filter((x): x is string => Boolean(x));
  const names = new Map<string, string>();
  if (partyIds.length) {
    const cs = await tx.select({ id: schema.customers.id, name: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})` }).from(schema.customers).where(inArray(schema.customers.id, partyIds));
    const ss = await tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, partyIds));
    for (const p of [...cs, ...ss]) names.set(p.id, p.name);
  }
  const docs = new Map<string, { number: string | null; label: string | null }>();
  if (paymentIds.length) {
    const ps = await tx.execute<{ id: string; number: string | null; label: string | null }>(sql`
      select p.id, p.payment_number as number,
             coalesce((select coalesce(c.business_name, c.name) from customers c where c.id = p.customer_id),
                      (select s.name from suppliers s where s.id = p.supplier_id),
                      (select e.name from employees e where e.id = p.employee_id), p.other_party_name) as label
      from payments p where p.id in (${sql.join(paymentIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    for (const p of ps.rows) docs.set(p.id, { number: p.number, label: p.label });
  }
  if (expenseIds.length) {
    const es = await tx.execute<{ id: string; number: string | null; label: string | null }>(sql`
      select e.id, e.expense_number as number, (select c.name from expense_categories c where c.id = e.category_id) as label
      from expenses e where e.id in (${sql.join(expenseIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    for (const e of es.rows) docs.set(e.id, { number: e.number, label: e.label });
  }
  if (transferIds.length) {
    const ts = await tx.execute<{ id: string; label: string | null }>(sql`
      select t.id, concat((select a.name from payment_accounts a where a.id = t.from_account_id), ' → ', (select a.name from payment_accounts a where a.id = t.to_account_id)) as label
      from account_transfers t where t.id in (${sql.join(transferIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    for (const t of ts.rows) docs.set(t.id, { number: null, label: t.label });
  }
  return rows.map((r) => {
    const docId = r.paymentId ?? r.expenseId ?? r.transferId;
    const type = r.paymentId ? "payment" : r.expenseId ? "expense" : r.transferId ? "transfer" : null;
    return {
      id: r.id,
      statementId: r.statementId,
      row: r.rowNo,
      date: r.lineDate,
      narration: r.narration,
      reference: r.reference,
      amount: r.amount,
      runningBalance: r.runningBalance,
      status: r.status,
      kind: (r.kind as BankLineView["kind"]) ?? null,
      suggestion: r.suggestion ? { ...r.suggestion, partyName: r.suggestion.partyId ? (names.get(r.suggestion.partyId) ?? null) : null } : null,
      document: docId && type ? { type, id: docId, number: docs.get(docId)?.number ?? null, label: docs.get(docId)?.label ?? null, madeFromLine: r.madeFromLine } : null,
      note: r.note,
    };
  });
}

export async function statementViews(tx: Tx, businessId: string, accountId: string): Promise<BankStatementView[]> {
  const st = schema.bankStatements;
  const rows = await tx
    .select({
      statement: st,
      open: sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = ${st.id} and l.status = 'open')`,
      reconciled: sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = ${st.id} and l.status = 'reconciled')`,
      ignored: sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = ${st.id} and l.status = 'ignored')`,
    })
    .from(st)
    .where(and(eq(st.businessId, businessId), eq(st.paymentAccountId, accountId)))
    .orderBy(desc(st.periodTo), desc(st.createdAt))
    .limit(100);
  return rows.map(({ statement: s, open, reconciled, ignored }) => ({
    id: s.id,
    paymentAccountId: s.paymentAccountId,
    fileName: s.fileName,
    periodFrom: s.periodFrom,
    periodTo: s.periodTo,
    closingBalance: s.closingBalance,
    linesAdded: s.linesAdded,
    linesKnown: s.linesKnown,
    createdAt: s.createdAt,
    open: Number(open),
    reconciled: Number(reconciled),
    ignored: Number(ignored),
  }));
}

// ---------------------------------------------------------------- reconciling

/** Who may do what to a line: record for customers or suppliers, enter expenses, move money between accounts. */
function allowed(ctx: RequestCtx, action: BankLineAction, inflow: boolean): boolean {
  switch (action.action) {
    case "receipt":
      return can(ctx, "payment.collect");
    case "payment":
      return can(ctx, "payment.pay");
    case "bank_charge":
      return can(ctx, "expense.create");
    case "interest":
      return inflow ? can(ctx, "payment.collect") : can(ctx, "expense.create");
    default:
      return can(ctx, "payment.collect") || can(ctx, "payment.pay");
  }
}

/** The business's expense category for the bank's own charges or interest, made the first time it is needed. */
async function bankCategory(tx: Tx, ctx: RequestCtx, which: "charges" | "interest"): Promise<string> {
  const name = which === "charges" ? "Bank charges" : "Bank interest";
  const nameHi = which === "charges" ? "बैंक शुल्क" : "बैंक ब्याज";
  const c = schema.expenseCategories;
  const [found] = await tx
    .select({ id: c.id, isActive: c.isActive })
    .from(c)
    .where(and(eq(c.businessId, ctx.businessId), sql`lower(${c.name}) = lower(${name})`));
  if (found) {
    if (!found.isActive) await tx.update(c).set({ isActive: true }).where(eq(c.id, found.id));
    return found.id;
  }
  const [made] = await tx.insert(c).values({ businessId: ctx.businessId, name, nameHi, isSystem: true }).returning({ id: c.id });
  return made!.id;
}

/** An expense paid from the account, without GST (the bank's charges or the interest it took). */
async function recordBankExpense(tx: Tx, ctx: RequestCtx, fyStart: number, input: { date: string; amount: string; categoryId: string; accountId: string; reference: string | null; notes: string }) {
  const numbering = await nextDocumentNumber(tx, ctx.businessId, "expense", input.date, fyStart, { name: "Expense", pattern: "EXP/{FYS}/{SEQ:5}" });
  const id = uuidv7();
  await tx.insert(schema.expenses).values({
    id,
    businessId: ctx.businessId,
    expenseNumber: numbering.number,
    expenseDate: input.date,
    categoryId: input.categoryId,
    paidTo: null,
    amount: input.amount,
    gstRate: "0",
    cgstAmount: "0",
    sgstAmount: "0",
    igstAmount: "0",
    totalAmount: input.amount,
    paymentMethod: "bank_transfer",
    paymentAccountId: input.accountId,
    referenceNumber: input.reference,
    notes: input.notes,
    status: "posted",
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await audit(tx, ctx, { action: "expense.posted", entityType: "expense", entityId: id, entityLabel: numbering.number, changes: { amount: input.amount, method: "bank_transfer", from: "bank statement" } });
  await tx.insert(schema.outboxEvents).values({ businessId: ctx.businessId, eventType: "expense.posted", aggregateType: "expense", aggregateId: id, payload: { total: input.amount, categoryId: input.categoryId } });
  return id;
}

/** Money moved between two of the business's own accounts. */
async function recordTransfer(tx: Tx, ctx: RequestCtx, input: { date: string; from: string; to: string; amount: string; reference: string | null; notes: string }) {
  const [made] = await tx
    .insert(schema.accountTransfers)
    .values({ businessId: ctx.businessId, transferDate: input.date, fromAccountId: input.from, toAccountId: input.to, amount: input.amount, reference: input.reference, notes: input.notes, createdBy: ctx.userId, updatedBy: ctx.userId })
    .returning({ id: schema.accountTransfers.id });
  await audit(tx, ctx, { action: "transfer.posted", entityType: "payment_account", entityId: input.to, changes: { from: input.from, to: input.to, amount: input.amount } });
  return made!.id;
}

/** The cash drawer: the default active cash account. */
async function cashAccount(tx: Tx, businessId: string): Promise<string> {
  const pa = schema.paymentAccounts;
  const [cash] = await tx
    .select({ id: pa.id })
    .from(pa)
    .where(and(eq(pa.businessId, businessId), eq(pa.type, "cash"), eq(pa.isActive, true)))
    .orderBy(sql`${pa.isDefault} desc`, asc(pa.createdAt))
    .limit(1);
  if (!cash) throw conflict("CASH_ACCOUNT_MISSING");
  return cash.id;
}

/**
 * Applies one action to one line (the caller gives each its own savepoint,
 * so one that fails leaves the others done).
 */
export async function reconcileLine(tx: Tx, ctx: RequestCtx, action: BankLineAction, today: string): Promise<void> {
  const b = schema.bankStatementLines;
  const [line] = await tx
    .select()
    .from(b)
    .where(and(eq(b.id, action.lineId), eq(b.businessId, ctx.businessId)))
    .for("update");
  if (!line) throw notFound("bank_statement_line");
  const amount = dec(line.amount);
  const inflow = amount.gt(0);
  if (!allowed(ctx, action, inflow)) throw forbidden();
  const by = { userId: ctx.userId, at: new Date().toISOString() };
  if (action.action === "undo") {
    if (line.status === "open") throw conflict("BANK_LINE_OPEN");
    await tx
      .update(b)
      .set({ status: "open", kind: null, paymentId: null, expenseId: null, transferId: null, madeFromLine: false, note: null, reconciledBy: null, reconciledAt: null })
      .where(eq(b.id, line.id));
    return;
  }
  if (line.status !== "open") throw conflict("BANK_LINE_DONE", { status: line.status });
  if (action.action === "ignore") {
    await tx
      .update(b)
      .set({ status: "ignored", kind: "other", note: action.note ?? null, reconciledBy: by.userId, reconciledAt: by.at })
      .where(eq(b.id, line.id));
    return;
  }
  const date = line.lineDate > today ? today : line.lineDate;
  const value = amount.abs().toFixed(2);
  const reference = line.reference ? line.reference.slice(0, 40) : null;
  const notes = `Bank statement: ${line.narration}`.slice(0, 500);
  const [business] = await tx.select({ fyStart: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
  const fyStart = business!.fyStart;
  const made = (entry: Omit<BookEntry, "date" | "amount" | "reference" | "partyType" | "accountless">) =>
    linkEntry(tx, line, { ...entry, date, amount: Number(value), reference, partyType: null, accountless: false }, line.paymentAccountId, { ...by, made: true });

  switch (action.action) {
    case "receipt":
    case "payment": {
      if (inflow !== (action.action === "receipt")) throw badRequest("BANK_LINE_DIRECTION", {}, "action");
      const customer = action.action === "receipt";
      const partyTable = customer ? schema.customers : schema.suppliers;
      const partyId = customer ? action.customerId : action.supplierId;
      const [party] = await tx
        .select({ id: partyTable.id, name: partyTable.name })
        .from(partyTable)
        .where(and(eq(partyTable.id, partyId), eq(partyTable.businessId, ctx.businessId)));
      if (!party) throw badRequest("REFERENCE_NOT_FOUND", {}, customer ? "customerId" : "supplierId");
      // The bill the line names (or the one chosen) is paid first; else oldest due first, or by hand where the business allocates by hand.
      let prefer: string | null = customer && action.action === "receipt" ? (action.invoiceId ?? null) : null;
      if (!prefer && line.suggestion?.billNumber && line.suggestion.partyId === partyId) {
        const table = customer ? schema.invoices : schema.purchases;
        const numberCol = customer ? schema.invoices.invoiceNumber : schema.purchases.supplierInvoiceNumber;
        const partyCol = customer ? schema.invoices.customerId : schema.purchases.supplierId;
        const [bill] = await tx
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.businessId, ctx.businessId), eq(partyCol, partyId), eq(numberCol, line.suggestion.billNumber), eq(table.status, "posted")));
        prefer = bill?.id ?? null;
      }
      const mode = await getSetting(tx, ctx.businessId, "payments.allocation");
      const receipt = await recordPayment(tx, ctx, fyStart, {
        direction: customer ? "in" : "out",
        party: customer ? { type: "customer", id: party.id, name: party.name } : { type: "supplier", id: party.id, name: party.name },
        date,
        amount: value,
        method: methodOfLine(line.narration),
        referenceNumber: reference,
        paymentAccountId: line.paymentAccountId,
        notes,
        ...(mode === "manual" ? { allocations: [] } : {}),
        preferDocumentId: prefer,
      });
      await tx.insert(schema.outboxEvents).values({
        businessId: ctx.businessId,
        eventType: customer ? "payment.received" : "payment.made",
        aggregateType: "payment",
        aggregateId: receipt.id,
        payload: { amount: value, method: methodOfLine(line.narration) },
      });
      await made({ type: "payment", id: receipt.id, direction: customer ? "in" : "out", cash: false });
      return;
    }
    case "link": {
      const entry = (await unmatchedBookEntries(tx, ctx.businessId, line.paymentAccountId, { id: action.documentId })).find((e) => e.type === action.documentType);
      if (!entry) throw badRequest("BANK_LINK_NOT_FOUND", {}, "documentId");
      if (entry.direction !== (inflow ? "in" : "out") || Math.abs(entry.amount - Number(value)) >= 0.005) throw badRequest("BANK_LINK_MISMATCH", { amount: value }, "documentId");
      await linkEntry(tx, line, entry, line.paymentAccountId, { ...by, made: false });
      return;
    }
    case "bank_charge": {
      if (inflow) throw badRequest("BANK_LINE_DIRECTION", {}, "action");
      const id = await recordBankExpense(tx, ctx, fyStart, { date, amount: value, categoryId: await bankCategory(tx, ctx, "charges"), accountId: line.paymentAccountId, reference, notes });
      await linkEntry(tx, line, { type: "expense", id, direction: "out", date, amount: Number(value), reference, cash: false, partyType: null, accountless: false }, line.paymentAccountId, { ...by, made: true });
      await tx.update(b).set({ kind: "bank_charge" }).where(eq(b.id, line.id));
      return;
    }
    case "interest": {
      if (inflow) {
        const r = await recordOtherPayment(tx, ctx, fyStart, { direction: "in", name: "Bank interest", date, amount: value, method: "bank_transfer", paymentAccountId: line.paymentAccountId, referenceNumber: reference, notes });
        await made({ type: "payment", id: r.id, direction: "in", cash: false });
      } else {
        const id = await recordBankExpense(tx, ctx, fyStart, { date, amount: value, categoryId: await bankCategory(tx, ctx, "interest"), accountId: line.paymentAccountId, reference, notes });
        await made({ type: "expense", id, direction: "out", cash: false });
      }
      await tx.update(b).set({ kind: "interest" }).where(eq(b.id, line.id));
      return;
    }
    case "cash_deposit":
    case "cash_withdrawal": {
      const deposit = action.action === "cash_deposit";
      if (inflow !== deposit) throw badRequest("BANK_LINE_DIRECTION", {}, "action");
      const cash = await cashAccount(tx, ctx.businessId);
      const id = await recordTransfer(tx, ctx, { date, from: deposit ? cash : line.paymentAccountId, to: deposit ? line.paymentAccountId : cash, amount: value, reference, notes });
      await made({ type: "transfer", id, direction: deposit ? "in" : "out", cash: true });
      return;
    }
  }
}

/** Each action in its own savepoint: one that cannot be done is reported and the rest go ahead. */
export async function reconcileLines(tx: Tx, ctx: RequestCtx, actions: BankLineAction[], today: string) {
  const results: Array<{ lineId: string; ok: boolean; error?: { code: string; params: Record<string, string | number> } }> = [];
  for (const action of actions) {
    try {
      await tx.transaction((sp) => reconcileLine(sp as Tx, ctx, action, today));
      results.push({ lineId: action.lineId, ok: true });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      results.push({ lineId: action.lineId, ok: false, error: { code: e.code, params: e.params } });
    }
  }
  const done = results.filter((r) => r.ok).length;
  if (done) {
    await audit(tx, ctx, {
      action: "bank_statement.reconciled",
      entityType: "payment_account",
      changes: { done, failed: results.length - done, actions: [...new Set(actions.map((a) => a.action))] },
    });
  }
  return { done, results };
}

// ---------------------------------------------------------------- BRS

/** Entries the books have for the account and the bank has not shown, up to a date (from when statements start). */
async function unseenEntries(tx: Tx, businessId: string, accountId: string, from: string, to: string): Promise<BrsBookEntry[]> {
  const rows = await tx.execute<{ type: BrsBookEntry["type"]; id: string; date: string; number: string | null; label: string | null; direction: "in" | "out"; amount: string; reference: string | null }>(sql`
    select 'payment' as type, p.id, p.payment_date::text as date, p.payment_number as number,
           coalesce((select coalesce(c.business_name, c.name) from customers c where c.id = p.customer_id),
                    (select s.name from suppliers s where s.id = p.supplier_id),
                    (select e.name from employees e where e.id = p.employee_id), p.other_party_name) as label,
           p.direction::text as direction, p.amount::text as amount, p.reference_number as reference
    from payments p
    where p.business_id = ${businessId} and p.payment_account_id = ${accountId} and p.status = 'posted' and coalesce(p.cheque_status::text, '') <> 'bounced'
      and p.payment_date between ${from} and ${to}
      and not exists (select 1 from bank_statement_lines l where l.payment_id = p.id)
    union all
    select 'expense', e.id, e.expense_date::text, e.expense_number, (select c.name from expense_categories c where c.id = e.category_id), 'out', e.total_amount::text, e.reference_number
    from expenses e
    where e.business_id = ${businessId} and e.payment_account_id = ${accountId} and e.status = 'posted'
      and e.expense_date between ${from} and ${to}
      and not exists (select 1 from bank_statement_lines l where l.expense_id = e.id)
    union all
    select 'transfer', t.id, t.transfer_date::text, null,
           concat((select a.name from payment_accounts a where a.id = t.from_account_id), ' → ', (select a.name from payment_accounts a where a.id = t.to_account_id)),
           case when t.to_account_id = ${accountId} then 'in' else 'out' end, t.amount::text, t.reference
    from account_transfers t
    where t.business_id = ${businessId} and t.status = 'posted' and ${accountId} in (t.from_account_id, t.to_account_id)
      and t.transfer_date between ${from} and ${to}
      and not exists (select 1 from bank_statement_lines l where l.transfer_id = t.id)
    order by date, number nulls last`);
  return rows.rows;
}

/**
 * The bank reconciliation statement of an account as at a statement's last
 * date (the latest one unless another is chosen): the bank's closing
 * balance, the books' balance, the lines the books do not have yet and the
 * entries the bank has not shown yet (from the first statement's start).
 */
export async function brs(tx: Tx, businessId: string, accountId: string, statementId?: string): Promise<BrsView> {
  const account = await bankAccount(tx, businessId, accountId);
  const st = schema.bankStatements;
  const [statement] = await tx
    .select()
    .from(st)
    .where(and(eq(st.businessId, businessId), eq(st.paymentAccountId, accountId), ...(statementId ? [eq(st.id, statementId)] : [])))
    .orderBy(desc(st.periodTo), desc(st.createdAt))
    .limit(1);
  if (statementId && !statement) throw notFound("bank_statement");
  const asOf = statement?.periodTo ?? null;
  const [start] = await tx
    .select({ from: sql<string | null>`min(${st.periodFrom})::text` })
    .from(st)
    .where(and(eq(st.businessId, businessId), eq(st.paymentAccountId, accountId)));
  const upTo = asOf ?? "9999-12-31";
  const [books] = (
    await tx.execute<{ amount: string }>(sql`
      select (
        ${account.openingBalance}::numeric
        + coalesce((select sum(case when p.direction = 'in' then p.amount else -p.amount end) from payments p
                    where p.business_id = ${businessId} and p.payment_account_id = ${accountId} and p.status = 'posted'
                      and coalesce(p.cheque_status::text, '') <> 'bounced' and p.payment_date <= ${upTo}), 0)
        - coalesce((select sum(e.total_amount) from expenses e
                    where e.business_id = ${businessId} and e.payment_account_id = ${accountId} and e.status = 'posted' and e.expense_date <= ${upTo}), 0)
        + coalesce((select sum(case when t.to_account_id = ${accountId} then t.amount else -t.amount end) from account_transfers t
                    where t.business_id = ${businessId} and t.status = 'posted' and ${accountId} in (t.from_account_id, t.to_account_id) and t.transfer_date <= ${upTo}), 0)
      )::numeric(15, 2)::text as amount`)
  ).rows;
  const l = schema.bankStatementLines;
  const open = await tx
    .select()
    .from(l)
    .where(and(eq(l.businessId, businessId), eq(l.paymentAccountId, accountId), eq(l.status, "open"), sql`${l.lineDate} <= ${upTo}`))
    .orderBy(asc(l.lineDate), asc(l.rowNo));
  const credits = open.filter((x) => Number(x.amount) > 0).reduce((s, x) => s.plus(x.amount), dec(0));
  const debits = open.filter((x) => Number(x.amount) < 0).reduce((s, x) => s.plus(dec(x.amount).abs()), dec(0));
  const unseen = start?.from ? await unseenEntries(tx, businessId, accountId, start.from, upTo) : [];
  const receipts = unseen.filter((e) => e.direction === "in").reduce((s, e) => s.plus(e.amount), dec(0));
  const payments = unseen.filter((e) => e.direction === "out").reduce((s, e) => s.plus(e.amount), dec(0));
  const booksBalance = dec(books!.amount);
  const bankBalance = statement?.closingBalance ?? null;
  // bank = books + what only the bank has − what only the books have.
  const expected = booksBalance.plus(credits).minus(debits).minus(receipts).plus(payments);
  return {
    accountId,
    accountName: account.name,
    asOf,
    statementId: statement?.id ?? null,
    bankBalance,
    openingBalance: dec(account.openingBalance).toFixed(2),
    booksBalance: booksBalance.toFixed(2),
    notInBooks: { credits: credits.toFixed(2), debits: debits.toFixed(2), count: open.length, lines: await lineViews(tx, open.slice(0, 100)) },
    notInBank: { receipts: receipts.toFixed(2), payments: payments.toFixed(2), count: unseen.length, entries: unseen.slice(0, 100) },
    difference: bankBalance === null ? null : dec(bankBalance).minus(expected).toFixed(2),
  };
}

/** Lines of an account, newest first, by status (and statement). */
export function lineFilter(businessId: string, q: { accountId: string; status: "open" | "reconciled" | "ignored" | "all"; statementId?: string | undefined }): SQL {
  const l = schema.bankStatementLines;
  const where: SQL[] = [eq(l.businessId, businessId), eq(l.paymentAccountId, q.accountId)];
  if (q.status !== "all") where.push(eq(l.status, q.status));
  if (q.statementId) where.push(eq(l.statementId, q.statementId));
  return and(...where)!;
}

/** Receipts, payments, expenses and transfers a line could be linked to: the same money the same way, within a fortnight. */
export async function lineCandidates(tx: Tx, businessId: string, lineId: string) {
  const b = schema.bankStatementLines;
  const [line] = await tx
    .select()
    .from(b)
    .where(and(eq(b.id, lineId), eq(b.businessId, businessId)));
  if (!line) throw notFound("bank_statement_line");
  const entries = await unmatchedBookEntries(tx, businessId, line.paymentAccountId, { from: shift(line.lineDate, -15), to: shift(line.lineDate, 15) });
  const direction = Number(line.amount) > 0 ? "in" : "out";
  const amount = Math.abs(Number(line.amount));
  const fits = entries.filter((e) => e.direction === direction && Math.abs(e.amount - amount) < 0.005).sort((a, b2) => daysApart(a.date, line.lineDate) - daysApart(b2.date, line.lineDate));
  const views = await unseenLabels(tx, fits);
  return views.slice(0, 20);
}

/** Numbers and names for book entries (for choosing one to link). */
async function unseenLabels(tx: Tx, entries: BookEntry[]): Promise<BrsBookEntry[]> {
  if (!entries.length) return [];
  const ids = entries.map((e) => e.id);
  const rows = await tx.execute<{ id: string; number: string | null; label: string | null }>(sql`
    select p.id, p.payment_number as number,
           coalesce((select coalesce(c.business_name, c.name) from customers c where c.id = p.customer_id),
                    (select s.name from suppliers s where s.id = p.supplier_id),
                    (select e.name from employees e where e.id = p.employee_id), p.other_party_name) as label
    from payments p where p.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    union all
    select e.id, e.expense_number, (select c.name from expense_categories c where c.id = e.category_id) from expenses e where e.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    union all
    select t.id, null, concat((select a.name from payment_accounts a where a.id = t.from_account_id), ' → ', (select a.name from payment_accounts a where a.id = t.to_account_id))
    from account_transfers t where t.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const byId = new Map<string, { number: string | null; label: string | null }>(rows.rows.map((r) => [r.id, { number: r.number, label: r.label }]));
  return entries.map((e) => ({ type: e.type, id: e.id, date: e.date, number: byId.get(e.id)?.number ?? null, label: byId.get(e.id)?.label ?? null, direction: e.direction, amount: e.amount.toFixed(2), reference: e.reference }));
}

