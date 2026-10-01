import { allowedTransitions, DEFAULT_ORDER_WORKFLOW, type OrderStatus } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { eq } from "drizzle-orm";
import { audit } from "../lib/audit.js";
import type { RequestCtx } from "../lib/context.js";
import { getSetting } from "./settings.js";

/**
 * Moves a sales order forward as packing and dispatch happen, through each
 * step in `path` that the business's workflow allows (for example packed,
 * then dispatched). Steps not allowed from the current status are skipped;
 * an order already past them is left alone. Returns the final status.
 */
export async function advanceOrder(tx: Tx, ctx: RequestCtx, orderId: string, path: readonly OrderStatus[], note?: string): Promise<OrderStatus> {
  const [o] = await tx.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, orderId)).for("update");
  if (!o) return "cancelled";
  const workflow = { ...DEFAULT_ORDER_WORKFLOW, ...(await getSetting(tx, ctx.businessId, "orders.workflow")) };
  let status = o.status as OrderStatus;
  let version = o.version;
  for (const to of path) {
    if (status === to || !allowedTransitions(status, workflow).includes(to)) continue;
    version += 1;
    await tx.update(schema.salesOrders).set({ status: to, version, updatedBy: ctx.userId }).where(eq(schema.salesOrders.id, o.id));
    await tx.insert(schema.statusHistory).values({ businessId: ctx.businessId, entityType: "sales_order", entityId: o.id, fromStatus: status, toStatus: to, note: note ?? null, createdBy: ctx.userId });
    await audit(tx, ctx, { action: `sales_order.${to}`, entityType: "sales_order", entityId: o.id, entityLabel: o.orderNumber ?? undefined, changes: { status: [status, to], via: note ?? null } });
    status = to;
  }
  return status;
}
