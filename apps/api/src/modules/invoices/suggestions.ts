import {
  addDays,
  daysBetween,
  paymentBehaviour,
  buildReorderList,
  reorderStatus,
  suggestedQty,
  suggestProducts,
  type CustomerProductStats,
  type SuggestionProduct,
} from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { assertOwned } from "../../services/owned.js";
import { fromStatsRow, purchaseHistory, storeAssociations, type StatsRow } from "../../services/purchase-history.js";
import { getSettings } from "../../services/settings.js";
import type { ApiModule } from "../types.js";

const Params = z.object({ id: z.uuid() });
const Query = z.object({
  /** Product ids already on the bill (comma separated): never suggested again, and drive "bought together". */
  cart: z
    .string()
    .max(4000)
    .optional()
    .transform((v) => (v ? v.split(",").filter((x) => z.uuid().safeParse(x).success) : [])),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const DueQuery = z.object({
  routeId: z.uuid().optional(),
  salespersonId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const Group = z.enum(["reorder", "frequent", "together", "last_order"]);
const FeedbackItem = z.strictObject({
  productId: z.uuid(),
  group: Group,
  rank: z.number().int().min(1).max(200),
  reasons: z.array(z.string().trim().min(1).max(30)).max(8).default([]),
});
const FeedbackBody = z.strictObject({
  /** Made by the app for the bill being made: sending again replaces what was sent. */
  id: z.uuid(),
  customerId: z.uuid(),
  invoiceId: z.uuid().nullish(),
  shown: z.array(FeedbackItem).max(50),
  added: z.array(FeedbackItem).max(50),
});
const SummaryQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

type ProductRow = SuggestionProduct & { unitId: string; sellingPrice: string };

/** What the engine needs about each product: active, stock, minimum and order multiple (case size). */
async function suggestionProducts(tx: Tx, businessId: string, ids: Iterable<string>): Promise<Map<string, ProductRow>> {
  const list = [...new Set(ids)];
  const products = new Map<string, ProductRow>();
  if (!list.length) return products;
  const rows = await tx.execute<{
    id: string;
    name: string;
    is_active: boolean;
    deleted: boolean;
    stock: string;
    min_stock: string | null;
    order_multiple: string | null;
    base_unit_id: string;
    selling_price: string;
  }>(sql`
    select p.id, p.name, p.is_active, p.deleted_at is not null as deleted, coalesce(st.qty, 0)::text as stock,
           p.min_stock::text, pu.conversion_factor::text as order_multiple, p.base_unit_id, p.selling_price::text
    from products p
    left join lateral (select sum(qty) as qty from stock_balances sb where sb.product_id = p.id) st on true
    left join lateral (select conversion_factor from product_units u where u.product_id = p.id and u.is_default_sale limit 1) pu on true
    where p.business_id = ${businessId} and p.id in ${sql`(${sql.join(list.map((id) => sql`${id}::uuid`), sql`, `)})`}`);
  for (const p of rows.rows) {
    products.set(p.id, {
      id: p.id,
      name: p.name,
      active: p.is_active && !p.deleted,
      stockQty: p.stock,
      minStock: p.min_stock,
      orderMultiple: p.order_multiple,
      unitId: p.base_unit_id,
      sellingPrice: p.selling_price,
    });
  }
  return products;
}

async function findCustomer(tx: Tx, ctx: RequestCtx, id: string) {
  const [customer] = await tx
    .select({ id: schema.customers.id, name: schema.customers.name, balance: schema.customers.balance })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
  if (!customer) throw notFound("customer");
  return customer;
}

const statsJson = (s: CustomerProductStats) => ({
  productId: s.productId,
  orderCount: s.orderCount,
  orderShare: s.orderShare,
  totalQty: s.totalQty.toString(),
  avgQty: s.avgQty.toString(),
  lastQty: s.lastQty.toString(),
  lastRate: s.lastRate?.toString() ?? null,
  firstPurchasedOn: s.firstPurchasedOn,
  lastPurchasedOn: s.lastPurchasedOn,
  daysSinceLast: s.daysSinceLast,
  typicalIntervalDays: s.typicalIntervalDays,
  recentQtys: s.recentQtys.map((q) => q.toString()),
});

const reorderJson = (stats: Map<string, CustomerProductStats>, products: Map<string, ProductRow>) =>
  buildReorderList({ stats, products }).map((row) => ({
    productId: row.productId,
    productName: products.get(row.productId)?.name ?? null,
    lastQty: row.lastQty.toString(),
    lastPurchasedOn: row.lastPurchasedOn,
    daysSinceLast: row.daysSinceLast,
    typicalIntervalDays: row.typicalIntervalDays,
    status: row.status,
    dueInDays: row.dueInDays,
    suggestedQty: row.suggestedQty.toString(),
  }));

const rate = (added: number, shown: number) => (shown ? Math.round((added / shown) * 1000) / 1000 : null);
const RANK_BUCKETS = ["1-3", "4-6", "7-12", "13+"] as const;

/**
 * A customer's buying and paying as the billing screen reads it (the
 * store-wide "bought together" rules apart): per-product statistics, payment
 * behaviour, open bills, their own rules. Also cached on phones for the
 * day's beat, so suggestions work there without a connection.
 */
export async function customerInsightJson(tx: Tx, businessId: string, customer: { id: string; balance: string }, today: string, windowDays: number) {
  const since = addDays(today, -windowDays);
  const history = await purchaseHistory(tx, businessId, customer.id, today, windowDays);
  const invoices = (
    await tx.execute<{ id: string; number: string; date: string; due_date: string; total: string; paid: string; balance: string; settled_on: string | null }>(sql`
      select i.id, i.invoice_number as number, i.invoice_date::text as date, coalesce(i.due_date, i.invoice_date)::text as due_date,
             i.grand_total::text as total, i.amount_paid::text as paid, i.balance_due::text as balance,
             case when i.balance_due = 0 then (
               select max(p.payment_date)::text from payment_allocations a join payments p on p.id = a.payment_id
               where a.invoice_id = i.id and a.reversed_at is null) end as settled_on
      from invoices i
      where i.business_id = ${businessId} and i.customer_id = ${customer.id} and i.status = 'posted'
        and (i.invoice_date >= ${since} or i.balance_due > 0)
      order by i.invoice_date`)
  ).rows;
  const inWindow = invoices.filter((i) => i.date >= since);
  const open = invoices.filter((i) => Number(i.balance) > 0);
  const overdue = open.filter((i) => i.due_date < today);
  const totalSales = inWindow.reduce((acc, i) => acc + Number(i.total), 0);
  return {
    asOf: today,
    windowDays,
    source: history.source,
    summary: history.summary,
    stats: [...history.stats.values()].map(statsJson),
    totalSales: totalSales.toFixed(2),
    invoiceCount: inWindow.length,
    avgOrderValue: inWindow.length ? (totalSales / inWindow.length).toFixed(2) : "0.00",
    outstanding: customer.balance,
    overdue: overdue.reduce((acc, i) => acc + Number(i.balance), 0).toFixed(2),
    overdueCount: overdue.length,
    oldestOverdueDays: overdue.length ? Math.max(...overdue.map((i) => daysBetween(i.due_date, today))) : 0,
    lastPurchase: history.summary.lastInvoiceOn,
    behaviour: paymentBehaviour(
      inWindow.map((i) => ({ date: i.date, dueDate: i.due_date, settledOn: i.settled_on })),
      today,
    ),
    openInvoices: open.map((i) => ({ id: i.id, number: i.number, date: i.date, dueDate: i.due_date, total: i.total, paid: i.paid, balance: i.balance })),
    customerAssociations: history.customerAssociations,
  };
}

/**
 * Customers with products due to be bought again (by each product's usual
 * interval), most urgent first, each with up to 10 products: overdue, due,
 * lapsed. On a route, of a salesperson, or of the customers given.
 */
export async function reorderDueCustomers(tx: Tx, businessId: string, today: string, filter: { routeId?: string; salespersonId?: string; customerIds?: readonly string[] }) {
  const rows = await tx.execute<{
    customer_id: string;
    customer_name: string;
    city: string | null;
    route_id: string | null;
    product_id: string;
    product_name: string;
    order_multiple: string | null;
    order_count: number;
    order_share: number;
    total_qty: string;
    avg_qty: string;
    last_qty: string;
    last_rate: string | null;
    recent_qtys: string[];
    first_purchased_on: string;
    last_purchased_on: string;
    typical_interval_days: number;
  }>(sql`
    select c.id as customer_id, c.name as customer_name, c.city, c.route_id,
           s.product_id, p.name as product_name, pu.conversion_factor::text as order_multiple,
           s.order_count, s.order_share, s.total_qty::text, s.avg_qty::text, s.last_qty::text, s.last_rate::text,
           s.recent_qtys::text[] as recent_qtys, s.first_purchased_on::text, s.last_purchased_on::text, s.typical_interval_days
    from customer_product_stats s
    join customers c on c.id = s.customer_id and c.deleted_at is null and c.is_active
    join products p on p.id = s.product_id and p.deleted_at is null and p.is_active
    left join lateral (select conversion_factor from product_units u where u.product_id = p.id and u.is_default_sale limit 1) pu on true
    where s.business_id = ${businessId} and s.typical_interval_days > 0
      and (${today}::date - s.last_purchased_on) >= 0.75 * s.typical_interval_days
      and (${today}::date - s.last_purchased_on) <= 6 * s.typical_interval_days
      ${filter.routeId ? sql`and c.route_id = ${filter.routeId}` : sql``}
      ${filter.salespersonId ? sql`and c.sales_rep_id = ${filter.salespersonId}` : sql``}
      ${filter.customerIds ? (filter.customerIds.length ? sql`and c.id in (${sql.join(filter.customerIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`and false`) : sql``}
    order by c.name, c.id`);
  const URGENCY = { overdue: 0, due: 1, lapsed: 2 } as const;
  type Due = { productId: string; productName: string; status: keyof typeof URGENCY; ratio: number; daysSinceLast: number; typicalIntervalDays: number; lastQty: string; suggestedQty: string };
  const byCustomer = new Map<string, { customerId: string; name: string; city: string | null; routeId: string | null; products: Due[] }>();
  for (const row of rows.rows) {
    const stats = fromStatsRow(
      {
        productId: row.product_id,
        orderCount: row.order_count,
        orderShare: row.order_share,
        totalQty: row.total_qty,
        avgQty: row.avg_qty,
        lastQty: row.last_qty,
        lastRate: row.last_rate,
        recentQtys: row.recent_qtys,
        firstPurchasedOn: row.first_purchased_on,
        lastPurchasedOn: row.last_purchased_on,
        typicalIntervalDays: row.typical_interval_days,
      } satisfies StatsRow,
      today,
    );
    const { status, ratio } = reorderStatus(stats.daysSinceLast, row.typical_interval_days);
    if (status !== "due" && status !== "overdue" && status !== "lapsed") continue;
    const entry = byCustomer.get(row.customer_id) ?? { customerId: row.customer_id, name: row.customer_name, city: row.city, routeId: row.route_id, products: [] };
    entry.products.push({
      productId: row.product_id,
      productName: row.product_name,
      status,
      ratio: Math.round(ratio * 100) / 100,
      daysSinceLast: stats.daysSinceLast,
      typicalIntervalDays: row.typical_interval_days,
      lastQty: stats.lastQty.toString(),
      suggestedQty: suggestedQty(stats, row.order_multiple).toString(),
    });
    byCustomer.set(row.customer_id, entry);
  }
  const customers = [...byCustomer.values()].map((c) => {
    const count = (s: Due["status"]) => c.products.filter((p) => p.status === s).length;
    c.products.sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || b.ratio - a.ratio || a.productName.localeCompare(b.productName));
    return { ...c, overdue: count("overdue"), due: count("due"), lapsed: count("lapsed"), products: c.products.slice(0, 10) };
  });
  customers.sort((a, b) => b.overdue - a.overdue || b.due - a.due || b.lapsed - a.lapsed || a.name.localeCompare(b.name));
  return customers;
}

export const suggestionsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Everything the billing screen and the customer profile show about a
   * customer's buying: per-product purchase statistics, payment behaviour,
   * open bills and association rules. Clients feed it to the same suggestion
   * engine (@digitalbahi/core) the server uses, so offline and online agree.
   * The purchase history comes from the stored figures (purchase-history.ts).
   */
  r.get(
    "/customers/:id/insight",
    { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"], params: Params } },
    async (request) => {
      const ctx: RequestCtx = request.ctx;
      const today = deps.clock.today(ctx.timeZone);
      return withTenant(deps.db, ctx, async (tx) => {
        const customer = await findCustomer(tx, ctx, request.params.id);
        const windowDays = (await getSettings(tx, ctx.businessId, ["suggestions.window_days"] as const))["suggestions.window_days"];
        return { ...(await customerInsightJson(tx, ctx.businessId, customer, today, windowDays)), storeAssociations: await storeAssociations(tx, ctx.businessId, today) };
      });
    },
  );

  /**
   * What this customer is likely to need now, with the reasons (reorder due,
   * frequently bought, bought together, last order). Suggestions are only
   * offered; the client never adds them without the user's action.
   */
  r.get(
    "/customers/:id/suggestions",
    { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], params: Params, querystring: Query } },
    async (request) => {
      const ctx: RequestCtx = request.ctx;
      const today = deps.clock.today(ctx.timeZone);
      return withTenant(deps.db, ctx, async (tx) => {
        const { id, name } = await findCustomer(tx, ctx, request.params.id);
        const settings = await getSettings(tx, ctx.businessId, ["suggestions.weights", "suggestions.window_days"] as const);
        const { summary, stats, customerAssociations, source } = await purchaseHistory(tx, ctx.businessId, id, today, settings["suggestions.window_days"]);
        const associations = await storeAssociations(tx, ctx.businessId, today);

        const cart = request.query.cart;
        const ids = new Set<string>([...stats.keys(), ...cart]);
        for (const a of [...associations, ...customerAssociations]) {
          if (cart.includes(a.productId) || stats.has(a.productId)) ids.add(a.relatedProductId);
        }
        const products = await suggestionProducts(tx, ctx.businessId, ids);
        const suggestions = suggestProducts(
          { asOf: today, summary, stats, associations, customerAssociations, cartProductIds: cart, products },
          { weights: settings["suggestions.weights"], limit: request.query.limit },
        );
        return {
          customer: { id, name },
          source,
          summary,
          suggestions: suggestions.map((s) => ({
            productId: s.productId,
            productName: s.productName,
            group: s.group,
            score: s.score,
            suggestedQty: s.suggestedQty?.toString() ?? null,
            lastRate: stats.get(s.productId)?.lastRate?.toFixed(4) ?? null,
            reasons: s.reasons,
          })),
          reorder: reorderJson(stats, products),
        };
      });
    },
  );

  /** The customer's reorder table: everything they buy repeatedly, most urgent first. */
  r.get(
    "/customers/:id/reorder",
    { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"], params: Params } },
    async (request) => {
      const ctx: RequestCtx = request.ctx;
      const today = deps.clock.today(ctx.timeZone);
      return withTenant(deps.db, ctx, async (tx) => {
        const { id } = await findCustomer(tx, ctx, request.params.id);
        const windowDays = (await getSettings(tx, ctx.businessId, ["suggestions.window_days"] as const))["suggestions.window_days"];
        const { stats, source } = await purchaseHistory(tx, ctx.businessId, id, today, windowDays);
        const products = await suggestionProducts(tx, ctx.businessId, stats.keys());
        return { asOf: today, source, rows: reorderJson(stats, products) };
      });
    },
  );

  /**
   * Customers who should be reordering now (due, overdue or lapsed habits),
   * most urgent first, optionally for one beat or salesperson: the list a
   * salesperson works through on their route. Read from the stored figures only.
   */
  r.get("/reorder/due", { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"], querystring: DueQuery } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const q = request.query;
    const today = deps.clock.today(ctx.timeZone);
    return withTenant(deps.db, ctx, async (tx) => {
      const customers = await reorderDueCustomers(tx, ctx.businessId, today, { ...(q.routeId ? { routeId: q.routeId } : {}), ...(q.salespersonId ? { salespersonId: q.salespersonId } : {}) });
      return { asOf: today, customers: customers.slice(0, q.limit) };
    });
  });

  /**
   * What the billing screen offered and what the user took, for one bill
   * being made. Sent when the bill is saved; sending the same id again
   * replaces it (a retry never counts twice).
   */
  r.post("/suggestions/feedback", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], body: FeedbackBody } }, async (request, reply) => {
    const ctx: RequestCtx = request.ctx;
    const b = request.body;
    await withTenant(deps.db, ctx, async (tx) => {
      await assertOwned(tx, schema.customers, ctx.businessId, b.customerId, "customerId");
      await assertOwned(tx, schema.invoices, ctx.businessId, b.invoiceId, "invoiceId");
      const now = deps.clock.now().toISOString();
      const f = schema.suggestionFeedback;
      await tx
        .insert(f)
        .values({ id: b.id, businessId: ctx.businessId, customerId: b.customerId, userId: ctx.userId, invoiceId: b.invoiceId ?? null, shown: b.shown, added: b.added, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: f.id,
          set: { shown: b.shown, added: b.added, invoiceId: sql`coalesce(excluded.invoice_id, ${f.invoiceId})`, updatedAt: now },
          // Only the person who sent it, for the same customer.
          setWhere: sql`${f.userId} = ${ctx.userId} and ${f.customerId} = ${b.customerId}`,
        });
    });
    return reply.code(204).send();
  });

  /**
   * Whether suggestions help: how many were offered and taken in a period, by
   * reason (tab) and by position, and the share of bill lines that came from
   * them. Days are the business's.
   */
  r.get("/suggestions/feedback/summary", { preHandler: guard(deps, "report.view_sales"), schema: { tags: ["reports"], querystring: SummaryQuery } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const today = deps.clock.today(ctx.timeZone);
    const to = request.query.to ?? today;
    const from = request.query.from ?? addDays(to, -29);
    return withTenant(deps.db, ctx, async (tx) => {
      const scope = sql`business_id = ${ctx.businessId} and (created_at at time zone ${ctx.timeZone})::date between ${from} and ${to}`;
      const counts = await tx.execute<{ kind: "shown" | "added"; grp: string; bucket: string; n: number }>(sql`
        with f as (select shown, added from suggestion_feedback where ${scope}),
        items as (
          select 'shown' as kind, x from f, jsonb_array_elements(f.shown) x
          union all
          select 'added' as kind, x from f, jsonb_array_elements(f.added) x
        )
        select kind, x->>'group' as grp,
               case when (x->>'rank')::int <= 3 then '1-3' when (x->>'rank')::int <= 6 then '4-6' when (x->>'rank')::int <= 12 then '7-12' else '13+' end as bucket,
               count(*)::int as n
        from items group by 1, 2, 3`);
      const [sessions] = (
        await tx.execute<{ sessions: number; saved: number; lines_from_suggestions: number }>(sql`
          select count(*)::int as sessions, count(f.invoice_id)::int as saved,
                 coalesce(sum(jsonb_array_length(f.added)) filter (where i.status = 'posted'), 0)::int as lines_from_suggestions
          from suggestion_feedback f left join invoices i on i.id = f.invoice_id
          where f.business_id = ${ctx.businessId} and (f.created_at at time zone ${ctx.timeZone})::date between ${from} and ${to}`)
      ).rows;
      const [lines] = (
        await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from invoice_items ii join invoices i on i.id = ii.invoice_id
          where i.business_id = ${ctx.businessId} and i.status = 'posted' and i.invoice_date between ${from} and ${to}`)
      ).rows;
      const total = (kind: "shown" | "added", where: (c: { grp: string; bucket: string }) => boolean = () => true) =>
        counts.rows.filter((c) => c.kind === kind && where(c)).reduce((acc, c) => acc + c.n, 0);
      const shown = total("shown");
      const added = total("added");
      return {
        from,
        to,
        sessions: sessions!.sessions,
        savedBills: sessions!.saved,
        shown,
        added,
        acceptance: rate(added, shown),
        byGroup: Group.options.map((g) => {
          const s = total("shown", (c) => c.grp === g);
          const a = total("added", (c) => c.grp === g);
          return { group: g, shown: s, added: a, acceptance: rate(a, s) };
        }),
        byRank: RANK_BUCKETS.map((ranks) => {
          const s = total("shown", (c) => c.bucket === ranks);
          const a = total("added", (c) => c.bucket === ranks);
          return { ranks, shown: s, added: a, acceptance: rate(a, s) };
        }),
        invoiceLines: lines!.n,
        linesFromSuggestions: sessions!.lines_from_suggestions,
        shareOfLines: lines!.n ? Math.round((sessions!.lines_from_suggestions / lines!.n) * 1000) / 1000 : null,
      };
    });
  });
};
