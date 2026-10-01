import { BrandBody, CategoryBody, patchOf, PriceLevelBody, TaxCategoryBody, TaxRateEndBody, TaxRateRuleBody, UnitBody } from "@digitalbahi/contracts";
import { findOverlappingRules, type TaxRateRule } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { assertOwned } from "../../services/owned.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });

type RuleInput = z.output<typeof TaxRateRuleBody>;
type RuleRow = typeof schema.taxRates.$inferSelect;

const asCoreRule = (r: Pick<RuleRow, "id" | "effectiveFrom" | "effectiveTo" | "gstRate" | "priority" | "condition">): TaxRateRule => ({
  id: r.id,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  gstRate: r.gstRate,
  priority: r.priority,
  condition: (r.condition as TaxRateRule["condition"]) ?? null,
});

function assertNoOverlap(rules: TaxRateRule[]): void {
  for (const r of rules) {
    if (r.effectiveTo && r.effectiveTo < r.effectiveFrom) throw badRequest("TAX_RULE_DATES_INVALID", {}, "rules");
  }
  const overlaps = findOverlappingRules(rules);
  if (overlaps.length) throw badRequest("TAX_RULES_OVERLAP", {}, "rules");
}

const ruleValues = (businessId: string, taxCategoryId: string, rule: RuleInput, userId: string) => ({
  id: uuidv7(),
  businessId,
  taxCategoryId,
  effectiveFrom: rule.effectiveFrom,
  effectiveTo: rule.effectiveTo ?? null,
  gstRate: rule.gstRate,
  cessRate: rule.cessRate,
  cessPerUnit: rule.cessPerUnit,
  condition: rule.condition ?? null,
  priority: rule.priority,
  reference: rule.reference ?? null,
  createdBy: userId,
  updatedBy: userId,
});

export async function listTaxCategories(tx: Tx, businessId: string) {
  const cats = await tx.select().from(schema.taxCategories).where(eq(schema.taxCategories.businessId, businessId)).orderBy(asc(schema.taxCategories.name));
  const rules = await tx
    .select()
    .from(schema.taxRates)
    .where(eq(schema.taxRates.businessId, businessId))
    .orderBy(asc(schema.taxRates.effectiveFrom));
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    description: c.description,
    rules: rules
      .filter((r) => r.taxCategoryId === c.id)
      .map((r) => ({
        id: r.id,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        gstRate: r.gstRate,
        cessRate: r.cessRate,
        cessPerUnit: r.cessPerUnit,
        condition: r.condition,
        priority: r.priority,
        reference: r.reference,
      })),
  }));
}

/** Units, brands, categories, price levels and GST tax categories. */
export const catalogMastersModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  // ---------------------------------------------------------------- units
  r.get("/units", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx.select().from(schema.units).where(eq(schema.units.businessId, request.ctx.businessId)).orderBy(asc(schema.units.name)),
    ),
  }));

  r.post("/units", { preHandler: guard(deps, "product.create"), schema: { tags: ["catalog"], body: UnitBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const [u] = await tx
        .insert(schema.units)
        .values({ ...request.body, symbol: request.body.symbol.toUpperCase(), id: uuidv7(), businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "unit.created", entityType: "unit", entityId: u!.id, entityLabel: u!.symbol });
      return u!;
    });
    return reply.code(201).send(row);
  });

  r.patch("/units/:id", { preHandler: guard(deps, "product.update"), schema: { tags: ["catalog"], params: IdParams, body: patchOf(UnitBody) } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [u] = await tx.select().from(schema.units).where(and(eq(schema.units.id, request.params.id), eq(schema.units.businessId, ctx.businessId)));
      if (!u) throw notFound("unit");
      const patch = { ...request.body, ...(request.body.symbol ? { symbol: request.body.symbol.toUpperCase() } : {}) };
      const [row] = await tx.update(schema.units).set({ ...patch, updatedBy: ctx.userId }).where(eq(schema.units.id, u.id)).returning();
      await audit(tx, ctx, { action: "unit.updated", entityType: "unit", entityId: u.id, entityLabel: row!.symbol, changes: diff(u, patch) });
      return row!;
    });
  });

  // ---------------------------------------------------------------- brands
  r.get("/brands", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx
        .select()
        .from(schema.brands)
        .where(and(eq(schema.brands.businessId, request.ctx.businessId), isNull(schema.brands.deletedAt)))
        .orderBy(asc(schema.brands.name)),
    ),
  }));

  r.post("/brands", { preHandler: guard(deps, "product.create"), schema: { tags: ["catalog"], body: BrandBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const [b] = await tx
        .insert(schema.brands)
        .values({ ...request.body, id: uuidv7(), businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "brand.created", entityType: "brand", entityId: b!.id, entityLabel: b!.name });
      return b!;
    });
    return reply.code(201).send(row);
  });

  r.patch(
    "/brands/:id",
    { preHandler: guard(deps, "product.update"), schema: { tags: ["catalog"], params: IdParams, body: patchOf(BrandBody.extend({ isActive: z.boolean() })) } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [b] = await tx
          .select()
          .from(schema.brands)
          .where(and(eq(schema.brands.id, request.params.id), eq(schema.brands.businessId, ctx.businessId), isNull(schema.brands.deletedAt)));
        if (!b) throw notFound("brand");
        const [row] = await tx.update(schema.brands).set({ ...request.body, updatedBy: ctx.userId }).where(eq(schema.brands.id, b.id)).returning();
        await audit(tx, ctx, { action: "brand.updated", entityType: "brand", entityId: b.id, entityLabel: row!.name, changes: diff(b, request.body) });
        return row!;
      });
    },
  );

  r.delete("/brands/:id", { preHandler: guard(deps, "product.delete"), schema: { tags: ["catalog"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [b] = await tx
        .select()
        .from(schema.brands)
        .where(and(eq(schema.brands.id, request.params.id), eq(schema.brands.businessId, ctx.businessId), isNull(schema.brands.deletedAt)));
      if (!b) throw notFound("brand");
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.products)
        .where(and(eq(schema.products.brandId, b.id), isNull(schema.products.deletedAt)));
      if (used!.n > 0) throw conflict("IN_USE", { count: used!.n });
      await tx.update(schema.brands).set({ deletedAt: deps.clock.now().toISOString(), deletedBy: ctx.userId }).where(eq(schema.brands.id, b.id));
      await audit(tx, ctx, { action: "brand.deleted", entityType: "brand", entityId: b.id, entityLabel: b.name });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- categories (tree)
  r.get("/categories", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx
        .select()
        .from(schema.productCategories)
        .where(and(eq(schema.productCategories.businessId, request.ctx.businessId), isNull(schema.productCategories.deletedAt)))
        .orderBy(asc(schema.productCategories.sortOrder), asc(schema.productCategories.name)),
    ),
  }));

  r.post("/categories", { preHandler: guard(deps, "product.create"), schema: { tags: ["catalog"], body: CategoryBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      await assertOwned(tx, schema.productCategories, ctx.businessId, request.body.parentId, "parentId");
      const [c] = await tx
        .insert(schema.productCategories)
        .values({ name: request.body.name, parentId: request.body.parentId ?? null, id: uuidv7(), businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "category.created", entityType: "category", entityId: c!.id, entityLabel: c!.name });
      return c!;
    });
    return reply.code(201).send(row);
  });

  r.patch("/categories/:id", { preHandler: guard(deps, "product.update"), schema: { tags: ["catalog"], params: IdParams, body: patchOf(CategoryBody) } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const all = await tx
        .select({ id: schema.productCategories.id, parentId: schema.productCategories.parentId })
        .from(schema.productCategories)
        .where(and(eq(schema.productCategories.businessId, ctx.businessId), isNull(schema.productCategories.deletedAt)));
      const [c] = await tx.select().from(schema.productCategories).where(and(eq(schema.productCategories.id, request.params.id), eq(schema.productCategories.businessId, ctx.businessId), isNull(schema.productCategories.deletedAt)));
      if (!c) throw notFound("category");
      const parentId = request.body.parentId;
      if (parentId) {
        await assertOwned(tx, schema.productCategories, ctx.businessId, parentId, "parentId");
        // Walking up from the new parent must never reach this category.
        const parentOf = new Map(all.map((x) => [x.id, x.parentId]));
        for (let cur: string | null | undefined = parentId, depth = 0; cur && depth < 50; cur = parentOf.get(cur), depth++) {
          if (cur === c.id) throw badRequest("CATEGORY_CYCLE", {}, "parentId");
        }
      }
      const [row] = await tx.update(schema.productCategories).set({ ...request.body, updatedBy: ctx.userId }).where(eq(schema.productCategories.id, c.id)).returning();
      await audit(tx, ctx, { action: "category.updated", entityType: "category", entityId: c.id, entityLabel: row!.name, changes: diff(c, request.body) });
      return row!;
    });
  });

  r.delete("/categories/:id", { preHandler: guard(deps, "product.delete"), schema: { tags: ["catalog"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [c] = await tx.select().from(schema.productCategories).where(and(eq(schema.productCategories.id, request.params.id), eq(schema.productCategories.businessId, ctx.businessId), isNull(schema.productCategories.deletedAt)));
      if (!c) throw notFound("category");
      const [used] = await tx.execute<{ n: number }>(sql`
        select (select count(*) from products where category_id = ${c.id} and deleted_at is null)
             + (select count(*) from product_categories where parent_id = ${c.id} and deleted_at is null) as n`).then((x) => x.rows);
      if (Number(used!.n) > 0) throw conflict("IN_USE", { count: Number(used!.n) });
      await tx.update(schema.productCategories).set({ deletedAt: deps.clock.now().toISOString(), deletedBy: ctx.userId }).where(eq(schema.productCategories.id, c.id));
      await audit(tx, ctx, { action: "category.deleted", entityType: "category", entityId: c.id, entityLabel: c.name });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- price levels (rate lists)
  r.get("/price-levels", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx.select().from(schema.priceLevels).where(eq(schema.priceLevels.businessId, request.ctx.businessId)).orderBy(asc(schema.priceLevels.sortOrder), asc(schema.priceLevels.name)),
    ),
  }));

  const clearDefaultLevel = (tx: Tx, businessId: string, exceptId: string) =>
    tx
      .update(schema.priceLevels)
      .set({ isDefault: false })
      .where(and(eq(schema.priceLevels.businessId, businessId), ne(schema.priceLevels.id, exceptId), eq(schema.priceLevels.isDefault, true)));

  r.post("/price-levels", { preHandler: guard(deps, "product.update_price"), schema: { tags: ["catalog"], body: PriceLevelBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const id = uuidv7();
      if (request.body.isDefault) await clearDefaultLevel(tx, ctx.businessId, id);
      const [max] = await tx.select({ n: sql<number>`coalesce(max(sort_order), 0)::int` }).from(schema.priceLevels).where(eq(schema.priceLevels.businessId, ctx.businessId));
      const [p] = await tx
        .insert(schema.priceLevels)
        .values({ ...request.body, id, sortOrder: max!.n + 1, businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "price_level.created", entityType: "price_level", entityId: id, entityLabel: p!.name });
      return p!;
    });
    return reply.code(201).send(row);
  });

  r.patch(
    "/price-levels/:id",
    { preHandler: guard(deps, "product.update_price"), schema: { tags: ["catalog"], params: IdParams, body: patchOf(PriceLevelBody) } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [p] = await tx.select().from(schema.priceLevels).where(and(eq(schema.priceLevels.id, request.params.id), eq(schema.priceLevels.businessId, ctx.businessId)));
        if (!p) throw notFound("price_level");
        if (request.body.isDefault) await clearDefaultLevel(tx, ctx.businessId, p.id);
        const [row] = await tx.update(schema.priceLevels).set({ ...request.body, updatedBy: ctx.userId }).where(eq(schema.priceLevels.id, p.id)).returning();
        await audit(tx, ctx, { action: "price_level.updated", entityType: "price_level", entityId: p.id, entityLabel: row!.name, changes: diff(p, request.body) });
        return row!;
      });
    },
  );

  // ---------------------------------------------------------------- GST tax categories + dated rules
  r.get("/tax-categories", { preHandler: guard(deps, "product.view"), schema: { tags: ["gst"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) => listTaxCategories(tx, request.ctx.businessId)),
  }));

  r.post("/tax-categories", { preHandler: guard(deps, "settings.update"), schema: { tags: ["gst"], body: TaxCategoryBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    if (body.kind === "taxable" && !body.rules.length) throw badRequest("TAX_RULE_REQUIRED", {}, "rules");
    assertNoOverlap(body.rules.map((rule, i) => ({ ...rule, id: String(i) })));
    const created = await tenant(ctx, async (tx) => {
      const id = uuidv7();
      await tx.insert(schema.taxCategories).values({
        id,
        businessId: ctx.businessId,
        name: body.name,
        kind: body.kind,
        description: body.description ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      if (body.rules.length) await tx.insert(schema.taxRates).values(body.rules.map((rule) => ruleValues(ctx.businessId, id, rule, ctx.userId)));
      await audit(tx, ctx, { action: "tax_category.created", entityType: "tax_category", entityId: id, entityLabel: body.name, changes: { rules: body.rules } });
      return (await listTaxCategories(tx, ctx.businessId)).find((c) => c.id === id)!;
    });
    return reply.code(201).send(created);
  });

  r.patch(
    "/tax-categories/:id",
    {
      preHandler: guard(deps, "settings.update"),
      schema: { tags: ["gst"], params: IdParams, body: patchOf(TaxCategoryBody.pick({ name: true, description: true })) },
    },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [c] = await tx.select().from(schema.taxCategories).where(and(eq(schema.taxCategories.id, request.params.id), eq(schema.taxCategories.businessId, ctx.businessId)));
        if (!c) throw notFound("tax_category");
        await tx.update(schema.taxCategories).set({ ...request.body, updatedBy: ctx.userId }).where(eq(schema.taxCategories.id, c.id));
        await audit(tx, ctx, { action: "tax_category.updated", entityType: "tax_category", entityId: c.id, entityLabel: c.name, changes: diff(c, request.body) });
        return (await listTaxCategories(tx, ctx.businessId)).find((x) => x.id === c.id)!;
      });
    },
  );

  /**
   * A government rate change: add a rule from its effective date (and end the
   * old one the day before). Posted documents keep the rate they were issued with.
   */
  r.post(
    "/tax-categories/:id/rules",
    { preHandler: guard(deps, "settings.update"), schema: { tags: ["gst"], params: IdParams, body: TaxRateRuleBody } },
    async (request, reply) => {
      const ctx = request.ctx;
      const result = await tenant(ctx, async (tx) => {
        const [c] = await tx.select().from(schema.taxCategories).where(and(eq(schema.taxCategories.id, request.params.id), eq(schema.taxCategories.businessId, ctx.businessId))).for("update");
        if (!c) throw notFound("tax_category");
        if (c.kind !== "taxable") throw badRequest("TAX_CATEGORY_NOT_TAXABLE", {}, "id");
        const existing = await tx.select().from(schema.taxRates).where(eq(schema.taxRates.taxCategoryId, c.id));
        assertNoOverlap([...existing.map(asCoreRule), { ...request.body, id: "new" }]);
        const values = ruleValues(ctx.businessId, c.id, request.body, ctx.userId);
        await tx.insert(schema.taxRates).values(values);
        await audit(tx, ctx, { action: "tax_rate.added", entityType: "tax_category", entityId: c.id, entityLabel: c.name, changes: { rule: request.body } });
        return (await listTaxCategories(tx, ctx.businessId)).find((x) => x.id === c.id)!;
      });
      return reply.code(201).send(result);
    },
  );

  r.patch(
    "/tax-rates/:id",
    { preHandler: guard(deps, "settings.update"), schema: { tags: ["gst"], params: IdParams, body: TaxRateEndBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [rule] = await tx.select().from(schema.taxRates).where(and(eq(schema.taxRates.id, request.params.id), eq(schema.taxRates.businessId, ctx.businessId))).for("update");
        if (!rule) throw notFound("tax_rate");
        if (request.body.effectiveTo < rule.effectiveFrom) throw badRequest("TAX_RULE_DATES_INVALID", {}, "effectiveTo");
        await tx.update(schema.taxRates).set({ effectiveTo: request.body.effectiveTo, updatedBy: ctx.userId }).where(eq(schema.taxRates.id, rule.id));
        await audit(tx, ctx, {
          action: "tax_rate.ended",
          entityType: "tax_category",
          entityId: rule.taxCategoryId,
          changes: { effectiveTo: [rule.effectiveTo, request.body.effectiveTo], gstRate: rule.gstRate },
        });
        return (await listTaxCategories(tx, ctx.businessId)).find((x) => x.id === rule.taxCategoryId)!;
      });
    },
  );
};
