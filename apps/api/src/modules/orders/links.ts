import { ShopOrderBody } from "@digitalbahi/contracts";
import { dec, hasPermission, resolveTax, roundRate, type TaxCategory, type TaxRateRule } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard, loadAccess } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { inSequence, withTenant } from "../../lib/db.js";
import { ApiError, badRequest, notFound } from "../../lib/errors.js";
import { prepareSale } from "../../services/sales-document.js";
import type { ApiModule } from "../types.js";
import { createSalesOrder } from "./routes.js";

const IdParams = z.strictObject({ id: z.uuid() });
/** The key in a link: 24 random bytes, URL-safe. */
const KeyParams = z.strictObject({ key: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const gone = () => new ApiError(410, "ORDER_LINK_OFF");

interface FoundLink {
  id: string;
  businessId: string;
  customerId: string;
  ownerId: string;
  timeZone: string;
}

/** The link a key opens, or "turned off" (no such key, a link replaced or turned off, or a business closed). */
async function findLink(deps: AppDeps, key: string): Promise<FoundLink> {
  const res = await deps.db.execute<{ id: string; business_id: string; customer_id: string; owner_id: string; time_zone: string }>(
    sql`select id, business_id, customer_id, owner_id, time_zone from order_link_find(${hashKey(key)})`,
  );
  const row = res.rows[0];
  if (!row) throw gone();
  return { id: row.id, businessId: row.business_id, customerId: row.customer_id, ownerId: row.owner_id, timeZone: row.time_zone };
}

/**
 * Whose name a link's orders are booked in: the person who made the link,
 * while they still belong to the business and may book orders.
 */
async function linkCtx(deps: AppDeps, link: FoundLink, ip: string, userAgent: string | null): Promise<RequestCtx> {
  const access = await loadAccess(deps.db, link.ownerId, link.businessId);
  if (!access || !hasPermission(access.grants, "order.create")) throw gone();
  return {
    userId: link.ownerId,
    userName: access.userName,
    businessId: link.businessId,
    sessionId: "",
    roleKey: access.roleKey,
    // Only the shop's own rates: no other price, discount or back-dating.
    grants: access.grants.filter((g) => g !== "*" && g !== "invoice.override_price" && g !== "invoice.backdate").concat(["order.create", "order.view"]),
    isOwner: false,
    timeZone: link.timeZone,
    requestId: uuidv7(),
    ip,
    userAgent,
  };
}

/** The shop's own price for each pack of each product it may order, as the bill would charge it. */
async function shopCatalogue(tx: Tx, ctx: RequestCtx, customerId: string, today: string) {
  const [customer] = await tx.select().from(schema.customers).where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)));
  if (!customer || !customer.isActive) throw gone();
  let priceLevelId = customer.priceLevelId;
  if (!priceLevelId) {
    const [def] = await tx.select({ id: schema.priceLevels.id }).from(schema.priceLevels).where(and(eq(schema.priceLevels.businessId, ctx.businessId), eq(schema.priceLevels.isDefault, true)));
    priceLevelId = def?.id ?? null;
  }
  const products = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.businessId, ctx.businessId), eq(schema.products.isActive, true), isNull(schema.products.deletedAt)))
    .orderBy(asc(schema.products.name));
  const ids = products.map((p) => p.id);
  const [altUnits, prices, units, categories, rules, productCategories, brands, stock] = await inSequence([
    () => (ids.length ? tx.select().from(schema.productUnits).where(inArray(schema.productUnits.productId, ids)) : Promise.resolve([])),
    () => (ids.length && priceLevelId ? tx.select().from(schema.productPrices).where(and(inArray(schema.productPrices.productId, ids), eq(schema.productPrices.priceLevelId, priceLevelId))) : Promise.resolve([])),
    () => tx.select().from(schema.units).where(eq(schema.units.businessId, ctx.businessId)),
    () => tx.select().from(schema.taxCategories).where(eq(schema.taxCategories.businessId, ctx.businessId)),
    () => tx.select().from(schema.taxRates).where(eq(schema.taxRates.businessId, ctx.businessId)),
    () => tx.select({ id: schema.productCategories.id, name: schema.productCategories.name }).from(schema.productCategories).where(eq(schema.productCategories.businessId, ctx.businessId)),
    () => tx.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(eq(schema.brands.businessId, ctx.businessId)),
    () =>
      tx
        .select({ productId: schema.stockBalances.productId, qty: sql<string>`sum(${schema.stockBalances.qty})::text` })
        .from(schema.stockBalances)
        .where(eq(schema.stockBalances.businessId, ctx.businessId))
        .groupBy(schema.stockBalances.productId),
  ]);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const categoryName = new Map(productCategories.map((c) => [c.id, c.name]));
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const stockOf = new Map(stock.map((s) => [s.productId, s.qty]));
  const taxCategory = new Map<string, TaxCategory>(
    categories.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        kind: c.kind,
        rules: rules
          .filter((r) => r.taxCategoryId === c.id)
          .map((r): TaxRateRule => ({ id: r.id, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, gstRate: r.gstRate, cessRate: r.cessRate, cessPerUnit: r.cessPerUnit, condition: (r.condition as TaxRateRule["condition"]) ?? null, priority: r.priority })),
      },
    ]),
  );
  return {
    customer,
    products: products.map((p) => {
      const packs = [
        { unitId: p.baseUnitId, factor: "1", isDefault: !altUnits.some((u) => u.productId === p.id && u.isDefaultSale) },
        ...altUnits.filter((u) => u.productId === p.id).map((u) => ({ unitId: u.unitId, factor: u.conversionFactor, isDefault: u.isDefaultSale })),
      ];
      const basePrice = prices.find((x) => x.productId === p.id && x.unitId === p.baseUnitId);
      const category = taxCategory.get(p.taxCategoryId);
      // The same rate the order will be priced at (sales-document.ts): the pack's own price, else the stock unit's times the pack.
      const units = packs.map((u) => {
        const own = prices.find((x) => x.productId === p.id && x.unitId === u.unitId);
        const rate = own ? dec(own.price) : roundRate(dec(basePrice?.price ?? p.sellingPrice).times(u.factor));
        const unit = unitById.get(u.unitId);
        return { unitId: u.unitId, symbol: unit?.symbol ?? "", name: unit?.name ?? "", factor: u.factor, rate: rate.toFixed(2), isDefault: u.isDefault };
      });
      const gstRate = category ? resolveTax(category, { date: today, unitValue: dec(units[0]!.rate), unitValueIncludesTax: p.pricesIncludeTax }).gstRate : dec(0);
      return {
        id: p.id,
        name: p.name,
        nameLocal: p.nameLocal,
        code: p.code,
        brand: p.brandId ? (brandName.get(p.brandId) ?? null) : null,
        category: p.categoryId ? (categoryName.get(p.categoryId) ?? null) : null,
        mrp: p.mrp,
        pricesIncludeTax: p.pricesIncludeTax,
        gstRate: dec(gstRate).toFixed(2),
        inStock: Number(stockOf.get(p.id) ?? 0) > 0,
        units,
      };
    }),
  };
}

/**
 * Order links. The business makes one per shop (a customer) and sends it;
 * the shop opens it with no sign-in, sees its own rates and places orders,
 * which wait under Sales orders to be confirmed. The /shop routes are the
 * page's: they take the link's key in the address and nothing else.
 */
export const orderLinksModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const t = schema.orderLinks;
  const linkUrlKey = (row: { keySealed: string }) => deps.cipher.decrypt(row.keySealed);

  const current = (tx: Tx, businessId: string, customerId: string) =>
    tx
      .select()
      .from(t)
      .where(and(eq(t.businessId, businessId), eq(t.customerId, customerId), isNull(t.revokedAt)))
      .orderBy(desc(t.createdAt))
      .limit(1);

  r.get("/customers/:id/order-link", { preHandler: guard(deps, "order.create"), schema: { tags: ["orders"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    const [row] = await withTenant(deps.db, ctx, (tx) => current(tx, ctx.businessId, request.params.id));
    return row ? { key: linkUrlKey(row), createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, ordersPlaced: row.ordersPlaced } : { key: null };
  });

  // A new link: the old one (if any) stops opening.
  r.post("/customers/:id/order-link", { preHandler: guard(deps, "order.create"), schema: { tags: ["orders"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    const key = randomBytes(24).toString("base64url");
    const now = deps.clock.now().toISOString();
    const row = await withTenant(deps.db, ctx, async (tx) => {
      const [customer] = await tx
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.id, request.params.id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
      if (!customer) throw notFound("customer");
      if (!customer.isActive) throw badRequest("CUSTOMER_INACTIVE", {}, "customerId");
      const replaced = await tx
        .update(t)
        .set({ revokedAt: now, updatedAt: now, updatedBy: ctx.userId })
        .where(and(eq(t.businessId, ctx.businessId), eq(t.customerId, customer.id), isNull(t.revokedAt)))
        .returning({ id: t.id });
      const [made] = await tx
        .insert(t)
        .values({ businessId: ctx.businessId, customerId: customer.id, keyHash: hashKey(key), keySealed: deps.cipher.encrypt(key), ownerId: ctx.userId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: replaced.length ? "order_link.replaced" : "order_link.created", entityType: "customer", entityId: customer.id, entityLabel: customer.businessName ?? customer.name });
      return made!;
    });
    return reply.code(201).send({ key, createdAt: row.createdAt, lastUsedAt: null, ordersPlaced: 0 });
  });

  r.delete("/customers/:id/order-link", { preHandler: guard(deps, "order.create"), schema: { tags: ["orders"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    const now = deps.clock.now().toISOString();
    await withTenant(deps.db, ctx, async (tx) => {
      const off = await tx
        .update(t)
        .set({ revokedAt: now, updatedAt: now, updatedBy: ctx.userId })
        .where(and(eq(t.businessId, ctx.businessId), eq(t.customerId, request.params.id), isNull(t.revokedAt)))
        .returning({ id: t.id });
      if (!off.length) throw notFound("order_link");
      await audit(tx, ctx, { action: "order_link.revoked", entityType: "customer", entityId: request.params.id });
    });
    return reply.code(204).send();
  });

  const pageLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };
  const orderLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  /** The shop's page: the business, the shop, its rates and its recent orders. */
  r.get("/shop/:key", { config: pageLimit, schema: { tags: ["shop"], params: KeyParams } }, async (request, reply) => {
    const link = await findLink(deps, request.params.key);
    const ctx = await linkCtx(deps, link, request.ip, request.headers["user-agent"] ?? null);
    const today = deps.clock.today(ctx.timeZone);
    const body = await withTenant(deps.db, ctx, async (tx) => {
      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const { customer, products } = await shopCatalogue(tx, ctx, link.customerId, today);
      const orders = await tx
        .select({ id: schema.salesOrders.id, orderNumber: schema.salesOrders.orderNumber, orderDate: schema.salesOrders.orderDate, status: schema.salesOrders.status, grandTotal: schema.salesOrders.grandTotal })
        .from(schema.salesOrders)
        .where(and(eq(schema.salesOrders.businessId, ctx.businessId), eq(schema.salesOrders.customerId, customer.id), eq(schema.salesOrders.source, "link")))
        .orderBy(desc(schema.salesOrders.createdAt))
        .limit(10);
      return {
        business: { name: business!.tradeName ?? business!.legalName, phone: business!.phone, city: business!.city },
        customer: { name: customer.businessName ?? customer.name },
        products,
        orders,
      };
    });
    reply.header("cache-control", "private, no-store");
    return body;
  });

  /** What an order would come to, with GST, before it is placed. */
  r.post("/shop/:key/quote", { config: pageLimit, schema: { tags: ["shop"], params: KeyParams, body: ShopOrderBody } }, async (request) => {
    const link = await findLink(deps, request.params.key);
    const ctx = await linkCtx(deps, link, request.ip, request.headers["user-agent"] ?? null);
    const today = deps.clock.today(ctx.timeZone);
    return withTenant(deps.db, ctx, async (tx) => {
      const sale = await prepareSale(tx, ctx, { customerId: link.customerId, lines: request.body.lines.map((l) => ({ ...l, freeQty: "0", discountAmount: "0" })), charges: [] } as never, today, { order: true });
      const tot = sale.totals;
      return {
        taxable: tot.taxableTotal.toFixed(2),
        tax: tot.cgstTotal.plus(tot.sgstTotal).plus(tot.igstTotal).plus(tot.cessTotal).toFixed(2),
        roundOff: tot.roundOff.toFixed(2),
        grandTotal: tot.grandTotal.toFixed(2),
        lines: tot.lines.map((l, i) => ({ productId: request.body.lines[i]!.productId, total: l.total.toFixed(2) })),
      };
    });
  });

  /** Places the order: priced from the shop's rate list, waiting to be confirmed. */
  r.post("/shop/:key/orders", { config: orderLimit, schema: { tags: ["shop"], params: KeyParams, body: ShopOrderBody } }, async (request, reply) => {
    const link = await findLink(deps, request.params.key);
    const ctx = await linkCtx(deps, link, request.ip, request.headers["user-agent"] ?? null);
    const idem = request.headers["idempotency-key"];
    const clientId = typeof idem === "string" && z.uuid().safeParse(idem).success ? idem : null;
    if (idem !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await withTenant(deps.db, ctx, async (tx) => {
      const made = await createSalesOrder(
        tx,
        ctx,
        deps,
        { customerId: link.customerId, source: "link", lines: request.body.lines.map((l) => ({ ...l, freeQty: "0", discountAmount: "0" })), ...(request.body.notes ? { notes: request.body.notes } : {}) },
        clientId,
        { status: "pending" },
      );
      if (!made.replay) {
        const now = deps.clock.now().toISOString();
        await tx.update(t).set({ lastUsedAt: now, ordersPlaced: sql`${t.ordersPlaced} + 1` }).where(eq(t.id, link.id));
      }
      return made;
    });
    const d = result.detail;
    return reply.code(result.replay ? 200 : 201).send({ id: d.id, orderNumber: d.orderNumber, orderDate: d.orderDate, status: d.status, grandTotal: d.grandTotal });
  });
};
