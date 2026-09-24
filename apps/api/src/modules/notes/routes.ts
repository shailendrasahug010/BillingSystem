import { CancelBody, NoteListQuery, ReturnBody } from "@vyapaar/contracts";
import { applyRoundOff, dec, roundAmount, toAmountString, toQtyString, type Dec } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { FastifyReply } from "fastify";
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
import { applyToDocument } from "../../services/payments.js";
import { getSettings } from "../../services/settings.js";
import { postStockMovement } from "../../services/stock.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
type ReturnInput = z.output<typeof ReturnBody>;
type Side = "customer" | "supplier";

/** Amount columns carried from the original line to the returned share of it. */
const AMOUNTS = ["grossAmount", "discountAmount", "documentDiscountShare", "taxableValue", "cgstAmount", "sgstAmount", "igstAmount", "cessAmount"] as const;
type AmountKey = (typeof AMOUNTS)[number];
type LineRow = typeof schema.invoiceItems.$inferSelect | typeof schema.purchaseItems.$inferSelect;

async function periodLocked(tx: Tx, businessId: string, date: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.gstReturnPeriods.id })
    .from(schema.gstReturnPeriods)
    .where(
      and(
        eq(schema.gstReturnPeriods.businessId, businessId),
        eq(schema.gstReturnPeriods.period, date.slice(0, 7)),
        sql`${schema.gstReturnPeriods.status} in ('locked', 'filed')`,
      ),
    );
  return Boolean(row);
}

/** Posted returns against a document (shown on the invoice / purchase and blocking its cancellation). */
export async function documentReturns(tx: Tx, target: { invoiceId: string } | { purchaseId: string }) {
  const n = schema.creditDebitNotes;
  return tx
    .select({ id: n.id, noteNumber: n.noteNumber, noteDate: n.noteDate, noteType: n.noteType, grandTotal: n.grandTotal, amountSettled: n.amountSettled, status: n.status, restock: n.affectsStock })
    .from(n)
    .where("invoiceId" in target ? eq(n.invoiceId, target.invoiceId) : eq(n.purchaseId, target.purchaseId))
    .orderBy(asc(n.noteDate), asc(n.id));
}

/** Refuses to cancel an invoice / purchase that still has posted returns (their stock and GST would be reversed twice). */
export async function assertNoPostedReturns(tx: Tx, target: { invoiceId: string } | { purchaseId: string }): Promise<void> {
  const returns = await documentReturns(tx, target);
  const open = returns.filter((r) => r.status === "posted");
  if (open.length) throw conflict("DOCUMENT_HAS_RETURNS", { notes: open.map((r) => r.noteNumber ?? "").join(", ") });
}

export async function noteDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [note] = await tx
    .select()
    .from(schema.creditDebitNotes)
    .where(and(eq(schema.creditDebitNotes.id, id), eq(schema.creditDebitNotes.businessId, ctx.businessId)));
  if (!note) throw notFound("note");
  const items = await tx.select().from(schema.creditDebitNoteItems).where(eq(schema.creditDebitNoteItems.noteId, id)).orderBy(asc(schema.creditDebitNoteItems.lineNo));
  const original = note.invoiceId
    ? (await tx.select({ id: schema.invoices.id, number: schema.invoices.invoiceNumber, date: schema.invoices.invoiceDate }).from(schema.invoices).where(eq(schema.invoices.id, note.invoiceId)))[0]
    : note.purchaseId
      ? (
          await tx
            .select({ id: schema.purchases.id, number: schema.purchases.supplierInvoiceNumber, date: schema.purchases.supplierInvoiceDate })
            .from(schema.purchases)
            .where(eq(schema.purchases.id, note.purchaseId))
        )[0]
      : undefined;
  const { businessId: _b, ...rest } = note;
  return { ...rest, original: original ?? null, items: items.map(({ businessId: _ib, ...i }) => i) };
}

/**
 * The share of an original line being returned. Values are proportional to
 * the quantity (so line and invoice discounts and inclusive prices carry
 * over exactly); the return that completes a line takes whatever remains, so
 * returning everything credits exactly what was billed.
 */
function returnedShare(item: LineRow, qty: Dec, previous: Record<AmountKey, Dec> & { qty: Dec }): Record<AmountKey, Dec> {
  const completes = previous.qty.plus(qty).eq(item.qty);
  const ratio = qty.dividedBy(item.qty);
  const out = {} as Record<AmountKey, Dec>;
  for (const key of AMOUNTS) {
    const full = dec(item[key]);
    out[key] = completes ? full.minus(previous[key]) : roundAmount(full.times(ratio));
  }
  return out;
}

/**
 * Posts a return in one transaction: note number, note lines, stock back in
 * (sales return) or out (purchase return), returned quantities on the original
 * lines, party ledger, the original document's balance, GST register rows
 * (with the original invoice reference), audit and outbox.
 */
async function postReturn(tx: Tx, ctx: RequestCtx, deps: Parameters<ApiModule>[1], side: Side, documentId: string, body: ReturnInput, clientId: string | null) {
  const today = deps.clock.today(ctx.timeZone);
  const noteDate = body.noteDate ?? today;
  if (noteDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "noteDate");
  if (await periodLocked(tx, ctx.businessId, noteDate)) throw conflict("GST_PERIOD_LOCKED");

  const isSale = side === "customer";
  const docTable = isSale ? schema.invoices : schema.purchases;
  const [doc] = await tx
    .select()
    .from(docTable)
    .where(and(eq(docTable.id, documentId), eq(docTable.businessId, ctx.businessId)))
    .for("update");
  if (!doc) throw notFound(isSale ? "invoice" : "purchase");
  if (doc.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: doc.status });
  const docDate = "invoiceDate" in doc ? doc.invoiceDate : doc.supplierInvoiceDate;
  const docNumber = ("invoiceNumber" in doc ? doc.invoiceNumber : doc.supplierInvoiceNumber) ?? "";
  if (noteDate < docDate) throw badRequest("NOTE_BEFORE_DOCUMENT", { date: docDate }, "noteDate");
  if (!isSale && doc.isReverseCharge) throw conflict("RETURN_NOT_SUPPORTED_RCM");

  // Merge repeated lines, then lock the original lines in a stable order.
  const wanted = new Map<string, Dec>();
  body.lines.forEach((l, i) => {
    if (dec(l.qty).lte(0)) throw badRequest("QTY_NOT_POSITIVE", {}, `lines[${i}].qty`);
    wanted.set(l.lineId, (wanted.get(l.lineId) ?? dec(0)).plus(l.qty));
  });
  const itemTable = isSale ? schema.invoiceItems : schema.purchaseItems;
  const parentColumn = isSale ? schema.invoiceItems.invoiceId : schema.purchaseItems.purchaseId;
  const items: LineRow[] = await tx
    .select()
    .from(itemTable)
    .where(and(eq(parentColumn, doc.id), inArray(itemTable.id, [...wanted.keys()])))
    .orderBy(asc(itemTable.id))
    .for("update");
  body.lines.forEach((l, i) => {
    if (!items.some((it) => it.id === l.lineId)) throw badRequest("RETURN_LINE_NOT_ON_DOCUMENT", {}, `lines[${i}].lineId`);
  });

  // What earlier (posted) returns already took from each line.
  const ni = schema.creditDebitNoteItems;
  const earlier = await tx
    .select({
      lineId: ni.originalLineId,
      qty: sql<string>`sum(${ni.qty})`,
      ...Object.fromEntries(AMOUNTS.map((k) => [k, sql<string>`sum(${ni[k]})`])),
    })
    .from(ni)
    .innerJoin(schema.creditDebitNotes, eq(schema.creditDebitNotes.id, ni.noteId))
    .where(and(inArray(ni.originalLineId, items.map((i) => i.id)), eq(schema.creditDebitNotes.status, "posted")))
    .groupBy(ni.originalLineId);

  const lines = items
    .map((item) => {
      const qty = wanted.get(item.id)!;
      const available = dec(item.qty).minus(item.returnedQty);
      const index = body.lines.findIndex((l) => l.lineId === item.id);
      if (qty.gt(available)) throw badRequest("RETURN_QTY_EXCEEDS", { product: item.productName, max: toQtyString(available) }, `lines[${index}].qty`);
      const prev = earlier.find((e) => e.lineId === item.id) as Record<string, string> | undefined;
      const previous = { qty: dec(prev?.qty ?? 0), ...Object.fromEntries(AMOUNTS.map((k) => [k, dec(prev?.[k] ?? 0)])) } as Record<AmountKey, Dec> & { qty: Dec };
      const share = returnedShare(item, qty, previous);
      const total = share.taxableValue.plus(share.cgstAmount).plus(share.sgstAmount).plus(share.igstAmount).plus(share.cessAmount);
      return { item, qty, qtyBase: qty.times(item.conversionFactor), share, total, index };
    })
    .sort((a, b) => a.index - b.index);

  const sumOf = (k: AmountKey) => lines.reduce((acc, l) => acc.plus(l.share[k]), dec(0));
  const settings = await getSettings(tx, ctx.businessId, ["invoice.round_off", "stock.negative_policy"] as const);
  const before = lines.reduce((acc, l) => acc.plus(l.total), dec(0));
  const { rounded: grandTotal, roundOff } = applyRoundOff(before, settings["invoice.round_off"]);
  if (body.clientTotals?.grandTotal !== undefined && !dec(body.clientTotals.grandTotal).eq(grandTotal)) {
    throw new ApiError(422, "TOTALS_MISMATCH", { field: "grandTotal", expected: grandTotal.toFixed(2), received: dec(body.clientTotals.grandTotal).toFixed(2) });
  }

  const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
  const noteType = isSale ? "credit" : "debit";
  const numbering = await nextDocumentNumber(tx, ctx.businessId, isSale ? "credit_note" : "debit_note", noteDate, business!.financialYearStartMonth);
  const partyId = "customerId" in doc ? doc.customerId : doc.supplierId;
  const [party] = isSale
    ? await tx.select({ registration: schema.customers.gstRegistration }).from(schema.customers).where(eq(schema.customers.id, partyId))
    : await tx.select({ registration: schema.suppliers.gstRegistration }).from(schema.suppliers).where(eq(schema.suppliers.id, partyId));
  const id = uuidv7();
  const now = deps.clock.now().toISOString();

  // Applied to the original document first; any excess stays on the party's account.
  const settle = dec(doc.balanceDue).lt(grandTotal) ? dec(doc.balanceDue) : grandTotal;

  await tx.insert(schema.creditDebitNotes).values({
    id,
    businessId: ctx.businessId,
    noteType,
    partyType: side,
    ...(isSale ? { customerId: partyId } : { supplierId: partyId }),
    noteNumber: numbering.number,
    partyNoteNumber: body.partyNoteNumber ?? null,
    seriesId: numbering.seriesId,
    financialYear: numbering.financialYear,
    noteDate,
    reason: body.reason ?? (isSale ? "sales_return" : "purchase_return"),
    ...(isSale ? { invoiceId: doc.id } : { purchaseId: doc.id }),
    affectsStock: body.restock,
    warehouseId: doc.warehouseId,
    partyName: doc.partyName,
    partyGstin: doc.partyGstin,
    partyStateCode: doc.partyStateCode,
    billingAddress: doc.billingAddress,
    placeOfSupply: doc.placeOfSupply,
    supplyType: doc.supplyType,
    isReverseCharge: false,
    taxEngineVersion: doc.taxEngineVersion,
    status: "posted",
    grossTotal: toAmountString(sumOf("grossAmount")),
    discountTotal: toAmountString(sumOf("discountAmount").plus(sumOf("documentDiscountShare"))),
    taxableTotal: toAmountString(sumOf("taxableValue")),
    cgstTotal: toAmountString(sumOf("cgstAmount")),
    sgstTotal: toAmountString(sumOf("sgstAmount")),
    igstTotal: toAmountString(sumOf("igstAmount")),
    cessTotal: toAmountString(sumOf("cessAmount")),
    roundOff: toAmountString(roundOff),
    grandTotal: toAmountString(grandTotal),
    amountSettled: toAmountString(settle),
    settlementStatus: settle.eq(grandTotal) ? "paid" : settle.gt(0) ? "partial" : "unpaid",
    notes: body.notes ?? null,
    postedAt: now,
    clientId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });

  const itemIds = lines.map(() => uuidv7());
  await tx.insert(schema.creditDebitNoteItems).values(
    lines.map((l, i) => {
      const it = l.item;
      return {
        id: itemIds[i]!,
        businessId: ctx.businessId,
        noteId: id,
        lineNo: i + 1,
        productId: it.productId,
        productName: it.productName,
        hsnCode: it.hsnCode,
        uqc: it.uqc,
        unitId: it.unitId,
        conversionFactor: it.conversionFactor,
        qty: toQtyString(l.qty),
        freeQty: "0",
        qtyBase: toQtyString(l.qtyBase),
        rate: it.rate,
        rateIncludesTax: it.rateIncludesTax,
        discountPercent: it.discountPercent,
        grossAmount: toAmountString(l.share.grossAmount),
        discountAmount: toAmountString(l.share.discountAmount),
        documentDiscountShare: toAmountString(l.share.documentDiscountShare),
        taxableValue: toAmountString(l.share.taxableValue),
        cgstAmount: toAmountString(l.share.cgstAmount),
        sgstAmount: toAmountString(l.share.sgstAmount),
        igstAmount: toAmountString(l.share.igstAmount),
        cessAmount: toAmountString(l.share.cessAmount),
        taxability: it.taxability,
        taxCategoryId: it.taxCategoryId,
        taxRateId: it.taxRateId,
        gstRate: it.gstRate,
        cgstRate: it.cgstRate,
        sgstRate: it.sgstRate,
        igstRate: it.igstRate,
        cessRate: it.cessRate,
        lineTotal: toAmountString(l.total),
        batchId: it.batchId,
        unitCost: "unitCost" in it ? it.unitCost : it.landedUnitCost,
        originalLineId: it.id,
      };
    }),
  );

  // Stock, in a stable product order; returned quantities on the original lines.
  const warnings: Array<{ code: string; params: Record<string, string> }> = [];
  for (const [i, l] of [...lines.entries()].sort((a, b) => a[1].item.productId.localeCompare(b[1].item.productId))) {
    const it = l.item;
    await tx
      .update(itemTable)
      .set({ returnedQty: sql`${itemTable.returnedQty} + ${toQtyString(l.qty)}` })
      .where(eq(itemTable.id, it.id));
    if (!body.restock) continue;
    const moved = await postStockMovement(
      tx,
      {
        businessId: ctx.businessId,
        productId: it.productId,
        productName: it.productName,
        warehouseId: doc.warehouseId,
        batchId: it.batchId,
        date: noteDate,
        type: isSale ? "sale_return" : "purchase_return",
        qty: toQtyString(l.qtyBase),
        unitCost: "unitCost" in it ? it.unitCost : it.landedUnitCost,
        refType: isSale ? "credit_note" : "debit_note",
        refId: id,
        refLineId: itemIds[i]!,
        refNumber: numbering.number,
        reason: body.reason ?? null,
        userId: ctx.userId,
      },
      isSale ? "allow" : settings["stock.negative_policy"],
    );
    if (moved.warning) warnings.push({ code: "insufficient_stock", params: { product: it.productName, available: moved.warning.available.toString() } });
  }

  if (settle.gt(0)) {
    await applyToDocument(tx, side, doc.id, toAmountString(settle), toAmountString(dec(doc.balanceDue).minus(settle)));
  }
  await postPartyEntry(tx, {
    businessId: ctx.businessId,
    party: isSale ? { type: "customer", id: partyId } : { type: "supplier", id: partyId },
    date: noteDate,
    docType: isSale ? "credit_note" : "debit_note",
    docId: id,
    docNumber: numbering.number,
    ...(isSale ? { credit: toAmountString(grandTotal) } : { debit: toAmountString(grandTotal) }),
    narration: `${isSale ? "Sales return" : "Purchase return"} against ${docNumber}`,
    userId: ctx.userId,
  });

  await tx.insert(schema.gstTransactions).values(
    lines.map((l, i) => ({
      businessId: ctx.businessId,
      direction: isSale ? ("outward" as const) : ("inward" as const),
      docType: isSale ? ("credit_note" as const) : ("debit_note" as const),
      docId: id,
      docLineId: itemIds[i]!,
      docNumber: numbering.number,
      docDate: noteDate,
      originalDocNumber: docNumber,
      originalDocDate: docDate,
      returnPeriod: noteDate.slice(0, 7),
      partyName: doc.partyName,
      partyGstin: doc.partyGstin,
      partyRegistration: party!.registration,
      partyStateCode: doc.partyStateCode,
      placeOfSupply: doc.placeOfSupply,
      supplyType: doc.supplyType,
      taxability: l.item.taxability,
      hsnCode: l.item.hsnCode,
      uqc: l.item.uqc,
      qty: toQtyString(l.qtyBase),
      taxableValue: toAmountString(l.share.taxableValue),
      gstRate: l.item.gstRate,
      cgstAmount: toAmountString(l.share.cgstAmount),
      sgstAmount: toAmountString(l.share.sgstAmount),
      igstAmount: toAmountString(l.share.igstAmount),
      cessAmount: toAmountString(l.share.cessAmount),
      documentValue: toAmountString(grandTotal),
      ...(isSale ? {} : { itcEligibility: (doc as typeof schema.purchases.$inferSelect).itcEligibility }),
    })),
  );

  await audit(tx, ctx, {
    action: isSale ? "credit_note.posted" : "debit_note.posted",
    entityType: "note",
    entityId: id,
    entityLabel: `${numbering.number} (${docNumber})`,
    changes: { grandTotal: toAmountString(grandTotal), restock: body.restock, lines: lines.map((l) => [l.item.productName, toQtyString(l.qty)]) },
  });
  await tx.insert(schema.outboxEvents).values({
    businessId: ctx.businessId,
    eventType: isSale ? "credit_note.posted" : "debit_note.posted",
    aggregateType: "note",
    aggregateId: id,
    payload: { [isSale ? "invoiceId" : "purchaseId"]: doc.id, grandTotal: toAmountString(grandTotal) },
  });
  return { ...(await noteDetail(tx, ctx, id)), warnings };
}

export const notesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  const create = async (side: Side, ctx: RequestCtx, documentId: string, body: ReturnInput, key: unknown, reply: FastifyReply) => {
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        const [existing] = await tx
          .select({ id: schema.creditDebitNotes.id })
          .from(schema.creditDebitNotes)
          .where(and(eq(schema.creditDebitNotes.businessId, ctx.businessId), eq(schema.creditDebitNotes.clientId, clientId)));
        if (existing) return { replay: true, detail: await noteDetail(tx, ctx, existing.id) };
      }
      return { replay: false, detail: await postReturn(tx, ctx, deps, side, documentId, body, clientId) };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.detail);
  };

  /** Sales return: a credit note against the invoice. */
  r.post("/invoices/:id/returns", { preHandler: guard(deps, "note.create"), schema: { tags: ["notes"], params: IdParams, body: ReturnBody } }, (request, reply) =>
    create("customer", request.ctx, request.params.id, request.body, request.headers["idempotency-key"], reply),
  );

  /** Purchase return: a debit note to the supplier against their bill. */
  r.post("/purchases/:id/returns", { preHandler: guard(deps, "note.create"), schema: { tags: ["notes"], params: IdParams, body: ReturnBody } }, (request, reply) =>
    create("supplier", request.ctx, request.params.id, request.body, request.headers["idempotency-key"], reply),
  );

  r.get("/notes", { preHandler: guard(deps, "note.view"), schema: { tags: ["notes"], querystring: NoteListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const n = schema.creditDebitNotes;
    const where: SQL[] = [eq(n.businessId, ctx.businessId)];
    if (q.party !== "all") where.push(eq(n.partyType, q.party));
    if (q.customerId) where.push(eq(n.customerId, q.customerId));
    if (q.supplierId) where.push(eq(n.supplierId, q.supplierId));
    if (q.invoiceId) where.push(eq(n.invoiceId, q.invoiceId));
    if (q.purchaseId) where.push(eq(n.purchaseId, q.purchaseId));
    if (q.from) where.push(sql`${n.noteDate} >= ${q.from}`);
    if (q.to) where.push(sql`${n.noteDate} <= ${q.to}`);
    if (q.status !== "all") where.push(eq(n.status, q.status));
    if (cursor) where.push(sql`(${n.noteDate}, ${n.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: n.id,
          noteNumber: n.noteNumber,
          noteType: n.noteType,
          noteDate: n.noteDate,
          partyType: n.partyType,
          customerId: n.customerId,
          supplierId: n.supplierId,
          partyName: n.partyName,
          reason: n.reason,
          invoiceId: n.invoiceId,
          purchaseId: n.purchaseId,
          grandTotal: n.grandTotal,
          status: n.status,
        })
        .from(n)
        .where(and(...where))
        .orderBy(desc(n.noteDate), desc(n.id))
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.noteDate, id: x.id }));
  });

  r.get("/notes/:id", { preHandler: guard(deps, "note.view"), schema: { tags: ["notes"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => noteDetail(tx, request.ctx, request.params.id)),
  );

  /** Cancels a return: stock, returned quantities, ledger, document balance and GST rows are reversed. */
  r.post("/notes/:id/cancel", { preHandler: guard(deps, "note.cancel"), schema: { tags: ["notes"], params: IdParams, body: CancelBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [note] = await tx
        .select()
        .from(schema.creditDebitNotes)
        .where(and(eq(schema.creditDebitNotes.id, request.params.id), eq(schema.creditDebitNotes.businessId, ctx.businessId)))
        .for("update");
      if (!note) throw notFound("note");
      if (note.status !== "posted") throw conflict("NOTE_NOT_POSTED", { status: note.status });
      if (await periodLocked(tx, ctx.businessId, note.noteDate)) throw conflict("GST_PERIOD_LOCKED");
      const isSale = note.partyType === "customer";
      const docTable = isSale ? schema.invoices : schema.purchases;
      const docId = (isSale ? note.invoiceId : note.purchaseId)!;
      const [doc] = await tx.select({ id: docTable.id, balanceDue: docTable.balanceDue }).from(docTable).where(eq(docTable.id, docId)).for("update");
      const today = deps.clock.today(ctx.timeZone);
      const now = deps.clock.now().toISOString();
      const policy = (await getSettings(tx, ctx.businessId, ["stock.negative_policy"] as const))["stock.negative_policy"];
      const items = await tx.select().from(schema.creditDebitNoteItems).where(eq(schema.creditDebitNoteItems.noteId, note.id));
      const itemTable = isSale ? schema.invoiceItems : schema.purchaseItems;
      for (const it of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
        await tx
          .update(itemTable)
          .set({ returnedQty: sql`${itemTable.returnedQty} - ${it.qty}` })
          .where(eq(itemTable.id, it.originalLineId!));
        if (!note.affectsStock) continue;
        await postStockMovement(
          tx,
          {
            businessId: ctx.businessId,
            productId: it.productId,
            productName: it.productName,
            warehouseId: note.warehouseId!,
            batchId: it.batchId,
            date: today,
            // Undo the return: the goods leave again (sale) or come back (purchase).
            type: isSale ? "sale" : "purchase",
            qty: it.qtyBase,
            unitCost: it.unitCost,
            refType: isSale ? "credit_note_cancel" : "debit_note_cancel",
            refId: note.id,
            refLineId: it.id,
            refNumber: note.noteNumber,
            reason: request.body.reason,
            userId: ctx.userId,
          },
          isSale ? policy : "allow",
        );
      }
      if (doc && dec(note.amountSettled).gt(0)) {
        await applyToDocument(tx, isSale ? "customer" : "supplier", doc.id, `-${note.amountSettled}`, toAmountString(dec(doc.balanceDue).plus(note.amountSettled)));
      }
      const [original] = await tx
        .select({ id: schema.partyLedgerEntries.id })
        .from(schema.partyLedgerEntries)
        .where(and(eq(schema.partyLedgerEntries.docId, note.id), eq(schema.partyLedgerEntries.docType, isSale ? "credit_note" : "debit_note")));
      await postPartyEntry(tx, {
        businessId: ctx.businessId,
        party: isSale ? { type: "customer", id: note.customerId! } : { type: "supplier", id: note.supplierId! },
        date: today,
        docType: isSale ? "credit_note_cancel" : "debit_note_cancel",
        docId: note.id,
        docNumber: note.noteNumber,
        ...(isSale ? { debit: note.grandTotal } : { credit: note.grandTotal }),
        narration: `Cancelled: ${request.body.reason}`,
        reversesEntryId: original?.id ?? null,
        userId: ctx.userId,
      });
      await tx
        .update(schema.gstTransactions)
        .set({ isCancelled: true })
        .where(and(eq(schema.gstTransactions.docType, isSale ? "credit_note" : "debit_note"), eq(schema.gstTransactions.docId, note.id), eq(schema.gstTransactions.businessId, ctx.businessId)));
      await tx
        .update(schema.creditDebitNotes)
        .set({ status: "cancelled", cancelledAt: now, cancelReason: request.body.reason, amountSettled: "0", settlementStatus: "unpaid", version: note.version + 1, updatedBy: ctx.userId })
        .where(eq(schema.creditDebitNotes.id, note.id));
      await audit(tx, ctx, {
        action: isSale ? "credit_note.cancelled" : "debit_note.cancelled",
        entityType: "note",
        entityId: note.id,
        entityLabel: note.noteNumber ?? undefined,
        changes: { reason: request.body.reason, grandTotal: note.grandTotal },
      });
      return noteDetail(tx, ctx, note.id);
    });
  });
};
