import { createHash } from "node:crypto";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { catalogLists, catalogProducts } from "../catalog/products.js";
import { SYNC_KEEP_DAYS } from "../../services/sync-changes.js";
import { customerRows, supplierRows } from "../parties/routes.js";
import type { ApiModule } from "../types.js";

/**
 * The pull feed (Phase 5.3): what changed in the business since a device last
 * asked, so it keeps its copy current without loading everything again.
 *
 * Triggers record each product, customer and supplier changed, with the
 * transaction that changed it (sync_changes). Each pass remembers the
 * database snapshot it read at: the transactions still running then, and the
 * first one that had not started. The next pass returns changes from exactly
 * those transactions, so one that commits late is never skipped and a change
 * is not sent twice (a record can come again only when a pass spans several
 * pages, and the device simply replaces it). The device
 * gets each record as GET /catalog, /customers and /suppliers give it, or its
 * id under `removed` (deleted, or no longer active for customers and
 * suppliers); the small lists (tax categories, rate lists, units, brands,
 * categories, routes, godowns, expense categories) come whole when they
 * differ from the copy the device has. Customers whose bills fell overdue
 * since the device's last day come again with their new overdue figure.
 */


/**
 * More transactions than this running at a pass's snapshot: the next pass
 * starts from the oldest of them instead (a few changes then come twice).
 */
const MAX_RUNNING = 200;

/** A database snapshot's edge: transactions from `xmax` on had not started, those in `xip` were still running. */
interface Boundary {
  xmax: string;
  xip: string[];
}

interface Cursor {
  /** Changes from transactions past the previous pass's snapshot are new to the device. */
  b: Boundary;
  /** Within a pass of several pages: where the last page stopped. */
  a?: { xid: string; entity: string; id: string };
  /** Within a pass: the snapshot it began at (the next pass starts from there). */
  n?: Boundary;
  /** The day the device's overdue figures are for. */
  d: string;
  /** When the pass started, to know when changes the device needs were deleted. */
  t: string;
}

const Xid = z.string().regex(/^\d{1,20}$/);
const BoundaryShape = z.object({ xmax: Xid, xip: z.array(Xid).max(MAX_RUNNING) });
const CursorShape = z.object({
  b: BoundaryShape,
  a: z.object({ xid: Xid, entity: z.enum(["product", "customer", "supplier"]), id: z.uuid() }).optional(),
  n: BoundaryShape.optional(),
  d: z.iso.date(),
  t: z.iso.datetime({ offset: true }),
});

/** One read: the snapshot's edge and the changes past the previous one. */
type SnapshotRead = { xmin: string; xmax: string; xip: string[] | null; running: number; changes: Array<{ entity: "product" | "customer" | "supplier"; entity_id: string; xid: string }> | null };

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decode(raw: string): Cursor {
  try {
    return CursorShape.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))) as Cursor;
  } catch {
    throw badRequest("INVALID_CURSOR", {}, "cursor");
  }
}

const PullQuery = z.object({
  cursor: z.string().max(1000).optional(),
  /** The hash of the lists the device has (from the last answer that carried them). */
  lists: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/** The small lists a device keeps with the products and customers, those this person may see. */
async function lists(tx: Tx, ctx: RequestCtx) {
  const out: Record<string, unknown> = {};
  if (can(ctx, "product.view")) {
    Object.assign(out, await catalogLists(tx, ctx));
    out.warehouses = await tx
      .select()
      .from(schema.warehouses)
      .where(and(eq(schema.warehouses.businessId, ctx.businessId), isNull(schema.warehouses.deletedAt)))
      .orderBy(asc(schema.warehouses.name));
  }
  if (can(ctx, "customer.view")) {
    out.routes = await tx.select().from(schema.salesRoutes).where(eq(schema.salesRoutes.businessId, ctx.businessId)).orderBy(asc(schema.salesRoutes.name));
  }
  if (can(ctx, "expense.view")) {
    out.expenseCategories = await tx
      .select({ id: schema.expenseCategories.id, name: schema.expenseCategories.name, nameHi: schema.expenseCategories.nameHi, isSystem: schema.expenseCategories.isSystem, isActive: schema.expenseCategories.isActive })
      .from(schema.expenseCategories)
      .where(eq(schema.expenseCategories.businessId, ctx.businessId))
      .orderBy(schema.expenseCategories.name);
  }
  return out;
}

export const syncModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/sync/pull", { preHandler: guard(deps), schema: { tags: ["sync"], querystring: PullQuery } }, async (request, reply) => {
    const ctx: RequestCtx = request.ctx;
    const q = request.query;
    const now = deps.clock.now();
    const today = deps.clock.today(ctx.timeZone);
    const seeProducts = can(ctx, "product.view");
    const seeCustomers = can(ctx, "customer.view");
    const seeSuppliers = can(ctx, "supplier.view");
    const given = q.cursor ? decode(q.cursor) : null;
    reply.header("cache-control", "private, no-store");

    const body = await withTenant(deps.db, ctx, async (tx) => {
      const firstPage = !given?.a;
      const withLists = async () => {
        const l = await lists(tx, ctx);
        // Hashed in id order, so rows read back in another order do not count as a change.
        const canonical = Object.entries(l).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort((a: { id?: string }, b: { id?: string }) => String(a.id).localeCompare(String(b.id))) : v]);
        const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("base64url").slice(0, 43);
        return hash === q.lists ? { listsHash: hash } : { lists: l, listsHash: hash };
      };
      // The snapshot's edge and the changes past the previous one, read in one statement (one snapshot).
      const b = given?.b ?? { xmax: "0", xip: [] };
      const after = given?.a ? sql`and (c.xid, c.entity, c.entity_id) > (${given.a.xid}::xid8, ${given.a.entity}, ${given.a.id}::uuid)` : sql``;
      const xip = b.xip.length ? sql`or c.xid in (${sql.join(b.xip.map((x) => sql`${x}::xid8`), sql`, `)})` : sql``;
      const [read] = (
        await tx.execute<SnapshotRead>(sql`
          select pg_snapshot_xmin(s)::text as xmin, pg_snapshot_xmax(s)::text as xmax,
                 (select array_agg(x::text) from (select x from pg_snapshot_xip(s) x limit ${MAX_RUNNING}) r) as xip,
                 (select count(*)::int from pg_snapshot_xip(s)) as running,
                 ${
                   given
                     ? sql`(select json_agg(r) from (
                         select c.entity, c.entity_id, c.xid::text from sync_changes c
                         where c.business_id = ${ctx.businessId} and (c.xid >= ${b.xmax}::xid8 ${xip}) ${after}
                         order by c.xid, c.entity, c.entity_id limit ${q.limit + 1}) r)`
                     : sql`null`
                 } as changes
          from (select pg_current_snapshot() as s) snap`)
      ).rows as [SnapshotRead];
      // Too many running to list: start the next pass from the oldest (a few changes then come twice).
      const here: Boundary = read.running > MAX_RUNNING ? { xmax: read.xmin, xip: [] } : { xmax: read.xmax, xip: read.xip ?? [] };

      // No cursor, or changes the device needs were deleted: it loads everything, then pulls from here.
      if (!given || Date.parse(given.t) < now.getTime() - (SYNC_KEEP_DAYS - 1) * 86_400_000) {
        return { reset: true, more: false, cursor: encode({ b: here, d: today, t: now.toISOString() }), products: [], customers: [], suppliers: [], removed: { product: [], customer: [], supplier: [] }, ...(await withLists()) };
      }

      const rows = read.changes ?? [];
      const more = rows.length > q.limit;
      const changed = rows.slice(0, q.limit);
      const ids = { product: new Set<string>(), customer: new Set<string>(), supplier: new Set<string>() };
      for (const c of changed) ids[c.entity].add(c.entity_id);
      // Bills that fell overdue since the device's last day: their customers' overdue figures moved.
      if (firstPage && given.d < today && seeCustomers) {
        const fell = await tx.execute<{ id: string }>(sql`
          select distinct customer_id as id from invoices
          where business_id = ${ctx.businessId} and status = 'posted' and balance_due > 0 and due_date >= ${given.d} and due_date < ${today}`);
        for (const x of fell.rows) ids.customer.add(x.id);
      }

      const productIds = seeProducts ? [...ids.product] : [];
      const customerIds = seeCustomers ? [...ids.customer] : [];
      const supplierIds = seeSuppliers ? [...ids.supplier] : [];
      const products = productIds.length ? await catalogProducts(tx, ctx, productIds) : [];
      const customers = customerIds.length
        ? await customerRows(tx, today, sql`c.business_id = ${ctx.businessId} and c.deleted_at is null and c.is_active and c.id in ${sql`(${sql.join(customerIds.map((id) => sql`${id}::uuid`), sql`, `)})`}`)
        : [];
      const suppliers = supplierIds.length
        ? await supplierRows(tx, and(eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt), eq(schema.suppliers.isActive, true), inArray(schema.suppliers.id, supplierIds)))
        : [];
      const kept = (list: Array<{ id: string }>) => new Set(list.map((x) => x.id));
      const [p, c, s] = [kept(products), kept(customers), kept(suppliers)];
      const removed = {
        product: productIds.filter((id) => !p.has(id)),
        customer: customerIds.filter((id) => !c.has(id)),
        supplier: supplierIds.filter((id) => !s.has(id)),
      };

      const last = changed[changed.length - 1];
      // The next pass starts from the snapshot this pass began at.
      const nextBoundary = given.n ?? here;
      const startedAt = given.a ? given.t : now.toISOString();
      const next: Cursor =
        more && last
          ? { b: given.b, a: { xid: last.xid, entity: last.entity, id: last.entity_id }, n: nextBoundary, d: today, t: startedAt }
          : { b: nextBoundary, d: today, t: startedAt };
      return { more, cursor: encode(next), products, customers, suppliers, removed, ...(firstPage ? await withLists() : {}) };
    });
    return body;
  });
};
