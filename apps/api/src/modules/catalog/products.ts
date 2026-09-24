import { ProductBody, ProductListQuery, ProductPatch } from "@vyapaar/contracts";
import { dec } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { inSequence, withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextMasterCode } from "../../services/numbering.js";
import { assertOwned } from "../../services/owned.js";
import { postStockMovement } from "../../services/stock.js";
import type { ApiModule } from "../types.js";
import { listTaxCategories } from "./masters.js";

const IdParams = z.object({ id: z.uuid() });
type Body = z.output<typeof ProductBody>;
type Patch = z.output<typeof ProductPatch>;
type ProductRow = typeof schema.products.$inferSelect;

/** Setting prices while creating a product needs only product.create; changing them later needs product.update_price. */
const PRICE_FIELDS = ["sellingPrice", "mrp", "purchasePrice", "prices", "pricesIncludeTax"] as const;

/** ILIKE pattern with the user's text taken literally. */
export const likeContains = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

/** Purchase cost and margin are hidden from roles without product.view_cost (e.g. sales staff). */
function productOut(p: ProductRow, showCost: boolean) {
  const { businessId: _b, deletedAt: _d, deletedBy: _db, purchasePrice, avgCost, ...rest } = p;
  return { ...rest, ...(showCost ? { purchasePrice, avgCost } : {}) };
}

async function validateRefs(tx: Tx, businessId: string, body: Partial<Body>, baseUnitId: string): Promise<void> {
  await assertOwned(tx, schema.taxCategories, businessId, body.taxCategoryId, "taxCategoryId");
  await assertOwned(tx, schema.brands, businessId, body.brandId, "brandId");
  await assertOwned(tx, schema.productCategories, businessId, body.categoryId, "categoryId");
  await assertOwned(tx, schema.units, businessId, body.baseUnitId, "baseUnitId");
  await assertOwned(tx, schema.suppliers, businessId, body.preferredSupplierId, "preferredSupplierId");
  const unitIds = new Set<string>([baseUnitId]);
  for (const [i, u] of (body.units ?? []).entries()) {
    if (u.unitId === baseUnitId) throw badRequest("ALT_UNIT_IS_BASE_UNIT", {}, `units[${i}].unitId`);
    if (unitIds.has(u.unitId)) throw badRequest("DUPLICATE_UNIT", {}, `units[${i}].unitId`);
    if (dec(u.conversionFactor).lte(0)) throw badRequest("CONVERSION_FACTOR_INVALID", {}, `units[${i}].conversionFactor`);
    await assertOwned(tx, schema.units, businessId, u.unitId, `units[${i}].unitId`);
    unitIds.add(u.unitId);
  }
  const priceKeys = new Set<string>();
  for (const [i, p] of (body.prices ?? []).entries()) {
    await assertOwned(tx, schema.priceLevels, businessId, p.priceLevelId, `prices[${i}].priceLevelId`);
    if (!unitIds.has(p.unitId)) throw badRequest("PRICE_UNIT_NOT_ON_PRODUCT", {}, `prices[${i}].unitId`);
    const key = `${p.priceLevelId}:${p.unitId}`;
    if (priceKeys.has(key)) throw badRequest("DUPLICATE_PRICE", {}, `prices[${i}]`);
    priceKeys.add(key);
  }
  const barcodes = body.barcodes ?? [];
  if (new Set(barcodes).size !== barcodes.length) throw badRequest("DUPLICATE_BARCODE", {}, "barcodes");
}

async function writeChildren(tx: Tx, ctx: RequestCtx, productId: string, body: Partial<Body>, replace: boolean): Promise<void> {
  const base = { businessId: ctx.businessId, productId, createdBy: ctx.userId, updatedBy: ctx.userId };
  if (body.barcodes) {
    if (replace) await tx.delete(schema.productBarcodes).where(eq(schema.productBarcodes.productId, productId));
    if (body.barcodes.length) await tx.insert(schema.productBarcodes).values(body.barcodes.map((barcode) => ({ ...base, id: uuidv7(), barcode })));
  }
  if (body.units) {
    if (replace) await tx.delete(schema.productUnits).where(eq(schema.productUnits.productId, productId));
    if (body.units.length) await tx.insert(schema.productUnits).values(body.units.map((u) => ({ ...base, id: uuidv7(), ...u })));
  }
  if (body.prices) {
    if (replace) await tx.delete(schema.productPrices).where(eq(schema.productPrices.productId, productId));
    if (body.prices.length) await tx.insert(schema.productPrices).values(body.prices.map((p) => ({ ...base, ...p })));
  }
}

export async function productDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [p] = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, id), eq(schema.products.businessId, ctx.businessId), isNull(schema.products.deletedAt)));
  if (!p) throw notFound("product");
  const [units, barcodes, prices, stock] = await inSequence([
    () => tx
      .select({
        unitId: schema.productUnits.unitId,
        symbol: schema.units.symbol,
        conversionFactor: schema.productUnits.conversionFactor,
        isDefaultSale: schema.productUnits.isDefaultSale,
        isDefaultPurchase: schema.productUnits.isDefaultPurchase,
      })
      .from(schema.productUnits)
      .innerJoin(schema.units, eq(schema.units.id, schema.productUnits.unitId))
      .where(eq(schema.productUnits.productId, id)),
    () => tx.select({ barcode: schema.productBarcodes.barcode, unitId: schema.productBarcodes.unitId }).from(schema.productBarcodes).where(eq(schema.productBarcodes.productId, id)),
    () => tx
      .select({
        priceLevelId: schema.productPrices.priceLevelId,
        unitId: schema.productPrices.unitId,
        price: schema.productPrices.price,
        discountPercent: schema.productPrices.discountPercent,
      })
      .from(schema.productPrices)
      .where(eq(schema.productPrices.productId, id)),
    () => tx
      .select({ warehouseId: schema.stockBalances.warehouseId, warehouse: schema.warehouses.name, qty: sql<string>`sum(${schema.stockBalances.qty})::text` })
      .from(schema.stockBalances)
      .innerJoin(schema.warehouses, eq(schema.warehouses.id, schema.stockBalances.warehouseId))
      .where(eq(schema.stockBalances.productId, id))
      .groupBy(schema.stockBalances.warehouseId, schema.warehouses.name),
  ]);
  const total = stock.reduce((acc, s) => acc.plus(s.qty), dec(0));
  return {
    ...productOut(p, can(ctx, "product.view_cost")),
    units,
    barcodes,
    prices,
    stock: { total: total.toFixed(3), byWarehouse: stock },
  };
}

async function defaultWarehouseId(tx: Tx, businessId: string): Promise<string> {
  const [wh] = await tx
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(and(eq(schema.warehouses.businessId, businessId), eq(schema.warehouses.isDefault, true), isNull(schema.warehouses.deletedAt)));
  if (!wh) throw new ApiError(409, "NO_DEFAULT_WAREHOUSE");
  return wh.id;
}

export const productsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.get("/products", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"], querystring: ProductListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [sql`p.business_id = ${ctx.businessId}`, sql`p.deleted_at is null`];
    if (q.active !== "all") where.push(sql`p.is_active = ${q.active === "true"}`);
    if (q.brandId) where.push(sql`p.brand_id = ${q.brandId}`);
    if (q.categoryId) where.push(sql`p.category_id = ${q.categoryId}`);
    if (q.stock === "low") where.push(sql`p.min_stock is not null and coalesce(st.qty, 0) <= p.min_stock`);
    if (q.stock === "out") where.push(sql`coalesce(st.qty, 0) <= 0`);
    if (q.q) {
      const like = likeContains(q.q);
      where.push(sql`(p.name ilike ${like} or p.name_local ilike ${like} or p.code ilike ${like} or p.sku = ${q.q}
        or array_to_string(p.aliases, ' ') ilike ${like}
        or exists (select 1 from product_barcodes pb where pb.product_id = p.id and pb.barcode = ${q.q}))`);
    }
    if (cursor) where.push(sql`(p.name, p.id) > (${String(cursor.v)}, ${cursor.id}::uuid)`);
    const showCost = can(ctx, "product.view_cost");
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{
          id: string;
          code: string;
          name: string;
          name_local: string | null;
          sku: string | null;
          hsn_code: string | null;
          brand_id: string | null;
          brand: string | null;
          category_id: string | null;
          tax_category_id: string;
          base_unit_id: string;
          unit: string;
          selling_price: string;
          mrp: string | null;
          purchase_price: string;
          avg_cost: string;
          min_stock: string | null;
          is_active: boolean;
          stock: string;
        }>(sql`
          select p.id, p.code, p.name, p.name_local, p.sku, p.hsn_code, p.brand_id, b.name as brand, p.category_id,
                 p.tax_category_id, p.base_unit_id, u.symbol as unit, p.selling_price, p.mrp, p.purchase_price, p.avg_cost,
                 p.min_stock, p.is_active, coalesce(st.qty, 0)::text as stock
          from products p
          join units u on u.id = p.base_unit_id
          left join brands b on b.id = p.brand_id
          left join lateral (select sum(sb.qty) as qty from stock_balances sb where sb.product_id = p.id) st on true
          where ${sql.join(where, sql` and `)}
          order by p.name, p.id
          limit ${q.limit + 1}`)
      ).rows,
    );
    const data = rows.map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      nameLocal: x.name_local,
      sku: x.sku,
      hsnCode: x.hsn_code,
      brandId: x.brand_id,
      brand: x.brand,
      categoryId: x.category_id,
      taxCategoryId: x.tax_category_id,
      baseUnitId: x.base_unit_id,
      unit: x.unit,
      sellingPrice: x.selling_price,
      mrp: x.mrp,
      ...(showCost ? { purchasePrice: x.purchase_price, avgCost: x.avg_cost } : {}),
      minStock: x.min_stock,
      isActive: x.is_active,
      stock: x.stock,
      stockStatus: dec(x.stock).lte(0) ? "out" : x.min_stock && dec(x.stock).lte(x.min_stock) ? "low" : "ok",
    }));
    return page(data, q.limit, (row) => ({ v: row.name, id: row.id }));
  });

  r.get("/products/:id", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => productDetail(tx, request.ctx, request.params.id)),
  );

  /** Scanner lookup: a barcode may belong to a pack unit (case of 24), which the invoice line then uses. */
  r.get(
    "/products/lookup",
    { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"], querystring: z.object({ barcode: z.string().trim().min(1).max(64) }) } },
    async (request) =>
      tenant(request.ctx, async (tx) => {
        const [hit] = await tx
          .select({ productId: schema.productBarcodes.productId, unitId: schema.productBarcodes.unitId })
          .from(schema.productBarcodes)
          .innerJoin(schema.products, eq(schema.products.id, schema.productBarcodes.productId))
          .where(
            and(
              eq(schema.productBarcodes.businessId, request.ctx.businessId),
              eq(schema.productBarcodes.barcode, request.query.barcode),
              isNull(schema.products.deletedAt),
            ),
          );
        if (!hit) throw notFound("product");
        return { unitId: hit.unitId, product: await productDetail(tx, request.ctx, hit.productId) };
      }),
  );

  r.post("/products", { preHandler: guard(deps, "product.create"), schema: { tags: ["catalog"], body: ProductBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const detail = await tenant(ctx, async (tx) => {
      await validateRefs(tx, ctx.businessId, body, body.baseUnitId);
      const today = deps.clock.today(ctx.timeZone);
      const code =
        body.code?.toUpperCase() ??
        (await nextMasterCode(tx, ctx.businessId, "product", today, async (c) => {
          const [x] = await tx
            .select({ id: schema.products.id })
            .from(schema.products)
            .where(and(eq(schema.products.businessId, ctx.businessId), eq(schema.products.code, c), isNull(schema.products.deletedAt)));
          return Boolean(x);
        }));
      const id = uuidv7();
      const { barcodes: _bc, units: _u, prices: _p, openingStock, openingStockCost, code: _c, ...fields } = body;
      const cost = openingStockCost ?? body.purchasePrice;
      await tx.insert(schema.products).values({
        ...fields,
        id,
        code,
        businessId: ctx.businessId,
        aliases: body.aliases,
        avgCost: "0",
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      await writeChildren(tx, ctx, id, body, false);
      if (openingStock && dec(openingStock).gt(0)) {
        await postStockMovement(
          tx,
          {
            businessId: ctx.businessId,
            productId: id,
            productName: body.name,
            warehouseId: await defaultWarehouseId(tx, ctx.businessId),
            date: today,
            type: "opening",
            qty: openingStock,
            unitCost: cost,
            refType: "opening",
            refId: id,
            refNumber: code,
            reason: "Opening stock",
            userId: ctx.userId,
          },
          "allow",
        );
      }
      await audit(tx, ctx, { action: "product.created", entityType: "product", entityId: id, entityLabel: `${code} ${body.name}` });
      return productDetail(tx, ctx, id);
    });
    return reply.code(201).send(detail);
  });

  r.patch("/products/:id", { preHandler: guard(deps, "product.update"), schema: { tags: ["catalog"], params: IdParams, body: ProductPatch } }, async (request) => {
    const ctx = request.ctx;
    const body: Patch = request.body;
    if (PRICE_FIELDS.some((f) => body[f] !== undefined) && !can(ctx, "product.update_price")) throw forbidden("product.update_price");
    const expectedVersion = request.headers["if-match"] ? Number(request.headers["if-match"]) : null;
    return tenant(ctx, async (tx) => {
      const [p] = await tx
        .select()
        .from(schema.products)
        .where(and(eq(schema.products.id, request.params.id), eq(schema.products.businessId, ctx.businessId), isNull(schema.products.deletedAt)))
        .for("update");
      if (!p) throw notFound("product");
      if (expectedVersion !== null && expectedVersion !== p.version) throw conflict("VERSION_CONFLICT", { current: p.version });
      if (body.baseUnitId && body.baseUnitId !== p.baseUnitId) {
        const [moved] = await tx.select({ id: schema.stockLedger.id }).from(schema.stockLedger).where(eq(schema.stockLedger.productId, p.id)).limit(1);
        if (moved) throw conflict("BASE_UNIT_LOCKED", {}, "baseUnitId");
      }
      const baseUnitId = body.baseUnitId ?? p.baseUnitId;
      if (body.prices && !body.units) {
        // Prices may use the product's existing alternate units.
        const units = await tx.select({ unitId: schema.productUnits.unitId, conversionFactor: schema.productUnits.conversionFactor }).from(schema.productUnits).where(eq(schema.productUnits.productId, p.id));
        await validateRefs(tx, ctx.businessId, { ...body, units: units.map((u) => ({ ...u, isDefaultSale: false, isDefaultPurchase: false })) }, baseUnitId);
      } else {
        await validateRefs(tx, ctx.businessId, body, baseUnitId);
      }
      const { barcodes: _bc, units: _u, prices: _p, ...fields } = body;
      if (fields.code) fields.code = fields.code.toUpperCase();
      const changes = diff(p, fields);
      await tx
        .update(schema.products)
        .set({ ...fields, updatedBy: ctx.userId, version: p.version + 1 })
        .where(eq(schema.products.id, p.id));
      await writeChildren(tx, ctx, p.id, body, true);
      for (const key of ["barcodes", "units", "prices"] as const) if (body[key]) changes[key] = ["(replaced)", body[key]];
      await audit(tx, ctx, { action: "product.updated", entityType: "product", entityId: p.id, entityLabel: `${p.code} ${fields.name ?? p.name}`, changes });
      return productDetail(tx, ctx, p.id);
    });
  });

  r.delete("/products/:id", { preHandler: guard(deps, "product.delete"), schema: { tags: ["catalog"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [p] = await tx
        .select()
        .from(schema.products)
        .where(and(eq(schema.products.id, request.params.id), eq(schema.products.businessId, ctx.businessId), isNull(schema.products.deletedAt)))
        .for("update");
      if (!p) throw notFound("product");
      const [stock] = await tx
        .select({ qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)::text` })
        .from(schema.stockBalances)
        .where(eq(schema.stockBalances.productId, p.id));
      if (!dec(stock!.qty).isZero()) throw conflict("PRODUCT_HAS_STOCK", { qty: stock!.qty });
      // History (invoices, ledger) keeps pointing at the row; barcodes are freed for reuse.
      await tx.delete(schema.productBarcodes).where(eq(schema.productBarcodes.productId, p.id));
      await tx
        .update(schema.products)
        .set({ deletedAt: deps.clock.now().toISOString(), deletedBy: ctx.userId, isActive: false })
        .where(eq(schema.products.id, p.id));
      await audit(tx, ctx, { action: "product.deleted", entityType: "product", entityId: p.id, entityLabel: `${p.code} ${p.name}` });
    });
    return reply.code(204).send();
  });

  /**
   * Everything a device needs to search and bill offline: products with their
   * barcodes, units, prices and stock, plus tax categories and rate lists.
   */
  r.get("/catalog", { preHandler: guard(deps, "product.view"), schema: { tags: ["catalog"] } }, async (request, reply) => {
    const ctx = request.ctx;
    const showCost = can(ctx, "product.view_cost");
    const body = await tenant(ctx, async (tx) => {
      const products = await tx
        .select()
        .from(schema.products)
        .where(and(eq(schema.products.businessId, ctx.businessId), isNull(schema.products.deletedAt)))
        .orderBy(asc(schema.products.name));
      const ids = products.map((p) => p.id);
      const [barcodes, units, prices, stock, taxCategories, priceLevels, unitList, brands, categories] = await inSequence([
        () => ids.length ? tx.select().from(schema.productBarcodes).where(inArray(schema.productBarcodes.productId, ids)) : [],
        () => ids.length ? tx.select().from(schema.productUnits).where(inArray(schema.productUnits.productId, ids)) : [],
        () => ids.length ? tx.select().from(schema.productPrices).where(inArray(schema.productPrices.productId, ids)) : [],
        () => tx
          .select({ productId: schema.stockBalances.productId, qty: sql<string>`sum(${schema.stockBalances.qty})::text` })
          .from(schema.stockBalances)
          .where(eq(schema.stockBalances.businessId, ctx.businessId))
          .groupBy(schema.stockBalances.productId),
        () => listTaxCategories(tx, ctx.businessId),
        () => tx.select().from(schema.priceLevels).where(eq(schema.priceLevels.businessId, ctx.businessId)),
        () => tx.select().from(schema.units).where(eq(schema.units.businessId, ctx.businessId)),
        () => tx.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(and(eq(schema.brands.businessId, ctx.businessId), isNull(schema.brands.deletedAt))),
        () => tx
          .select({ id: schema.productCategories.id, name: schema.productCategories.name, parentId: schema.productCategories.parentId })
          .from(schema.productCategories)
          .where(and(eq(schema.productCategories.businessId, ctx.businessId), isNull(schema.productCategories.deletedAt))),
      ]);
      const group = <T extends { productId: string }>(rows: T[]) => {
        const m = new Map<string, T[]>();
        for (const row of rows) m.set(row.productId, [...(m.get(row.productId) ?? []), row]);
        return m;
      };
      const [byBarcode, byUnit, byPrice] = [group(barcodes), group(units), group(prices)];
      const stockOf = new Map(stock.map((s) => [s.productId, s.qty]));
      return {
        generatedAt: deps.clock.now().toISOString(),
        products: products.map((p) => ({
          ...productOut(p, showCost),
          barcodes: (byBarcode.get(p.id) ?? []).map((b) => ({ barcode: b.barcode, unitId: b.unitId })),
          units: (byUnit.get(p.id) ?? []).map((u) => ({ unitId: u.unitId, conversionFactor: u.conversionFactor, isDefaultSale: u.isDefaultSale })),
          prices: (byPrice.get(p.id) ?? []).map((x) => ({ priceLevelId: x.priceLevelId, unitId: x.unitId, price: x.price, discountPercent: x.discountPercent })),
          stock: stockOf.get(p.id) ?? "0",
        })),
        taxCategories,
        priceLevels,
        units: unitList,
        brands,
        categories,
      };
    });
    reply.header("cache-control", "private, no-store");
    return body;
  });
};
