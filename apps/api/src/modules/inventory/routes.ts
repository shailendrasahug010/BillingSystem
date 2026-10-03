import { AdjustmentBody, StockLedgerQuery, StockQuery, TransferBody } from "@digitalbahi/contracts";
import { dec, toQtyString, type StockMovementType } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { getSetting } from "../../services/settings.js";
import { postStockMovement } from "../../services/stock.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";

/** Removal reasons map to their own movement types so reports can tell damage from theft. */
const OUT_TYPE: Record<string, StockMovementType> = { damage: "damaged", expiry: "expired", internal_use: "consumption", sample: "free_out" };

export const inventoryModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** Stock position per product (optionally one godown), with value for roles allowed to see it. */
  r.get("/stock", { preHandler: guard(deps, "inventory.view"), schema: { tags: ["inventory"], querystring: StockQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const showValue = can(ctx, "inventory.view_value");
    const where: SQL[] = [sql`p.business_id = ${ctx.businessId}`, sql`p.deleted_at is null`, sql`p.is_active`];
    if (q.q) where.push(sql`(p.name ilike ${likeContains(q.q)} or p.code ilike ${likeContains(q.q)})`);
    if (q.level === "low") where.push(sql`p.min_stock is not null and coalesce(st.qty, 0) <= p.min_stock and coalesce(st.qty, 0) > 0`);
    if (q.level === "out") where.push(sql`coalesce(st.qty, 0) <= 0`);
    if (cursor) where.push(sql`(p.name, p.id) > (${String(cursor.v)}, ${cursor.id}::uuid)`);
    const wh = q.warehouseId ? sql`and sb.warehouse_id = ${q.warehouseId}` : sql``;
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{ id: string; code: string; name: string; unit: string; qty: string; min_stock: string | null; reorder_qty: string | null; avg_cost: string }>(sql`
          select p.id, p.code, p.name, u.symbol as unit, coalesce(st.qty, 0)::text as qty, p.min_stock::text, p.reorder_qty::text, p.avg_cost::text
          from products p
          join units u on u.id = p.base_unit_id
          left join lateral (select sum(sb.qty) as qty from stock_balances sb where sb.product_id = p.id ${wh}) st on true
          where ${sql.join(where, sql` and `)}
          order by p.name, p.id
          limit ${q.limit + 1}`)
      ).rows,
    );
    const data = rows.map((x) => ({
      productId: x.id,
      code: x.code,
      name: x.name,
      unit: x.unit,
      qty: x.qty,
      minStock: x.min_stock,
      reorderQty: x.reorder_qty,
      level: dec(x.qty).lte(0) ? "out" : x.min_stock && dec(x.qty).lte(x.min_stock) ? "low" : "ok",
      ...(showValue ? { avgCost: x.avg_cost, value: dec(x.qty).gt(0) ? dec(x.qty).times(x.avg_cost).toFixed(2) : "0.00" } : {}),
    }));
    return page(data, q.limit, (x) => ({ v: x.name, id: x.productId }));
  });

  /** Every movement of a product: date | document | in | out | balance. */
  r.get("/stock/ledger", { preHandler: guard(deps, "inventory.view"), schema: { tags: ["inventory"], querystring: StockLedgerQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    return tenant(ctx, async (tx) => {
      const [product] = await tx
        .select({ id: schema.products.id, name: schema.products.name, code: schema.products.code })
        .from(schema.products)
        .where(and(eq(schema.products.id, q.productId), eq(schema.products.businessId, ctx.businessId)));
      if (!product) throw badRequest("REFERENCE_NOT_FOUND", {}, "productId");
      const scope: SQL[] = [sql`business_id = ${ctx.businessId}`, sql`product_id = ${q.productId}`];
      if (q.warehouseId) scope.push(sql`warehouse_id = ${q.warehouseId}`);
      const [opening] = (
        await tx.execute<{ qty: string }>(sql`
          select coalesce(sum(qty_in - qty_out), 0)::text as qty from stock_ledger
          where ${sql.join(scope, sql` and `)} ${q.from ? sql`and txn_date < ${q.from}` : sql`and false`}`)
      ).rows;
      const rows = (
        await tx.execute<{
          id: number;
          txn_date: string;
          movement_type: string;
          qty_in: string;
          qty_out: string;
          ref_type: string;
          ref_id: string | null;
          ref_number: string | null;
          reason: string | null;
          warehouse_id: string;
          batch_id: string | null;
          unit_cost: string;
        }>(sql`
          select id, txn_date::text, movement_type, qty_in::text, qty_out::text, ref_type, ref_id, ref_number, reason, warehouse_id, batch_id, unit_cost::text
          from stock_ledger
          where ${sql.join(scope, sql` and `)} ${q.from ? sql`and txn_date >= ${q.from}` : sql``} ${q.to ? sql`and txn_date <= ${q.to}` : sql``}
          order by txn_date, id
          limit ${q.limit}`)
      ).rows;
      let running = dec(opening!.qty);
      const showCost = can(ctx, "product.view_cost");
      return {
        product,
        opening: running.toFixed(3),
        entries: rows.map((e) => {
          running = running.plus(e.qty_in).minus(e.qty_out);
          return {
            id: e.id,
            date: e.txn_date,
            type: e.movement_type,
            qtyIn: e.qty_in,
            qtyOut: e.qty_out,
            balance: running.toFixed(3),
            refType: e.ref_type,
            refId: e.ref_id,
            refNumber: e.ref_number,
            reason: e.reason,
            warehouseId: e.warehouse_id,
            batchId: e.batch_id,
            ...(showCost ? { unitCost: e.unit_cost } : {}),
          };
        }),
        closing: running.toFixed(3),
      };
    });
  });

  /**
   * Physical count corrections, damage, expiry, theft... never a direct edit
   * of the balance: a numbered adjustment whose lines become ledger rows.
   */
  r.post("/stock/adjustments", { preHandler: guard(deps, "inventory.adjust"), schema: { tags: ["inventory"], body: AdjustmentBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const result = await tenant(ctx, async (tx) => {
      const today = deps.clock.today(ctx.timeZone);
      const date = body.adjustmentDate ?? today;
      if (date > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "adjustmentDate");
      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const [wh] = await tx
        .select({ id: schema.warehouses.id })
        .from(schema.warehouses)
        .where(
          and(
            eq(schema.warehouses.businessId, ctx.businessId),
            isNull(schema.warehouses.deletedAt),
            body.warehouseId ? eq(schema.warehouses.id, body.warehouseId) : eq(schema.warehouses.isDefault, true),
          ),
        );
      if (!wh) throw body.warehouseId ? badRequest("REFERENCE_NOT_FOUND", {}, "warehouseId") : new ApiError(409, "NO_DEFAULT_WAREHOUSE");
      const productIds = [...new Set(body.lines.map((l) => l.productId))];
      const products = await tx
        .select()
        .from(schema.products)
        .where(and(eq(schema.products.businessId, ctx.businessId), inArray(schema.products.id, productIds), isNull(schema.products.deletedAt)));
      const byId = new Map(products.map((p) => [p.id, p]));
      body.lines.forEach((l, i) => {
        if (!byId.has(l.productId)) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
        if (dec(l.qtyChange).isZero()) throw badRequest("QTY_NOT_POSITIVE", {}, `lines[${i}].qtyChange`);
        if (dec(l.qtyChange).gt(0) && body.reason !== "count_correction" && body.reason !== "other") {
          throw badRequest("ADJUSTMENT_DIRECTION_INVALID", { reason: body.reason }, `lines[${i}].qtyChange`);
        }
      });
      const numbering = await nextDocumentNumber(tx, ctx.businessId, "adjustment", date, business!.financialYearStartMonth);
      const id = uuidv7();
      await tx.insert(schema.stockAdjustments).values({
        id,
        businessId: ctx.businessId,
        adjustmentNumber: numbering.number,
        adjustmentDate: date,
        warehouseId: wh.id,
        reason: body.reason,
        notes: body.notes ?? null,
        status: "posted",
        approvedBy: ctx.userId,
        postedAt: deps.clock.now().toISOString(),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      const policy = await getSetting(tx, ctx.businessId, "stock.negative_policy");
      const lines = [];
      for (const l of [...body.lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
        const product = byId.get(l.productId)!;
        const change = dec(l.qtyChange);
        const itemId = uuidv7();
        const [system] = await tx
          .select({ qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)::text` })
          .from(schema.stockBalances)
          .where(and(eq(schema.stockBalances.productId, product.id), eq(schema.stockBalances.warehouseId, wh.id)));
        await tx.insert(schema.stockAdjustmentItems).values({
          id: itemId,
          businessId: ctx.businessId,
          adjustmentId: id,
          productId: product.id,
          batchId: l.batchId ?? null,
          qtyChange: toQtyString(change),
          systemQty: system!.qty,
          unitCost: product.avgCost,
          note: l.note ?? null,
        });
        const type: StockMovementType = change.gt(0) ? "adjustment_in" : (OUT_TYPE[body.reason] ?? "adjustment_out");
        const moved = await postStockMovement(
          tx,
          {
            businessId: ctx.businessId,
            productId: product.id,
            productName: product.name,
            warehouseId: wh.id,
            batchId: l.batchId ?? null,
            date,
            type,
            qty: toQtyString(change.abs()),
            // Valued at the current average cost (which therefore does not move).
            unitCost: product.avgCost,
            refType: "adjustment",
            refId: id,
            refLineId: itemId,
            refNumber: numbering.number,
            reason: l.note ?? body.reason,
            userId: ctx.userId,
          },
          policy,
        );
        lines.push({ productId: product.id, name: product.name, change: toQtyString(change), before: system!.qty, after: moved.balanceAfter });
      }
      await audit(tx, ctx, {
        action: "stock.adjusted",
        entityType: "stock_adjustment",
        entityId: id,
        entityLabel: numbering.number,
        changes: { reason: body.reason, lines: lines.map((l) => [l.name, l.change]) },
      });
      return { id, adjustmentNumber: numbering.number, adjustmentDate: date, warehouseId: wh.id, reason: body.reason, lines };
    });
    return reply.code(201).send(result);
  });

  r.get("/stock/adjustments", { preHandler: guard(deps, "inventory.view"), schema: { tags: ["inventory"] } }, async (request) => {
    const ctx = request.ctx;
    return {
      data: await tenant(ctx, (tx) =>
        tx
          .select()
          .from(schema.stockAdjustments)
          .where(eq(schema.stockAdjustments.businessId, ctx.businessId))
          .orderBy(sql`${schema.stockAdjustments.adjustmentDate} desc, ${schema.stockAdjustments.id} desc`)
          .limit(100),
      ),
    };
  });

  /**
   * Moves stock between godowns in one transaction: out of the source and
   * into the destination at the current average cost (so the average does
   * not move), numbered like other documents.
   */
  r.post("/stock/transfers", { preHandler: guard(deps, "inventory.transfer"), schema: { tags: ["inventory"], body: TransferBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    if (body.fromWarehouseId === body.toWarehouseId) throw badRequest("TRANSFER_SAME_GODOWN", {}, "toWarehouseId");
    const result = await tenant(ctx, async (tx) => {
      const today = deps.clock.today(ctx.timeZone);
      const date = body.transferDate ?? today;
      if (date > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "transferDate");
      const godowns = await tx
        .select({ id: schema.warehouses.id, name: schema.warehouses.name, isActive: schema.warehouses.isActive })
        .from(schema.warehouses)
        .where(and(eq(schema.warehouses.businessId, ctx.businessId), inArray(schema.warehouses.id, [body.fromWarehouseId, body.toWarehouseId]), isNull(schema.warehouses.deletedAt)));
      const from = godowns.find((g) => g.id === body.fromWarehouseId);
      const to = godowns.find((g) => g.id === body.toWarehouseId);
      if (!from) throw badRequest("REFERENCE_NOT_FOUND", {}, "fromWarehouseId");
      if (!to) throw badRequest("REFERENCE_NOT_FOUND", {}, "toWarehouseId");
      if (!to.isActive) throw conflict("GODOWN_INACTIVE", { godown: to.name }, "toWarehouseId");

      const quantities = new Map<string, ReturnType<typeof dec>>();
      body.lines.forEach((l, i) => {
        if (dec(l.qty).lte(0)) throw badRequest("QTY_NOT_POSITIVE", {}, `lines[${i}].qty`);
        const key = `${l.productId}|${l.batchId ?? ""}`;
        quantities.set(key, (quantities.get(key) ?? dec(0)).plus(l.qty));
      });
      const productIds = [...new Set(body.lines.map((l) => l.productId))];
      const products = await tx
        .select({ id: schema.products.id, name: schema.products.name, avgCost: schema.products.avgCost })
        .from(schema.products)
        .where(and(eq(schema.products.businessId, ctx.businessId), inArray(schema.products.id, productIds), isNull(schema.products.deletedAt)));
      const byId = new Map(products.map((p) => [p.id, p]));
      body.lines.forEach((l, i) => {
        if (!byId.has(l.productId)) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
      });

      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const numbering = await nextDocumentNumber(tx, ctx.businessId, "stock_transfer", date, business!.financialYearStartMonth, { name: "Stock transfer", pattern: "STR/{FYS}/{SEQ:5}" });
      const policy = await getSetting(tx, ctx.businessId, "stock.negative_policy");
      const id = uuidv7();
      const now = deps.clock.now().toISOString();
      await tx.insert(schema.stockTransfers).values({
        id,
        businessId: ctx.businessId,
        transferNumber: numbering.number,
        transferDate: date,
        fromWarehouseId: from.id,
        toWarehouseId: to.id,
        status: "received",
        notes: body.notes ?? null,
        receivedAt: now,
        receivedBy: ctx.userId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      const lines = [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b));
      const out: Array<{ productId: string; name: string; qty: string; fromAfter: string; toAfter: string }> = [];
      for (const [key, qty] of lines) {
        const [productId, batchId] = key.split("|") as [string, string];
        const product = byId.get(productId)!;
        const itemId = uuidv7();
        await tx.insert(schema.stockTransferItems).values({ id: itemId, businessId: ctx.businessId, transferId: id, productId, batchId: batchId || null, qty: toQtyString(qty), receivedQty: toQtyString(qty) });
        const common = {
          businessId: ctx.businessId,
          productId,
          productName: product.name,
          batchId: batchId || null,
          date,
          qty: toQtyString(qty),
          unitCost: product.avgCost,
          refType: "stock_transfer",
          refId: id,
          refLineId: itemId,
          refNumber: numbering.number,
          reason: body.notes ?? null,
          userId: ctx.userId,
        };
        const moved = await postStockMovement(tx, { ...common, warehouseId: from.id, type: "transfer_out" }, policy);
        const arrived = await postStockMovement(tx, { ...common, warehouseId: to.id, type: "transfer_in" }, "allow");
        out.push({ productId, name: product.name, qty: toQtyString(qty), fromAfter: moved.balanceAfter, toAfter: arrived.balanceAfter });
      }
      await audit(tx, ctx, {
        action: "stock.transferred",
        entityType: "stock_transfer",
        entityId: id,
        entityLabel: numbering.number,
        changes: { from: from.name, to: to.name, lines: out.map((l) => [l.name, l.qty]) },
      });
      return { id, transferNumber: numbering.number, transferDate: date, from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, lines: out };
    });
    return reply.code(201).send(result);
  });

  r.get("/stock/transfers", { preHandler: guard(deps, "inventory.view"), schema: { tags: ["inventory"] } }, async (request) => {
    const ctx = request.ctx;
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{ id: string; transfer_number: string; transfer_date: string; from_name: string; to_name: string; notes: string | null; lines: number; qty: string }>(sql`
          select t.id, t.transfer_number, t.transfer_date::text, f.name as from_name, w.name as to_name, t.notes,
                 (select count(*)::int from stock_transfer_items i where i.transfer_id = t.id) as lines,
                 (select coalesce(sum(i.qty), 0)::text from stock_transfer_items i where i.transfer_id = t.id) as qty
          from stock_transfers t
          join warehouses f on f.id = t.from_warehouse_id
          join warehouses w on w.id = t.to_warehouse_id
          where t.business_id = ${ctx.businessId}
          order by t.transfer_date desc, t.id desc
          limit 100`)
      ).rows,
    );
    return {
      data: rows.map((x) => ({ id: x.id, transferNumber: x.transfer_number, transferDate: x.transfer_date, from: x.from_name, to: x.to_name, notes: x.notes, lines: x.lines, qty: x.qty })),
    };
  });
};
