import { InvoiceBody, OrderInvoiceBody, OrderListQuery, OrderStatusBody, SalesOrderBody } from "@digitalbahi/contracts";
import { allowedTransitions, dec, DEFAULT_ORDER_WORKFLOW, roundAmount, toAmountString, toQtyString, toRateString, type OrderStatus, type OrderWorkflowConfig } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { lockIdempotencyKey, withTenant } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { orderStatusEvent } from "../../services/order-status.js";
import { prepareSale } from "../../services/sales-document.js";
import { getSetting } from "../../services/settings.js";
import { likeContains } from "../catalog/products.js";
import { invoiceDetail, postInvoice } from "../invoices/routes.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const money = (d: { toFixed(n: number): string }) => d.toFixed(2);
/** Orders that can still be invoiced (and whose goods can leave on a delivery challan). */
const INVOICEABLE = new Set<OrderStatus>(["confirmed", "packing", "packed", "dispatched", "delivered"]);
/** Quotations are numbered on their own series; accepted, the order takes an order number too. */
const QUOTATION_SERIES = { name: "Quotation", pattern: "QT/{FYS}/{SEQ:5}" };
const CHALLAN_SERIES = { name: "Delivery challan", pattern: "DC/{FYS}/{SEQ:5}" };

async function orderDetail(tx: Tx, ctx: RequestCtx, id: string, workflow: OrderWorkflowConfig) {
  const [o] = await tx.select().from(schema.salesOrders).where(and(eq(schema.salesOrders.id, id), eq(schema.salesOrders.businessId, ctx.businessId)));
  if (!o) throw notFound("sales_order");
  const items = await tx.select().from(schema.salesOrderItems).where(eq(schema.salesOrderItems.orderId, id)).orderBy(asc(schema.salesOrderItems.lineNo));
  const schemeIds = [...new Set(items.map((i) => i.schemeId).filter((x): x is string => x !== null))];
  const schemeNames = schemeIds.length ? await tx.select({ id: schema.schemes.id, name: schema.schemes.name }).from(schema.schemes).where(inArray(schema.schemes.id, schemeIds)) : [];
  const [customer] = await tx
    .select({ id: schema.customers.id, name: schema.customers.name, businessName: schema.customers.businessName, mobile: schema.customers.mobile })
    .from(schema.customers)
    .where(eq(schema.customers.id, o.customerId));
  const invoices = await tx
    .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber, invoiceDate: schema.invoices.invoiceDate, grandTotal: schema.invoices.grandTotal, status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.salesOrderId, id))
    .orderBy(asc(schema.invoices.invoiceDate));
  const history = await tx
    .select({ fromStatus: schema.statusHistory.fromStatus, toStatus: schema.statusHistory.toStatus, note: schema.statusHistory.note, createdAt: schema.statusHistory.createdAt })
    .from(schema.statusHistory)
    .where(and(eq(schema.statusHistory.entityType, "sales_order"), eq(schema.statusHistory.entityId, id)))
    .orderBy(asc(schema.statusHistory.createdAt));
  const { businessId: _b, ...rest } = o;
  return {
    ...rest,
    customer: customer ? { id: customer.id, name: customer.businessName ?? customer.name, mobile: customer.mobile } : null,
    items: items.map(({ businessId: _ib, ...i }) => ({ ...i, schemeName: schemeNames.find((x) => x.id === i.schemeId)?.name ?? null, remainingQty: toQtyString(remaining(i)) })),
    invoices,
    history,
    nextStatuses: allowedTransitions(o.status as OrderStatus, workflow),
  };
}

/** Still to invoice, in the line's own unit. */
function remaining(i: Pick<typeof schema.salesOrderItems.$inferSelect, "qty" | "invoicedQty" | "cancelledQty" | "conversionFactor">) {
  const done = dec(i.invoicedQty).plus(i.cancelledQty).dividedBy(i.conversionFactor);
  const left = dec(i.qty).minus(done);
  return left.gt(0) ? left : dec(0);
}

const workflowOf = async (tx: Tx, businessId: string) => ({ ...DEFAULT_ORDER_WORKFLOW, ...(await getSetting(tx, businessId, "orders.workflow")) });

async function recordStatus(tx: Tx, ctx: RequestCtx, id: string, from: string | null, to: string, note?: string) {
  await tx.insert(schema.statusHistory).values({ businessId: ctx.businessId, entityType: "sales_order", entityId: id, fromStatus: from, toStatus: to, note: note ?? null, createdBy: ctx.userId });
}

/**
 * Books a sales order (or a quotation) priced like an invoice on the order
 * date. A replay of the same Idempotency-Key returns the order it made.
 * `status` books it as that instead of what the workflow says (an order from
 * a shop's order link waits to be confirmed).
 */
export async function createSalesOrder(
  tx: Tx,
  ctx: RequestCtx,
  deps: AppDeps,
  body: z.output<typeof SalesOrderBody>,
  clientId: string | null,
  options: { status?: OrderStatus } = {},
): Promise<{ replay: boolean; detail: Awaited<ReturnType<typeof orderDetail>> }> {
    const workflow = await workflowOf(tx, ctx.businessId);
    if (clientId) {
      await lockIdempotencyKey(tx, clientId);
      const [existing] = await tx
        .select({ id: schema.salesOrders.id })
        .from(schema.salesOrders)
        .where(and(eq(schema.salesOrders.businessId, ctx.businessId), eq(schema.salesOrders.clientId, clientId)));
      if (existing) return { replay: true, detail: await orderDetail(tx, ctx, existing.id, workflow) };
    }
    const today = deps.clock.today(ctx.timeZone);
    if (body.expectedDeliveryDate && body.expectedDeliveryDate < (body.orderDate ?? today)) throw badRequest("DELIVERY_BEFORE_ORDER", {}, "expectedDeliveryDate");
    if (body.validUntil && (!body.quotation || body.validUntil < (body.orderDate ?? today))) throw badRequest("VALID_UNTIL_BEFORE_DATE", {}, "validUntil");
    // Priced by the same code as an invoice on the order date.
    const sale = await prepareSale(tx, ctx, { customerId: body.customerId, invoiceDate: body.orderDate, lines: body.lines, charges: [] } as z.output<typeof InvoiceBody>, today, { order: true });
    const t = sale.totals;
    const quotation = body.quotation === true;
    const numbering = quotation
      ? await nextDocumentNumber(tx, ctx.businessId, "quotation", sale.invoiceDate, sale.business.financialYearStartMonth, QUOTATION_SERIES)
      : await nextDocumentNumber(tx, ctx.businessId, "sales_order", sale.invoiceDate, sale.business.financialYearStartMonth);
    const id = uuidv7();
    // A quotation waits as a draft until the customer accepts it.
    const status: OrderStatus = quotation ? "draft" : (options.status ?? (workflow.requireConfirmation ? "pending" : "confirmed"));
    await tx.insert(schema.salesOrders).values({
      id,
      businessId: ctx.businessId,
      orderNumber: numbering.number,
      seriesId: numbering.seriesId,
      financialYear: numbering.financialYear,
      orderDate: sale.invoiceDate,
      expectedDeliveryDate: body.expectedDeliveryDate ?? null,
      quotationNumber: quotation ? numbering.number : null,
      validUntil: quotation ? (body.validUntil ?? null) : null,
      customerId: sale.customer.id,
      warehouseId: sale.warehouseId,
      priceLevelId: sale.priceLevelId,
      status,
      source: body.source,
      placeOfSupply: sale.placeOfSupply,
      grossTotal: toAmountString(t.grossTotal),
      discountTotal: toAmountString(t.discountTotal),
      taxableTotal: toAmountString(t.taxableTotal),
      cgstTotal: toAmountString(t.cgstTotal),
      sgstTotal: toAmountString(t.sgstTotal),
      igstTotal: toAmountString(t.igstTotal),
      cessTotal: toAmountString(t.cessTotal),
      roundOff: toAmountString(t.roundOff),
      grandTotal: toAmountString(t.grandTotal),
      notes: body.notes ?? null,
      clientId,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });
    await tx.insert(schema.salesOrderItems).values(
      sale.lines.map((p, i) => {
        const l = t.lines[i]!;
        return {
          id: uuidv7(),
          businessId: ctx.businessId,
          orderId: id,
          lineNo: i + 1,
          productId: p.productId,
          productName: p.productName,
          hsnCode: p.hsnCode,
          uqc: p.uqc,
          unitId: p.unitId,
          conversionFactor: p.conversionFactor,
          qty: toQtyString(l.qty),
          freeQty: p.freeQty,
          qtyBase: toQtyString(l.qtyBase),
          rate: toRateString(l.rate),
          rateIncludesTax: p.rateIncludesTax,
          grossAmount: money(l.gross),
          discountPercent: p.schemeFree ? "100" : (body.lines[i]!.discountPercent ?? "0"),
          discountAmount: money(l.lineDiscount),
          documentDiscountShare: money(l.documentDiscountShare),
          taxableValue: money(l.taxable),
          taxability: p.taxability,
          taxCategoryId: p.taxCategoryId,
          taxRateId: p.taxRateId,
          gstRate: l.gstRate.toFixed(3),
          cgstRate: l.cgstRate.toFixed(3),
          cgstAmount: money(l.cgst),
          sgstRate: l.sgstRate.toFixed(3),
          sgstAmount: money(l.sgst),
          igstRate: l.igstRate.toFixed(3),
          igstAmount: money(l.igst),
          cessRate: l.cessRate.toFixed(3),
          cessAmount: money(l.cess),
          lineTotal: money(l.total),
          schemeId: p.schemeId,
          schemeDiscount: p.schemeDiscount,
          schemeFree: p.schemeFree,
        };
      }),
    );
    await recordStatus(tx, ctx, id, null, status);
    await audit(tx, ctx, { action: quotation ? "quotation.created" : "sales_order.created", entityType: "sales_order", entityId: id, entityLabel: numbering.number, changes: { customer: sale.customer.name, grandTotal: toAmountString(t.grandTotal) } });
    if (!quotation) await tx.insert(schema.outboxEvents).values({ businessId: ctx.businessId, eventType: "sales_order.created", aggregateType: "sales_order", aggregateId: id, payload: { customerId: sale.customer.id, status } });
    return { replay: false, detail: await orderDetail(tx, ctx, id, workflow) };
}

/**
 * Sales orders: a salesperson or the counter books what the customer wants,
 * priced exactly like an invoice (rate list, GST on the order date). Nothing
 * moves until it is invoiced, fully or line by line; packing and dispatch
 * steps follow the business's workflow setting.
 */
export const ordersModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.post("/sales-orders", { preHandler: guard(deps, "order.create"), schema: { tags: ["orders"], body: SalesOrderBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await tenant(ctx, (tx) => createSalesOrder(tx, ctx, deps, body, clientId));
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.detail);
  });

  r.get("/sales-orders", { preHandler: guard(deps, "order.view"), schema: { tags: ["orders"], querystring: OrderListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const o = schema.salesOrders;
    const where: SQL[] = [eq(o.businessId, ctx.businessId)];
    if (q.status === "open") where.push(sql`${o.status} not in ('delivered', 'cancelled', 'draft')`);
    else if (q.status === "all") where.push(sql`${o.status} <> 'draft'`);
    else where.push(eq(o.status, q.status));
    if (q.customerId) where.push(eq(o.customerId, q.customerId));
    if (q.from) where.push(sql`${o.orderDate} >= ${q.from}`);
    if (q.to) where.push(sql`${o.orderDate} <= ${q.to}`);
    if (q.q) where.push(sql`(${o.orderNumber} ilike ${likeContains(q.q)} or exists (select 1 from customers c where c.id = "sales_orders"."customer_id" and (c.name ilike ${likeContains(q.q)} or c.business_name ilike ${likeContains(q.q)})))`);
    if (cursor) where.push(sql`(${o.orderDate}, ${o.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: o.id,
          orderNumber: o.orderNumber,
          quotationNumber: o.quotationNumber,
          validUntil: o.validUntil,
          orderDate: o.orderDate,
          expectedDeliveryDate: o.expectedDeliveryDate,
          customerId: o.customerId,
          // Outer columns are spelled out: inside a single-table select Drizzle leaves them unqualified.
          partyName: sql<string>`(select coalesce(c.business_name, c.name) from customers c where c.id = "sales_orders"."customer_id")`,
          status: o.status,
          source: o.source,
          grandTotal: o.grandTotal,
          lines: sql<number>`(select count(*)::int from sales_order_items i where i.order_id = "sales_orders"."id")`,
          // 0..1 share of the ordered quantity already invoiced (or cancelled).
          invoiced: sql<string>`(select coalesce(sum((i.invoiced_qty + i.cancelled_qty) / i.conversion_factor) / nullif(sum(i.qty), 0), 0)::numeric(6,3)::text from sales_order_items i where i.order_id = "sales_orders"."id")`,
        })
        .from(o)
        .where(and(...where))
        .orderBy(desc(o.orderDate), desc(o.id))
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.orderDate, id: x.id }));
  });

  r.get("/sales-orders/:id", { preHandler: guard(deps, "order.view"), schema: { tags: ["orders"], params: IdParams } }, async (request) =>
    tenant(request.ctx, async (tx) => orderDetail(tx, request.ctx, request.params.id, await workflowOf(tx, request.ctx.businessId))),
  );

  /** Moves an order along its workflow (confirm, packing, packed, dispatched, delivered) or cancels it. */
  r.post("/sales-orders/:id/status", { preHandler: guard(deps, "order.view"), schema: { tags: ["orders"], params: IdParams, body: OrderStatusBody } }, async (request) => {
    const ctx = request.ctx;
    const to = request.body.status;
    const permission = to === "confirmed" ? "order.confirm" : to === "cancelled" ? "order.cancel" : to === "packing" || to === "packed" ? "packing.pack" : to === "dispatched" ? "dispatch.dispatch" : to === "delivered" ? "dispatch.deliver" : "order.update";
    if (!can(ctx, permission)) throw forbidden(permission);
    return tenant(ctx, async (tx) => {
      const [o] = await tx.select().from(schema.salesOrders).where(and(eq(schema.salesOrders.id, request.params.id), eq(schema.salesOrders.businessId, ctx.businessId))).for("update");
      if (!o) throw notFound("sales_order");
      const workflow = await workflowOf(tx, ctx.businessId);
      const from = o.status as OrderStatus;
      if (!allowedTransitions(from, workflow).includes(to)) throw conflict("INVALID_STATUS_TRANSITION", { from, to });
      if (to === "cancelled") {
        if (!request.body.note || request.body.note.length < 3) throw badRequest("CANCEL_REASON_REQUIRED", {}, "note");
        // Invoiced quantities stay; only what is still open is cancelled.
        const items = await tx.select().from(schema.salesOrderItems).where(eq(schema.salesOrderItems.orderId, o.id));
        for (const i of items) {
          const open = remaining(i).times(i.conversionFactor);
          if (open.gt(0)) await tx.update(schema.salesOrderItems).set({ cancelledQty: sql`${schema.salesOrderItems.cancelledQty} + ${toQtyString(open)}` }).where(eq(schema.salesOrderItems.id, i.id));
        }
      }
      // A quotation accepted becomes an order with an order number (the quotation's number is kept).
      const accepted =
        from === "draft" && to !== "cancelled"
          ? await nextDocumentNumber(tx, ctx.businessId, "sales_order", deps.clock.today(ctx.timeZone), (await tx.select({ m: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId)))[0]!.m)
          : null;
      await tx
        .update(schema.salesOrders)
        .set({
          status: to,
          ...(accepted ? { orderNumber: accepted.number, seriesId: accepted.seriesId, financialYear: accepted.financialYear } : {}),
          ...(to === "cancelled" ? { cancelledAt: deps.clock.now().toISOString(), cancelReason: request.body.note ?? null } : {}),
          version: o.version + 1,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.salesOrders.id, o.id));
      await recordStatus(tx, ctx, o.id, from, to, request.body.note);
      await orderStatusEvent(tx, ctx.businessId, o.id, from, to);
      await audit(tx, ctx, {
        action: accepted ? "quotation.accepted" : `sales_order.${to}`,
        entityType: "sales_order",
        entityId: o.id,
        entityLabel: accepted?.number ?? o.orderNumber ?? undefined,
        changes: { status: [from, to], ...(accepted ? { quotation: o.orderNumber, order: accepted.number } : {}) },
      });
      return orderDetail(tx, ctx, o.id, workflow);
    });
  });

  /**
   * The order's delivery challan, for goods that leave before the bill: given
   * a number from its own series and today's date the first time, the same
   * ever after (printing it again is the same challan).
   */
  r.post("/sales-orders/:id/challan", { preHandler: guard(deps, "order.view"), schema: { tags: ["orders"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    if (!can(ctx, "order.update") && !can(ctx, "dispatch.dispatch")) throw forbidden("order.update");
    return tenant(ctx, async (tx) => {
      const [o] = await tx.select().from(schema.salesOrders).where(and(eq(schema.salesOrders.id, request.params.id), eq(schema.salesOrders.businessId, ctx.businessId))).for("update");
      if (!o) throw notFound("sales_order");
      const workflow = await workflowOf(tx, ctx.businessId);
      if (!o.challanNumber) {
        if (!INVOICEABLE.has(o.status as OrderStatus)) throw conflict("ORDER_NOT_CONFIRMED", { status: o.status });
        const today = deps.clock.today(ctx.timeZone);
        const [b] = await tx.select({ m: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
        const numbering = await nextDocumentNumber(tx, ctx.businessId, "delivery_challan", today, b!.m, CHALLAN_SERIES);
        await tx.update(schema.salesOrders).set({ challanNumber: numbering.number, challanDate: today, updatedBy: ctx.userId }).where(eq(schema.salesOrders.id, o.id));
        await audit(tx, ctx, { action: "delivery_challan.created", entityType: "sales_order", entityId: o.id, entityLabel: numbering.number, changes: { order: o.orderNumber } });
      }
      return orderDetail(tx, ctx, o.id, workflow);
    });
  });

  /**
   * Invoices an order (all open quantities, or chosen ones): the invoice is
   * posted exactly like POST /invoices, at the order's agreed rates, and the
   * order lines record what has been invoiced.
   */
  r.post("/sales-orders/:id/invoice", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["orders"], params: IdParams, body: OrderInvoiceBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        await lockIdempotencyKey(tx, clientId);
        const [existing] = await tx
          .select({ id: schema.invoices.id })
          .from(schema.invoices)
          .where(and(eq(schema.invoices.businessId, ctx.businessId), eq(schema.invoices.clientId, clientId)));
        if (existing) return { replay: true, detail: await invoiceDetail(tx, ctx, existing.id), warnings: [] };
      }
      const [o] = await tx.select().from(schema.salesOrders).where(and(eq(schema.salesOrders.id, request.params.id), eq(schema.salesOrders.businessId, ctx.businessId))).for("update");
      if (!o) throw notFound("sales_order");
      if (!INVOICEABLE.has(o.status as OrderStatus)) throw conflict("ORDER_NOT_CONFIRMED", { status: o.status });
      const items = await tx.select().from(schema.salesOrderItems).where(eq(schema.salesOrderItems.orderId, o.id)).orderBy(asc(schema.salesOrderItems.lineNo)).for("update");
      const chosen = body.lines
        ? body.lines.map((l, i) => {
            const item = items.find((x) => x.id === l.orderLineId);
            if (!item) throw badRequest("RETURN_LINE_NOT_ON_DOCUMENT", {}, `lines[${i}].orderLineId`);
            if (dec(l.qty).lte(0)) throw badRequest("QTY_NOT_POSITIVE", {}, `lines[${i}].qty`);
            if (dec(l.qty).gt(remaining(item))) throw badRequest("ORDER_QTY_EXCEEDS", { product: item.productName, max: toQtyString(remaining(item)) }, `lines[${i}].qty`);
            return { item, qty: dec(l.qty) };
          })
        : items.filter((i) => remaining(i).gt(0)).map((item) => ({ item, qty: remaining(item) }));
      if (!chosen.length) throw conflict("ORDER_FULLY_INVOICED");
      const invoiceBody = {
        customerId: o.customerId,
        ...(body.invoiceDate ? { invoiceDate: body.invoiceDate } : {}),
        lines: chosen.map(({ item, qty }) => ({
          productId: item.productId,
          unitId: item.unitId,
          qty: toQtyString(qty),
          // Free goods go with the invoice that completes the line.
          freeQty: qty.eq(remaining(item)) ? item.freeQty : "0",
          rate: item.rate,
          discountPercent: item.discountPercent,
          discountAmount: "0",
          // Its scheme goes with it: goods given free whole, a discount for the part billed.
          ...(item.schemeId && item.schemeFree ? { scheme: { id: item.schemeId, free: true } } : {}),
          ...(item.schemeId && !item.schemeFree && dec(item.schemeDiscount).gt(0)
            ? { scheme: { id: item.schemeId, discount: money(roundAmount(dec(item.schemeDiscount).times(qty).dividedBy(item.qty))) } }
            : {}),
        })),
        charges: [],
        ...(body.payment ? { payment: body.payment } : {}),
        notes: body.notes ?? `Against order ${o.orderNumber}`,
      } as z.output<typeof InvoiceBody>;
      const posted = await postInvoice(tx, ctx, deps, invoiceBody, clientId, { salesOrderId: o.id, orderItemIds: chosen.map((c) => c.item.id) });
      for (const { item, qty } of chosen) {
        await tx
          .update(schema.salesOrderItems)
          .set({ invoicedQty: sql`${schema.salesOrderItems.invoicedQty} + ${toQtyString(qty.times(item.conversionFactor))}` })
          .where(eq(schema.salesOrderItems.id, item.id));
      }
      await audit(tx, ctx, {
        action: "sales_order.invoiced",
        entityType: "sales_order",
        entityId: o.id,
        entityLabel: o.orderNumber ?? undefined,
        changes: { invoice: posted.detail.invoiceNumber, lines: chosen.map((c) => [c.item.productName, toQtyString(c.qty)]) },
      });
      return { replay: false, detail: posted.detail, warnings: posted.warnings };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send({ ...result.detail, warnings: result.warnings });
  });

  /** Open orders' quantities by product: what the warehouse must supply (and what stock covers). */
  r.get("/sales-orders/demand", { preHandler: guard(deps, "order.view"), schema: { tags: ["orders"] } }, async (request) => {
    const ctx = request.ctx;
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{ product_id: string; name: string; qty: string; stock: string; orders: number }>(sql`
          select i.product_id, max(i.product_name) as name,
                 sum(i.qty_base - i.invoiced_qty - i.cancelled_qty)::text as qty,
                 coalesce((select sum(sb.qty) from stock_balances sb where sb.product_id = i.product_id), 0)::text as stock,
                 count(distinct o.id)::int as orders
          from sales_order_items i join sales_orders o on o.id = i.order_id
          where o.business_id = ${ctx.businessId} and o.status not in ('draft', 'cancelled', 'delivered')
            and i.qty_base - i.invoiced_qty - i.cancelled_qty > 0
          group by i.product_id order by 2`)
      ).rows,
    );
    return { data: rows.map((x) => ({ productId: x.product_id, name: x.name, qty: dec(x.qty).toFixed(3), stock: dec(x.stock).toFixed(3), orders: x.orders, short: dec(x.qty).gt(x.stock) })) };
  });
};

