import { CancelBody, GoodsReceiptBody, GoodsReceiptListQuery, type GoodsReceiptRow, type GoodsReceiptStatus, type GoodsReceiptView } from "@digitalbahi/contracts";
import { dec, receivedUnitCost, toAmountString, toQtyString, toRateString } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { lockIdempotencyKey, withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { assertReceivable, lockOrderLines, receiveOnOrderLines } from "../../services/purchase-orders.js";
import { getSetting } from "../../services/settings.js";
import { postStockMovement } from "../../services/stock.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";
import { godownOf, productsOfLines, purchaseOrderView, supplierOf } from "./orders.js";

const IdParams = z.object({ id: z.uuid() });
export const GOODS_RECEIPT_SERIES = { name: "Goods receipt", pattern: "GRN/{FYS}/{SEQ:5}" };

/** A receipt with its lines, its order's number and the bill it was billed in. */
export async function goodsReceiptView(tx: Tx, businessId: string, id: string): Promise<GoodsReceiptView> {
  const gr = schema.goodsReceipts;
  const [g] = await tx.select().from(gr).where(and(eq(gr.id, id), eq(gr.businessId, businessId)));
  if (!g) throw notFound("goods_receipt");
  const items = await tx.select().from(schema.goodsReceiptItems).where(eq(schema.goodsReceiptItems.goodsReceiptId, id)).orderBy(asc(schema.goodsReceiptItems.lineNo));
  const [order] = g.purchaseOrderId
    ? await tx.select({ orderNumber: schema.purchaseOrders.orderNumber }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, g.purchaseOrderId))
    : [];
  const [bill] = g.purchaseId
    ? await tx
        .select({ id: schema.purchases.id, purchaseNumber: schema.purchases.purchaseNumber, supplierInvoiceNumber: schema.purchases.supplierInvoiceNumber })
        .from(schema.purchases)
        .where(eq(schema.purchases.id, g.purchaseId))
    : [];
  return {
    id: g.id,
    receiptNumber: g.receiptNumber,
    receivedDate: g.receivedDate,
    supplierId: g.supplierId,
    partyName: g.partyName,
    purchaseOrderId: g.purchaseOrderId,
    orderNumber: order?.orderNumber ?? null,
    warehouseId: g.warehouseId,
    challanNumber: g.challanNumber,
    status: g.status,
    totalValue: g.totalValue,
    notes: g.notes,
    cancelledAt: g.cancelledAt,
    cancelReason: g.cancelReason,
    createdAt: g.createdAt,
    purchase: bill ?? null,
    items: items.map((i) => ({
      id: i.id,
      lineNo: i.lineNo,
      productId: i.productId,
      productName: i.productName,
      unitId: i.unitId,
      conversionFactor: i.conversionFactor,
      qty: i.qty,
      freeQty: i.freeQty,
      rate: i.rate,
      discountPercent: i.discountPercent,
      unitCost: i.unitCost,
      purchaseOrderItemId: i.purchaseOrderItemId,
      batchId: i.batchId,
      batchNumber: i.batchNumber,
      mfgDate: i.mfgDate,
      expiryDate: i.expiryDate,
      mrp: i.mrp,
    })),
  };
}

/**
 * Goods received before their bill: the stock comes in at once at the
 * expected cost, counts against the order it came for, and waits for the
 * supplier's bill, which sets its cost. Cancelling one that is not billed
 * takes the goods out again.
 */
export const goodsReceiptsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.post("/goods-receipts", { preHandler: guard(deps, "purchase.receive"), schema: { tags: ["purchases"], body: GoodsReceiptBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        await lockIdempotencyKey(tx, clientId);
        const [existing] = await tx
          .select({ id: schema.goodsReceipts.id })
          .from(schema.goodsReceipts)
          .where(and(eq(schema.goodsReceipts.businessId, ctx.businessId), eq(schema.goodsReceipts.clientId, clientId)));
        if (existing) return { replay: true, view: await goodsReceiptView(tx, ctx.businessId, existing.id) };
      }
      const today = deps.clock.today(ctx.timeZone);
      const receivedDate = body.receivedDate ?? today;
      if (receivedDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "receivedDate");
      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const supplier = await supplierOf(tx, ctx.businessId, body.supplierId);

      // The order the goods came for, and its lines named on the receipt.
      let order: { id: string; orderNumber: string; supplierId: string; warehouseId: string; status: string } | null = null;
      if (body.purchaseOrderId) {
        const po = schema.purchaseOrders;
        const [o] = await tx
          .select({ id: po.id, orderNumber: po.orderNumber, supplierId: po.supplierId, warehouseId: po.warehouseId, status: po.status })
          .from(po)
          .where(and(eq(po.id, body.purchaseOrderId), eq(po.businessId, ctx.businessId)))
          .for("update");
        if (!o) throw badRequest("REFERENCE_NOT_FOUND", {}, "purchaseOrderId");
        if (o.supplierId !== supplier.id) throw badRequest("ORDER_OTHER_SUPPLIER", { number: o.orderNumber }, "purchaseOrderId");
        assertReceivable(o, "purchaseOrderId");
        order = o;
      }
      const orderLines = await lockOrderLines(
        tx,
        ctx.businessId,
        body.lines.flatMap((l) => (l.purchaseOrderItemId ? [l.purchaseOrderItemId] : [])),
      );
      const orderLineOf = body.lines.map((l, i) => {
        if (!l.purchaseOrderItemId) return null;
        const line = orderLines.find((x) => x.id === l.purchaseOrderItemId);
        if (!line || !order || line.purchaseOrderId !== order.id) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].purchaseOrderItemId`);
        if (line.productId !== l.productId) throw badRequest("ORDER_LINE_OTHER_PRODUCT", {}, `lines[${i}].productId`);
        return line;
      });

      const wh = await godownOf(tx, ctx.businessId, body.warehouseId ?? order?.warehouseId);
      const meta = await productsOfLines(tx, ctx.businessId, body.lines);
      body.lines.forEach((line, i) => {
        const p = meta[i]!.product;
        if (p.trackBatches && !line.batchNumber) throw badRequest("BATCH_REQUIRED", { product: p.name }, `lines[${i}].batchNumber`);
        if (p.trackExpiry && !line.expiryDate) throw badRequest("EXPIRY_REQUIRED", { product: p.name }, `lines[${i}].expiryDate`);
      });
      // Expected rate per unit of the line's unit: as given, else the order line's, else the last purchase rate.
      const priced = body.lines.map((line, i) => {
        const m = meta[i]!;
        const ordered = orderLineOf[i];
        const rate = line.rate
          ? dec(line.rate)
          : ordered
            ? dec(ordered.rate).dividedBy(ordered.conversionFactor).times(m.factor)
            : dec(m.product.purchasePrice).times(m.factor);
        const discountPercent = line.discountPercent ?? ordered?.discountPercent ?? "0";
        const unitCost = receivedUnitCost({ qty: line.qty, freeQty: line.freeQty, conversionFactor: m.factor, rate, discountPercent });
        const base = dec(line.qty).plus(line.freeQty).times(m.factor);
        const value = dec(line.qty).times(rate).times(dec(100).minus(discountPercent)).dividedBy(100);
        return { rate, discountPercent, unitCost, base, value };
      });

      const numbering = await nextDocumentNumber(tx, ctx.businessId, "goods_receipt", receivedDate, business!.financialYearStartMonth, GOODS_RECEIPT_SERIES);
      const id = uuidv7();
      const totalValue = priced.reduce((acc, x) => acc.plus(x.value), dec(0));
      await tx.insert(schema.goodsReceipts).values({
        id,
        businessId: ctx.businessId,
        receiptNumber: numbering.number,
        seriesId: numbering.seriesId,
        financialYear: numbering.financialYear,
        receivedDate,
        supplierId: supplier.id,
        partyName: supplier.companyName ?? supplier.name,
        purchaseOrderId: order?.id ?? null,
        warehouseId: wh.id,
        challanNumber: body.challanNumber ?? null,
        status: "received",
        totalValue: toAmountString(totalValue),
        notes: body.notes ?? null,
        clientId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

      const items: Array<{ id: string; productId: string; productName: string; batchId: string | null; base: ReturnType<typeof dec>; unitCost: string }> = [];
      for (const [i, line] of body.lines.entries()) {
        const m = meta[i]!;
        const pr = priced[i]!;
        let batchId: string | null = null;
        if (line.batchNumber) {
          await tx
            .insert(schema.batches)
            .values({
              id: uuidv7(),
              businessId: ctx.businessId,
              productId: m.product.id,
              batchNumber: line.batchNumber,
              mfgDate: line.mfgDate ?? null,
              expiryDate: line.expiryDate ?? null,
              mrp: line.mrp ?? null,
              purchaseRate: toRateString(pr.rate.dividedBy(m.factor)),
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            })
            .onConflictDoNothing();
          const [batch] = await tx
            .select({ id: schema.batches.id })
            .from(schema.batches)
            .where(and(eq(schema.batches.productId, m.product.id), eq(schema.batches.batchNumber, line.batchNumber)));
          batchId = batch!.id;
        }
        const itemId = uuidv7();
        await tx.insert(schema.goodsReceiptItems).values({
          id: itemId,
          businessId: ctx.businessId,
          goodsReceiptId: id,
          lineNo: i + 1,
          productId: m.product.id,
          productName: m.product.name,
          unitId: m.unitId,
          conversionFactor: m.factor,
          qty: line.qty,
          freeQty: line.freeQty,
          qtyBase: toQtyString(dec(line.qty).times(m.factor)),
          rate: toRateString(pr.rate),
          discountPercent: pr.discountPercent,
          unitCost: toRateString(pr.unitCost),
          purchaseOrderItemId: line.purchaseOrderItemId ?? null,
          batchId,
          batchNumber: line.batchNumber ?? null,
          mfgDate: line.mfgDate ?? null,
          expiryDate: line.expiryDate ?? null,
          mrp: line.mrp ?? null,
        });
        items.push({ id: itemId, productId: m.product.id, productName: m.product.name, batchId, base: pr.base, unitCost: toRateString(pr.unitCost) });
      }

      // Stock in at the expected cost (product order, as everywhere stock is locked).
      for (const it of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
        await postStockMovement(
          tx,
          {
            businessId: ctx.businessId,
            productId: it.productId,
            productName: it.productName,
            warehouseId: wh.id,
            batchId: it.batchId,
            date: receivedDate,
            type: "purchase",
            qty: toQtyString(it.base),
            unitCost: it.unitCost,
            refType: "goods_receipt",
            refId: id,
            refLineId: it.id,
            refNumber: numbering.number,
            userId: ctx.userId,
          },
          "allow",
        );
      }
      await receiveOnOrderLines(
        tx,
        ctx.businessId,
        body.lines.flatMap((l, i) => (l.purchaseOrderItemId ? [{ itemId: l.purchaseOrderItemId, base: priced[i]!.base }] : [])),
      );
      await audit(tx, ctx, {
        action: "goods_receipt.posted",
        entityType: "goods_receipt",
        entityId: id,
        entityLabel: numbering.number,
        changes: { supplier: supplier.name, order: order?.orderNumber ?? null, lines: body.lines.length, value: toAmountString(totalValue) },
      });
      return { replay: false, view: await goodsReceiptView(tx, ctx.businessId, id) };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.view);
  });

  r.get("/goods-receipts", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], querystring: GoodsReceiptListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [sql`g.business_id = ${ctx.businessId}`];
    if (q.supplierId) where.push(sql`g.supplier_id = ${q.supplierId}`);
    if (q.status !== "all") where.push(sql`g.status = ${q.status}`);
    if (q.from) where.push(sql`g.received_date >= ${q.from}`);
    if (q.to) where.push(sql`g.received_date <= ${q.to}`);
    if (q.q) where.push(sql`(g.receipt_number ilike ${likeContains(q.q)} or g.party_name ilike ${likeContains(q.q)} or g.challan_number ilike ${likeContains(q.q)})`);
    if (cursor) where.push(sql`(g.received_date, g.id) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{ id: string; receipt_number: string; received_date: string; supplier_id: string; party_name: string; challan_number: string | null; status: GoodsReceiptStatus; total_value: string; order_number: string | null; lines: number }>(sql`
          select g.id, g.receipt_number, g.received_date::text, g.supplier_id, g.party_name, g.challan_number, g.status::text as status, g.total_value::text,
                 (select o.order_number from purchase_orders o where o.id = g.purchase_order_id) as order_number,
                 (select count(*)::int from goods_receipt_items i where i.goods_receipt_id = g.id) as lines
          from goods_receipts g
          where ${sql.join(where, sql` and `)}
          order by g.received_date desc, g.id desc
          limit ${q.limit + 1}`)
      ).rows,
    );
    const data = rows.map(
      (x): GoodsReceiptRow => ({
        id: x.id,
        receiptNumber: x.receipt_number,
        receivedDate: x.received_date,
        supplierId: x.supplier_id,
        partyName: x.party_name,
        challanNumber: x.challan_number,
        status: x.status,
        totalValue: x.total_value,
        orderNumber: x.order_number,
        lines: x.lines,
      }),
    );
    return page(data, q.limit, (x) => ({ v: x.receivedDate, id: x.id }));
  });

  r.get("/goods-receipts/:id", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => goodsReceiptView(tx, request.ctx.businessId, request.params.id)),
  );

  /** Goods received by mistake (or sent back before the bill): out of stock again, and off their order. */
  r.post("/goods-receipts/:id/cancel", { preHandler: guard(deps, "purchase.receive"), schema: { tags: ["purchases"], params: IdParams, body: CancelBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const gr = schema.goodsReceipts;
      const [g] = await tx.select().from(gr).where(and(eq(gr.id, request.params.id), eq(gr.businessId, ctx.businessId))).for("update");
      if (!g) throw notFound("goods_receipt");
      if (g.status === "billed") throw conflict("GOODS_RECEIPT_BILLED", { number: g.receiptNumber });
      if (g.status === "cancelled") throw conflict("GOODS_RECEIPT_CANCELLED", { number: g.receiptNumber });
      const policy = await getSetting(tx, ctx.businessId, "stock.negative_policy");
      const today = deps.clock.today(ctx.timeZone);
      const items = await tx.select().from(schema.goodsReceiptItems).where(eq(schema.goodsReceiptItems.goodsReceiptId, g.id));
      const warnings: Array<{ code: string; params: Record<string, string> }> = [];
      for (const item of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
        const moved = await postStockMovement(
          tx,
          {
            businessId: ctx.businessId,
            productId: item.productId,
            productName: item.productName,
            warehouseId: g.warehouseId,
            batchId: item.batchId,
            date: today,
            type: "purchase_return",
            qty: toQtyString(dec(item.qty).plus(item.freeQty).times(item.conversionFactor)),
            unitCost: item.unitCost,
            refType: "goods_receipt_cancel",
            refId: g.id,
            refLineId: item.id,
            refNumber: g.receiptNumber,
            reason: request.body.reason,
            userId: ctx.userId,
          },
          policy,
        );
        if (moved.warning) warnings.push({ code: "insufficient_stock", params: { product: item.productName, available: moved.warning.available.toString() } });
      }
      await receiveOnOrderLines(
        tx,
        ctx.businessId,
        items.flatMap((i) => (i.purchaseOrderItemId ? [{ itemId: i.purchaseOrderItemId, base: dec(i.qty).plus(i.freeQty).times(i.conversionFactor).negated() }] : [])),
      );
      await tx
        .update(gr)
        .set({ status: "cancelled", cancelledAt: deps.clock.now().toISOString(), cancelledBy: ctx.userId, cancelReason: request.body.reason, updatedBy: ctx.userId, version: g.version + 1 })
        .where(eq(gr.id, g.id));
      await audit(tx, ctx, { action: "goods_receipt.cancelled", entityType: "goods_receipt", entityId: g.id, entityLabel: g.receiptNumber, changes: { reason: request.body.reason } });
      return { ...(await goodsReceiptView(tx, ctx.businessId, g.id)), warnings };
    });
  });

  /** What a bill from this supplier can be made from: goods received and not billed, and orders still open. */
  r.get("/suppliers/:id/open-purchases", { preHandler: guard(deps, "purchase.create"), schema: { tags: ["purchases"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      await supplierOf(tx, ctx.businessId, request.params.id, "id");
      const gr = schema.goodsReceipts;
      const po = schema.purchaseOrders;
      const receiptIds = await tx
        .select({ id: gr.id })
        .from(gr)
        .where(and(eq(gr.businessId, ctx.businessId), eq(gr.supplierId, request.params.id), eq(gr.status, "received")))
        .orderBy(asc(gr.receivedDate), asc(gr.id))
        .limit(30);
      const orderIds = await tx
        .select({ id: po.id })
        .from(po)
        .where(and(eq(po.businessId, ctx.businessId), eq(po.supplierId, request.params.id), sql`${po.status} in ('open', 'partly_received')`))
        .orderBy(asc(po.orderDate), asc(po.id))
        .limit(20);
      const receipts = [];
      for (const { id } of receiptIds) receipts.push(await goodsReceiptView(tx, ctx.businessId, id));
      const orders = [];
      for (const { id } of orderIds) orders.push(await purchaseOrderView(tx, ctx.businessId, id));
      return { receipts, orders };
    });
  });
};
