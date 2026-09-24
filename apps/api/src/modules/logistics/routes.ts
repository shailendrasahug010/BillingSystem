import { DeliveryBody, DispatchBody, DispatchListQuery, PackingBody, PackingListQuery } from "@vyapaar/contracts";
import { dec, toQtyString } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { inSequence, withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { advanceOrder } from "../../services/order-status.js";
import { assertOwned } from "../../services/owned.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const StopParams = z.object({ id: z.uuid(), stopId: z.uuid() });
const oi = schema.salesOrderItems;
const d = schema.dispatches;
const stops = schema.dispatchOrders;

/** Base units an order line still needs packed: ordered (with free goods) less cancelled and packed. */
const toPack = (i: typeof oi.$inferSelect) => dec(i.qtyBase).plus(dec(i.freeQty).times(i.conversionFactor)).minus(i.cancelledQty).minus(i.packedQty);
const ordered = (i: typeof oi.$inferSelect) => dec(i.qtyBase).plus(dec(i.freeQty).times(i.conversionFactor)).minus(i.cancelledQty);

async function fyStart(tx: Tx, businessId: string) {
  return (await tx.select({ m: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, businessId)))[0]!.m;
}

async function packingDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [row] = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.packing_number as "packingNumber", p.status::text as status, p.box_count as "boxCount", p.total_weight_kg::text as "totalWeightKg",
           p.packed_at as "packedAt", p.notes, p.sales_order_id as "salesOrderId", o.order_number as "orderNumber", o.order_date::text as "orderDate",
           o.status::text as "orderStatus", coalesce(c.business_name, c.name) as "customerName", c.address_line1 as "customerAddress", c.city as "customerCity",
           c.mobile as "customerMobile", e.name as "packedByName"
    from packings p join sales_orders o on o.id = p.sales_order_id join customers c on c.id = o.customer_id
    left join employees e on e.id = p.packed_by
    where p.id = ${id} and p.business_id = ${ctx.businessId}`).then((r) => r.rows);
  if (!row) throw notFound("packing");
  const items = await tx.execute<Record<string, unknown>>(sql`
    select pi.id, pi.order_item_id as "orderItemId", pi.product_id as "productId", oi.product_name as "productName", pi.qty::text as qty,
           u.symbol as unit, pi.box_no as "boxNo", b.batch_number as "batchNumber", b.expiry_date::text as "expiryDate"
    from packing_items pi join sales_order_items oi on oi.id = pi.order_item_id
    join products p on p.id = pi.product_id join units u on u.id = p.base_unit_id
    left join batches b on b.id = pi.batch_id
    where pi.packing_id = ${id} order by pi.box_no nulls last, oi.line_no`);
  return { ...row, items: items.rows };
}

async function dispatchDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [trip] = await tx.select().from(d).where(and(eq(d.id, id), eq(d.businessId, ctx.businessId)));
  if (!trip) throw notFound("dispatch");
  const stopRows = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.delivery_sequence as "sequence", s.status::text as status, s.delivered_at as "deliveredAt", s.received_by as "receivedBy", s.remarks,
           s.invoice_id as "invoiceId", i.invoice_number as "invoiceNumber", i.invoice_date::text as "invoiceDate", i.grand_total::text as "grandTotal",
           i.balance_due::text as "balanceDue", s.sales_order_id as "salesOrderId", o.order_number as "orderNumber",
           coalesce(c.business_name, c.name) as "customerName", c.address_line1 as address, c.city, c.mobile
    from dispatch_orders s
    left join invoices i on i.id = s.invoice_id
    left join sales_orders o on o.id = s.sales_order_id
    left join customers c on c.id = coalesce(i.customer_id, o.customer_id)
    where s.dispatch_id = ${id} order by s.delivery_sequence nulls last, s.created_at`);
  // Loading sheet: everything on the vehicle, by product.
  const loading = await tx.execute<Record<string, unknown>>(sql`
    select ii.product_id as "productId", max(ii.product_name) as "productName", max(u.symbol) as unit,
           sum(ii.qty_base + ii.free_qty * ii.conversion_factor)::numeric(15, 3)::text as qty, count(distinct ii.invoice_id)::int as invoices
    from dispatch_orders s join invoice_items ii on ii.invoice_id = s.invoice_id
    join products p on p.id = ii.product_id join units u on u.id = p.base_unit_id
    where s.dispatch_id = ${id} and s.status <> 'cancelled'
    group by ii.product_id order by max(ii.product_name)`);
  const driver = trip.driverEmployeeId ? (await tx.select({ name: schema.employees.name }).from(schema.employees).where(eq(schema.employees.id, trip.driverEmployeeId)))[0] : null;
  const { businessId: _b, ...rest } = trip;
  return { ...rest, driverEmployeeName: driver?.name ?? null, stops: stopRows.rows, loading: loading.rows };
}

async function history(tx: Tx, ctx: RequestCtx, entityId: string, from: string | null, to: string, note?: string) {
  await tx.insert(schema.statusHistory).values({ businessId: ctx.businessId, entityType: "dispatch", entityId, fromStatus: from, toStatus: to, note: note ?? null, createdBy: ctx.userId });
}

export const logisticsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  // ---------------------------------------------------------------- packing
  /** Confirmed orders waiting to be packed, with what is left per line, barcodes and batches first to expire. */
  r.get("/packing/queue", { preHandler: guard(deps, "packing.view"), schema: { tags: ["packing"] } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const orders = await tx.execute<{ id: string; order_number: string; order_date: string; expected_delivery_date: string | null; status: string; customer_name: string; city: string | null }>(sql`
        select o.id, o.order_number, o.order_date::text, o.expected_delivery_date::text, o.status::text, coalesce(c.business_name, c.name) as customer_name, c.city
        from sales_orders o join customers c on c.id = o.customer_id
        where o.business_id = ${ctx.businessId} and o.status in ('confirmed', 'packing')
        order by coalesce(o.expected_delivery_date, o.order_date), o.order_number limit 100`);
      const ids = orders.rows.map((o) => o.id);
      if (!ids.length) return { data: [] };
      const items = await tx.select().from(oi).where(inArray(oi.orderId, ids)).orderBy(asc(oi.lineNo));
      const productIds = [...new Set(items.map((i) => i.productId))];
      const [units, barcodes, batches] = await inSequence([
        () => tx.execute<{ id: string; symbol: string }>(sql`select p.id, u.symbol from products p join units u on u.id = p.base_unit_id where p.id in ${sql`(${sql.join(productIds.map((x) => sql`${x}`), sql`, `)})`}`),
        () => tx.select({ productId: schema.productBarcodes.productId, barcode: schema.productBarcodes.barcode }).from(schema.productBarcodes).where(inArray(schema.productBarcodes.productId, productIds)),
        () => tx.execute<{ product_id: string; batch_id: string; batch_number: string; expiry_date: string | null; qty: string }>(sql`
          select sb.product_id, b.id as batch_id, b.batch_number, b.expiry_date::text, sum(sb.qty)::text as qty
          from stock_balances sb join batches b on b.id = sb.batch_id
          where sb.business_id = ${ctx.businessId} and sb.product_id in ${sql`(${sql.join(productIds.map((x) => sql`${x}`), sql`, `)})`} and sb.qty > 0
          group by sb.product_id, b.id order by b.expiry_date nulls last, b.batch_number`),
      ]);
      const unitOf = new Map(units.rows.map((u) => [u.id, u.symbol]));
      return {
        data: orders.rows.map((o) => ({
          id: o.id,
          orderNumber: o.order_number,
          orderDate: o.order_date,
          expectedDeliveryDate: o.expected_delivery_date,
          status: o.status,
          customerName: o.customer_name,
          city: o.city,
          lines: items
            .filter((i) => i.orderId === o.id && ordered(i).gt(0))
            .map((i) => ({
              orderItemId: i.id,
              productId: i.productId,
              productName: i.productName,
              unit: unitOf.get(i.productId) ?? "",
              ordered: toQtyString(ordered(i)),
              packed: i.packedQty,
              remaining: toQtyString(dec(0).gt(toPack(i)) ? dec(0) : toPack(i)),
              barcodes: barcodes.filter((b) => b.productId === i.productId).map((b) => b.barcode),
              // First expiry first out: suggested picking order.
              batches: batches.rows.filter((b) => b.product_id === i.productId).map((b) => ({ batchId: b.batch_id, batchNumber: b.batch_number, expiryDate: b.expiry_date, qty: b.qty })),
            })),
        })),
      };
    });
  });

  r.post("/packing", { preHandler: guard(deps, "packing.pack"), schema: { tags: ["packing"], body: PackingBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const detail = await tenant(ctx, async (tx) => {
      const [order] = await tx.select().from(schema.salesOrders).where(and(eq(schema.salesOrders.id, body.salesOrderId), eq(schema.salesOrders.businessId, ctx.businessId))).for("update");
      if (!order) throw badRequest("REFERENCE_NOT_FOUND", {}, "salesOrderId");
      if (order.status !== "confirmed" && order.status !== "packing") throw conflict("ORDER_NOT_READY_TO_PACK", { status: order.status });
      await assertOwned(tx, schema.employees, ctx.businessId, body.packedBy, "packedBy");
      const items = await tx.select().from(oi).where(eq(oi.orderId, order.id)).for("update");
      const byId = new Map(items.map((i) => [i.id, i]));
      const packing = new Map<string, ReturnType<typeof dec>>();
      for (const [n, l] of body.lines.entries()) {
        const item = byId.get(l.orderItemId);
        if (!item) throw badRequest("PACK_LINE_NOT_ON_ORDER", {}, `lines[${n}].orderItemId`);
        if (dec(l.qty).lte(0)) throw badRequest("QTY_NOT_POSITIVE", {}, `lines[${n}].qty`);
        if (l.batchId) {
          const [b] = await tx.select({ productId: schema.batches.productId }).from(schema.batches).where(and(eq(schema.batches.id, l.batchId), eq(schema.batches.businessId, ctx.businessId)));
          if (!b || b.productId !== item.productId) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${n}].batchId`);
        }
        packing.set(item.id, (packing.get(item.id) ?? dec(0)).plus(l.qty));
      }
      for (const [itemId, qty] of packing) {
        const item = byId.get(itemId)!;
        if (qty.gt(toPack(item))) throw conflict("PACK_QTY_EXCEEDS", { product: item.productName, remaining: toQtyString(toPack(item)) });
      }
      const numbering = await nextDocumentNumber(tx, ctx.businessId, "packing", deps.clock.today(ctx.timeZone), await fyStart(tx, ctx.businessId), { name: "Packing slip", pattern: "PK/{FYS}/{SEQ:5}" });
      const id = uuidv7();
      const now = deps.clock.now().toISOString();
      await tx.insert(schema.packings).values({
        id,
        businessId: ctx.businessId,
        packingNumber: numbering.number,
        salesOrderId: order.id,
        status: "packed",
        boxCount: body.boxCount,
        totalWeightKg: body.totalWeightKg ?? null,
        packedBy: body.packedBy ?? null,
        packedAt: now,
        notes: body.notes ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      await tx.insert(schema.packingItems).values(
        body.lines.map((l) => ({
          businessId: ctx.businessId,
          packingId: id,
          orderItemId: l.orderItemId,
          productId: byId.get(l.orderItemId)!.productId,
          batchId: l.batchId ?? null,
          qty: l.qty,
          boxNo: l.boxNo ?? null,
          scannedBarcode: l.scannedBarcode ?? null,
        })),
      );
      for (const [itemId, qty] of packing) await tx.update(oi).set({ packedQty: sql`${oi.packedQty} + ${toQtyString(qty)}` }).where(eq(oi.id, itemId));
      const complete = items.every((i) => toPack(i).minus(packing.get(i.id) ?? 0).lte(0));
      await advanceOrder(tx, ctx, order.id, complete ? ["packing", "packed"] : ["packing"], numbering.number);
      await audit(tx, ctx, { action: "packing.packed", entityType: "packing", entityId: id, entityLabel: numbering.number, changes: { order: order.orderNumber, lines: body.lines.length, boxes: body.boxCount, complete } });
      return packingDetail(tx, ctx, id);
    });
    return reply.code(201).send(detail);
  });

  r.get("/packing", { preHandler: guard(deps, "packing.view"), schema: { tags: ["packing"], querystring: PackingListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [sql`p.business_id = ${ctx.businessId}`];
    if (q.salesOrderId) where.push(sql`p.sales_order_id = ${q.salesOrderId}`);
    if (q.q) where.push(sql`(p.packing_number ilike ${`%${q.q}%`} or o.order_number ilike ${`%${q.q}%`})`);
    if (cursor) where.push(sql`(p.created_at, p.id) < (${String(cursor.v)}::timestamptz, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx.execute<{ id: string; createdAt: string }>(sql`
        select p.id, p.packing_number as "packingNumber", p.status::text as status, p.box_count as "boxCount", p.packed_at as "packedAt", p.created_at as "createdAt",
               o.order_number as "orderNumber", coalesce(c.business_name, c.name) as "customerName", (select count(*)::int from packing_items pi where pi.packing_id = p.id) as lines
        from packings p join sales_orders o on o.id = p.sales_order_id join customers c on c.id = o.customer_id
        where ${sql.join(where, sql` and `)} order by p.created_at desc, p.id desc limit ${q.limit + 1}`),
    );
    return page(rows.rows, q.limit, (x) => ({ v: x.createdAt, id: x.id }));
  });

  r.get("/packing/:id", { preHandler: guard(deps, "packing.view"), schema: { tags: ["packing"], params: IdParams } }, async (request) => tenant(request.ctx, (tx) => packingDetail(tx, request.ctx, request.params.id)));

  /** Unpack: the quantities go back to the order; a fully packed order returns to packing. */
  r.post("/packing/:id/cancel", { preHandler: guard(deps, "packing.pack"), schema: { tags: ["packing"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [p] = await tx.select().from(schema.packings).where(and(eq(schema.packings.id, request.params.id), eq(schema.packings.businessId, ctx.businessId))).for("update");
      if (!p) throw notFound("packing");
      if (p.status === "cancelled") throw conflict("PACKING_CANCELLED");
      const [order] = await tx.select({ status: schema.salesOrders.status }).from(schema.salesOrders).where(eq(schema.salesOrders.id, p.salesOrderId)).for("update");
      if (order!.status !== "packing" && order!.status !== "packed") throw conflict("ORDER_ALREADY_DISPATCHED", { status: order!.status });
      const lines = await tx.select().from(schema.packingItems).where(eq(schema.packingItems.packingId, p.id));
      for (const l of lines) await tx.update(oi).set({ packedQty: sql`greatest(${oi.packedQty} - ${l.qty}, 0)` }).where(eq(oi.id, l.orderItemId));
      await tx.update(schema.packings).set({ status: "cancelled", version: p.version + 1, updatedBy: ctx.userId }).where(eq(schema.packings.id, p.id));
      if (order!.status === "packed") await advanceOrder(tx, ctx, p.salesOrderId, ["packing"], `${p.packingNumber} unpacked`);
      await audit(tx, ctx, { action: "packing.cancelled", entityType: "packing", entityId: p.id, entityLabel: p.packingNumber ?? undefined });
      return packingDetail(tx, ctx, p.id);
    });
  });

  // ---------------------------------------------------------------- dispatch
  /** Posted invoices of the last 60 days that are not on a trip yet. */
  r.get("/dispatch/ready", { preHandler: guard(deps, "dispatch.view"), schema: { tags: ["dispatch"] } }, async (request) => {
    const ctx = request.ctx;
    const since = new Date(new Date(`${deps.clock.today(ctx.timeZone)}T00:00:00Z`).getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    const rows = await tenant(ctx, (tx) =>
      tx.execute(sql`
        select i.id, i.invoice_number as "invoiceNumber", i.invoice_date::text as "invoiceDate", i.grand_total::text as "grandTotal",
               coalesce(c.business_name, c.name) as "customerName", c.city, c.address_line1 as address, r.name as route,
               o.order_number as "orderNumber", o.status::text as "orderStatus"
        from invoices i join customers c on c.id = i.customer_id
        left join sales_routes r on r.id = c.route_id
        left join sales_orders o on o.id = i.sales_order_id
        where i.business_id = ${ctx.businessId} and i.status = 'posted' and i.invoice_date >= ${since}
          and not exists (select 1 from dispatch_orders s join dispatches t on t.id = s.dispatch_id where s.invoice_id = i.id and t.status <> 'cancelled')
        order by r.name nulls last, c.city nulls last, i.invoice_date, i.invoice_number limit 300`),
    );
    return { data: rows.rows };
  });

  r.post("/dispatches", { preHandler: guard(deps, "dispatch.dispatch"), schema: { tags: ["dispatch"], body: DispatchBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const detail = await tenant(ctx, async (tx) => {
      const today = deps.clock.today(ctx.timeZone);
      const date = body.dispatchDate ?? today;
      if (new Set(body.invoiceIds).size !== body.invoiceIds.length) throw badRequest("DUPLICATE_INVOICE", {}, "invoiceIds");
      await assertOwned(tx, schema.employees, ctx.businessId, body.driverEmployeeId, "driverEmployeeId");
      const invoices = await tx
        .select({ id: schema.invoices.id, number: schema.invoices.invoiceNumber, status: schema.invoices.status, salesOrderId: schema.invoices.salesOrderId })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.businessId, ctx.businessId), inArray(schema.invoices.id, body.invoiceIds)))
        .for("update");
      if (invoices.length !== body.invoiceIds.length) throw badRequest("REFERENCE_NOT_FOUND", {}, "invoiceIds");
      const notPosted = invoices.find((i) => i.status !== "posted");
      if (notPosted) throw conflict("INVOICE_NOT_POSTED", { status: notPosted.status });
      const [busy] = (
        await tx.execute<{ number: string }>(sql`
          select i.invoice_number as number from dispatch_orders s join dispatches t on t.id = s.dispatch_id join invoices i on i.id = s.invoice_id
          where s.invoice_id in ${sql`(${sql.join(body.invoiceIds.map((x) => sql`${x}`), sql`, `)})`} and t.status <> 'cancelled' limit 1`)
      ).rows;
      if (busy) throw conflict("INVOICE_ALREADY_DISPATCHED", { number: busy.number });
      const numbering = await nextDocumentNumber(tx, ctx.businessId, "dispatch", date, await fyStart(tx, ctx.businessId), { name: "Dispatch", pattern: "DSP/{FYS}/{SEQ:5}" });
      const id = uuidv7();
      const status = body.start ? ("dispatched" as const) : ("planned" as const);
      await tx.insert(d).values({
        id,
        businessId: ctx.businessId,
        dispatchNumber: numbering.number,
        dispatchDate: date,
        vehicleNumber: body.vehicleNumber ?? null,
        driverName: body.driverName ?? null,
        driverMobile: body.driverMobile ?? null,
        driverEmployeeId: body.driverEmployeeId ?? null,
        transporterName: body.transporterName ?? null,
        transporterGstin: body.transporterGstin ?? null,
        lrNumber: body.lrNumber ?? null,
        lrDate: body.lrDate ?? null,
        expectedDeliveryDate: body.expectedDeliveryDate ?? null,
        remarks: body.remarks ?? null,
        status,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      const byId = new Map(invoices.map((i) => [i.id, i]));
      await tx.insert(stops).values(
        body.invoiceIds.map((invoiceId, n) => ({ businessId: ctx.businessId, dispatchId: id, invoiceId, salesOrderId: byId.get(invoiceId)!.salesOrderId, deliverySequence: n + 1, status, createdBy: ctx.userId, updatedBy: ctx.userId })),
      );
      await history(tx, ctx, id, null, status);
      if (body.start) for (const orderId of new Set(invoices.map((i) => i.salesOrderId).filter((x): x is string => Boolean(x)))) await advanceOrder(tx, ctx, orderId, ["packed", "dispatched"], numbering.number);
      await audit(tx, ctx, { action: `dispatch.${status}`, entityType: "dispatch", entityId: id, entityLabel: numbering.number, changes: { invoices: invoices.map((i) => i.number), vehicle: body.vehicleNumber ?? null } });
      return dispatchDetail(tx, ctx, id);
    });
    return reply.code(201).send(detail);
  });

  r.get("/dispatches", { preHandler: guard(deps, "dispatch.view"), schema: { tags: ["dispatch"], querystring: DispatchListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [sql`t.business_id = ${ctx.businessId}`];
    if (q.status === "open") where.push(sql`t.status in ('planned', 'dispatched', 'in_transit')`);
    else if (q.status === "delivered") where.push(sql`t.status in ('delivered', 'partially_delivered')`);
    else if (q.status !== "all") where.push(sql`t.status = ${q.status}`);
    if (q.q) where.push(sql`(t.dispatch_number ilike ${`%${q.q}%`} or t.vehicle_number ilike ${`%${q.q}%`} or t.driver_name ilike ${`%${q.q}%`})`);
    if (cursor) where.push(sql`(t.dispatch_date, t.id) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx.execute<{ id: string; dispatchDate: string }>(sql`
        select t.id, t.dispatch_number as "dispatchNumber", t.dispatch_date::text as "dispatchDate", t.vehicle_number as "vehicleNumber",
               coalesce(t.driver_name, (select e.name from employees e where e.id = t.driver_employee_id)) as "driverName", t.status::text as status,
               (select count(*)::int from dispatch_orders s where s.dispatch_id = t.id) as stops,
               (select count(*)::int from dispatch_orders s where s.dispatch_id = t.id and s.status in ('delivered', 'partially_delivered', 'returned')) as done,
               (select coalesce(sum(i.grand_total), 0)::text from dispatch_orders s join invoices i on i.id = s.invoice_id where s.dispatch_id = t.id) as value
        from dispatches t where ${sql.join(where, sql` and `)}
        order by t.dispatch_date desc, t.id desc limit ${q.limit + 1}`),
    );
    return page(rows.rows, q.limit, (x) => ({ v: x.dispatchDate, id: x.id }));
  });

  r.get("/dispatches/:id", { preHandler: guard(deps, "dispatch.view"), schema: { tags: ["dispatch"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => dispatchDetail(tx, request.ctx, request.params.id)),
  );

  r.post("/dispatches/:id/start", { preHandler: guard(deps, "dispatch.dispatch"), schema: { tags: ["dispatch"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [trip] = await tx.select().from(d).where(and(eq(d.id, request.params.id), eq(d.businessId, ctx.businessId))).for("update");
      if (!trip) throw notFound("dispatch");
      if (trip.status !== "planned") throw conflict("DISPATCH_NOT_PLANNED", { status: trip.status });
      await tx.update(d).set({ status: "dispatched", version: trip.version + 1, updatedBy: ctx.userId }).where(eq(d.id, trip.id));
      const moved = await tx.update(stops).set({ status: "dispatched", updatedBy: ctx.userId }).where(and(eq(stops.dispatchId, trip.id), eq(stops.status, "planned"))).returning({ salesOrderId: stops.salesOrderId });
      for (const orderId of new Set(moved.map((s) => s.salesOrderId).filter((x): x is string => Boolean(x)))) await advanceOrder(tx, ctx, orderId, ["packed", "dispatched"], trip.dispatchNumber ?? undefined);
      await history(tx, ctx, trip.id, "planned", "dispatched");
      await audit(tx, ctx, { action: "dispatch.dispatched", entityType: "dispatch", entityId: trip.id, entityLabel: trip.dispatchNumber ?? undefined });
      return dispatchDetail(tx, ctx, trip.id);
    });
  });

  /** Delivery update for one stop; the trip is complete when every stop has an outcome. */
  r.post("/dispatches/:id/stops/:stopId/deliver", { preHandler: guard(deps, "dispatch.deliver"), schema: { tags: ["dispatch"], params: StopParams, body: DeliveryBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return tenant(ctx, async (tx) => {
      const [trip] = await tx.select().from(d).where(and(eq(d.id, request.params.id), eq(d.businessId, ctx.businessId))).for("update");
      if (!trip) throw notFound("dispatch");
      if (trip.status !== "dispatched" && trip.status !== "in_transit") throw conflict("DISPATCH_NOT_ON_ROAD", { status: trip.status });
      const [stop] = await tx.select().from(stops).where(and(eq(stops.id, request.params.stopId), eq(stops.dispatchId, trip.id))).for("update");
      if (!stop) throw notFound("dispatch_stop");
      if (stop.status !== "dispatched" && stop.status !== "in_transit") throw conflict("STOP_ALREADY_CLOSED", { status: stop.status });
      await tx
        .update(stops)
        .set({ status: body.status, deliveredAt: deps.clock.now().toISOString(), receivedBy: body.receivedBy ?? null, remarks: body.remarks ?? null, updatedBy: ctx.userId })
        .where(eq(stops.id, stop.id));
      if (stop.salesOrderId && body.status !== "returned") await advanceOrder(tx, ctx, stop.salesOrderId, ["delivered"], trip.dispatchNumber ?? undefined);
      const all = await tx.select({ status: stops.status }).from(stops).where(eq(stops.dispatchId, trip.id));
      if (all.every((s) => s.status === "delivered" || s.status === "partially_delivered" || s.status === "returned")) {
        const final = all.every((s) => s.status === "delivered") ? ("delivered" as const) : ("partially_delivered" as const);
        await tx.update(d).set({ status: final, version: trip.version + 1, updatedBy: ctx.userId }).where(eq(d.id, trip.id));
        await history(tx, ctx, trip.id, trip.status, final);
      }
      await audit(tx, ctx, { action: `dispatch.stop_${body.status}`, entityType: "dispatch", entityId: trip.id, entityLabel: trip.dispatchNumber ?? undefined, changes: { stop: stop.id, receivedBy: body.receivedBy ?? null, remarks: body.remarks ?? null } });
      return dispatchDetail(tx, ctx, trip.id);
    });
  });

  r.post("/dispatches/:id/cancel", { preHandler: guard(deps, "dispatch.dispatch"), schema: { tags: ["dispatch"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [trip] = await tx.select().from(d).where(and(eq(d.id, request.params.id), eq(d.businessId, ctx.businessId))).for("update");
      if (!trip) throw notFound("dispatch");
      if (trip.status !== "planned") throw conflict("DISPATCH_NOT_PLANNED", { status: trip.status });
      await tx.update(d).set({ status: "cancelled", version: trip.version + 1, updatedBy: ctx.userId }).where(eq(d.id, trip.id));
      await tx.update(stops).set({ status: "cancelled", updatedBy: ctx.userId }).where(eq(stops.dispatchId, trip.id));
      await history(tx, ctx, trip.id, "planned", "cancelled");
      await audit(tx, ctx, { action: "dispatch.cancelled", entityType: "dispatch", entityId: trip.id, entityLabel: trip.dispatchNumber ?? undefined });
      return dispatchDetail(tx, ctx, trip.id);
    });
  });
};
