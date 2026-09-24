import { CancelBody, PurchaseBody, PurchaseListQuery } from "@vyapaar/contracts";
import {
  addDays,
  apportion,
  calculateDocument,
  dec,
  determineSupplyType,
  financialYearOf,
  resolveTax,
  taxAt,
  toAmountString,
  toQtyString,
  toRateString,
  type DocumentLineInput,
  type PartyGstRegistration,
  type ResolvedTax,
  type TaxCategory,
  type TaxRateRule,
} from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { postPartyEntry } from "../../services/party-ledger.js";
import { recordPayment, releaseAllocations } from "../../services/payments.js";
import { getSettings } from "../../services/settings.js";
import { postStockMovement } from "../../services/stock.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
type Body = z.output<typeof PurchaseBody>;
const money = (d: { toFixed(n: number): string }) => d.toFixed(2);

/** Registrations that charge GST on their bills. Composition / unregistered suppliers issue a bill of supply. */
const CHARGES_GST = new Set(["regular", "sez", "deemed_export"]);

async function purchaseDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [p] = await tx.select().from(schema.purchases).where(and(eq(schema.purchases.id, id), eq(schema.purchases.businessId, ctx.businessId)));
  if (!p) throw notFound("purchase");
  const items = await tx.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, id)).orderBy(asc(schema.purchaseItems.lineNo));
  const payments = await tx
    .select({
      paymentId: schema.payments.id,
      paymentNumber: schema.payments.paymentNumber,
      paymentDate: schema.payments.paymentDate,
      method: schema.payments.method,
      amount: schema.paymentAllocations.amount,
      reversedAt: schema.paymentAllocations.reversedAt,
    })
    .from(schema.paymentAllocations)
    .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentAllocations.paymentId))
    .where(eq(schema.paymentAllocations.purchaseId, id));
  const { businessId: _b, ...rest } = p;
  return { ...rest, items: items.map(({ businessId: _ib, ...i }) => i), payments };
}

export const purchasesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /**
   * Posts a supplier bill: stock in (with batch / expiry), landed cost into
   * the moving-average cost, supplier ledger credit, inward GST rows with ITC
   * eligibility, optional payment. The same supplier bill cannot be entered twice.
   */
  r.post("/purchases", { preHandler: guard(deps, "purchase.create"), schema: { tags: ["purchases"], body: PurchaseBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body: Body = request.body;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");

    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        const [existing] = await tx
          .select({ id: schema.purchases.id })
          .from(schema.purchases)
          .where(and(eq(schema.purchases.businessId, ctx.businessId), eq(schema.purchases.clientId, clientId)));
        if (existing) return { replay: true, detail: await purchaseDetail(tx, ctx, existing.id) };
      }
      const today = deps.clock.today(ctx.timeZone);
      const receivedDate = body.receivedDate ?? today;
      if (receivedDate > today || body.supplierInvoiceDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "supplierInvoiceDate");
      if (body.supplierInvoiceDate > receivedDate) throw badRequest("BILL_AFTER_RECEIPT", {}, "supplierInvoiceDate");

      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const [supplier] = await tx
        .select()
        .from(schema.suppliers)
        .where(and(eq(schema.suppliers.id, body.supplierId), eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt)));
      if (!supplier) throw badRequest("REFERENCE_NOT_FOUND", {}, "supplierId");
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
      const [altUnits, unitRows, categories, rules] = await Promise.all([
        tx.select().from(schema.productUnits).where(inArray(schema.productUnits.productId, productIds)),
        tx.select().from(schema.units).where(eq(schema.units.businessId, ctx.businessId)),
        tx.select().from(schema.taxCategories).where(eq(schema.taxCategories.businessId, ctx.businessId)),
        tx.select().from(schema.taxRates).where(eq(schema.taxRates.businessId, ctx.businessId)),
      ]);
      const categoryOf = (id: string): TaxCategory => {
        const c = categories.find((x) => x.id === id)!;
        return {
          id: c.id,
          name: c.name,
          kind: c.kind,
          rules: rules
            .filter((x) => x.taxCategoryId === id)
            .map((x): TaxRateRule => ({ id: x.id, effectiveFrom: x.effectiveFrom, effectiveTo: x.effectiveTo, gstRate: x.gstRate, cessRate: x.cessRate, cessPerUnit: x.cessPerUnit, condition: (x.condition as TaxRateRule["condition"]) ?? null, priority: x.priority })),
        };
      };

      // Goods are received here, so our state is the place of supply.
      const supplyType = determineSupplyType({
        supplierStateCode: supplier.stateCode,
        placeOfSupplyStateCode: business!.stateCode,
        recipientRegistration: "regular" as PartyGstRegistration,
      });
      const supplierChargesGst = CHARGES_GST.has(supplier.gstRegistration);

      const lineMeta = body.lines.map((line, i) => {
        const product = byId.get(line.productId);
        if (!product) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
        const unitId = line.unitId ?? product.baseUnitId;
        let factor = "1";
        if (unitId !== product.baseUnitId) {
          const alt = altUnits.find((u) => u.productId === product.id && u.unitId === unitId);
          if (!alt) throw badRequest("UNIT_NOT_ON_PRODUCT", { product: product.name }, `lines[${i}].unitId`);
          factor = alt.conversionFactor;
        }
        if (product.trackBatches && !line.batchNumber) throw badRequest("BATCH_REQUIRED", { product: product.name }, `lines[${i}].batchNumber`);
        if (product.trackExpiry && !line.expiryDate) throw badRequest("EXPIRY_REQUIRED", { product: product.name }, `lines[${i}].expiryDate`);
        const tax: ResolvedTax = line.gstRate !== undefined ? taxAt(line.gstRate) : resolveTax(categoryOf(product.taxCategoryId), { date: body.supplierInvoiceDate });
        return { product, unitId, factor, tax, uqc: unitRows.find((u) => u.id === product.baseUnitId)?.uqc ?? null };
      });

      const engineLines: DocumentLineInput[] = body.lines.map((line, i) => ({
        key: `L${i + 1}`,
        qty: line.qty,
        rate: line.rate,
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
        conversionFactor: lineMeta[i]!.factor,
        tax: lineMeta[i]!.tax,
        hsnCode: lineMeta[i]!.product.hsnCode,
        uqc: lineMeta[i]!.uqc,
      }));
      const settings = await getSettings(tx, ctx.businessId, ["invoice.round_off"] as const);
      const charges = body.charges.map((c, i) => ({ key: `C${i + 1}`, label: c.label, amount: c.amount, tax: c.gstRate ? taxAt(c.gstRate) : null }));
      // Under reverse charge the supplier's bill carries no tax; we still record (and pay) the GST ourselves.
      const payable = calculateDocument({
        lines: engineLines,
        supplyType,
        chargeTax: supplierChargesGst && !body.isReverseCharge,
        charges,
        roundOff: settings["invoice.round_off"],
        amountPaid: body.payment?.amount ?? "0",
      });
      const taxView = body.isReverseCharge
        ? calculateDocument({ lines: engineLines, supplyType, chargeTax: true, charges, roundOff: { mode: "none", step: 1 } })
        : payable;

      if (body.clientTotals) {
        const expected = { taxableTotal: payable.taxableTotal, taxTotal: payable.taxTotal, roundOff: payable.roundOff, grandTotal: payable.grandTotal };
        for (const field of ["taxableTotal", "taxTotal", "roundOff", "grandTotal"] as const) {
          const received = body.clientTotals[field];
          if (received !== undefined && !dec(received).eq(expected[field])) {
            throw new ApiError(422, "TOTALS_MISMATCH", { field, expected: expected[field].toFixed(2), received: dec(received).toFixed(2) });
          }
        }
      }

      // Landed cost per base unit: line value + its share of charges (+ GST when no ITC can be claimed).
      const chargeCost = payable.charges.reduce((acc, ch) => acc.plus(ch.taxable), dec(0));
      const shares = chargeCost.isZero() ? payable.lines.map(() => dec(0)) : apportion(chargeCost, payable.lines.map((l) => l.taxable));
      const noItc = body.itcEligibility === "ineligible";

      const numbering = await nextDocumentNumber(tx, ctx.businessId, "purchase", receivedDate, business!.financialYearStartMonth);
      const fy = financialYearOf(body.supplierInvoiceDate, business!.financialYearStartMonth).label;
      const id = uuidv7();
      const address = { line1: supplier.addressLine1, line2: supplier.addressLine2, city: supplier.city, stateCode: supplier.stateCode, pincode: supplier.pincode };
      const t = payable;
      await tx.insert(schema.purchases).values({
        id,
        businessId: ctx.businessId,
        purchaseNumber: numbering.number,
        seriesId: numbering.seriesId,
        financialYear: fy,
        supplierId: supplier.id,
        supplierInvoiceNumber: body.supplierInvoiceNumber,
        supplierInvoiceDate: body.supplierInvoiceDate,
        receivedDate,
        dueDate: addDays(body.supplierInvoiceDate, supplier.creditDays),
        warehouseId: wh.id,
        partyName: supplier.companyName ?? supplier.name,
        partyGstin: supplier.gstin,
        partyStateCode: supplier.stateCode,
        billingAddress: address,
        placeOfSupply: business!.stateCode,
        supplyType,
        isReverseCharge: body.isReverseCharge,
        taxEngineVersion: "gst-line@1",
        itcEligibility: body.itcEligibility,
        status: "posted",
        grossTotal: toAmountString(t.grossTotal),
        discountTotal: toAmountString(t.discountTotal),
        taxableTotal: toAmountString(taxView.taxableTotal),
        cgstTotal: toAmountString(taxView.cgstTotal),
        sgstTotal: toAmountString(taxView.sgstTotal),
        igstTotal: toAmountString(taxView.igstTotal),
        cessTotal: toAmountString(taxView.cessTotal),
        charges: t.charges.map((ch) => ({ key: ch.key, label: ch.label, taxable: money(ch.taxable), gstRate: ch.gstRate.toFixed(3), total: money(ch.total) })),
        chargesTotal: toAmountString(t.chargesTotal),
        roundOff: toAmountString(t.roundOff),
        grandTotal: toAmountString(t.grandTotal),
        amountPaid: "0",
        balanceDue: toAmountString(t.grandTotal),
        paymentStatus: t.grandTotal.isZero() ? "paid" : "unpaid",
        notes: body.notes ?? null,
        postedAt: deps.clock.now().toISOString(),
        postedBy: ctx.userId,
        clientId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

      const itemIds = body.lines.map(() => uuidv7());
      const items = [];
      for (const [i, line] of body.lines.entries()) {
        const meta = lineMeta[i]!;
        const l = t.lines[i]!;
        const taxLine = taxView.lines[i]!;
        let batchId: string | null = null;
        if (line.batchNumber) {
          await tx
            .insert(schema.batches)
            .values({
              id: uuidv7(),
              businessId: ctx.businessId,
              productId: meta.product.id,
              batchNumber: line.batchNumber,
              mfgDate: line.mfgDate ?? null,
              expiryDate: line.expiryDate ?? null,
              mrp: line.mrp ?? null,
              purchaseRate: toRateString(dec(line.rate).dividedBy(meta.factor)),
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            })
            .onConflictDoNothing();
          const [batch] = await tx
            .select({ id: schema.batches.id })
            .from(schema.batches)
            .where(and(eq(schema.batches.productId, meta.product.id), eq(schema.batches.batchNumber, line.batchNumber)));
          batchId = batch!.id;
        }
        const freeBase = dec(line.freeQty).times(meta.factor);
        const unitsIn = l.qtyBase.plus(freeBase);
        const cost = l.taxable.plus(shares[i]!).plus(noItc ? taxLine.taxTotal : 0);
        const landed = unitsIn.isZero() ? dec(0) : cost.dividedBy(unitsIn);
        items.push({ meta, l, taxLine, batchId, unitsIn, landed, line });
        await tx.insert(schema.purchaseItems).values({
          id: itemIds[i]!,
          businessId: ctx.businessId,
          purchaseId: id,
          lineNo: i + 1,
          productId: meta.product.id,
          productName: meta.product.name,
          hsnCode: meta.product.hsnCode,
          uqc: meta.uqc,
          unitId: meta.unitId,
          conversionFactor: meta.factor,
          qty: toQtyString(l.qty),
          freeQty: line.freeQty,
          qtyBase: toQtyString(l.qtyBase),
          rate: toRateString(l.rate),
          grossAmount: money(l.gross),
          discountPercent: line.discountPercent,
          discountAmount: money(l.lineDiscount),
          taxableValue: money(taxLine.taxable),
          taxability: meta.tax.kind,
          taxCategoryId: meta.product.taxCategoryId,
          taxRateId: meta.tax.ruleId,
          gstRate: taxLine.gstRate.toFixed(3),
          cgstRate: taxLine.cgstRate.toFixed(3),
          cgstAmount: money(taxLine.cgst),
          sgstRate: taxLine.sgstRate.toFixed(3),
          sgstAmount: money(taxLine.sgst),
          igstRate: taxLine.igstRate.toFixed(3),
          igstAmount: money(taxLine.igst),
          cessRate: taxLine.cessRate.toFixed(3),
          cessAmount: money(taxLine.cess),
          lineTotal: money(l.total),
          batchId,
          batchNumber: line.batchNumber ?? null,
          mfgDate: line.mfgDate ?? null,
          expiryDate: line.expiryDate ?? null,
          mrp: line.mrp ?? null,
          landedUnitCost: toRateString(landed),
        });
      }

      // Stock in (product order), moving-average cost, last purchase rate.
      for (const it of [...items].sort((a, b) => a.meta.product.id.localeCompare(b.meta.product.id))) {
        const i = items.indexOf(it);
        await postStockMovement(
          tx,
          {
            businessId: ctx.businessId,
            productId: it.meta.product.id,
            productName: it.meta.product.name,
            warehouseId: wh.id,
            batchId: it.batchId,
            date: receivedDate,
            type: "purchase",
            qty: toQtyString(it.unitsIn),
            unitCost: toRateString(it.landed),
            refType: "purchase",
            refId: id,
            refLineId: itemIds[i]!,
            refNumber: body.supplierInvoiceNumber,
            userId: ctx.userId,
          },
          "allow",
        );
        await tx
          .update(schema.products)
          .set({ purchasePrice: toRateString(dec(it.line.rate).dividedBy(it.meta.factor)) })
          .where(eq(schema.products.id, it.meta.product.id));
      }

      await postPartyEntry(tx, {
        businessId: ctx.businessId,
        party: { type: "supplier", id: supplier.id },
        date: body.supplierInvoiceDate,
        docType: "purchase",
        docId: id,
        docNumber: body.supplierInvoiceNumber,
        credit: toAmountString(t.grandTotal),
        narration: `Purchase bill ${body.supplierInvoiceNumber}`,
        userId: ctx.userId,
      });

      const gstBase = {
        businessId: ctx.businessId,
        direction: "inward" as const,
        docType: "purchase" as const,
        docId: id,
        docNumber: body.supplierInvoiceNumber,
        docDate: body.supplierInvoiceDate,
        returnPeriod: body.supplierInvoiceDate.slice(0, 7),
        partyName: supplier.companyName ?? supplier.name,
        partyGstin: supplier.gstin,
        partyRegistration: supplier.gstRegistration,
        partyStateCode: supplier.stateCode,
        placeOfSupply: business!.stateCode,
        supplyType,
        isReverseCharge: body.isReverseCharge,
        documentValue: toAmountString(t.grandTotal),
        itcEligibility: body.itcEligibility,
      };
      await tx.insert(schema.gstTransactions).values(
        items.map((it, i) => ({
          ...gstBase,
          docLineId: itemIds[i]!,
          taxability: it.meta.tax.kind,
          hsnCode: it.meta.product.hsnCode,
          uqc: it.meta.uqc,
          qty: toQtyString(it.l.qtyBase),
          taxableValue: money(it.taxLine.taxable),
          gstRate: it.taxLine.gstRate.toFixed(3),
          cgstAmount: money(it.taxLine.cgst),
          sgstAmount: money(it.taxLine.sgst),
          igstAmount: money(it.taxLine.igst),
          cessAmount: money(it.taxLine.cess),
        })),
      );

      let payment = null;
      if (body.payment && dec(body.payment.amount).gt(0)) {
        const settle = t.amountPaid.gt(t.grandTotal) ? t.grandTotal : t.amountPaid;
        payment = await recordPayment(tx, ctx, business!.financialYearStartMonth, {
          direction: "out",
          party: { type: "supplier", id: supplier.id, name: supplier.name },
          date: receivedDate,
          amount: body.payment.amount,
          method: body.payment.method,
          referenceNumber: body.payment.reference ?? null,
          paymentAccountId: body.payment.paymentAccountId ?? null,
          allocations: settle.gt(0) ? [{ documentId: id, amount: settle.toFixed(2) }] : [],
        });
      }

      await audit(tx, ctx, {
        action: "purchase.posted",
        entityType: "purchase",
        entityId: id,
        entityLabel: `${numbering.number} (${body.supplierInvoiceNumber})`,
        changes: { supplier: supplier.name, grandTotal: toAmountString(t.grandTotal) },
      });
      await tx.insert(schema.outboxEvents).values({
        businessId: ctx.businessId,
        eventType: "purchase.posted",
        aggregateType: "purchase",
        aggregateId: id,
        payload: { supplierId: supplier.id, grandTotal: toAmountString(t.grandTotal) },
      });
      return { replay: false, detail: { ...(await purchaseDetail(tx, ctx, id)), ...(payment ? { payment } : {}) } };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.detail);
  });

  r.get("/purchases", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], querystring: PurchaseListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const p = schema.purchases;
    const where: SQL[] = [eq(p.businessId, ctx.businessId), sql`${p.status} <> 'draft'`];
    if (q.supplierId) where.push(eq(p.supplierId, q.supplierId));
    if (q.from) where.push(sql`${p.supplierInvoiceDate} >= ${q.from}`);
    if (q.to) where.push(sql`${p.supplierInvoiceDate} <= ${q.to}`);
    if (q.status !== "all") where.push(eq(p.status, q.status));
    if (q.q) where.push(sql`(${p.supplierInvoiceNumber} ilike ${likeContains(q.q)} or ${p.purchaseNumber} ilike ${likeContains(q.q)} or ${p.partyName} ilike ${likeContains(q.q)})`);
    if (cursor) where.push(sql`(${p.supplierInvoiceDate}, ${p.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: p.id,
          purchaseNumber: p.purchaseNumber,
          supplierInvoiceNumber: p.supplierInvoiceNumber,
          supplierInvoiceDate: p.supplierInvoiceDate,
          supplierId: p.supplierId,
          partyName: p.partyName,
          grandTotal: p.grandTotal,
          balanceDue: p.balanceDue,
          paymentStatus: p.paymentStatus,
          status: p.status,
        })
        .from(p)
        .where(and(...where))
        .orderBy(sql`${p.supplierInvoiceDate} desc, ${p.id} desc`)
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.supplierInvoiceDate, id: x.id }));
  });

  r.get("/purchases/:id", { preHandler: guard(deps, "purchase.view"), schema: { tags: ["purchases"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => purchaseDetail(tx, request.ctx, request.params.id)),
  );

  r.post(
    "/purchases/:id/cancel",
    { preHandler: guard(deps, "purchase.cancel"), schema: { tags: ["purchases"], params: IdParams, body: CancelBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [p] = await tx
          .select()
          .from(schema.purchases)
          .where(and(eq(schema.purchases.id, request.params.id), eq(schema.purchases.businessId, ctx.businessId)))
          .for("update");
        if (!p) throw notFound("purchase");
        if (p.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: p.status });
        const [locked] = await tx
          .select({ id: schema.gstReturnPeriods.id })
          .from(schema.gstReturnPeriods)
          .where(
            and(
              eq(schema.gstReturnPeriods.businessId, ctx.businessId),
              eq(schema.gstReturnPeriods.period, p.supplierInvoiceDate.slice(0, 7)),
              sql`${schema.gstReturnPeriods.status} in ('locked', 'filed')`,
            ),
          );
        if (locked) throw conflict("GST_PERIOD_LOCKED");
        const now = deps.clock.now().toISOString();
        const today = deps.clock.today(ctx.timeZone);
        const policy = (await getSettings(tx, ctx.businessId, ["stock.negative_policy"] as const))["stock.negative_policy"];
        const items = await tx.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, p.id));
        const warnings: Array<{ code: string; params: Record<string, string> }> = [];
        for (const item of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
          const qty = dec(item.qtyBase).plus(dec(item.freeQty).times(item.conversionFactor));
          const moved = await postStockMovement(
            tx,
            {
              businessId: ctx.businessId,
              productId: item.productId,
              productName: item.productName,
              warehouseId: p.warehouseId,
              batchId: item.batchId,
              date: today,
              type: "purchase_return",
              qty: toQtyString(qty),
              unitCost: item.landedUnitCost,
              refType: "purchase_cancel",
              refId: p.id,
              refLineId: item.id,
              refNumber: p.supplierInvoiceNumber,
              reason: request.body.reason,
              userId: ctx.userId,
            },
            policy,
          );
          if (moved.warning) warnings.push({ code: "insufficient_stock", params: { product: item.productName, available: moved.warning.available.toString() } });
        }
        const released = await releaseAllocations(tx, { purchaseId: p.id }, now);
        await tx
          .update(schema.purchases)
          .set({ status: "cancelled", cancelledAt: now, cancelledBy: ctx.userId, cancelReason: request.body.reason, amountPaid: "0", balanceDue: "0", paymentStatus: "unpaid", version: p.version + 1 })
          .where(eq(schema.purchases.id, p.id));
        await postPartyEntry(tx, {
          businessId: ctx.businessId,
          party: { type: "supplier", id: p.supplierId },
          date: today,
          docType: "purchase_cancel",
          docId: p.id,
          docNumber: p.supplierInvoiceNumber,
          debit: p.grandTotal,
          narration: `Cancelled: ${request.body.reason}`,
          userId: ctx.userId,
        });
        await tx
          .update(schema.gstTransactions)
          .set({ isCancelled: true })
          .where(and(eq(schema.gstTransactions.docType, "purchase"), eq(schema.gstTransactions.docId, p.id), eq(schema.gstTransactions.businessId, ctx.businessId)));
        await audit(tx, ctx, {
          action: "purchase.cancelled",
          entityType: "purchase",
          entityId: p.id,
          entityLabel: p.purchaseNumber ?? p.supplierInvoiceNumber,
          changes: { reason: request.body.reason, grandTotal: p.grandTotal, releasedToAdvance: released },
        });
        return { ...(await purchaseDetail(tx, ctx, p.id)), warnings };
      });
    },
  );

};
