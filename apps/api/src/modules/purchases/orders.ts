import {
  PurchaseOrderBody,
  PurchaseOrderListQuery,
  PurchaseOrderStopBody,
  ReorderQuery,
  type GoodsReceiptStatus,
  type PurchaseOrderItemView,
  type PurchaseOrderRow,
  type PurchaseOrderStatus,
  type PurchaseOrderView,
  type ReorderRow,
} from "@digitalbahi/contracts";
import {
  calculateDocument,
  dec,
  determineSupplyType,
  orderLineProgress,
  reorderAdvice,
  resolveTax,
  taxAt,
  toAmountString,
  toQtyString,
  toRateString,
  type DocumentLineInput,
} from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { lockIdempotencyKey, withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { taxCategoriesOf } from "../../services/sales-document.js";
import { getSettings } from "../../services/settings.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const money = (d: { toFixed(n: number): string }) => d.toFixed(2);
/** Registrations that charge GST on their bills. Composition / unregistered suppliers issue a bill of supply. */
export const CHARGES_GST = new Set(["regular", "sez", "deemed_export"]);
export const PURCHASE_ORDER_SERIES = { name: "Purchase order", pattern: "PO/{FYS}/{SEQ:5}" };

/** The business's own supplier (not deleted). */
export async function supplierOf(tx: Tx, businessId: string, supplierId: string, field = "supplierId") {
  const [supplier] = await tx
    .select()
    .from(schema.suppliers)
    .where(and(eq(schema.suppliers.id, supplierId), eq(schema.suppliers.businessId, businessId), isNull(schema.suppliers.deletedAt)));
  if (!supplier) throw badRequest("REFERENCE_NOT_FOUND", {}, field);
  return supplier;
}

/** The godown asked for (in use), or the main one. */
export async function godownOf(tx: Tx, businessId: string, warehouseId: string | null | undefined) {
  const w = schema.warehouses;
  const [wh] = await tx
    .select({ id: w.id, name: w.name, isActive: w.isActive })
    .from(w)
    .where(and(eq(w.businessId, businessId), isNull(w.deletedAt), warehouseId ? eq(w.id, warehouseId) : eq(w.isDefault, true)));
  if (!wh) throw warehouseId ? badRequest("REFERENCE_NOT_FOUND", {}, "warehouseId") : new ApiError(409, "NO_DEFAULT_WAREHOUSE");
  if (!wh.isActive) throw conflict("GODOWN_INACTIVE", { godown: wh.name }, "warehouseId");
  return wh;
}

/** Each line's product, unit and base units per unit (a unit the product does not have is refused). */
export async function productsOfLines(tx: Tx, businessId: string, lines: ReadonlyArray<{ productId: string; unitId?: string | undefined }>) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.businessId, businessId), inArray(schema.products.id, ids), isNull(schema.products.deletedAt)));
  const byId = new Map(products.map((p) => [p.id, p]));
  const altUnits = await tx.select().from(schema.productUnits).where(inArray(schema.productUnits.productId, ids));
  const units = await tx.select({ id: schema.units.id, uqc: schema.units.uqc }).from(schema.units).where(eq(schema.units.businessId, businessId));
  return lines.map((line, i) => {
    const product = byId.get(line.productId);
    if (!product) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
    const unitId = line.unitId ?? product.baseUnitId;
    let factor = "1";
    if (unitId !== product.baseUnitId) {
      const alt = altUnits.find((u) => u.productId === product.id && u.unitId === unitId);
      if (!alt) throw badRequest("UNIT_NOT_ON_PRODUCT", { product: product.name }, `lines[${i}].unitId`);
      factor = alt.conversionFactor;
    }
    return { product, unitId, factor, uqc: units.find((u) => u.id === product.baseUnitId)?.uqc ?? null };
  });
}

/** An order with its lines' progress, the goods received against it and the bills that brought goods for it. */
export async function purchaseOrderView(tx: Tx, businessId: string, id: string): Promise<PurchaseOrderView> {
  const po = schema.purchaseOrders;
  const [o] = await tx.select().from(po).where(and(eq(po.id, id), eq(po.businessId, businessId)));
  if (!o) throw notFound("purchase_order");
  const items = await tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, id)).orderBy(asc(schema.purchaseOrderItems.lineNo));
  const gr = schema.goodsReceipts;
  const receipts = await tx
    .select({ id: gr.id, receiptNumber: gr.receiptNumber, receivedDate: gr.receivedDate, status: gr.status })
    .from(gr)
    .where(and(eq(gr.businessId, businessId), eq(gr.purchaseOrderId, id)))
    .orderBy(asc(gr.receivedDate), asc(gr.id));
  const bills = items.length
    ? (
        await tx.execute<{ id: string; purchase_number: string | null; supplier_invoice_number: string; supplier_invoice_date: string; status: string }>(sql`
          select distinct p.id, p.purchase_number, p.supplier_invoice_number, p.supplier_invoice_date::text, p.status::text
          from purchases p
          where p.business_id = ${businessId}
            and exists (select 1 from purchase_items pi where pi.purchase_id = p.id and pi.purchase_order_item_id in (${sql.join(items.map((i) => sql`${i.id}::uuid`), sql`, `)}))
          order by p.supplier_invoice_date::text, p.id`)
      ).rows
    : [];
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    orderDate: o.orderDate,
    expectedDate: o.expectedDate,
    supplierId: o.supplierId,
    partyName: o.partyName,
    partyGstin: o.partyGstin,
    warehouseId: o.warehouseId,
    status: o.status,
    supplyType: o.supplyType,
    taxableTotal: o.taxableTotal,
    cgstTotal: o.cgstTotal,
    sgstTotal: o.sgstTotal,
    igstTotal: o.igstTotal,
    cessTotal: o.cessTotal,
    roundOff: o.roundOff,
    grandTotal: o.grandTotal,
    notes: o.notes,
    closedAt: o.closedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt,
    items: items.map((i): PurchaseOrderItemView => {
      const p = orderLineProgress(i);
      return {
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
        gstRate: i.gstRate,
        taxableValue: i.taxableValue,
        lineTotal: i.lineTotal,
        orderedBase: toQtyString(p.ordered),
        receivedBase: toQtyString(p.received),
        remainingBase: toQtyString(p.remaining),
      };
    }),
    receipts: receipts.map((r) => ({ ...r, status: r.status as GoodsReceiptStatus })),
    bills: bills.map((b) => ({ id: b.id, purchaseNumber: b.purchase_number, supplierInvoiceNumber: b.supplier_invoice_number, supplierInvoiceDate: b.supplier_invoice_date, status: b.status })),
  };
}

/**
 * Orders to suppliers and what to order. An order is priced like a bill (the
 * supplier's GST, the order's rates) so it can be sent, and goods received
 * against it count on its lines; it moves no stock and no money.
 */
export const purchaseOrdersModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.post("/purchase-orders", { preHandler: guard(deps, "purchase.order"), schema: { tags: ["purchases"], body: PurchaseOrderBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        await lockIdempotencyKey(tx, clientId);
        const [existing] = await tx
          .select({ id: schema.purchaseOrders.id })
          .from(schema.purchaseOrders)
          .where(and(eq(schema.purchaseOrders.businessId, ctx.businessId), eq(schema.purchaseOrders.clientId, clientId)));
        if (existing) return { replay: true, view: await purchaseOrderView(tx, ctx.businessId, existing.id) };
      }
      const today = deps.clock.today(ctx.timeZone);
      const orderDate = body.orderDate ?? today;
      if (orderDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "orderDate");
      if (body.expectedDate && body.expectedDate < orderDate) throw badRequest("EXPECTED_BEFORE_ORDER", {}, "expectedDate");
      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const supplier = await supplierOf(tx, ctx.businessId, body.supplierId);
      const wh = await godownOf(tx, ctx.businessId, body.warehouseId);
      const meta = await productsOfLines(tx, ctx.businessId, body.lines);
      const categories = await taxCategoriesOf(tx, ctx.businessId);
      const taxes = body.lines.map((line, i) => (line.gstRate !== undefined ? taxAt(line.gstRate) : resolveTax(categories.get(meta[i]!.product.taxCategoryId)!, { date: orderDate })));
      const supplyType = determineSupplyType({ supplierStateCode: supplier.stateCode, placeOfSupplyStateCode: business!.stateCode, recipientRegistration: "regular" });
      const engine: DocumentLineInput[] = body.lines.map((line, i) => ({
        key: `L${i + 1}`,
        qty: line.qty,
        rate: line.rate,
        discountPercent: line.discountPercent,
        discountAmount: "0",
        conversionFactor: meta[i]!.factor,
        tax: taxes[i]!,
        hsnCode: meta[i]!.product.hsnCode,
        uqc: meta[i]!.uqc,
      }));
      const settings = await getSettings(tx, ctx.businessId, ["invoice.round_off"] as const);
      const t = calculateDocument({ lines: engine, supplyType, chargeTax: CHARGES_GST.has(supplier.gstRegistration), charges: [], roundOff: settings["invoice.round_off"] });
      if (body.clientTotals?.grandTotal !== undefined && !dec(body.clientTotals.grandTotal).eq(t.grandTotal)) {
        throw new ApiError(422, "TOTALS_MISMATCH", { field: "grandTotal", expected: t.grandTotal.toFixed(2), received: dec(body.clientTotals.grandTotal).toFixed(2) });
      }
      const numbering = await nextDocumentNumber(tx, ctx.businessId, "purchase_order", orderDate, business!.financialYearStartMonth, PURCHASE_ORDER_SERIES);
      const id = uuidv7();
      await tx.insert(schema.purchaseOrders).values({
        id,
        businessId: ctx.businessId,
        orderNumber: numbering.number,
        seriesId: numbering.seriesId,
        financialYear: numbering.financialYear,
        orderDate,
        expectedDate: body.expectedDate ?? null,
        supplierId: supplier.id,
        warehouseId: wh.id,
        partyName: supplier.companyName ?? supplier.name,
        partyGstin: supplier.gstin,
        partyStateCode: supplier.stateCode,
        billingAddress: { line1: supplier.addressLine1, line2: supplier.addressLine2, city: supplier.city, stateCode: supplier.stateCode, pincode: supplier.pincode },
        placeOfSupply: business!.stateCode,
        supplyType,
        taxEngineVersion: "gst-line@1",
        status: "open",
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
      await tx.insert(schema.purchaseOrderItems).values(
        body.lines.map((line, i) => {
          const m = meta[i]!;
          const l = t.lines[i]!;
          return {
            id: uuidv7(),
            businessId: ctx.businessId,
            purchaseOrderId: id,
            lineNo: i + 1,
            productId: m.product.id,
            productName: m.product.name,
            hsnCode: m.product.hsnCode,
            uqc: m.uqc,
            unitId: m.unitId,
            conversionFactor: m.factor,
            qty: toQtyString(l.qty),
            freeQty: line.freeQty,
            qtyBase: toQtyString(l.qtyBase),
            rate: toRateString(l.rate),
            grossAmount: money(l.gross),
            discountPercent: line.discountPercent,
            discountAmount: money(l.lineDiscount),
            taxableValue: money(l.taxable),
            taxability: taxes[i]!.kind,
            taxCategoryId: m.product.taxCategoryId,
            taxRateId: taxes[i]!.ruleId,
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
          };
        }),
      );
      await audit(tx, ctx, {
        action: "purchase_order.created",
        entityType: "purchase_order",
        entityId: id,
        entityLabel: numbering.number,
        changes: { supplier: supplier.name, lines: body.lines.length, grandTotal: toAmountString(t.grandTotal) },
      });
      return { replay: false, view: await purchaseOrderView(tx, ctx.businessId, id) };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.view);
  });

  r.get("/purchase-orders", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], querystring: PurchaseOrderListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [sql`o.business_id = ${ctx.businessId}`];
    if (q.supplierId) where.push(sql`o.supplier_id = ${q.supplierId}`);
    if (q.status === "pending") where.push(sql`o.status in ('open', 'partly_received')`);
    else if (q.status !== "all") where.push(sql`o.status = ${q.status}`);
    if (q.from) where.push(sql`o.order_date >= ${q.from}`);
    if (q.to) where.push(sql`o.order_date <= ${q.to}`);
    if (q.q) where.push(sql`(o.order_number ilike ${likeContains(q.q)} or o.party_name ilike ${likeContains(q.q)})`);
    if (cursor) where.push(sql`(o.order_date, o.id) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{ id: string; order_number: string; order_date: string; expected_date: string | null; supplier_id: string; party_name: string; status: PurchaseOrderStatus; grand_total: string; lines: number; pending_lines: number }>(sql`
          select o.id, o.order_number, o.order_date::text, o.expected_date::text, o.supplier_id, o.party_name, o.status::text as status, o.grand_total::text,
                 (select count(*)::int from purchase_order_items i where i.purchase_order_id = o.id) as lines,
                 (select count(*)::int from purchase_order_items i where i.purchase_order_id = o.id and (i.qty + i.free_qty) * i.conversion_factor > i.received_qty) as pending_lines
          from purchase_orders o
          where ${sql.join(where, sql` and `)}
          order by o.order_date desc, o.id desc
          limit ${q.limit + 1}`)
      ).rows,
    );
    const data = rows.map(
      (x): PurchaseOrderRow => ({
        id: x.id,
        orderNumber: x.order_number,
        orderDate: x.order_date,
        expectedDate: x.expected_date,
        supplierId: x.supplier_id,
        partyName: x.party_name,
        status: x.status,
        grandTotal: x.grand_total,
        lines: x.lines,
        pendingLines: x.status === "open" || x.status === "partly_received" ? x.pending_lines : 0,
      }),
    );
    return page(data, q.limit, (x) => ({ v: x.orderDate, id: x.id }));
  });

  /**
   * What to order: every product running short (of one supplier: the one it
   * is usually bought from, else the last one it was bought from), with its
   * stock, pace of sales, what is already on order and the suggested
   * quantity in the pack it is bought in.
   */
  r.get("/purchase-orders/reorder", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], querystring: ReorderQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const today = deps.clock.today(ctx.timeZone);
    const since = new Date(Date.parse(today) - q.days * 86_400_000).toISOString().slice(0, 10);
    const wh = (column: string) => (q.warehouseId ? sql`and ${sql.raw(column)} = ${q.warehouseId}` : sql``);
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{
          id: string;
          code: string;
          name: string;
          unit: string;
          min_stock: string | null;
          reorder_qty: string | null;
          purchase_price: string;
          supplier_id: string | null;
          supplier_name: string | null;
          on_hand: string;
          on_order: string;
          sold: string;
          pack_unit_id: string | null;
          pack_symbol: string | null;
          pack_factor: string | null;
          base_unit_id: string;
        }>(sql`
          -- Sold less returned, in the base unit.
          with sold as (
            select l.product_id, sum(l.qty_out - l.qty_in) as qty
            from stock_ledger l
            where l.business_id = ${ctx.businessId} and l.movement_type in ('sale', 'sale_return') and l.txn_date > ${since}::date and l.txn_date <= ${today}::date ${wh("l.warehouse_id")}
            group by l.product_id
          ),
          stock as (
            select sb.product_id, sum(sb.qty) as qty from stock_balances sb where sb.business_id = ${ctx.businessId} ${wh("sb.warehouse_id")} group by sb.product_id
          ),
          ordered as (
            select i.product_id, sum(greatest((i.qty + i.free_qty) * i.conversion_factor - i.received_qty, 0)) as qty
            from purchase_order_items i join purchase_orders o on o.id = i.purchase_order_id
            where o.business_id = ${ctx.businessId} and o.status in ('open', 'partly_received') ${wh("o.warehouse_id")}
            group by i.product_id
          ),
          last_bought as (
            select distinct on (pi.product_id) pi.product_id, pu.supplier_id
            from purchase_items pi join purchases pu on pu.id = pi.purchase_id
            where pu.business_id = ${ctx.businessId} and pu.status = 'posted'
            order by pi.product_id, pu.supplier_invoice_date desc, pu.id desc
          )
          select p.id, p.code, p.name, u.symbol as unit, p.min_stock::text, p.reorder_qty::text, p.purchase_price::text, p.base_unit_id,
                 s.id as supplier_id, coalesce(s.company_name, s.name) as supplier_name,
                 coalesce(st.qty, 0)::text as on_hand, coalesce(od.qty, 0)::text as on_order, coalesce(sd.qty, 0)::text as sold,
                 pk.unit_id as pack_unit_id, pk.symbol as pack_symbol, pk.conversion_factor::text as pack_factor
          from products p
          join units u on u.id = p.base_unit_id
          left join last_bought lb on lb.product_id = p.id
          left join suppliers s on s.id = coalesce(p.preferred_supplier_id, lb.supplier_id)
          left join stock st on st.product_id = p.id
          left join ordered od on od.product_id = p.id
          left join sold sd on sd.product_id = p.id
          left join lateral (
            select pu2.unit_id, pu2.conversion_factor, u2.symbol from product_units pu2 join units u2 on u2.id = pu2.unit_id
            where pu2.product_id = p.id order by pu2.is_default_purchase desc, pu2.conversion_factor desc limit 1
          ) pk on true
          where p.business_id = ${ctx.businessId} and p.deleted_at is null and p.is_active
            and (sd.qty > 0 or p.min_stock is not null)
            ${q.supplierId ? sql`and s.id = ${q.supplierId}` : sql``}
          order by p.name, p.id
          limit 3000`)
      ).rows,
    );
    const ORDER = { out: 0, below_min: 1, runs_out: 2 } as const;
    const data: ReorderRow[] = [];
    for (const x of rows) {
      const factor = x.pack_factor ?? "1";
      const a = reorderAdvice(
        { onHand: x.on_hand, onOrder: x.on_order, soldInWindow: x.sold, windowDays: q.days, minStock: x.min_stock, reorderQty: x.reorder_qty, packFactor: factor },
        { leadDays: q.lead, coverDays: q.cover },
      );
      if (!a.reason || a.suggestBase.lte(0)) continue;
      data.push({
        productId: x.id,
        code: x.code,
        name: x.name,
        unit: x.unit,
        supplierId: x.supplier_id,
        supplierName: x.supplier_name,
        onHand: toQtyString(x.on_hand),
        onOrder: toQtyString(x.on_order),
        perDay: a.perDay.toDecimalPlaces(3).toString(),
        daysLeft: a.daysLeft === null ? null : a.daysLeft.toDecimalPlaces(1).toString(),
        minStock: x.min_stock,
        reason: a.reason,
        suggestBase: toQtyString(a.suggestBase),
        unitId: x.pack_unit_id ?? x.base_unit_id,
        unitSymbol: x.pack_symbol ?? x.unit,
        factor: toQtyString(factor),
        qty: toQtyString(a.suggestPacks),
        purchasePrice: x.purchase_price,
      });
    }
    data.sort((a, b) => ORDER[a.reason] - ORDER[b.reason] || Number(a.daysLeft ?? Infinity) - Number(b.daysLeft ?? Infinity) || a.name.localeCompare(b.name));
    return { asOf: today, days: q.days, cover: q.cover, lead: q.lead, data: data.slice(0, 500) };
  });

  r.get("/purchase-orders/:id", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => purchaseOrderView(tx, request.ctx.businessId, request.params.id)),
  );

  /** No more goods will come against the order: what is still to come is no longer expected. */
  r.post(
    "/purchase-orders/:id/close",
    { preHandler: guard(deps, "purchase.order"), schema: { tags: ["purchases"], params: IdParams, body: PurchaseOrderStopBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const po = schema.purchaseOrders;
        const [o] = await tx.select().from(po).where(and(eq(po.id, request.params.id), eq(po.businessId, ctx.businessId))).for("update");
        if (!o) throw notFound("purchase_order");
        if (o.status !== "open" && o.status !== "partly_received") throw conflict("PURCHASE_ORDER_NOT_OPEN", { number: o.orderNumber, status: o.status });
        await tx
          .update(po)
          .set({ status: "closed", closedAt: deps.clock.now().toISOString(), closedBy: ctx.userId, cancelReason: request.body.reason ?? null, updatedBy: ctx.userId, version: o.version + 1 })
          .where(eq(po.id, o.id));
        await audit(tx, ctx, { action: "purchase_order.closed", entityType: "purchase_order", entityId: o.id, entityLabel: o.orderNumber, changes: { reason: request.body.reason ?? null } });
        return purchaseOrderView(tx, ctx.businessId, o.id);
      });
    },
  );

  /** An order nothing came against is cancelled (one that had goods is closed instead). */
  r.post(
    "/purchase-orders/:id/cancel",
    { preHandler: guard(deps, "purchase.order"), schema: { tags: ["purchases"], params: IdParams, body: PurchaseOrderStopBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const po = schema.purchaseOrders;
        const [o] = await tx.select().from(po).where(and(eq(po.id, request.params.id), eq(po.businessId, ctx.businessId))).for("update");
        if (!o) throw notFound("purchase_order");
        if (o.status === "cancelled" || o.status === "closed") throw conflict("PURCHASE_ORDER_NOT_OPEN", { number: o.orderNumber, status: o.status });
        const [came] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.purchaseOrderItems)
          .where(and(eq(schema.purchaseOrderItems.purchaseOrderId, o.id), sql`${schema.purchaseOrderItems.receivedQty} > 0`));
        const [receipts] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.goodsReceipts)
          .where(and(eq(schema.goodsReceipts.purchaseOrderId, o.id), sql`${schema.goodsReceipts.status} <> 'cancelled'`));
        if (Number(came?.n ?? 0) > 0 || Number(receipts?.n ?? 0) > 0) throw conflict("PURCHASE_ORDER_RECEIVED", { number: o.orderNumber });
        await tx
          .update(po)
          .set({ status: "cancelled", cancelledAt: deps.clock.now().toISOString(), cancelledBy: ctx.userId, cancelReason: request.body.reason ?? null, updatedBy: ctx.userId, version: o.version + 1 })
          .where(eq(po.id, o.id));
        await audit(tx, ctx, { action: "purchase_order.cancelled", entityType: "purchase_order", entityId: o.id, entityLabel: o.orderNumber, changes: { reason: request.body.reason ?? null } });
        return purchaseOrderView(tx, ctx.businessId, o.id);
      });
    },
  );
};
