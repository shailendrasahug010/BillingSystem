import { SchemeBody, SchemeClaimQuery, SchemeListQuery, SchemePatch, type SchemeClaimLine, type SchemeClaimRow, type SchemeClaimView } from "@digitalbahi/contracts";
import { dec, schemeRuleProblem } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { schemeViews, type SchemeRow } from "../../services/schemes.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
type Body = z.output<typeof SchemeBody>;

/** Every id given is the business's own (foreign keys and arrays of ids ignore row-level security). */
async function assertAllOwned(tx: Tx, table: PgTable & { id: PgColumn; businessId: PgColumn; deletedAt?: PgColumn }, businessId: string, ids: readonly string[], field: string) {
  if (!ids.length) return;
  const unique = [...new Set(ids)];
  const where: SQL[] = [eq(table.businessId, businessId), inArray(table.id, unique)];
  if (table.deletedAt) where.push(isNull(table.deletedAt));
  const rows = await tx.select({ id: table.id }).from(table).where(and(...where));
  if (rows.length !== unique.length) throw badRequest("REFERENCE_NOT_FOUND", {}, field);
}

async function validate(tx: Tx, businessId: string, b: Body) {
  const problem = schemeRuleProblem({ ...b, slabs: b.slabs });
  if (problem) throw badRequest(problem, {}, problem === "SCHEME_ENDS_BEFORE_START" ? "validTo" : problem === "SCHEME_NO_PRODUCTS" ? "productIds" : "slabs");
  await assertAllOwned(tx, schema.products, businessId, [...b.productIds, ...(b.freeProductId ? [b.freeProductId] : [])], "productIds");
  await assertAllOwned(tx, schema.brands, businessId, b.brandIds, "brandIds");
  await assertAllOwned(tx, schema.productCategories, businessId, b.categoryIds, "categoryIds");
  await assertAllOwned(tx, schema.customerCategories, businessId, b.customerCategoryIds, "customerCategoryIds");
  await assertAllOwned(tx, schema.priceLevels, businessId, b.priceLevelIds, "priceLevelIds");
  await assertAllOwned(tx, schema.suppliers, businessId, b.supplierId ? [b.supplierId] : [], "supplierId");
}

/** A slab as kept: only what its kind uses. */
const slabsOf = (b: Pick<Body, "kind" | "slabs">): schema.SchemeSlabRow[] =>
  [...b.slabs]
    .sort((x, y) => dec(x.from).comparedTo(dec(y.from)))
    .map((s) =>
      b.kind === "free_goods"
        ? { from: dec(s.from).toFixed(3), freeQty: dec(s.freeQty ?? 0).toFixed(3) }
        : {
            from: dec(s.from).toFixed(3),
            ...(s.discountPercent && dec(s.discountPercent).gt(0) ? { discountPercent: dec(s.discountPercent).toFixed(3) } : {}),
            ...(s.discountPerUnit && dec(s.discountPerUnit).gt(0) ? { discountPerUnit: dec(s.discountPerUnit).toFixed(2) } : {}),
          },
    );

/** The fields as stored. */
const rowOf = (b: Body) => ({
  name: b.name,
  kind: b.kind,
  measure: b.measure,
  productIds: [...new Set(b.productIds)],
  brandIds: [...new Set(b.brandIds)],
  categoryIds: [...new Set(b.categoryIds)],
  slabs: slabsOf(b),
  repeat: b.kind === "free_goods" ? b.repeat : false,
  freeProductId: b.kind === "free_goods" ? b.freeProductId : null,
  validFrom: b.validFrom,
  validTo: b.validTo,
  customerCategoryIds: [...new Set(b.customerCategoryIds)],
  priceLevelIds: [...new Set(b.priceLevelIds)],
  supplierId: b.supplierId,
  reference: b.reference || null,
  notes: b.notes || null,
});

const bodyOf = (r: SchemeRow): Body => ({
  name: r.name,
  kind: r.kind,
  measure: r.measure,
  productIds: r.productIds,
  brandIds: r.brandIds,
  categoryIds: r.categoryIds,
  slabs: r.slabs.map((s) => ({ from: s.from, ...(s.freeQty ? { freeQty: s.freeQty } : {}), ...(s.discountPercent ? { discountPercent: s.discountPercent } : {}), ...(s.discountPerUnit ? { discountPerUnit: s.discountPerUnit } : {}) })),
  repeat: r.repeat,
  freeProductId: r.freeProductId,
  validFrom: r.validFrom,
  validTo: r.validTo,
  customerCategoryIds: r.customerCategoryIds,
  priceLevelIds: r.priceLevelIds,
  supplierId: r.supplierId,
  reference: r.reference,
  notes: r.notes,
});

const round2 = (v: string | null | undefined) => dec(v ?? 0).toFixed(2);

/**
 * Trade schemes: kept by those who set prices (product.update_price), seen
 * by everyone who bills; the claim report shows what each cost, to claim
 * from the company that runs it.
 */
export const schemesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const s = schema.schemes;

  r.get("/schemes", { preHandler: guard(deps, "product.view"), schema: { tags: ["schemes"], querystring: SchemeListQuery } }, async (request) => {
    const ctx = request.ctx;
    const { status, q } = request.query;
    const today = deps.clock.today(ctx.timeZone);
    const where: SQL[] = [eq(s.businessId, ctx.businessId)];
    if (status === "running") where.push(eq(s.isActive, true), sql`${s.validFrom} <= ${today}`, or(isNull(s.validTo), gte(s.validTo, today))!);
    if (status === "upcoming") where.push(eq(s.isActive, true), sql`${s.validFrom} > ${today}`);
    if (status === "ended") where.push(or(eq(s.isActive, false), lt(s.validTo, today))!);
    if (q) where.push(or(ilike(s.name, likeContains(q)), ilike(s.reference, likeContains(q)))!);
    return tenant(ctx, async (tx) => {
      const rows = await tx.select().from(s).where(and(...where)).orderBy(asc(s.validFrom), asc(s.name)).limit(500);
      return { data: await schemeViews(tx, rows, today) };
    });
  });

  r.get("/schemes/:id", { preHandler: guard(deps, "product.view"), schema: { tags: ["schemes"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [row] = await tx.select().from(s).where(and(eq(s.id, request.params.id), eq(s.businessId, ctx.businessId)));
      if (!row) throw notFound("scheme");
      return (await schemeViews(tx, [row], deps.clock.today(ctx.timeZone)))[0]!;
    });
  });

  r.post("/schemes", { preHandler: guard(deps, "product.update_price"), schema: { tags: ["schemes"], body: SchemeBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const view = await tenant(ctx, async (tx) => {
      await validate(tx, ctx.businessId, body);
      const [row] = await tx
        .insert(s)
        .values({ businessId: ctx.businessId, ...rowOf(body), createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "scheme.created", entityType: "scheme", entityId: row!.id, entityLabel: row!.name });
      return (await schemeViews(tx, [row!], deps.clock.today(ctx.timeZone)))[0]!;
    });
    return reply.code(201).send(view);
  });

  r.patch("/schemes/:id", { preHandler: guard(deps, "product.update_price"), schema: { tags: ["schemes"], params: IdParams, body: SchemePatch } }, async (request) => {
    const ctx = request.ctx;
    const { isActive, ...patch } = request.body;
    return tenant(ctx, async (tx) => {
      const [row] = await tx.select().from(s).where(and(eq(s.id, request.params.id), eq(s.businessId, ctx.businessId))).for("update");
      if (!row) throw notFound("scheme");
      const before = bodyOf(row);
      const merged: Body = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Body;
      await validate(tx, ctx.businessId, merged);
      const next = rowOf(merged);
      const [updated] = await tx
        .update(s)
        .set({ ...next, ...(isActive !== undefined ? { isActive } : {}), updatedBy: ctx.userId, updatedAt: sql`now()` })
        .where(eq(s.id, row.id))
        .returning();
      const changes = { ...diff(before as unknown as Record<string, unknown>, merged as unknown as Record<string, unknown>), ...(isActive !== undefined && isActive !== row.isActive ? { isActive: [row.isActive, isActive] } : {}) };
      if (Object.keys(changes).length) await audit(tx, ctx, { action: "scheme.updated", entityType: "scheme", entityId: row.id, entityLabel: updated!.name, changes });
      return (await schemeViews(tx, [updated!], deps.clock.today(ctx.timeZone)))[0]!;
    });
  });

  /** Only a scheme never given; one on bills or orders is switched off instead (they keep it). */
  r.delete("/schemes/:id", { preHandler: guard(deps, "product.update_price"), schema: { tags: ["schemes"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [row] = await tx.select().from(s).where(and(eq(s.id, request.params.id), eq(s.businessId, ctx.businessId))).for("update");
      if (!row) throw notFound("scheme");
      const [used] = await tx.execute<{ used: boolean }>(sql`
        select exists (select 1 from invoice_items where scheme_id = ${row.id}) or exists (select 1 from sales_order_items where scheme_id = ${row.id}) as used`).then((x) => x.rows);
      if (used?.used) throw conflict("SCHEME_IN_USE", { scheme: row.name });
      await tx.delete(s).where(eq(s.id, row.id));
      await audit(tx, ctx, { action: "scheme.deleted", entityType: "scheme", entityId: row.id, entityLabel: row.name });
    });
    return reply.code(204).send();
  });

  /**
   * What the schemes cost over a period, to claim from the companies: goods
   * given free (at cost and at the bills' rates) and discounts, on posted
   * bills, less what customers returned.
   */
  r.get("/reports/scheme-claims", { preHandler: guard(deps, "report.view_sales"), schema: { tags: ["schemes", "reports"], querystring: SchemeClaimQuery } }, async (request): Promise<SchemeClaimView> => {
    const ctx = request.ctx;
    const q = request.query;
    if (q.to < q.from) throw badRequest("INVALID_PERIOD", {}, "to");
    const showCost = can(ctx, "product.view_cost");
    const filters = sql.join(
      [
        sql`inv.business_id = ${ctx.businessId}`,
        sql`inv.status = 'posted'`,
        sql`inv.invoice_date between ${q.from} and ${q.to}`,
        sql`i.scheme_id is not null`,
        ...(q.schemeId ? [sql`i.scheme_id = ${q.schemeId}`] : []),
        ...(q.supplierId ? [sql`s.supplier_id = ${q.supplierId}`] : []),
      ],
      sql` and `,
    );
    // What is left after returns: the line's quantity less what came back, in its unit.
    const kept = sql`((i.qty - i.returned_qty) / i.qty)`;
    return tenant(ctx, async (tx) => {
      const rows = (
        await tx.execute<{ scheme_id: string; name: string; kind: "free_goods" | "discount"; reference: string | null; supplier_id: string | null; supplier_name: string | null; bills: number; free_lines: number; free_cost: string; free_value: string; discount: string }>(sql`
          select i.scheme_id, s.name, s.kind, s.reference, s.supplier_id, sup.name as supplier_name,
                 count(distinct inv.id)::int as bills,
                 (count(*) filter (where i.scheme_free))::int as free_lines,
                 coalesce(sum((i.qty - i.returned_qty) * i.conversion_factor * i.unit_cost) filter (where i.scheme_free), 0)::text as free_cost,
                 coalesce(sum(i.gross_amount * ${kept}) filter (where i.scheme_free), 0)::text as free_value,
                 coalesce(sum(i.scheme_discount * ${kept}), 0)::text as discount
          from invoice_items i
          join invoices inv on inv.id = i.invoice_id
          join schemes s on s.id = i.scheme_id
          left join suppliers sup on sup.id = s.supplier_id
          where ${filters}
          group by i.scheme_id, s.name, s.kind, s.reference, s.supplier_id, sup.name
          order by s.name`)
      ).rows;
      const lines = (
        await tx.execute<{ invoice_id: string; invoice_number: string; invoice_date: string; customer_name: string; scheme_id: string; scheme_name: string; product_name: string; free_qty: string; unit: string | null; free_cost: string; free_value: string; discount: string }>(sql`
          select inv.id as invoice_id, inv.invoice_number, inv.invoice_date::text, inv.party_name as customer_name,
                 i.scheme_id, s.name as scheme_name, i.product_name,
                 (case when i.scheme_free then (i.qty - i.returned_qty) * i.conversion_factor else 0 end)::text as free_qty,
                 (select u.symbol from products p join units u on u.id = p.base_unit_id where p.id = i.product_id) as unit,
                 (case when i.scheme_free then (i.qty - i.returned_qty) * i.conversion_factor * i.unit_cost else 0 end)::text as free_cost,
                 (case when i.scheme_free then i.gross_amount * ${kept} else 0 end)::text as free_value,
                 (i.scheme_discount * ${kept})::text as discount
          from invoice_items i
          join invoices inv on inv.id = i.invoice_id
          join schemes s on s.id = i.scheme_id
          where ${filters}
          order by inv.invoice_date, inv.invoice_number, i.line_no
          limit 5000`)
      ).rows;
      const out: SchemeClaimRow[] = rows.map((x) => ({
        schemeId: x.scheme_id,
        name: x.name,
        kind: x.kind,
        reference: x.reference,
        supplierId: x.supplier_id,
        supplierName: x.supplier_name,
        bills: x.bills,
        freeLines: x.free_lines,
        freeCost: showCost ? round2(x.free_cost) : null,
        freeValue: round2(x.free_value),
        discount: round2(x.discount),
        claim: showCost ? dec(round2(x.free_cost)).plus(round2(x.discount)).toFixed(2) : null,
      }));
      const detail: SchemeClaimLine[] = lines.map((x) => ({
        invoiceId: x.invoice_id,
        invoiceNumber: x.invoice_number,
        invoiceDate: x.invoice_date,
        customerName: x.customer_name,
        schemeId: x.scheme_id,
        schemeName: x.scheme_name,
        productName: x.product_name,
        freeQty: dec(x.free_qty).toFixed(3),
        unit: x.unit ?? "",
        freeCost: showCost ? round2(x.free_cost) : null,
        freeValue: round2(x.free_value),
        discount: round2(x.discount),
      }));
      const total = (pick: (r: SchemeClaimRow) => string | null) => out.reduce((a, r) => a.plus(pick(r) ?? 0), dec(0)).toFixed(2);
      return {
        from: q.from,
        to: q.to,
        rows: out,
        lines: detail,
        totals: { freeCost: showCost ? total((r) => r.freeCost) : null, freeValue: total((r) => r.freeValue), discount: total((r) => r.discount), claim: showCost ? total((r) => r.claim) : null },
      };
    });
  });
};
