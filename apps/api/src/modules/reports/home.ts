import { dec, type Permission } from "@vyapaar/core";
import type { Tx } from "@vyapaar/db";
import { sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { can, guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import type { ApiModule } from "../types.js";

/**
 * The home screen for every role: only the parts the person's role may see,
 * so a warehouse worker starts with what is waiting to be packed and sent, HR
 * with who is in today and the leave to decide, a collector with the promises
 * due today. (Sales figures stay on /dashboard, for dashboard.view.)
 */
export const homeModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.get("/home", { preHandler: guard(deps), schema: { tags: ["reports"] } }, async (request) => {
    const ctx = request.ctx;
    const b = ctx.businessId;
    const today = deps.clock.today(ctx.timeZone);
    const may = (...perms: Permission[]) => perms.some((p) => can(ctx, p));
    const month = `${today.slice(0, 7)}-01`;

    return tenant(ctx, async (tx) => {
      const out: Record<string, unknown> = { asOf: today };

      if (may("order.view", "packing.view", "dispatch.view")) {
        const [counts] = (
          await tx.execute<{ pending: number; to_pack: number; to_dispatch: number }>(sql`
            select count(*) filter (where status in ('pending', 'confirmed'))::int as pending,
                   count(*) filter (where status in ('confirmed', 'packing'))::int as to_pack,
                   count(*) filter (where status = 'packed')::int as to_dispatch
            from sales_orders where business_id = ${b}`)
        ).rows;
        // The oldest first: what should go out next.
        const queue = (stage: "pack" | "dispatch") =>
          tx.execute<{ id: string; number: string | null; date: string; customer: string; city: string | null; status: string }>(sql`
            select o.id, o.order_number as number, o.order_date::text as date, coalesce(c.business_name, c.name) as customer, c.city, o.status::text as status
            from sales_orders o join customers c on c.id = o.customer_id
            where o.business_id = ${b} and o.status in ${stage === "pack" ? sql`('confirmed', 'packing')` : sql`('packed')`}
            order by o.order_date, o.created_at limit 5`);
        out.orders = {
          ...(may("order.view") ? { pending: counts!.pending } : {}),
          ...(may("packing.view", "order.view") ? { toPack: counts!.to_pack } : {}),
          ...(may("dispatch.view", "order.view") ? { toDispatch: counts!.to_dispatch } : {}),
          ...(may("packing.view") ? { packNext: (await queue("pack")).rows } : {}),
          ...(may("dispatch.view") ? { dispatchNext: (await queue("dispatch")).rows } : {}),
        };
      }

      if (may("employee.view")) {
        const [p] = (
          await tx.execute<{ employees: number; present: number; absent: number; half_day: number; on_leave: number; off: number; not_marked: number }>(sql`
            select count(*)::int as employees,
                   count(*) filter (where a.status = 'present')::int as present,
                   count(*) filter (where a.status = 'absent')::int as absent,
                   count(*) filter (where a.status = 'half_day')::int as half_day,
                   count(*) filter (where a.status = 'leave')::int as on_leave,
                   count(*) filter (where a.status in ('holiday', 'week_off'))::int as off,
                   count(*) filter (where a.id is null)::int as not_marked
            from employees e
            left join attendance a on a.employee_id = e.id and a.date = ${today}
            where e.business_id = ${b} and e.deleted_at is null and e.status in ('active', 'on_notice')`)
        ).rows;
        out.people = { employees: p!.employees, present: p!.present, absent: p!.absent, halfDay: p!.half_day, onLeave: p!.on_leave, off: p!.off, notMarked: p!.not_marked };
      }

      if (may("leave.view", "leave.approve")) {
        const pending = (
          await tx.execute<{ id: string; employee: string; type: string; from_date: string; to_date: string; days: string }>(sql`
            select lr.id, e.name as employee, lt.name as type, lr.from_date::text, lr.to_date::text, lr.days::text
            from leave_requests lr join employees e on e.id = lr.employee_id join leave_types lt on lt.id = lr.leave_type_id
            where lr.business_id = ${b} and lr.status = 'pending'
            order by lr.from_date limit 5`)
        ).rows;
        const [n] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from leave_requests where business_id = ${b} and status = 'pending'`)).rows;
        const [away] = (
          await tx.execute<{ n: number }>(sql`
            select count(distinct employee_id)::int as n from leave_requests
            where business_id = ${b} and status = 'approved' and ${today} between from_date and to_date`)
        ).rows;
        out.leave = {
          pending: n!.n,
          onLeaveToday: away!.n,
          requests: pending.map((x) => ({ id: x.id, employee: x.employee, type: x.type, from: x.from_date, to: x.to_date, days: dec(x.days).toString() })),
        };
      }

      if (may("payroll.view")) {
        const [run] = (
          await tx.execute<{ id: string; status: string; total_net: string }>(sql`
            select id, status::text as status, total_net::text from payroll_runs where business_id = ${b} and period_month = ${month} and status <> 'cancelled'`)
        ).rows;
        out.payroll = { month, run: run ? { id: run.id, status: run.status, totalNet: dec(run.total_net).toFixed(2) } : null };
      }

      if (may("customer.view_ledger")) {
        const [c] = (
          await tx.execute<{ outstanding: string; customers: number; overdue: string }>(sql`
            select coalesce(sum(c.balance), 0)::text as outstanding, count(*)::int as customers,
                   coalesce((select sum(i.balance_due) from invoices i where i.business_id = ${b} and i.status = 'posted' and i.balance_due > 0 and coalesce(i.due_date, i.invoice_date) < ${today}), 0)::text as overdue
            from customers c where c.business_id = ${b} and c.deleted_at is null and c.balance > 0`)
        ).rows;
        // Promises to pay by today, not paid since (the latest promise after the last payment).
        const promises = (
          await tx.execute<{ customer_id: string; name: string; city: string | null; mobile: string | null; promised_on: string; promised_amount: string | null; balance: string }>(sql`
            select c.id as customer_id, coalesce(c.business_name, c.name) as name, c.city, c.mobile, pr.promised_on::text, pr.promised_amount::text, c.balance::text
            from customers c
            join lateral (
              select n.promised_on, n.promised_amount from collection_notes n
              where n.customer_id = c.id and n.kind = 'promise'
                and n.created_at > coalesce((select max(p.created_at) from payments p where p.customer_id = c.id and p.status = 'posted' and p.direction = 'in'), '-infinity'::timestamptz)
              order by n.created_at desc limit 1
            ) pr on true
            where c.business_id = ${b} and c.deleted_at is null and c.balance > 0 and pr.promised_on <= ${today}
            order by pr.promised_on, c.balance desc`)
        ).rows;
        out.collections = {
          outstanding: dec(c!.outstanding).toFixed(2),
          overdue: dec(c!.overdue).toFixed(2),
          customers: c!.customers,
          promisesDue: promises.length,
          promises: promises.slice(0, 5).map((x) => ({
            customerId: x.customer_id,
            name: x.name,
            city: x.city,
            mobile: x.mobile,
            date: x.promised_on,
            amount: x.promised_amount ? dec(x.promised_amount).toFixed(2) : null,
            balance: dec(x.balance).toFixed(2),
          })),
        };
      }

      if (may("expense.view")) {
        const [e] = (
          await tx.execute<{ total: string; count: number }>(sql`
            select coalesce(sum(total_amount), 0)::text as total, count(*)::int as count
            from expenses where business_id = ${b} and status = 'posted' and expense_date between ${month} and ${today}`)
        ).rows;
        out.expenses = { month, total: dec(e!.total).toFixed(2), count: e!.count };
      }

      return out;
    });
  });
};
