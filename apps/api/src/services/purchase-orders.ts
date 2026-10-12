import { dec, orderStatusFromLines, toQtyString, type Dec } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { badRequest, conflict } from "../lib/errors.js";

/**
 * Purchase orders and the goods received against them. Received quantities
 * live on the order lines (base units, bought and free together); goods
 * receipts and bills that bring goods add to them, and take them back when
 * cancelled. An order's status follows its lines unless it was closed or
 * cancelled by hand.
 */

/** Orders goods may still be received against. */
export const RECEIVABLE = new Set(["open", "partly_received"]);

/** Order lines with their orders, locked (orders in id order) for goods to be received against them. */
export async function lockOrderLines(tx: Tx, businessId: string, itemIds: readonly string[]) {
  if (!itemIds.length) return [];
  const poi = schema.purchaseOrderItems;
  const po = schema.purchaseOrders;
  const items = await tx
    .select({
      id: poi.id,
      purchaseOrderId: poi.purchaseOrderId,
      productId: poi.productId,
      unitId: poi.unitId,
      conversionFactor: poi.conversionFactor,
      qty: poi.qty,
      freeQty: poi.freeQty,
      rate: poi.rate,
      discountPercent: poi.discountPercent,
      receivedQty: poi.receivedQty,
    })
    .from(poi)
    .where(and(eq(poi.businessId, businessId), inArray(poi.id, [...new Set(itemIds)])));
  const orderIds = [...new Set(items.map((i) => i.purchaseOrderId))].sort();
  const orders = orderIds.length
    ? await tx
        .select({ id: po.id, orderNumber: po.orderNumber, supplierId: po.supplierId, warehouseId: po.warehouseId, status: po.status })
        .from(po)
        .where(and(eq(po.businessId, businessId), inArray(po.id, orderIds)))
        .orderBy(asc(po.id))
        .for("update")
    : [];
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  return items.map((i) => ({ ...i, order: byOrder.get(i.purchaseOrderId)! }));
}

/** An order goods are received against must be open (not received in full, closed or cancelled). */
export function assertReceivable(order: { orderNumber: string; status: string }, field: string) {
  if (!RECEIVABLE.has(order.status)) throw conflict("PURCHASE_ORDER_NOT_OPEN", { number: order.orderNumber, status: order.status }, field);
}

/** Adds (or, negative, takes back) base units received on order lines, then moves their orders' status. */
export async function receiveOnOrderLines(tx: Tx, businessId: string, moves: ReadonlyArray<{ itemId: string; base: Dec }>): Promise<void> {
  const byItem = new Map<string, Dec>();
  for (const m of moves) if (!m.base.isZero()) byItem.set(m.itemId, (byItem.get(m.itemId) ?? dec(0)).plus(m.base));
  if (!byItem.size) return;
  const poi = schema.purchaseOrderItems;
  const lines = await lockOrderLines(tx, businessId, [...byItem.keys()]);
  for (const line of [...lines].sort((a, b) => a.id.localeCompare(b.id))) {
    const next = dec(line.receivedQty).plus(byItem.get(line.id)!);
    await tx
      .update(poi)
      .set({ receivedQty: toQtyString(next.gt(0) ? next : 0) })
      .where(eq(poi.id, line.id));
  }
  await refreshOrderStatus(tx, [...new Set(lines.map((l) => l.purchaseOrderId))]);
}

/** Sets open / partly received / received from the lines (orders closed or cancelled by hand stay so). */
export async function refreshOrderStatus(tx: Tx, orderIds: readonly string[]): Promise<void> {
  const po = schema.purchaseOrders;
  const poi = schema.purchaseOrderItems;
  for (const id of orderIds) {
    const [order] = await tx.select({ status: po.status }).from(po).where(eq(po.id, id));
    if (!order || order.status === "closed" || order.status === "cancelled") continue;
    const lines = await tx.select({ qty: poi.qty, freeQty: poi.freeQty, conversionFactor: poi.conversionFactor, receivedQty: poi.receivedQty }).from(poi).where(eq(poi.purchaseOrderId, id));
    const status = orderStatusFromLines(lines);
    if (status !== order.status) {
      await tx
        .update(po)
        .set({ status, updatedAt: sql`now()`, version: sql`${po.version} + 1` })
        .where(eq(po.id, id));
    }
  }
}

/**
 * The goods receipts a bill is made from, locked: each the supplier's, not
 * billed or cancelled, and on the bill in full (every line once). Returns the
 * receipts and their lines by id.
 */
export async function lockReceiptsForBill(tx: Tx, businessId: string, supplierId: string, itemIds: readonly string[]) {
  const gi = schema.goodsReceiptItems;
  const gr = schema.goodsReceipts;
  if (!itemIds.length) return { receipts: [] as Array<typeof gr.$inferSelect>, items: new Map<string, typeof gi.$inferSelect>() };
  const unique = [...new Set(itemIds)];
  const items = await tx.select().from(gi).where(and(eq(gi.businessId, businessId), inArray(gi.id, unique)));
  if (items.length !== unique.length) throw badRequest("REFERENCE_NOT_FOUND", {}, "lines");
  const receiptIds = [...new Set(items.map((i) => i.goodsReceiptId))].sort();
  const receipts = await tx
    .select()
    .from(gr)
    .where(and(eq(gr.businessId, businessId), inArray(gr.id, receiptIds)))
    .orderBy(asc(gr.id))
    .for("update");
  for (const g of receipts) {
    if (g.supplierId !== supplierId) throw badRequest("RECEIPT_OTHER_SUPPLIER", { number: g.receiptNumber }, "lines");
    if (g.status === "billed") throw conflict("GOODS_RECEIPT_BILLED", { number: g.receiptNumber });
    if (g.status === "cancelled") throw conflict("GOODS_RECEIPT_CANCELLED", { number: g.receiptNumber });
  }
  const all = await tx.select({ id: gi.id, goodsReceiptId: gi.goodsReceiptId }).from(gi).where(inArray(gi.goodsReceiptId, receiptIds));
  const onBill = new Set(unique);
  for (const g of receipts) {
    if (all.some((x) => x.goodsReceiptId === g.id && !onBill.has(x.id))) throw badRequest("RECEIPT_NOT_WHOLE", { number: g.receiptNumber }, "lines");
  }
  return { receipts, items: new Map(items.map((i) => [i.id, i])) };
}
