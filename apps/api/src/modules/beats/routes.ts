import { BeatQuery, BeatReportQuery, RouteOrderBody, VisitBody } from "@digitalbahi/contracts";
import { daysBetween } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { assertRange } from "../../lib/period.js";
import { assertOwned } from "../../services/owned.js";
import { getSettings } from "../../services/settings.js";
import { storeAssociations } from "../../services/purchase-history.js";
import { customerInsightJson, reorderDueCustomers } from "../invoices/suggestions.js";
import type { ApiModule } from "../types.js";

/**
 * Beats (Phase 5.4): a salesperson's day along their routes. Routes have
 * weekdays and a salesperson; customers have a place on their route. Today's
 * beat is the person's routes for the day (everyone's for someone without a
 * route of their own), the customers in route order with what they owe, what
 * is due to be bought again and whether they were called on today; with
 * `insights=1` also each customer's buying, so the phone suggests products
 * without a connection. A call counts when it left a bill, order, payment or
 * visit note that day, or was recorded as a visit (checked in, or no order
 * and why). The beat report sets each salesperson's calls against their plan.
 */

const IdParams = z.object({ id: z.uuid() });

/** ISO weekday (1 = Monday … 7 = Sunday) of a date. */
const isoWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** The employee a person is (linked, or the same mobile number), if any. */
async function employeeOf(tx: Tx, businessId: string, userId: string): Promise<string | null> {
  const [row] = (
    await tx.execute<{ id: string }>(sql`
      select e.id from employees e
      where e.business_id = ${businessId} and e.status <> 'terminated'
        and (e.user_id = ${userId} or right(regexp_replace(e.mobile, '\\D', '', 'g'), 10) = (select right(regexp_replace(coalesce(u.mobile, ''), '\\D', '', 'g'), 10) from users u where u.id = ${userId}))
      order by (e.user_id = ${userId}) desc nulls last limit 1`)
  ).rows;
  return row?.id ?? null;
}

type Outcome = "bill" | "order" | "payment" | "note" | "no_order" | "visited";
const OUTCOME_RANK: Record<Outcome, number> = { bill: 0, order: 1, payment: 2, note: 3, no_order: 4, visited: 5 };

/** What happened at each customer on a day: the documents made for them and the visits recorded (the strongest outcome first). */
async function callsOn(tx: Tx, businessId: string, day: string, customerIds: readonly string[] | null, userId?: string) {
  const only = customerIds ? (customerIds.length ? sql`and customer_id in (${sql.join(customerIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`and false`) : sql``;
  const by = (column: string) => (userId ? sql`and ${sql.raw(column)} = ${userId}` : sql``);
  const rows = (
    await tx.execute<{ customer_id: string; kind: Outcome; amount: string | null; reason: string | null; at: string | null; user_id: string | null }>(sql`
      select customer_id, 'bill' as kind, grand_total::text as amount, null as reason, created_at::text as at, created_by as user_id from invoices
        where business_id = ${businessId} and status = 'posted' and invoice_date = ${day} ${only} ${by("created_by")}
      union all
      select customer_id, 'order', grand_total::text, null, created_at::text, created_by from sales_orders
        where business_id = ${businessId} and status <> 'cancelled' and order_date = ${day} ${only} ${by("created_by")}
      union all
      select customer_id, 'payment', amount::text, null, created_at::text, created_by from payments
        where business_id = ${businessId} and status = 'posted' and direction = 'in' and payment_date = ${day} and customer_id is not null ${only} ${by("created_by")}
      union all
      select customer_id, 'note', promised_amount::text, kind, created_at::text, created_by from collection_notes
        where business_id = ${businessId} and visited_on = ${day} ${only} ${by("created_by")}
      union all
      select customer_id, outcome, null, reason, visited_at::text, user_id from customer_visits
        where business_id = ${businessId} and visit_date = ${day} ${only} ${by("user_id")}`)
  ).rows;
  const out = new Map<string, { outcome: Outcome; billed: number; ordered: number; collected: number; reason: string | null; at: string | null; users: Set<string> }>();
  for (const r of rows) {
    const c = out.get(r.customer_id) ?? { outcome: r.kind, billed: 0, ordered: 0, collected: 0, reason: null, at: null, users: new Set<string>() };
    if (OUTCOME_RANK[r.kind] < OUTCOME_RANK[c.outcome]) c.outcome = r.kind;
    if (r.kind === "bill") c.billed += Number(r.amount ?? 0);
    if (r.kind === "order") c.ordered += Number(r.amount ?? 0);
    if (r.kind === "payment") c.collected += Number(r.amount ?? 0);
    if (r.kind === "no_order") c.reason = r.reason;
    if (r.at && (!c.at || r.at < c.at)) c.at = r.at;
    if (r.user_id) c.users.add(r.user_id);
    out.set(r.customer_id, c);
  }
  return out;
}

const money = (n: number) => n.toFixed(2);

export const beatsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Today's beat for the person (see the module comment). */
  r.get("/beats/today", { preHandler: guard(deps, "customer.view"), schema: { tags: ["beats"], querystring: BeatQuery } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const q = request.query;
    const day = q.date ?? deps.clock.today(ctx.timeZone);
    const weekday = isoWeekday(day);
    return withTenant(deps.db, ctx, async (tx) => {
      const me = await employeeOf(tx, ctx.businessId, ctx.userId);
      const all = await tx.execute<{ id: string; name: string; visit_days: number[] | null; salesperson_id: string | null; salesperson: string | null }>(sql`
        select r.id, r.name, r.visit_days, r.salesperson_id, e.name as salesperson from sales_routes r left join employees e on e.id = r.salesperson_id
        where r.business_id = ${ctx.businessId} and r.is_active order by r.name`);
      const todays = all.rows.filter((x) => (x.visit_days ?? []).includes(weekday));
      const hasOwn = me !== null && all.rows.some((x) => x.salesperson_id === me);
      // One route asked for; else the person's routes today; someone with no route of their own sees every route for today.
      const routes = q.routeId ? all.rows.filter((x) => x.id === q.routeId) : hasOwn ? todays.filter((x) => x.salesperson_id === me) : todays;
      if (q.routeId && !routes.length) throw notFound("route");
      const routeIds = routes.map((x) => x.id);
      const customers = routeIds.length
        ? (
            await tx.execute<{ id: string; code: string; name: string; mobile: string | null; city: string | null; route_id: string; route_sequence: number | null; balance: string; overdue: string; last_invoice_on: string | null; typical_visit_interval_days: number | null }>(sql`
              select c.id, c.code, coalesce(c.business_name, c.name) as name, c.mobile, c.city, c.route_id, c.route_sequence, c.balance::text,
                     coalesce((select sum(i.balance_due) from invoices i where i.customer_id = c.id and i.status = 'posted' and i.balance_due > 0 and i.due_date < ${day}), 0)::text as overdue,
                     cs.last_invoice_on::text, cs.typical_visit_interval_days
              from customers c left join customer_stats cs on cs.customer_id = c.id
              where c.business_id = ${ctx.businessId} and c.deleted_at is null and c.is_active
                and c.route_id in (${sql.join(routeIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
          ).rows
        : [];
      const routeOrder = new Map(routeIds.map((id, i) => [id, i]));
      customers.sort((a, b) => routeOrder.get(a.route_id)! - routeOrder.get(b.route_id)! || (a.route_sequence ?? 1e9) - (b.route_sequence ?? 1e9) || a.name.localeCompare(b.name));
      const ids = customers.map((c) => c.id);
      const calls = await callsOn(tx, ctx.businessId, day, ids);
      const due = new Map((await reorderDueCustomers(tx, ctx.businessId, day, { customerIds: ids })).map((d) => [d.customerId, d]));
      const lastCall = new Map(
        ids.length
          ? (
              await tx.execute<{ customer_id: string; day: string }>(sql`
                select customer_id, max(day)::text as day from (
                  select customer_id, invoice_date as day from invoices where business_id = ${ctx.businessId} and status = 'posted' and invoice_date < ${day}
                  union all select customer_id, order_date from sales_orders where business_id = ${ctx.businessId} and status <> 'cancelled' and order_date < ${day}
                  union all select customer_id, visit_date from customer_visits where business_id = ${ctx.businessId} and visit_date < ${day}
                  union all select customer_id, visited_on from collection_notes where business_id = ${ctx.businessId} and visited_on < ${day}
                ) x where customer_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) group by customer_id`)
            ).rows.map((x) => [x.customer_id, x.day])
          : [],
      );
      let insights: Record<string, unknown> | undefined;
      if (q.insights === "1" && ids.length) {
        const windowDays = (await getSettings(tx, ctx.businessId, ["suggestions.window_days"] as const))["suggestions.window_days"];
        insights = {};
        for (const c of customers) insights[c.id] = await customerInsightJson(tx, ctx.businessId, c, day, windowDays);
      }
      const rows = customers.map((c) => {
        const call = calls.get(c.id);
        const d = due.get(c.id);
        const last = lastCall.get(c.id) ?? null;
        return {
          id: c.id,
          code: c.code,
          name: c.name,
          mobile: c.mobile,
          city: c.city,
          routeId: c.route_id,
          sequence: c.route_sequence,
          balance: c.balance,
          overdue: Number(c.overdue).toFixed(2),
          lastCallOn: last,
          daysSinceCall: last ? daysBetween(last, day) : null,
          typicalVisitIntervalDays: c.typical_visit_interval_days,
          reorder: d ? { overdue: d.overdue, due: d.due, lapsed: d.lapsed, products: d.products.slice(0, 6) } : { overdue: 0, due: 0, lapsed: 0, products: [] },
          today: call ? { outcome: call.outcome, billed: money(call.billed), ordered: money(call.ordered), collected: money(call.collected), reason: call.reason, at: call.at } : null,
        };
      });
      const called = rows.filter((x) => x.today);
      return {
        date: day,
        weekday,
        routes: routes.map((x) => ({ id: x.id, name: x.name, visitDays: x.visit_days ?? [], salespersonId: x.salesperson_id, salesperson: x.salesperson, customers: rows.filter((c) => c.routeId === x.id).length })),
        customers: rows,
        summary: {
          planned: rows.length,
          called: called.length,
          productive: called.filter((x) => x.today!.outcome === "bill" || x.today!.outcome === "order").length,
          billed: money(called.reduce((a, x) => a + Number(x.today!.billed), 0)),
          ordered: money(called.reduce((a, x) => a + Number(x.today!.ordered), 0)),
          collected: money(called.reduce((a, x) => a + Number(x.today!.collected), 0)),
        },
        ...(insights ? { insights, storeAssociations: await storeAssociations(tx, ctx.businessId, day) } : {}),
      };
    });
  });

  /**
   * A call that left no document: checked in, or no order and why. The
   * Idempotency-Key is the visit's id (made on the phone), so one recorded
   * offline and sent twice is kept once.
   */
  r.post("/visits", { preHandler: guard(deps, "customer.view"), schema: { tags: ["beats"], body: VisitBody } }, async (request, reply) => {
    const ctx: RequestCtx = request.ctx;
    const key = request.headers["idempotency-key"];
    const id = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (!id) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const b = request.body;
    const result = await withTenant(deps.db, ctx, async (tx) => {
      await assertOwned(tx, schema.customers, ctx.businessId, b.customerId, "customerId");
      await assertOwned(tx, schema.salesRoutes, ctx.businessId, b.routeId ?? null, "routeId");
      const v = schema.customerVisits;
      const [made] = await tx
        .insert(v)
        .values({
          id,
          businessId: ctx.businessId,
          customerId: b.customerId,
          routeId: b.routeId ?? null,
          userId: ctx.userId,
          visitDate: b.visitDate ?? deps.clock.today(ctx.timeZone),
          outcome: b.outcome,
          reason: b.outcome === "no_order" ? b.reason! : null,
          note: b.note ?? null,
          latitude: b.latitude === undefined ? null : String(b.latitude),
          longitude: b.longitude === undefined ? null : String(b.longitude),
          visitedAt: b.visitedAt ?? deps.clock.now().toISOString(),
        })
        .onConflictDoNothing()
        .returning();
      if (made) return { replay: false, row: made };
      const [existing] = await tx.select().from(v).where(and(eq(v.id, id), eq(v.businessId, ctx.businessId)));
      if (!existing) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
      return { replay: true, row: existing };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.row);
  });

  /** The order customers are called on along a route (those listed in order; the rest of the route after them by name, or taken off it). */
  r.put("/routes/:id/order", { preHandler: guard(deps, "customer.update"), schema: { tags: ["beats"], params: IdParams, body: RouteOrderBody } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    return withTenant(deps.db, ctx, async (tx) => {
      const [route] = await tx.select().from(schema.salesRoutes).where(and(eq(schema.salesRoutes.id, request.params.id), eq(schema.salesRoutes.businessId, ctx.businessId)));
      if (!route) throw notFound("route");
      const ids = [...new Set(request.body.customerIds)];
      const list = ids.length ? sql`array[${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)}]` : sql`array[]::uuid[]`;
      const found = ids.length
        ? (await tx.execute<{ id: string }>(sql`select id from customers where business_id = ${ctx.businessId} and deleted_at is null and id = any(${list})`)).rows.length
        : 0;
      if (found !== ids.length) throw badRequest("REFERENCE_NOT_FOUND", {}, "customerIds");
      let removed = 0;
      if (request.body.others === "remove") {
        removed = (
          await tx.execute(sql`
            update customers set route_id = null, route_sequence = null, updated_at = now(), version = version + 1, updated_by = ${ctx.userId}
            where business_id = ${ctx.businessId} and route_id = ${route.id} and not (id = any(${list}))`)
        ).rowCount ?? 0;
      }
      await tx.execute(sql`update customers set route_sequence = null, updated_at = now() where business_id = ${ctx.businessId} and route_id = ${route.id} and route_sequence is not null`);
      if (ids.length) {
        await tx.execute(sql`
          update customers c set route_id = ${route.id}, route_sequence = o.n, updated_at = now(), version = c.version + 1, updated_by = ${ctx.userId}
          from unnest(${list}) with ordinality as o(id, n)
          where c.id = o.id and c.business_id = ${ctx.businessId}`);
      }
      await audit(tx, ctx, { action: "route.reordered", entityType: "route", entityId: route.id, entityLabel: route.name, changes: { customers: ids.length, removed } });
      return { routeId: route.id, customers: ids.length, removed };
    });
  });

  /**
   * Each salesperson's day against their plan: customers on their routes that
   * weekday, those called on, the productive calls (a bill or an order), what
   * they billed, booked and collected, the reasons for no order, and calls
   * off the plan. Calls on the plan count whoever entered them; calls off it
   * only the salesperson's own (so one with no sign-in still has a report).
   */
  r.get("/reports/beats", { preHandler: guard(deps, "report.view_sales"), schema: { tags: ["beats"], querystring: BeatReportQuery } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    if (daysBetween(q.from, q.to) > 62) throw badRequest("RANGE_TOO_LONG", { days: 62 }, "to");
    return withTenant(deps.db, ctx, async (tx) => {
      const people = (
        await tx.execute<{ employee_id: string; name: string; user_id: string | null }>(sql`
          select e.id as employee_id, e.name,
                 coalesce(e.user_id, (select bm.user_id from business_members bm join users u on u.id = bm.user_id
                   where bm.business_id = e.business_id and bm.is_active and right(regexp_replace(coalesce(u.mobile, ''), '\\D', '', 'g'), 10) = right(regexp_replace(e.mobile, '\\D', '', 'g'), 10) limit 1)) as user_id
          from employees e where e.business_id = ${ctx.businessId} and exists (select 1 from sales_routes r where r.salesperson_id = e.id and r.is_active)
          order by e.name`)
      ).rows;
      const routes = (
        await tx.execute<{ id: string; salesperson_id: string; visit_days: number[] | null }>(sql`
          select id, salesperson_id, visit_days from sales_routes where business_id = ${ctx.businessId} and is_active and salesperson_id is not null`)
      ).rows;
      const onRoute = new Map<string, string[]>();
      for (const c of (await tx.execute<{ id: string; route_id: string }>(sql`select id, route_id from customers where business_id = ${ctx.businessId} and deleted_at is null and is_active and route_id is not null`)).rows) {
        onRoute.set(c.route_id, [...(onRoute.get(c.route_id) ?? []), c.id]);
      }
      const rows: Array<Record<string, unknown>> = [];
      for (let day = q.from; day <= q.to; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        const weekday = isoWeekday(day);
        const calls = await callsOn(tx, ctx.businessId, day, null);
        for (const p of people) {
          const planned = new Set(routes.filter((x) => x.salesperson_id === p.employee_id && (x.visit_days ?? []).includes(weekday)).flatMap((x) => onRoute.get(x.id) ?? []));
          // A call on the plan counts whoever entered it (an order phoned in and entered at the office);
          // one off the plan only when the person made it.
          const onPlan = [...planned].flatMap((id) => (calls.has(id) ? [calls.get(id)!] : []));
          const offPlan = [...calls.entries()].filter(([id, c]) => !planned.has(id) && p.user_id !== null && c.users.has(p.user_id)).map(([, c]) => c);
          if (!planned.size && !offPlan.length) continue;
          const theirs = [...onPlan, ...offPlan];
          const reasons: Record<string, number> = {};
          for (const c of theirs) if (c.outcome === "no_order" && c.reason) reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
          rows.push({
            date: day,
            employeeId: p.employee_id,
            salesperson: p.name,
            planned: planned.size,
            called: onPlan.length,
            missed: planned.size - onPlan.length,
            productive: onPlan.filter((c) => c.outcome === "bill" || c.outcome === "order").length,
            offPlan: offPlan.length,
            billed: money(theirs.reduce((a, c) => a + c.billed, 0)),
            ordered: money(theirs.reduce((a, c) => a + c.ordered, 0)),
            collected: money(theirs.reduce((a, c) => a + c.collected, 0)),
            noOrderReasons: reasons,
          });
        }
      }
      return { from: q.from, to: q.to, rows };
    });
  });
};
