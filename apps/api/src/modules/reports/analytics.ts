import { dec, daysBetween } from "@digitalbahi/core";
import type { Tx } from "@digitalbahi/db";
import { sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { assertRange } from "../../lib/period.js";
import type { ApiModule } from "../types.js";
import { sendReport } from "./reports.js";

const Range = { from: z.iso.date(), to: z.iso.date(), format: z.enum(["json", "csv", "pdf", "xlsx"]).default("json") };
const ProfitQuery = z.object({ ...Range, groupBy: z.enum(["product", "brand", "category", "customer", "salesperson", "month"]).default("product") });

/**
 * Sale lines net of notes, with the cost of the goods at sale time: returns
 * take back quantity, value and cost (at the bill's cost, or the note's own
 * for goods returned without their bill); discounts and rate differences take
 * back value only; debit notes add value.
 */
export function netSaleLines(businessId: string, from: string, to: string): SQL {
  return sql`
    select ii.product_id, i.customer_id, i.salesperson_id, i.invoice_date as day,
           (ii.qty_base + ii.free_qty * ii.conversion_factor) as qty, ii.taxable_value as sales,
           (ii.qty_base + ii.free_qty * ii.conversion_factor) * ii.unit_cost as cost
    from invoice_items ii join invoices i on i.id = ii.invoice_id
    where i.business_id = ${businessId} and i.status = 'posted' and i.invoice_date between ${from} and ${to}
    union all
    select ni.product_id, n.customer_id, i.salesperson_id, n.note_date as day,
           case when n.note_type = 'debit' or n.reason in ('discount', 'rate_difference') then 0 else -ni.qty_base end,
           case when n.note_type = 'debit' then ni.taxable_value else -ni.taxable_value end,
           case when n.note_type = 'debit' or n.reason in ('discount', 'rate_difference') then 0 else -ni.qty_base * coalesce(ii.unit_cost, ni.unit_cost) end
    from credit_debit_note_items ni join credit_debit_notes n on n.id = ni.note_id
    left join invoice_items ii on ii.id = ni.original_line_id left join invoices i on i.id = n.invoice_id
    where n.business_id = ${businessId} and n.status = 'posted' and n.party_type = 'customer' and n.note_date between ${from} and ${to}`;
}

const pct = (margin: string, sales: string) => (dec(sales).gt(0) ? dec(margin).times(100).dividedBy(sales).toFixed(1) : null);

export const analyticsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** Margin by product, company (brand), category, customer, salesperson or month. */
  r.get("/reports/profit", { preHandler: guard(deps, "report.view_profit"), schema: { tags: ["reports"], querystring: ProfitQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    const group = {
      product: { key: sql`l.product_id::text`, label: sql`max(p.name)` },
      brand: { key: sql`coalesce(p.brand_id::text, '-')`, label: sql`coalesce(max(br.name), 'No brand')` },
      category: { key: sql`coalesce(p.category_id::text, '-')`, label: sql`coalesce(max(pc.name), 'No category')` },
      customer: { key: sql`l.customer_id::text`, label: sql`max(coalesce(c.business_name, c.name))` },
      salesperson: { key: sql`coalesce(l.salesperson_id::text, '-')`, label: sql`coalesce(max(e.name), 'Unassigned')` },
      month: { key: sql`to_char(l.day, 'YYYY-MM')`, label: sql`to_char(l.day, 'YYYY-MM')` },
    }[q.groupBy];
    const { rows, totals } = await tenant(ctx, async (tx) => {
      const rows = (
        await tx.execute<{ key: string; label: string; qty: string; sales: string; cost: string }>(sql`
          with l as (${netSaleLines(ctx.businessId, q.from, q.to)})
          select ${group.key} as key, ${group.label} as label, sum(l.qty)::numeric(15, 3)::text as qty,
                 sum(l.sales)::numeric(15, 2)::text as sales, sum(l.cost)::numeric(15, 2)::text as cost
          from l join products p on p.id = l.product_id
          left join brands br on br.id = p.brand_id
          left join product_categories pc on pc.id = p.category_id
          left join customers c on c.id = l.customer_id
          left join employees e on e.id = l.salesperson_id
          group by 1 order by ${q.groupBy === "month" ? sql`1` : sql`sum(l.sales) - sum(l.cost) desc`}`)
      ).rows.map((x) => {
        const margin = dec(x.sales).minus(x.cost).toFixed(2);
        return { key: x.key, label: x.label, qty: x.qty, sales: x.sales, cost: x.cost, margin, marginPercent: pct(margin, x.sales) };
      });
      const sales = rows.reduce((s, x) => s.plus(x.sales), dec(0)).toFixed(2);
      const cost = rows.reduce((s, x) => s.plus(x.cost), dec(0)).toFixed(2);
      const margin = dec(sales).minus(cost).toFixed(2);
      return { rows, totals: { sales, cost, margin, marginPercent: pct(margin, sales) } };
    });
    return sendReport(
      reply,
      ctx,
      deps,
      q.format,
      `profit-${q.groupBy}-${q.from}-${q.to}`,
      [
        { key: "label", label: q.groupBy },
        { key: "qty", label: "Qty" },
        { key: "sales", label: "Sales (taxable)" },
        { key: "cost", label: "Cost" },
        { key: "margin", label: "Margin" },
        { key: "marginPercent", label: "Margin %" },
      ],
      { from: q.from, to: q.to, groupBy: q.groupBy, rows, totals },
      { title: `Profit by ${q.groupBy}`, from: q.from, to: q.to },
    );
  });

  /** Profit and loss for a period: net sales, cost of goods sold, expenses by category, salaries, net profit. */
  r.get("/reports/pnl", { preHandler: guard(deps, "report.view_profit"), schema: { tags: ["reports"], querystring: z.object({ from: z.iso.date(), to: z.iso.date() }) } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    return tenant(ctx, async (tx) => {
      const [trade] = (
        await tx.execute<{ sales: string; cost: string }>(sql`
          with l as (${netSaleLines(ctx.businessId, q.from, q.to)})
          select coalesce(sum(sales), 0)::numeric(15, 2)::text as sales, coalesce(sum(cost), 0)::numeric(15, 2)::text as cost from l`)
      ).rows;
      const expenses = (
        await tx.execute<{ category: string; category_hi: string | null; amount: string }>(sql`
          select c.name as category, c.name_hi as category_hi, sum(x.amount)::text as amount
          from expenses x join expense_categories c on c.id = x.category_id
          where x.business_id = ${ctx.businessId} and x.status = 'posted' and x.expense_date between ${q.from} and ${q.to}
          group by c.id, c.name, c.name_hi order by sum(x.amount) desc`)
      ).rows;
      // Salaries of payroll months that fall in the period (finalized or paid).
      const [salaries] = (
        await tx.execute<{ amount: string }>(sql`
          select coalesce(sum(s.gross_earnings), 0)::text as amount
          from salary_slips s join payroll_runs r on r.id = s.payroll_run_id
          where r.business_id = ${ctx.businessId} and r.status in ('finalized', 'paid')
            and r.period_month between date_trunc('month', ${q.from}::date) and ${q.to}::date`)
      ).rows;
      const sales = dec(trade!.sales);
      const cogs = dec(trade!.cost);
      const gross = sales.minus(cogs);
      const expenseTotal = expenses.reduce((s, e) => s.plus(e.amount), dec(0));
      const net = gross.minus(expenseTotal).minus(salaries!.amount);
      return {
        from: q.from,
        to: q.to,
        sales: sales.toFixed(2),
        costOfGoodsSold: cogs.toFixed(2),
        grossProfit: gross.toFixed(2),
        grossMarginPercent: pct(gross.toFixed(2), sales.toFixed(2)),
        expenses: expenses.map((e) => ({ category: e.category, categoryHi: e.category_hi, amount: dec(e.amount).toFixed(2) })),
        expenseTotal: expenseTotal.toFixed(2),
        salaries: dec(salaries!.amount).toFixed(2),
        netProfit: net.toFixed(2),
        netMarginPercent: pct(net.toFixed(2), sales.toFixed(2)),
      };
    });
  });

  /** Product movement: sold, margin, stock, stock value, days of cover; fast, slow and not moving. */
  r.get("/reports/products", { preHandler: guard(deps, "report.view_sales"), schema: { tags: ["reports"], querystring: z.object(Range) } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    const days = daysBetween(q.from, q.to) + 1;
    const showCost = can(ctx, "report.view_profit");
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{ id: string; code: string; name: string; unit: string; brand: string | null; qty: string; sales: string; cost: string; stock: string; avg_cost: string; last_sold: string | null }>(sql`
          with l as (${netSaleLines(ctx.businessId, q.from, q.to)}),
          sold as (select product_id, sum(qty) as qty, sum(sales) as sales, sum(cost) as cost from l group by product_id),
          stock as (select product_id, sum(qty) as qty from stock_balances where business_id = ${ctx.businessId} group by product_id)
          select p.id, p.code, p.name, u.symbol as unit, br.name as brand,
                 coalesce(sold.qty, 0)::numeric(15, 3)::text as qty, coalesce(sold.sales, 0)::numeric(15, 2)::text as sales,
                 coalesce(sold.cost, 0)::numeric(15, 2)::text as cost, coalesce(stock.qty, 0)::text as stock, p.avg_cost::text,
                 (select max(i.invoice_date)::text from invoice_items ii join invoices i on i.id = ii.invoice_id where ii.product_id = p.id and i.status = 'posted') as last_sold
          from products p join units u on u.id = p.base_unit_id
          left join brands br on br.id = p.brand_id
          left join sold on sold.product_id = p.id
          left join stock on stock.product_id = p.id
          where p.business_id = ${ctx.businessId} and p.deleted_at is null and p.is_active
          order by coalesce(sold.sales, 0) desc, p.name
          limit 1000`)
      ).rows.map((x) => {
        const qty = dec(x.qty);
        const stock = dec(x.stock);
        const perDay = qty.dividedBy(days);
        const cover = perDay.gt(0) ? stock.dividedBy(perDay).toFixed(0) : null;
        const margin = dec(x.sales).minus(x.cost).toFixed(2);
        return {
          productId: x.id,
          code: x.code,
          name: x.name,
          unit: x.unit,
          brand: x.brand,
          qtySold: qty.toFixed(3),
          sales: x.sales,
          ...(showCost ? { margin, marginPercent: pct(margin, x.sales), stockValue: stock.gt(0) ? stock.times(x.avg_cost).toFixed(2) : "0.00" } : {}),
          stock: stock.toFixed(3),
          daysOfCover: cover,
          lastSold: x.last_sold,
          movement: qty.lte(0) ? (stock.gt(0) ? "not_moving" : "no_stock") : null,
        };
      }),
    );
    // Fast movers: the products making the top 80% of sales; the rest that sold are slow.
    const total = rows.reduce((s, x) => s.plus(x.sales), dec(0));
    let running = dec(0);
    const data = rows.map((x) => {
      if (x.movement) return x;
      running = running.plus(x.sales);
      return { ...x, movement: total.gt(0) && running.minus(x.sales).lt(total.times(0.8)) ? "fast" : "slow" };
    });
    return sendReport(
      reply,
      ctx,
      deps,
      q.format,
      `products-${q.from}-${q.to}`,
      [
        { key: "code", label: "Code" },
        { key: "name", label: "Product" },
        { key: "brand", label: "Company" },
        { key: "qtySold", label: "Qty sold" },
        { key: "sales", label: "Sales" },
        ...(showCost ? [{ key: "margin", label: "Margin" }, { key: "stockValue", label: "Stock value" }] : []),
        { key: "stock", label: "Stock" },
        { key: "daysOfCover", label: "Days of cover" },
        { key: "movement", label: "Movement" },
      ],
      { from: q.from, to: q.to, rows: data },
      { title: "Product movement", from: q.from, to: q.to },
    );
  });
};
