import { addDays } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql, type SQL } from "drizzle-orm";

/**
 * Daily sales summaries (Phase 5.1): sales_daily_product (per day, product
 * and salesperson: base units sold and returned, taxable value, GST, cost,
 * invoices, customers; base units and value bought in) and
 * sales_daily_customer (per day, customer and salesperson: invoices, taxable
 * value, total, money collected, returns), so reports over long periods read
 * a row per day instead of every bill line.
 *
 * A day is always worked out whole from its documents. The outbox worker does
 * it for the days a bill, note, payment or purchase falls on, a few seconds
 * after it; the nightly job works every day out again (counting the rows that
 * had drifted) and records that the summaries are complete. From then on
 * reports read them for the days before today; today, and everything while
 * they are not complete, comes from the documents. Writers take a lock per
 * business, so a refresh never lands under an older rebuild.
 */

/** The marker in analytics_runs that the summaries were built whole. */
export const SUMMARY_JOB = "sales_summaries";

/** A condition on a date column: the day is one of these (every day when null). */
type DayFilter = (column: SQL) => SQL;
const onDays = (days: readonly string[] | null): DayFilter =>
  days ? (column) => sql`${column} in (${sql.join(days.map((d) => sql`${d}::date`), sql`, `)})` : () => sql`true`;

async function lockSummaries(tx: Tx, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sales-daily:${businessId}`}, 0))`);
}

/** sales_daily_product rows for the days, worked out from the documents. */
function productRows(businessId: string, on: DayFilter): SQL {
  return sql`
    with sold as (
      select i.invoice_date as day, ii.product_id, i.salesperson_id,
             sum(ii.qty_base) as qty_sold, sum(ii.taxable_value) as taxable_value,
             sum(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount) as tax_amount,
             sum((ii.qty_base + ii.free_qty * ii.conversion_factor) * ii.unit_cost) as cost_value,
             count(distinct i.id)::int as invoice_count, count(distinct i.customer_id)::int as customer_count
      from invoice_items ii join invoices i on i.id = ii.invoice_id
      where i.business_id = ${businessId} and i.status = 'posted' and ${on(sql`i.invoice_date`)}
      group by 1, 2, 3
    ),
    returned as (
      select n.note_date as day, ni.product_id, i.salesperson_id, sum(ni.qty_base) as qty_returned
      from credit_debit_note_items ni join credit_debit_notes n on n.id = ni.note_id
      left join invoices i on i.id = n.invoice_id
      where n.business_id = ${businessId} and n.status = 'posted' and n.party_type = 'customer' and n.reason = 'sales_return' and ${on(sql`n.note_date`)}
      group by 1, 2, 3
    ),
    bought as (
      select pu.received_date as day, pi.product_id, null::uuid as salesperson_id, sum(pi.qty_base) as qty_purchased, sum(pi.taxable_value) as purchase_value
      from purchase_items pi join purchases pu on pu.id = pi.purchase_id
      where pu.business_id = ${businessId} and pu.status = 'posted' and ${on(sql`pu.received_date`)}
      group by 1, 2, 3
    ),
    keys as (select day, product_id, salesperson_id from sold union select day, product_id, salesperson_id from returned union select day, product_id, salesperson_id from bought)
    select ${businessId}::uuid as business_id, k.day, k.product_id, p.brand_id, p.category_id, k.salesperson_id,
           coalesce(s.qty_sold, 0) as qty_sold, coalesce(r.qty_returned, 0) as qty_returned,
           coalesce(s.taxable_value, 0) as taxable_value, coalesce(s.tax_amount, 0) as tax_amount, round(coalesce(s.cost_value, 0), 2) as cost_value,
           coalesce(s.invoice_count, 0) as invoice_count, coalesce(s.customer_count, 0) as customer_count,
           coalesce(b.qty_purchased, 0) as qty_purchased, coalesce(b.purchase_value, 0) as purchase_value
    from keys k join products p on p.id = k.product_id
    left join sold s on s.day = k.day and s.product_id = k.product_id and s.salesperson_id is not distinct from k.salesperson_id
    left join returned r on r.day = k.day and r.product_id = k.product_id and r.salesperson_id is not distinct from k.salesperson_id
    left join bought b on b.day = k.day and b.product_id = k.product_id and b.salesperson_id is not distinct from k.salesperson_id`;
}

/** sales_daily_customer rows for the days: billed by the bills' salesperson, collected by whoever collected it. */
function customerRows(businessId: string, on: DayFilter): SQL {
  return sql`
    with billed as (
      select invoice_date as day, customer_id, salesperson_id, count(*)::int as invoice_count, sum(taxable_total) as taxable_value, sum(grand_total) as grand_total
      from invoices where business_id = ${businessId} and status = 'posted' and ${on(sql`invoice_date`)}
      group by 1, 2, 3
    ),
    collected as (
      select payment_date as day, customer_id, collected_by_id as salesperson_id, sum(amount) as collected
      from payments where business_id = ${businessId} and status = 'posted' and direction = 'in' and customer_id is not null and ${on(sql`payment_date`)}
      group by 1, 2, 3
    ),
    returned as (
      select n.note_date as day, n.customer_id, i.salesperson_id, sum(n.grand_total) as returns
      from credit_debit_notes n left join invoices i on i.id = n.invoice_id
      where n.business_id = ${businessId} and n.status = 'posted' and n.party_type = 'customer' and n.reason = 'sales_return' and ${on(sql`n.note_date`)}
      group by 1, 2, 3
    ),
    keys as (select day, customer_id, salesperson_id from billed union select day, customer_id, salesperson_id from collected union select day, customer_id, salesperson_id from returned)
    select ${businessId}::uuid as business_id, k.day, k.customer_id, k.salesperson_id,
           coalesce(b.invoice_count, 0) as invoice_count, coalesce(b.taxable_value, 0) as taxable_value, coalesce(b.grand_total, 0) as grand_total,
           coalesce(c.collected, 0) as collected, coalesce(r.returns, 0) as returns
    from keys k
    left join billed b on b.day = k.day and b.customer_id = k.customer_id and b.salesperson_id is not distinct from k.salesperson_id
    left join collected c on c.day = k.day and c.customer_id = k.customer_id and c.salesperson_id is not distinct from k.salesperson_id
    left join returned r on r.day = k.day and r.customer_id = k.customer_id and r.salesperson_id is not distinct from k.salesperson_id`;
}

const PRODUCT_COLUMNS = sql.raw(
  "business_id, day, product_id, brand_id, category_id, salesperson_id, qty_sold, qty_returned, taxable_value, tax_amount, cost_value, invoice_count, customer_count, qty_purchased, purchase_value",
);
const CUSTOMER_COLUMNS = sql.raw("business_id, day, customer_id, salesperson_id, invoice_count, taxable_value, grand_total, collected, returns");

/** Replaces the summaries of these days (every day when null) with what their documents say. */
async function writeDays(tx: Tx, businessId: string, days: readonly string[] | null): Promise<void> {
  const on = onDays(days);
  await tx.execute(sql`delete from sales_daily_product where business_id = ${businessId} and ${on(sql`day`)}`);
  await tx.execute(sql`delete from sales_daily_customer where business_id = ${businessId} and ${on(sql`day`)}`);
  await tx.execute(sql`insert into sales_daily_product (${PRODUCT_COLUMNS}) ${productRows(businessId, on)}`);
  await tx.execute(sql`insert into sales_daily_customer (${CUSTOMER_COLUMNS}) ${customerRows(businessId, on)}`);
}

/** Works these days out again (the outbox worker, after the documents on them changed). */
export async function refreshSalesDays(tx: Tx, businessId: string, days: readonly string[]): Promise<void> {
  if (!days.length) return;
  await lockSummaries(tx, businessId);
  await writeDays(tx, businessId, days);
}

export interface SummaryRebuild {
  /** Rows (day x product or customer x salesperson) after the rebuild. */
  productRows: number;
  customerRows: number;
  /** Rows that were missing, extra or different before it: what the worker had missed. */
  drifted: number;
  /** Days with such rows, a few. */
  driftedDays: string[];
}

/** Every day worked out again, the rows that had drifted counted, and the summaries marked complete (the nightly job). */
export async function rebuildSalesSummaries(tx: Tx, businessId: string, asOf: string): Promise<SummaryRebuild> {
  await lockSummaries(tx, businessId);
  const all = onDays(null);
  const [drift] = (
    await tx.execute<{ drifted: number; days: string[] | null }>(sql`
      with fresh_p as (${productRows(businessId, all)}),
      fresh_c as (${customerRows(businessId, all)}),
      stored_p as (select ${PRODUCT_COLUMNS} from sales_daily_product where business_id = ${businessId}),
      stored_c as (select ${CUSTOMER_COLUMNS} from sales_daily_customer where business_id = ${businessId}),
      diff as (
        (select day from (select * from fresh_p except select * from stored_p) a)
        union all (select day from (select * from stored_p except select * from fresh_p) b)
        union all (select day from (select * from fresh_c except select * from stored_c) c)
        union all (select day from (select * from stored_c except select * from fresh_c) d)
      )
      select count(*)::int as drifted, (array_agg(distinct day::text order by day::text))[1:5] as days from diff`)
  ).rows;
  await writeDays(tx, businessId, null);
  const [counts] = (
    await tx.execute<{ p: number; c: number }>(sql`
      select (select count(*)::int from sales_daily_product where business_id = ${businessId}) as p,
             (select count(*)::int from sales_daily_customer where business_id = ${businessId}) as c`)
  ).rows;
  const result: SummaryRebuild = { productRows: counts!.p, customerRows: counts!.c, drifted: drift!.drifted, driftedDays: drift!.days ?? [] };
  const r = schema.analyticsRuns;
  const now = new Date().toISOString();
  await tx
    .insert(r)
    .values({ businessId, job: SUMMARY_JOB, asOf, status: "completed", finishedAt: now, details: result })
    .onConflictDoUpdate({ target: [r.businessId, r.job, r.asOf], set: { status: "completed", finishedAt: now, details: result } });
  return result;
}

/**
 * The last day reports may read from the summaries: the day before today once
 * they were built whole at least once, else null (the documents, then).
 */
export async function summariesThrough(tx: Tx, businessId: string, today: string): Promise<string | null> {
  const [row] = await tx
    .select({ asOf: schema.analyticsRuns.asOf })
    .from(schema.analyticsRuns)
    .where(and(eq(schema.analyticsRuns.businessId, businessId), eq(schema.analyticsRuns.job, SUMMARY_JOB), eq(schema.analyticsRuns.status, "completed")))
    .limit(1);
  return row ? addDays(today, -1) : null;
}

/** The outbox events whose documents a day's summaries count, and where each keeps its day. */
const DAY_OF: Record<string, { table: SQL; column: SQL }> = {
  "invoice.posted": { table: sql`invoices`, column: sql`invoice_date` },
  "invoice.cancelled": { table: sql`invoices`, column: sql`invoice_date` },
  "credit_note.posted": { table: sql`credit_debit_notes`, column: sql`note_date` },
  "credit_note.cancelled": { table: sql`credit_debit_notes`, column: sql`note_date` },
  "payment.received": { table: sql`payments`, column: sql`payment_date` },
  "payment.cancelled": { table: sql`payments`, column: sql`payment_date` },
  "payment.cheque_bounced": { table: sql`payments`, column: sql`payment_date` },
  "purchase.posted": { table: sql`purchases`, column: sql`received_date` },
  "purchase.cancelled": { table: sql`purchases`, column: sql`received_date` },
};

/** The days the events' documents fall on (to refresh), by outbox event id. */
export async function summaryDaysOf(tx: Tx, events: ReadonlyArray<{ id: number; eventType: string; aggregateId: string }>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const byType = new Map<string, Array<{ id: number; aggregateId: string }>>();
  for (const e of events) if (DAY_OF[e.eventType]) byType.set(e.eventType, [...(byType.get(e.eventType) ?? []), e]);
  for (const [type, list] of byType) {
    const { table, column } = DAY_OF[type]!;
    const rows = (
      await tx.execute<{ id: string; day: string }>(sql`select id, ${column}::text as day from ${table} where id in (${sql.join(list.map((e) => sql`${e.aggregateId}::uuid`), sql`, `)})`)
    ).rows;
    const dayOf = new Map(rows.map((r) => [r.id, r.day]));
    for (const e of list) {
      const day = dayOf.get(e.aggregateId);
      if (day) out.set(e.id, day);
    }
  }
  return out;
}


/**
 * Sales by product over a period, as rows to group further (product_id,
 * invoices, qty in base units, taxable, tax): the days through `through`
 * from the summaries, the rest from the bills. A product may appear twice
 * (once from each); the caller sums.
 */
export function productSalesRows(businessId: string, from: string, to: string, through: string | null): SQL {
  const bills = (a: string, b: string) => sql`
    select ii.product_id, count(distinct i.id)::int as invoices, sum(ii.qty_base) as qty, sum(ii.taxable_value) as taxable,
           sum(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount) as tax
    from invoice_items ii join invoices i on i.id = ii.invoice_id
    where i.business_id = ${businessId} and i.status = 'posted' and i.invoice_date between ${a} and ${b}
    group by ii.product_id`;
  if (!through || through < from) return bills(from, to);
  const last = to < through ? to : through;
  const summaries = sql`
    select product_id, sum(invoice_count)::int as invoices, sum(qty_sold) as qty, sum(taxable_value) as taxable, sum(tax_amount) as tax
    from sales_daily_product where business_id = ${businessId} and day between ${from} and ${last} and invoice_count > 0
    group by product_id`;
  return last >= to ? summaries : sql`${summaries} union all ${bills(addDays(last, 1), to)}`;
}
