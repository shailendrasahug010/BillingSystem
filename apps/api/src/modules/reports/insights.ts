import { abcClasses, addDays, changePercent, comparisonPeriod, daysBetween, daysSalesOutstanding, dec, inventoryTurnover, sharePercent, type AbcClass } from "@digitalbahi/core";
import type { Tx } from "@digitalbahi/db";
import { sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { assertRange } from "../../lib/period.js";
import type { ApiModule } from "../types.js";
import { netSaleLines } from "./analytics.js";
import { sendReport } from "./reports.js";

/**
 * Business intelligence (Phase 5.5): the period's measures against an
 * earlier period (sales, gross margin, bills, customers, returns,
 * collections, receivables and days to collect, stock value, turnover and
 * days of stock), a 12-month trend, who and what the sales come from
 * (customers, companies and salespeople with their share, ABC class and
 * growth) and how stock moves (fast, slow and dead). Margins and stock
 * values need report.view_profit, collections report.view_collection and
 * receivables report.view_outstanding, as in the reports.
 */
const InsightsQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  compare: z.enum(["previous", "last_year"]).default("previous"),
  /** For a file: the table to export. */
  section: z.enum(["customers", "companies", "salespeople", "fast", "slow", "dead"]).optional(),
  format: z.enum(["json", "csv", "pdf", "xlsx"]).default("json"),
});

/** Stock that sold but would last longer than this at the period's pace is slow. */
export const SLOW_AFTER_DAYS = 90;
/** Stock with no sale in this many days up to the end of the period is dead. */
export const DEAD_AFTER_DAYS = 90;
/** Rows of a contribution table sent to the screen (the file has them all). */
const TOP = 50;

interface Metric {
  value: string | null;
  previous: string | null;
  /** Percent change; for measures that are percents already, the change in points. */
  change: string | null;
}

const metric = (value: string | null, previous: string | null, points = false): Metric => ({
  value,
  previous,
  change: value === null || previous === null ? null : points ? dec(value).minus(previous).toFixed(1) : changePercent(value, previous),
});

interface Contribution {
  key: string;
  name: string;
  code: string | null;
  city: string | null;
  sales: string;
  cost: string;
  previousSales: string;
}

/** Sales lines net of credit notes (as the profit report), for a period. */
const lines = (businessId: string, from: string, to: string): SQL => netSaleLines(businessId, from, to);

async function trade(tx: Tx, businessId: string, from: string, to: string) {
  const [row] = (
    await tx.execute<{ sales: string; cost: string; returns: string }>(sql`
      select coalesce(sum(l.sales), 0)::numeric(15, 2)::text as sales, coalesce(sum(l.cost), 0)::numeric(15, 2)::text as cost,
             (select coalesce(sum(ni.taxable_value), 0)::numeric(15, 2)::text from credit_debit_note_items ni join credit_debit_notes n on n.id = ni.note_id
               where n.business_id = ${businessId} and n.status = 'posted' and n.party_type = 'customer' and n.reason = 'sales_return' and n.note_date between ${from} and ${to}) as returns
      from (${lines(businessId, from, to)}) l`)
  ).rows;
  const [bills] = (
    await tx.execute<{ bills: number; billing: string; customers: number; new_customers: number }>(sql`
      select count(*)::int as bills, coalesce(sum(grand_total), 0)::text as billing, count(distinct customer_id)::int as customers,
             (select count(*)::int from (select customer_id, min(invoice_date) as first from invoices where business_id = ${businessId} and status = 'posted' group by customer_id) f
               where f.first between ${from} and ${to}) as new_customers
      from invoices where business_id = ${businessId} and status = 'posted' and invoice_date between ${from} and ${to}`)
  ).rows;
  const [money] = (
    await tx.execute<{ collections: string; receivables: string; stock_end: string; stock_start: string }>(sql`
      select
        (select coalesce(sum(amount), 0)::text from payments where business_id = ${businessId} and direction = 'in' and party_type = 'customer' and status = 'posted'
           and cheque_status is distinct from 'bounced' and payment_date between ${from} and ${to}) as collections,
        (select coalesce(sum(debit - credit), 0)::text from party_ledger_entries where business_id = ${businessId} and party_type = 'customer' and entry_date <= ${to}) as receivables,
        (select coalesce(sum((qty_in - qty_out) * unit_cost), 0)::numeric(15, 2)::text from stock_ledger where business_id = ${businessId} and txn_date <= ${to}) as stock_end,
        (select coalesce(sum((qty_in - qty_out) * unit_cost), 0)::numeric(15, 2)::text from stock_ledger where business_id = ${businessId} and txn_date < ${from}) as stock_start`)
  ).rows;
  return { ...row!, ...bills!, ...money! };
}

/** One row per customer, company or salesperson with sales in either period (no company / no salesperson is one row). */
async function contribution(tx: Tx, businessId: string, by: "customer" | "company" | "salesperson", cur: { from: string; to: string }, prev: { from: string; to: string }): Promise<Contribution[]> {
  const key = { customer: sql`l.customer_id`, company: sql`p.brand_id`, salesperson: sql`l.salesperson_id` }[by];
  const named = {
    customer: sql`left join customers c on c.id = k.key`,
    company: sql`left join brands c on c.id = k.key`,
    salesperson: sql`left join employees c on c.id = k.key`,
  }[by];
  const name = by === "customer" ? sql`coalesce(c.business_name, c.name)` : sql`coalesce(c.name, '')`;
  const extra = by === "customer" ? sql`c.code, c.city` : sql`null::text as code, null::text as city`;
  return (
    await tx.execute<{ key: string; name: string; code: string | null; city: string | null; sales: string; cost: string; previous_sales: string }>(sql`
      with cur as (select ${key} as key, sum(l.sales) as sales, sum(l.cost) as cost from (${lines(businessId, cur.from, cur.to)}) l join products p on p.id = l.product_id group by 1),
      prev as (select ${key} as key, sum(l.sales) as sales from (${lines(businessId, prev.from, prev.to)}) l join products p on p.id = l.product_id group by 1),
      k as (select key from cur union select key from prev)
      select coalesce(k.key::text, '-') as key, ${name} as name, ${extra},
             coalesce(cur.sales, 0)::numeric(15, 2)::text as sales, coalesce(cur.cost, 0)::numeric(15, 2)::text as cost,
             coalesce(prev.sales, 0)::numeric(15, 2)::text as previous_sales
      from k ${named}
      left join cur on cur.key is not distinct from k.key
      left join prev on prev.key is not distinct from k.key`)
  ).rows.map((r) => ({ key: r.key, name: r.name, code: r.code, city: r.city, sales: r.sales, cost: r.cost, previousSales: r.previous_sales }));
}

/** Contribution rows with share, ABC class, growth and (for customers) whether they are new or lost. */
function shareOf(rows: Contribution[], showCost: boolean) {
  const classed = abcClasses(rows, (r) => r.sales);
  const out = classed.map((r) => {
    const margin = dec(r.sales).minus(r.cost).toFixed(2);
    const status = dec(r.previousSales).lte(0) && dec(r.sales).gt(0) ? "new" : dec(r.previousSales).gt(0) && dec(r.sales).lte(0) ? "lost" : dec(r.sales).gte(r.previousSales) ? "growing" : "declining";
    return {
      key: r.key,
      name: r.name,
      code: r.code,
      city: r.city,
      sales: r.sales,
      ...(showCost ? { margin, marginPercent: sharePercent(margin, r.sales) } : {}),
      share: r.share,
      cumulative: r.cumulative,
      abc: r.abc,
      previousSales: r.previousSales,
      change: changePercent(r.sales, r.previousSales),
      status,
    };
  });
  const total = rows.reduce((s, r) => (dec(r.sales).gt(0) ? s.plus(r.sales) : s), dec(0));
  const abc = Object.fromEntries(
    (["A", "B", "C"] as AbcClass[]).map((c) => {
      const inClass = out.filter((r) => r.abc === c && dec(r.sales).gt(0));
      const sales = inClass.reduce((s, r) => s.plus(r.sales), dec(0));
      return [c, { count: inClass.length, sales: sales.toFixed(2), share: sharePercent(sales, total) }];
    }),
  ) as Record<AbcClass, { count: number; sales: string; share: string | null }>;
  const lost = out.filter((r) => r.status === "lost");
  return {
    rows: out,
    abc,
    total: total.toFixed(2),
    count: out.filter((r) => dec(r.sales).gt(0)).length,
    newCount: out.filter((r) => r.status === "new").length,
    lostCount: lost.length,
    lostSales: lost.reduce((s, r) => s.plus(r.previousSales), dec(0)).toFixed(2),
  };
}

/** How each product moved in the period, with its stock at the end of it. */
async function movement(tx: Tx, businessId: string, from: string, to: string) {
  const days = daysBetween(from, to) + 1;
  const rows = (
    await tx.execute<{ id: string; code: string; name: string; unit: string; brand: string | null; qty: string; sales: string; cost: string; stock: string; stock_value: string; last_sold: string | null }>(sql`
      with l as (${lines(businessId, from, to)}),
      sold as (select product_id, sum(qty) as qty, sum(sales) as sales, sum(cost) as cost from l group by product_id),
      stock as (select product_id, sum(qty_in - qty_out) as qty, sum((qty_in - qty_out) * unit_cost) as value
                from stock_ledger where business_id = ${businessId} and txn_date <= ${to} group by product_id),
      last as (select ii.product_id, max(i.invoice_date) as day from invoice_items ii join invoices i on i.id = ii.invoice_id
               where i.business_id = ${businessId} and i.status = 'posted' and i.invoice_date <= ${to} group by ii.product_id)
      select p.id, p.code, p.name, u.symbol as unit, br.name as brand,
             coalesce(sold.qty, 0)::numeric(15, 3)::text as qty, coalesce(sold.sales, 0)::numeric(15, 2)::text as sales,
             coalesce(sold.cost, 0)::numeric(15, 2)::text as cost,
             coalesce(stock.qty, 0)::numeric(15, 3)::text as stock, greatest(coalesce(stock.value, 0), 0)::numeric(15, 2)::text as stock_value,
             last.day::text as last_sold
      from products p join units u on u.id = p.base_unit_id
      left join brands br on br.id = p.brand_id
      left join sold on sold.product_id = p.id
      left join stock on stock.product_id = p.id
      left join last on last.product_id = p.id
      where p.business_id = ${businessId} and p.deleted_at is null and p.is_active and (sold.qty is not null or coalesce(stock.qty, 0) > 0)`)
  ).rows.map((r) => {
    const qty = dec(r.qty);
    const stock = dec(r.stock);
    const perDay = qty.dividedBy(days);
    return {
      productId: r.id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      brand: r.brand,
      qtySold: qty.toFixed(3),
      sales: r.sales,
      margin: dec(r.sales).minus(r.cost).toFixed(2),
      stock: stock.toFixed(3),
      stockValue: r.stock_value,
      daysOfCover: perDay.gt(0) ? (stock.gt(0) ? stock.dividedBy(perDay).toFixed(0) : "0") : null,
      lastSold: r.last_sold,
    };
  });
  const deadSince = addDays(to, -DEAD_AFTER_DAYS);
  const fast = rows.filter((r) => dec(r.qtySold).gt(0)).sort((a, b) => dec(b.sales).comparedTo(dec(a.sales)));
  const slow = rows
    .filter((r) => dec(r.qtySold).gt(0) && r.daysOfCover !== null && Number(r.daysOfCover) > SLOW_AFTER_DAYS)
    .sort((a, b) => dec(b.stockValue).comparedTo(dec(a.stockValue)));
  const dead = rows
    .filter((r) => dec(r.stock).gt(0) && dec(r.qtySold).lte(0) && (r.lastSold === null || r.lastSold < deadSince))
    .sort((a, b) => dec(b.stockValue).comparedTo(dec(a.stockValue)));
  const value = (list: typeof rows) => list.reduce((s, r) => s.plus(r.stockValue), dec(0)).toFixed(2);
  return { fast, slow, dead, slowValue: value(slow), deadValue: value(dead) };
}

/** Sales (and margin) of each of the 12 months ending with the period's last month. */
async function trend(tx: Tx, businessId: string, to: string) {
  const [y, m] = to.slice(0, 7).split("-").map(Number) as [number, number];
  const startIndex = y * 12 + (m - 1) - 11;
  const start = `${Math.floor(startIndex / 12)}-${String((startIndex % 12) + 1).padStart(2, "0")}-01`;
  const sums = new Map(
    (
      await tx.execute<{ month: string; sales: string; cost: string }>(sql`
        select to_char(l.day, 'YYYY-MM') as month, sum(l.sales)::numeric(15, 2)::text as sales, sum(l.cost)::numeric(15, 2)::text as cost
        from (${lines(businessId, start, to)}) l group by 1`)
    ).rows.map((r) => [r.month, r]),
  );
  return Array.from({ length: 12 }, (_, i) => {
    const idx = startIndex + i;
    const month = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
    const row = sums.get(month);
    return { month, sales: row?.sales ?? "0.00", margin: row ? dec(row.sales).minus(row.cost).toFixed(2) : "0.00" };
  });
}

export const insightsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.get("/insights", { preHandler: guard(deps, "report.view_bi"), schema: { tags: ["reports"], querystring: InsightsQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    if (q.format !== "json" && !q.section) throw badRequest("SECTION_REQUIRED", {}, "section");
    const prev = comparisonPeriod(q.from, q.to, q.compare);
    const days = daysBetween(q.from, q.to) + 1;
    const showCost = can(ctx, "report.view_profit");
    const showCollections = can(ctx, "report.view_collection");
    const showReceivables = can(ctx, "report.view_outstanding");

    const data = await tenant(ctx, async (tx) => {
      const [now, before] = [await trade(tx, ctx.businessId, q.from, q.to), await trade(tx, ctx.businessId, prev.from, prev.to)];
      const margin = (t: typeof now) => dec(t.sales).minus(t.cost).toFixed(2);
      const avgBill = (t: typeof now) => (t.bills > 0 ? dec(t.billing).dividedBy(t.bills).toFixed(2) : null);
      const stock = (t: typeof now) => inventoryTurnover(t.cost, t.stock_start, t.stock_end, days);
      const kpis = {
        netSales: metric(now.sales, before.sales),
        bills: metric(String(now.bills), String(before.bills)),
        averageBill: metric(avgBill(now), avgBill(before)),
        customersBilled: metric(String(now.customers), String(before.customers)),
        newCustomers: metric(String(now.new_customers), String(before.new_customers)),
        returns: metric(now.returns, before.returns),
        returnRate: metric(sharePercent(now.returns, dec(now.sales).plus(now.returns)) ?? "0.0", sharePercent(before.returns, dec(before.sales).plus(before.returns)) ?? "0.0", true),
        ...(showCost
          ? {
              grossMargin: metric(margin(now), margin(before)),
              marginPercent: metric(sharePercent(margin(now), now.sales), sharePercent(margin(before), before.sales), true),
              costOfGoodsSold: metric(now.cost, before.cost),
              inventoryValue: metric(now.stock_end, before.stock_end),
              turnover: metric(stock(now).turnover, stock(before).turnover),
              daysOfInventory: metric(stock(now).daysOfInventory, stock(before).daysOfInventory),
            }
          : {}),
        ...(showCollections ? { collections: metric(dec(now.collections).toFixed(2), dec(before.collections).toFixed(2)) } : {}),
        ...(showReceivables
          ? {
              receivables: metric(dec(now.receivables).toFixed(2), dec(before.receivables).toFixed(2)),
              daysSalesOutstanding: metric(daysSalesOutstanding(now.receivables, now.billing, days), daysSalesOutstanding(before.receivables, before.billing, days)),
            }
          : {}),
      };
      const [customers, companies, salespeople] = [
        shareOf(await contribution(tx, ctx.businessId, "customer", q, prev), showCost),
        shareOf(await contribution(tx, ctx.businessId, "company", q, prev), showCost),
        shareOf(await contribution(tx, ctx.businessId, "salesperson", q, prev), showCost),
      ];
      const moves = await movement(tx, ctx.businessId, q.from, q.to);
      return { kpis, customers, companies, salespeople, moves, trend: await trend(tx, ctx.businessId, q.to) };
    });

    const strip = <T extends { margin: string; stockValue: string }>(row: T) => (showCost ? row : (({ margin: _m, stockValue: _v, ...rest }) => rest)(row));
    if (q.format !== "json") {
      const party = q.section === "customers" || q.section === "companies" || q.section === "salespeople";
      const table = party ? data[q.section as "customers" | "companies" | "salespeople"].rows : data.moves[q.section as "fast" | "slow" | "dead"].map(strip);
      const columns = party
        ? [
            ...(q.section === "customers" ? [{ key: "code", label: "Code" }] : []),
            { key: "name", label: q.section === "customers" ? "Customer" : q.section === "companies" ? "Company" : "Salesperson" },
            { key: "sales", label: "Sales" },
            ...(showCost ? [{ key: "margin", label: "Margin" }] : []),
            { key: "share", label: "Share %" },
            { key: "abc", label: "Class" },
            { key: "previousSales", label: "Earlier period" },
            { key: "change", label: "Change %" },
          ]
        : [
            { key: "code", label: "Code" },
            { key: "name", label: "Product" },
            { key: "brand", label: "Company" },
            { key: "qtySold", label: "Qty sold" },
            { key: "sales", label: "Sales" },
            { key: "stock", label: "Stock" },
            ...(showCost ? [{ key: "stockValue", label: "Stock value" }] : []),
            { key: "daysOfCover", label: "Days of cover" },
            { key: "lastSold", label: "Last sold" },
          ];
      const titles = { customers: "Customer contribution", companies: "Company contribution", salespeople: "Salesperson contribution", fast: "Fast movers", slow: "Slow movers", dead: "Dead stock" };
      return sendReport(reply, ctx, deps, q.format, `insights-${q.section}-${q.from}-${q.to}`, columns, { rows: table as Array<Record<string, unknown>> }, { title: titles[q.section!], from: q.from, to: q.to });
    }

    const top = <T>(section: { rows: T[] }) => ({ ...section, rows: section.rows.slice(0, TOP) });
    return {
      from: q.from,
      to: q.to,
      days,
      compare: { basis: q.compare, ...prev },
      kpis: data.kpis,
      trend: showCost ? data.trend : data.trend.map(({ margin: _m, ...rest }) => rest),
      customers: top(data.customers),
      companies: top(data.companies),
      salespeople: top(data.salespeople),
      movers: {
        slowAfterDays: SLOW_AFTER_DAYS,
        deadAfterDays: DEAD_AFTER_DAYS,
        fast: data.moves.fast.slice(0, 10).map(strip),
        slow: data.moves.slow.slice(0, 10).map(strip),
        dead: data.moves.dead.slice(0, 10).map(strip),
        slowCount: data.moves.slow.length,
        deadCount: data.moves.dead.length,
        ...(showCost ? { slowValue: data.moves.slowValue, deadValue: data.moves.deadValue } : {}),
      },
    };
  });
};
