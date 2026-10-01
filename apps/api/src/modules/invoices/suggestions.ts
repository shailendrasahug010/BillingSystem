import {
  addDays,
  daysBetween,
  paymentBehaviour,
  buildReorderList,
  computeCustomerStats,
  mineAssociations,
  suggestProducts,
  type AssociationRule,
  type Basket,
  type PurchaseLine,
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

/** Store-wide association rules, mined from recent baskets and cached briefly per business. */
const ASSOC_TTL_MS = 15 * 60_000;
const assocCache = new Map<string, { at: number; rules: AssociationRule[] }>();

async function storeAssociations(tx: Tx, businessId: string, since: string): Promise<AssociationRule[]> {
  // A nightly job may have materialised them; otherwise mine the last few thousand invoices on demand.
  const stored = await tx.select().from(schema.productAssociations).where(eq(schema.productAssociations.businessId, businessId));
  if (stored.length) return stored;
  const hit = assocCache.get(businessId);
  if (hit && Date.now() - hit.at < ASSOC_TTL_MS) return hit.rules;
  const rows = await tx.execute<{ invoice_id: string; product_ids: string[] }>(sql`
    select i.id as invoice_id, array_agg(distinct ii.product_id) as product_ids
    from invoices i join invoice_items ii on ii.invoice_id = i.id
    where i.business_id = ${businessId} and i.status = 'posted' and i.invoice_date >= ${since}
    group by i.id
    order by i.invoice_date desc
    limit 3000`);
  const baskets: Basket[] = rows.rows.map((r) => ({ id: r.invoice_id, productIds: r.product_ids }));
  const rules = mineAssociations(baskets);
  assocCache.set(businessId, { at: Date.now(), rules });
  return rules;
}

export const suggestionsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Everything the billing screen and the customer profile show about a
   * customer's buying: per-product purchase statistics, payment behaviour,
   * open bills and association rules. Clients feed it to the same suggestion
   * engine (@digitalbahi/core) the server uses, so offline and online agree.
   */
  r.get(
    "/customers/:id/insight",
    { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"], params: Params } },
    async (request) => {
      const ctx: RequestCtx = request.ctx;
      const today = deps.clock.today(ctx.timeZone);
      return withTenant(deps.db, ctx, async (tx) => {
        const [customer] = await tx
          .select({ id: schema.customers.id, balance: schema.customers.balance })
          .from(schema.customers)
          .where(and(eq(schema.customers.id, request.params.id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
        if (!customer) throw notFound("customer");
        const windowDays = (await getSettings(tx, ctx.businessId, ["suggestions.window_days"] as const))["suggestions.window_days"];
        const since = addDays(today, -windowDays);
        const invoices = (
          await tx.execute<{ id: string; number: string; date: string; due_date: string; total: string; paid: string; balance: string; settled_on: string | null }>(sql`
            select i.id, i.invoice_number as number, i.invoice_date::text as date, coalesce(i.due_date, i.invoice_date)::text as due_date,
                   i.grand_total::text as total, i.amount_paid::text as paid, i.balance_due::text as balance,
                   case when i.balance_due = 0 then (
                     select max(p.payment_date)::text from payment_allocations a join payments p on p.id = a.payment_id
                     where a.invoice_id = i.id and a.reversed_at is null) end as settled_on
            from invoices i
            where i.business_id = ${ctx.businessId} and i.customer_id = ${customer.id} and i.status = 'posted'
              and (i.invoice_date >= ${since} or i.balance_due > 0)
            order by i.invoice_date`)
        ).rows;
        const lines = (
          await tx.execute<{ invoice_id: string; invoice_date: string; product_id: string; qty: string; rate: string }>(sql`
            select i.id as invoice_id, i.invoice_date::text as invoice_date, ii.product_id, ii.qty_base::text as qty,
                   (ii.taxable_value / nullif(ii.qty_base, 0))::numeric(15,4)::text as rate
            from invoices i join invoice_items ii on ii.invoice_id = i.id
            where i.business_id = ${ctx.businessId} and i.customer_id = ${customer.id} and i.status = 'posted'
              and i.invoice_date >= ${since} and i.invoice_date <= ${today}`)
        ).rows;
        const purchaseLines: PurchaseLine[] = lines.map((l) => ({ invoiceId: l.invoice_id, date: l.invoice_date, productId: l.product_id, qty: l.qty, ...(l.rate ? { rate: l.rate } : {}) }));
        const { summary, products } = computeCustomerStats(purchaseLines, { asOf: today, windowDays });
        const byInvoice = new Map<string, string[]>();
        for (const l of purchaseLines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l.productId]);
        const customerAssociations = mineAssociations([...byInvoice].map(([id, productIds]) => ({ id, productIds })), { minPairCount: 3, minConfidence: 0.6, minLift: 1.05 });
        const inWindow = invoices.filter((i) => i.date >= since);
        const open = invoices.filter((i) => Number(i.balance) > 0);
        const overdue = open.filter((i) => i.due_date < today);
        const totalSales = inWindow.reduce((acc, i) => acc + Number(i.total), 0);
        return {
          asOf: today,
          windowDays,
          summary,
          stats: [...products.values()].map((s) => ({
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
          })),
          totalSales: totalSales.toFixed(2),
          invoiceCount: inWindow.length,
          avgOrderValue: inWindow.length ? (totalSales / inWindow.length).toFixed(2) : "0.00",
          outstanding: customer.balance,
          overdue: overdue.reduce((acc, i) => acc + Number(i.balance), 0).toFixed(2),
          overdueCount: overdue.length,
          oldestOverdueDays: overdue.length ? Math.max(...overdue.map((i) => daysBetween(i.due_date, today))) : 0,
          lastPurchase: summary.lastInvoiceOn,
          behaviour: paymentBehaviour(
            inWindow.map((i) => ({ date: i.date, dueDate: i.due_date, settledOn: i.settled_on })),
            today,
          ),
          openInvoices: open.map((i) => ({ id: i.id, number: i.number, date: i.date, dueDate: i.due_date, total: i.total, paid: i.paid, balance: i.balance })),
          customerAssociations,
          storeAssociations: await storeAssociations(tx, ctx.businessId, addDays(today, -180)),
        };
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
        const [customer] = await tx
          .select({ id: schema.customers.id, name: schema.customers.name })
          .from(schema.customers)
          .where(and(eq(schema.customers.id, request.params.id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
        if (!customer) throw notFound("customer");
        const settings = await getSettings(tx, ctx.businessId, ["suggestions.weights", "suggestions.window_days"] as const);
        const windowDays = settings["suggestions.window_days"];
        const since = addDays(today, -windowDays);

        const history = await tx.execute<{ invoice_id: string; invoice_date: string; product_id: string; qty: string; rate: string }>(sql`
          select i.id as invoice_id, i.invoice_date::text as invoice_date, ii.product_id, ii.qty_base::text as qty,
                 (ii.taxable_value / nullif(ii.qty_base, 0))::numeric(15,4)::text as rate
          from invoices i join invoice_items ii on ii.invoice_id = i.id
          where i.business_id = ${ctx.businessId} and i.customer_id = ${customer.id} and i.status = 'posted'
            and i.invoice_date >= ${since} and i.invoice_date <= ${today}`);
        const lines: PurchaseLine[] = history.rows.map((h) => ({
          invoiceId: h.invoice_id,
          date: h.invoice_date,
          productId: h.product_id,
          qty: h.qty,
          ...(h.rate ? { rate: h.rate } : {}),
        }));
        const { summary, products: stats } = computeCustomerStats(lines, { asOf: today, windowDays });

        const associations = await storeAssociations(tx, ctx.businessId, since);
        const byInvoice = new Map<string, string[]>();
        for (const l of lines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l.productId]);
        const customerAssociations = mineAssociations(
          [...byInvoice].map(([id, productIds]) => ({ id, productIds })),
          { minPairCount: 3, minConfidence: 0.5, minLift: 1 },
        );

        const cart = request.query.cart;
        const ids = new Set<string>([...stats.keys(), ...cart]);
        for (const a of [...associations, ...customerAssociations]) {
          if (cart.includes(a.productId) || stats.has(a.productId)) ids.add(a.relatedProductId);
        }
        const products = new Map<string, SuggestionProduct & { unitId: string; sellingPrice: string }>();
        if (ids.size) {
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
            where p.business_id = ${ctx.businessId} and p.id in ${sql`(${sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `)})`}`);
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
        }

        const suggestions = suggestProducts(
          { asOf: today, summary, stats, associations, customerAssociations, cartProductIds: cart, products },
          { weights: settings["suggestions.weights"], limit: request.query.limit },
        );
        const reorder = buildReorderList({ stats, products });
        return {
          customer,
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
          reorder: reorder.map((row) => ({
            productId: row.productId,
            productName: products.get(row.productId)?.name ?? null,
            lastQty: row.lastQty.toString(),
            lastPurchasedOn: row.lastPurchasedOn,
            daysSinceLast: row.daysSinceLast,
            typicalIntervalDays: row.typicalIntervalDays,
            status: row.status,
            dueInDays: row.dueInDays,
            suggestedQty: row.suggestedQty.toString(),
          })),
        };
      });
    },
  );
};
