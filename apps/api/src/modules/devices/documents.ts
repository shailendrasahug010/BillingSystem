import { addDays } from "@digitalbahi/core";
import type { Tx } from "@digitalbahi/db";
import { sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { invoiceDetail } from "../invoices/routes.js";
import { purchaseDetail } from "../purchases/routes.js";
import type { ApiModule } from "../types.js";

const Query = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

/** At most this many of each, newest first: enough for returns, small enough for a phone. */
const LIMIT = { invoices: 200, purchases: 150 };

/**
 * Recent bills for the copy kept on a device (encrypted there), so a bill
 * can be opened, printed and returned against without a connection. Each is
 * exactly what GET /invoices/:id and GET /purchases/:id give (cost fields
 * only for those who may see them); only the kinds the role may view.
 */
export const offlineDocumentsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.get("/offline/documents", { preHandler: guard(deps), schema: { tags: ["devices"], querystring: Query } }, async (request, reply) => {
    const ctx = request.ctx;
    const since = addDays(deps.clock.today(ctx.timeZone), -request.query.days);
    const out = await tenant(ctx, async (tx) => {
      const result: { since: string; invoices?: unknown[]; purchases?: unknown[] } = { since };
      if (can(ctx, "invoice.view")) {
        const ids = (
          await tx.execute<{ id: string }>(sql`
            select id from invoices where business_id = ${ctx.businessId} and status = 'posted' and invoice_date >= ${since}
            order by invoice_date desc, created_at desc limit ${LIMIT.invoices}`)
        ).rows;
        result.invoices = [];
        for (const { id } of ids) result.invoices.push(await invoiceDetail(tx, ctx, id));
      }
      if (can(ctx, "purchase.view")) {
        const ids = (
          await tx.execute<{ id: string }>(sql`
            select id from purchases where business_id = ${ctx.businessId} and status = 'posted' and received_date >= ${since}
            order by received_date desc, created_at desc limit ${LIMIT.purchases}`)
        ).rows;
        result.purchases = [];
        for (const { id } of ids) result.purchases.push(await purchaseDetail(tx, ctx, id));
      }
      return result;
    });
    // Business data for one person's device: never kept by a shared cache.
    return reply.header("cache-control", "no-store").send(out);
  });
};
