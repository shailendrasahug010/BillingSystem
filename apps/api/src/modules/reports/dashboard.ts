import { DashboardQuery } from "@digitalbahi/contracts";
import { addDays, ageDocuments, dec, financialYearOf } from "@digitalbahi/core";
import { schema } from "@digitalbahi/db";
import { eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { can, guard } from "../../lib/access.js";
import { withTenant } from "../../lib/db.js";
import { resolvePeriod } from "../../lib/period.js";
import { productSalesRows, summariesThrough } from "../../services/sales-daily.js";
import { getSettings } from "../../services/settings.js";
import type { ApiModule } from "../types.js";

/**
 * The home screen in one request: today's numbers, the chosen period against
 * the previous one, receivables aging, trend, top customers / products and
 * what needs attention. Money figures beyond sales and collections need
 * dashboard.view_financials.
 */
export const dashboardModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/dashboard", { preHandler: guard(deps, "dashboard.view"), schema: { tags: ["reports"], querystring: DashboardQuery } }, async (request) => {
    const ctx = request.ctx;
    const financials = can(ctx, "dashboard.view_financials");
    const today = deps.clock.today(ctx.timeZone);
    return withTenant(deps.db, ctx, async (tx) => {
      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const period = resolvePeriod(request.query.range, today, business!.financialYearStartMonth, request.query);
      const settings = await getSettings(tx, ctx.businessId, ["reports.aging_buckets", "stock.expiry_warning_days"] as const);
      const b = ctx.businessId;

      const sums = async (from: string, to: string) => {
        const [row] = (
          await tx.execute<{ sales: string; invoices: number; taxable: string; cost: string; collections: string; purchases: string; expenses: string; orders: number }>(sql`
            select
              (select coalesce(sum(grand_total), 0) from invoices where business_id = ${b} and status = 'posted' and invoice_date between ${from} and ${to})::text as sales,
              (select count(*) from invoices where business_id = ${b} and status = 'posted' and invoice_date between ${from} and ${to})::int as invoices,
              (select coalesce(sum(taxable_total), 0) from invoices where business_id = ${b} and status = 'posted' and invoice_date between ${from} and ${to})::text as taxable,
              (select coalesce(sum(cost_total), 0) from invoices where business_id = ${b} and status = 'posted' and invoice_date between ${from} and ${to})::text as cost,
              (select coalesce(sum(amount), 0) from payments where business_id = ${b} and status = 'posted' and direction = 'in' and payment_date between ${from} and ${to})::text as collections,
              (select coalesce(sum(grand_total), 0) from purchases where business_id = ${b} and status = 'posted' and supplier_invoice_date between ${from} and ${to})::text as purchases,
              (select coalesce(sum(total_amount), 0) from expenses where business_id = ${b} and status = 'posted' and expense_date between ${from} and ${to})::text as expenses,
              (select count(*) from sales_orders where business_id = ${b} and order_date between ${from} and ${to})::int as orders`)
        ).rows;
        const s = row!;
        return {
          sales: dec(s.sales).toFixed(2),
          invoices: s.invoices,
          avgBill: s.invoices ? dec(s.sales).dividedBy(s.invoices).toFixed(2) : "0.00",
          collections: dec(s.collections).toFixed(2),
          orders: s.orders,
          ...(financials
            ? {
                purchases: dec(s.purchases).toFixed(2),
                expenses: dec(s.expenses).toFixed(2),
                grossProfit: dec(s.taxable).minus(s.cost).toFixed(2),
                marginPercent: dec(s.taxable).gt(0) ? dec(s.taxable).minus(s.cost).dividedBy(s.taxable).times(100).toFixed(1) : "0.0",
              }
            : {}),
        };
      };

      const [todayNums, yesterdayNums, current, previous] = [
        await sums(today, today),
        await sums(addDays(today, -1), addDays(today, -1)),
        await sums(period.from, period.to),
        await sums(period.previous.from, period.previous.to),
      ];

      const open = (
        await tx.execute<{ id: string; number: string; date: string; due_date: string; balance: string }>(sql`
          select id, invoice_number as number, invoice_date::text as date, coalesce(due_date, invoice_date)::text as due_date, balance_due::text as balance
          from invoices where business_id = ${b} and status = 'posted' and balance_due > 0`)
      ).rows;
      const aging = ageDocuments(
        open.map((o) => ({ id: o.id, number: o.number, date: o.date, dueDate: o.due_date, balance: o.balance })),
        { asOf: today, basis: "due_date", edges: settings["reports.aging_buckets"] },
      );
      const [balances] = (
        await tx.execute<{ receivable: string; payable: string; advances: string }>(sql`
          select (select coalesce(sum(balance) filter (where balance > 0), 0) from customers where business_id = ${b} and deleted_at is null)::text as receivable,
                 (select coalesce(sum(balance) filter (where balance > 0), 0) from suppliers where business_id = ${b} and deleted_at is null)::text as payable,
                 (select coalesce(-sum(balance) filter (where balance < 0), 0) from customers where business_id = ${b} and deleted_at is null)::text as advances`)
      ).rows;

      // Trend buckets for the chosen grain, oldest first; the last bucket ends today.
      const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
      const buckets: Array<{ from: string; to: string }> = [];
      const grain = request.query.grain;
      if (grain === "daily") {
        for (let i = 29; i >= 0; i--) buckets.push({ from: addDays(today, -i), to: addDays(today, -i) });
      } else if (grain === "weekly") {
        for (let i = 11; i >= 0; i--) buckets.push({ from: addDays(today, -7 * i - 6), to: addDays(today, -7 * i) });
      } else if (grain === "monthly") {
        let start = monthStart(today);
        const starts = [start];
        for (let i = 0; i < 5; i++) {
          start = monthStart(addDays(start, -1));
          starts.unshift(start);
        }
        starts.forEach((s, i) => buckets.push({ from: s, to: i === starts.length - 1 ? today : addDays(starts[i + 1]!, -1) }));
      } else {
        const fy = financialYearOf(today, business!.financialYearStartMonth);
        for (let back = 2; back >= 0; back--) {
          const from = `${fy.startYear - back}${fy.startDate.slice(4)}`;
          const to = back === 0 ? today : addDays(`${fy.startYear - back + 1}${fy.startDate.slice(4)}`, -1);
          buckets.push({ from, to });
        }
      }
      const trend = (
        await tx.execute<{ from: string; to: string; sales: string; collections: string }>(sql`
          select bk.f::text as from, bk.t::text as to,
                 coalesce((select sum(grand_total) from invoices where business_id = ${b} and status = 'posted' and invoice_date between bk.f and bk.t), 0)::text as sales,
                 coalesce((select sum(amount) from payments where business_id = ${b} and status = 'posted' and direction = 'in' and payment_date between bk.f and bk.t), 0)::text as collections
          from (values ${sql.join(
            buckets.map((x) => sql`(${x.from}::date, ${x.to}::date)`),
            sql`, `,
          )}) as bk(f, t)
          order by bk.f`)
      ).rows;
      const month = resolvePeriod("thisMonth", today, business!.financialYearStartMonth);
      const [monthNow, monthBefore] = [await sums(month.from, month.to), await sums(month.previous.from, month.previous.to)];

      const topCustomers = (
        await tx.execute<{ id: string; name: string; sales: string; invoices: number }>(sql`
          select c.id, coalesce(c.business_name, c.name) as name, sum(i.grand_total)::text as sales, count(*)::int as invoices
          from invoices i join customers c on c.id = i.customer_id
          where i.business_id = ${b} and i.status = 'posted' and i.invoice_date between ${period.from} and ${period.to}
          group by c.id, c.name, c.business_name order by sum(i.grand_total) desc limit 5`)
      ).rows;
      // Product sales: past days from the daily summaries once they are complete, today from the bills.
      const sold = productSalesRows(b, period.from, period.to, await summariesThrough(tx, b, today));
      const topBrands = (
        await tx.execute<{ id: string; name: string; taxable: string }>(sql`
          with s as (${sold})
          select coalesce(p.brand_id::text, '-') as id, coalesce(max(br.name), '-') as name, sum(s.taxable)::text as taxable
          from s join products p on p.id = s.product_id left join brands br on br.id = p.brand_id
          group by 1 order by sum(s.taxable) desc limit 7`)
      ).rows;
      const topProducts = (
        await tx.execute<{ id: string; name: string; qty: string; taxable: string }>(sql`
          with s as (${sold})
          select s.product_id as id, max(p.name) as name, sum(s.qty)::text as qty, sum(s.taxable)::text as taxable
          from s join products p on p.id = s.product_id
          group by s.product_id order by sum(s.taxable) desc limit 5`)
      ).rows;

      const [attention] = (
        await tx.execute<{ low_stock: number; out_of_stock: number; expiring: number; pending_cheques: number; overdue_customers: number }>(sql`
          select
            (select count(*) from products p where p.business_id = ${b} and p.deleted_at is null and p.is_active and p.min_stock is not null
               and coalesce((select sum(qty) from stock_balances sb where sb.product_id = p.id), 0) between 0.001 and p.min_stock)::int as low_stock,
            (select count(*) from products p where p.business_id = ${b} and p.deleted_at is null and p.is_active
               and coalesce((select sum(qty) from stock_balances sb where sb.product_id = p.id), 0) <= 0)::int as out_of_stock,
            (select count(distinct bt.id) from batches bt join stock_balances sb on sb.batch_id = bt.id and sb.qty > 0
               where bt.business_id = ${b} and bt.expiry_date <= ${addDays(today, settings["stock.expiry_warning_days"])})::int as expiring,
            (select count(*) from payments where business_id = ${b} and status = 'posted' and method = 'cheque' and cheque_status in ('pending', 'deposited'))::int as pending_cheques,
            (select count(distinct customer_id) from invoices where business_id = ${b} and status = 'posted' and balance_due > 0 and due_date < ${today})::int as overdue_customers`)
      ).rows;
      const overdueCustomers = (
        await tx.execute<{ id: string; name: string; mobile: string | null; city: string | null; overdue: string; count: number; oldest_days: number }>(sql`
          select c.id, coalesce(c.business_name, c.name) as name, c.mobile, c.city, sum(i.balance_due)::text as overdue, count(*)::int as count,
                 (${today}::date - min(i.due_date))::int as oldest_days
          from invoices i join customers c on c.id = i.customer_id
          where i.business_id = ${b} and i.status = 'posted' and i.balance_due > 0 and i.due_date < ${today}
          group by c.id, c.name, c.business_name, c.mobile, c.city order by sum(i.balance_due) desc limit 5`)
      ).rows;
      const [orders] = (
        await tx.execute<{ pending: number; to_pack: number; to_dispatch: number }>(sql`
          select count(*) filter (where status in ('pending', 'confirmed'))::int as pending,
                 count(*) filter (where status in ('confirmed', 'packing'))::int as to_pack,
                 count(*) filter (where status = 'packed')::int as to_dispatch
          from sales_orders where business_id = ${b}`)
      ).rows;

      return {
        asOf: today,
        period: { from: period.from, to: period.to, previous: period.previous },
        today: todayNums,
        yesterday: yesterdayNums,
        current,
        previous,
        receivable: {
          total: dec(balances!.receivable).toFixed(2),
          overdue: aging.buckets.reduce((acc, x) => acc.plus(x.amount), dec(0)).toFixed(2),
          notDue: aging.notDue.toFixed(2),
          advances: dec(balances!.advances).toFixed(2),
          aging: aging.buckets.map((x) => ({ label: x.label, from: x.from, to: x.to, amount: x.amount.toFixed(2), count: x.count })),
        },
        ...(financials ? { payable: { total: dec(balances!.payable).toFixed(2) } } : {}),
        grain,
        trend: trend.map((d) => ({ from: d.from, to: d.to, sales: dec(d.sales).toFixed(2), collections: dec(d.collections).toFixed(2) })),
        month: { current: monthNow, previous: monthBefore },
        topBrands: topBrands.map((x) => ({ id: x.id, name: x.name, sales: dec(x.taxable).toFixed(2) })),
        topCustomers: topCustomers.map((c) => ({ id: c.id, name: c.name, sales: dec(c.sales).toFixed(2), invoices: c.invoices })),
        topProducts: topProducts.map((p) => ({ id: p.id, name: p.name, qty: dec(p.qty).toFixed(3), sales: dec(p.taxable).toFixed(2) })),
        attention: {
          lowStock: attention!.low_stock,
          outOfStock: attention!.out_of_stock,
          expiringBatches: attention!.expiring,
          pendingCheques: attention!.pending_cheques,
          overdueCustomers: attention!.overdue_customers,
          topOverdue: overdueCustomers.map((c) => ({ id: c.id, name: c.name, mobile: c.mobile, city: c.city, overdue: dec(c.overdue).toFixed(2), count: c.count, oldestDays: c.oldest_days })),
        },
        orders: { pending: orders!.pending, toPack: orders!.to_pack, toDispatch: orders!.to_dispatch },
      };
    });
  });
};
