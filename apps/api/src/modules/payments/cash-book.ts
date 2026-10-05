import { cashBook, dec, type CashBookKind } from "@digitalbahi/core";
import type { Tx } from "@digitalbahi/db";
import { sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { assertRange } from "../../lib/period.js";
import { Format, sendReport } from "../reports/reports.js";
import type { ApiModule } from "../types.js";

const CashBookQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  book: z.enum(["cash", "bank", "all"]).default("cash"),
  ...Format,
});

const BOOK_TITLE: Record<CashBookKind, string> = { cash: "Cash book", bank: "Bank & UPI book", all: "Cash & bank book" };

/** Which payment methods a book follows, as SQL on a method column. */
function methodFilter(book: CashBookKind, column: SQL): SQL {
  if (book === "cash") return sql`${column} = 'cash'`;
  if (book === "bank") return sql`${column} <> 'cash'`;
  return sql`true`;
}

/** Opening balances typed in for the business's accounts (cash drawer; bank, UPI, wallet, card). */
function accountFilter(book: CashBookKind): SQL {
  if (book === "cash") return sql`type = 'cash'`;
  if (book === "bank") return sql`type <> 'cash'`;
  return sql`true`;
}

/**
 * Every rupee that came in or went out, day by day: receipts and payments
 * (bounced cheques left out) and expenses, with the opening balance, a
 * running balance and each day's closing. The cash book follows cash; the
 * bank book everything else (UPI, transfers, cheques, cards).
 */
async function cashBookData(tx: Tx, ctx: RequestCtx, q: { from: string; to: string; book: CashBookKind }) {
  const b = ctx.businessId;
  const withExpenses = can(ctx, "expense.view");
  const payMethod = methodFilter(q.book, sql`p.method::text`);
  const expMethod = methodFilter(q.book, sql`e.payment_method::text`);
  const payments = sql`p.business_id = ${b} and p.status = 'posted' and coalesce(p.cheque_status::text, '') <> 'bounced' and ${payMethod}`;
  const expenses = sql`e.business_id = ${b} and e.status = 'posted' and ${expMethod}`;
  const [before] = (
    await tx.execute<{ amount: string }>(sql`
      select (
        coalesce((select sum(opening_balance) from payment_accounts where business_id = ${b} and is_active and ${accountFilter(q.book)}), 0)
        + coalesce((select sum(case when p.direction = 'in' then p.amount else -p.amount end) from payments p where ${payments} and p.payment_date < ${q.from}), 0)
        - ${withExpenses ? sql`coalesce((select sum(e.total_amount) from expenses e where ${expenses} and e.expense_date < ${q.from}), 0)` : sql`0`}
      )::numeric(15, 2)::text as amount`)
  ).rows;
  const rows = (
    await tx.execute<{ id: string; kind: "payment" | "expense"; date: string; number: string | null; direction: "in" | "out"; party: string | null; method: string; reference: string | null; amount: string; entered_at: string }>(sql`
      select p.id, 'payment' as kind, p.payment_date::text as date, p.payment_number as number, p.direction::text as direction,
             coalesce((select coalesce(c.business_name, c.name) from customers c where c.id = p.customer_id),
                      (select s.name from suppliers s where s.id = p.supplier_id),
                      (select em.name from employees em where em.id = p.employee_id), p.other_party_name) as party,
             p.method::text as method, p.reference_number as reference, p.amount::text as amount, p.created_at as entered_at
      from payments p
      where ${payments} and p.payment_date between ${q.from} and ${q.to}
      ${
        withExpenses
          ? sql`union all
      select e.id, 'expense', e.expense_date::text, e.expense_number, 'out',
             concat_ws(' · ', (select c.name from expense_categories c where c.id = e.category_id), e.paid_to),
             e.payment_method::text, e.reference_number, e.total_amount::text, e.created_at
      from expenses e
      where ${expenses} and e.expense_date between ${q.from} and ${q.to}`
          : sql``
      }
      order by date, entered_at, id
      limit 5001`)
  ).rows;
  const truncated = rows.length > 5000;
  const book = cashBook(
    before!.amount,
    rows.slice(0, 5000).map(({ entered_at: _e, ...r }) => ({ ...r, in: r.direction === "in" ? r.amount : "0", out: r.direction === "out" ? r.amount : "0" })),
  );
  return { book: q.book, from: q.from, to: q.to, includesExpenses: withExpenses, truncated, ...book };
}

export const cashBookModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/payments/cash-book", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], querystring: CashBookQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    const data = await withTenant(deps.db, ctx, (tx) => cashBookData(tx, ctx, q));
    if (q.format === "json") return data;
    // The file: an opening line, every entry with its balance, the totals and the closing.
    const fileRows = [
      { date: q.from, particulars: "Opening balance", number: "", method: "", in: "", out: "", balance: data.opening },
      ...data.rows.map((x) => ({
        date: x.date,
        particulars: x.kind === "expense" ? `Expense · ${x.party ?? ""}` : (x.party ?? ""),
        number: x.number ?? "",
        method: x.reference ? `${x.method} · ${x.reference}` : x.method,
        in: dec(x.in).isZero() ? "" : x.in,
        out: dec(x.out).isZero() ? "" : x.out,
        balance: x.balance,
      })),
    ];
    return sendReport(
      reply,
      ctx,
      deps,
      q.format,
      `${q.book === "cash" ? "cash-book" : q.book === "bank" ? "bank-book" : "cash-bank-book"}-${q.from}-${q.to}`,
      [
        { key: "date", label: "Date" },
        { key: "particulars", label: "Particulars" },
        { key: "number", label: "Number" },
        { key: "method", label: "Mode" },
        { key: "in", label: "In" },
        { key: "out", label: "Out" },
        { key: "balance", label: "Balance" },
      ],
      { rows: fileRows, totals: { particulars: "Closing balance", in: data.in, out: data.out, balance: data.closing } },
      { title: BOOK_TITLE[q.book], from: q.from, to: q.to },
      "payment.view",
    );
  });
};
