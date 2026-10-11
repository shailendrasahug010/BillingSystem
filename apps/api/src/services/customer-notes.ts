import type { DebitNoteBody, LooseReturnBody } from "@digitalbahi/contracts";
import {
  allocatePayment,
  applyRoundOff,
  calculateDocument,
  chargesGst,
  dec,
  determineSupplyType,
  paymentStatusFor,
  resolveTax,
  roundAmount,
  roundRate,
  TAX_ENGINE_VERSION,
  toAmountString,
  toQtyString,
  toRateString,
  zeroRatedKindFor,
  type BusinessGstRegistration,
  type Dec,
  type DocumentLineInput,
  type PartyGstRegistration,
} from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { z } from "zod";
import { audit } from "../lib/audit.js";
import type { AppDeps, RequestCtx } from "../lib/context.js";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.js";
import { periodLocked } from "./gst-period.js";
import { nextDocumentNumber } from "./numbering.js";
import { postPartyEntry } from "./party-ledger.js";
import { applyToDocument, lockOpenDocuments } from "./payments.js";
import { taxCategoriesOf } from "./sales-document.js";
import { getSettings } from "./settings.js";
import { postStockMovement } from "./stock.js";

type LooseReturnInput = z.output<typeof LooseReturnBody>;
type DebitNoteInput = z.output<typeof DebitNoteBody>;

/** A customer's last billed rate for a product, in the unit it was billed in. */
export interface LastRate {
  productId: string;
  unitId: string;
  rate: string;
  discountPercent: string;
  conversionFactor: string;
  /** Cost per base unit of the goods on that bill. */
  unitCost: string;
  invoiceNumber: string | null;
  invoiceDate: string;
}

/** The rate each product was last billed to the customer at (per unit it was billed in; goods given free left out). */
export async function lastBilledRates(tx: Tx, businessId: string, customerId: string, productIds: readonly string[]): Promise<LastRate[]> {
  if (!productIds.length) return [];
  const ii = schema.invoiceItems;
  const i = schema.invoices;
  return tx
    .selectDistinctOn([ii.productId, ii.unitId], {
      productId: ii.productId,
      unitId: ii.unitId,
      rate: ii.rate,
      discountPercent: ii.discountPercent,
      conversionFactor: ii.conversionFactor,
      unitCost: ii.unitCost,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
    })
    .from(ii)
    .innerJoin(i, eq(i.id, ii.invoiceId))
    .where(and(eq(i.businessId, businessId), eq(i.customerId, customerId), eq(i.status, "posted"), inArray(ii.productId, [...productIds]), eq(ii.schemeFree, false)))
    .orderBy(ii.productId, ii.unitId, desc(i.invoiceDate), desc(i.id));
}

/**
 * The customer's open bills take the note's credit not used yet, oldest due
 * first (as a payment's would); what is left stays on their account.
 */
export async function allocateNoteCredit(tx: Tx, businessId: string, noteId: string): Promise<{ allocated: Dec; left: Dec }> {
  const n = schema.creditDebitNotes;
  const [note] = await tx.select().from(n).where(and(eq(n.id, noteId), eq(n.businessId, businessId))).for("update");
  if (!note) throw notFound("note");
  const free = dec(note.grandTotal).minus(note.amountSettled);
  if (free.lte(0) || !note.customerId) return { allocated: dec(0), left: dec(0) };
  const open = await lockOpenDocuments(tx, businessId, { type: "customer", id: note.customerId, name: note.partyName });
  const { allocations, unallocated } = allocatePayment(free, open);
  for (const a of allocations) {
    const doc = open.find((d) => d.id === a.documentId)!;
    await tx.insert(schema.noteAllocations).values({ businessId, noteId, invoiceId: a.documentId, amount: toAmountString(a.amount) });
    await applyToDocument(tx, "customer", a.documentId, toAmountString(a.amount), toAmountString(dec(doc.balance).minus(a.amount)));
  }
  const allocated = free.minus(unallocated);
  if (allocated.gt(0)) {
    const settled = dec(note.amountSettled).plus(allocated);
    await tx
      .update(n)
      .set({ amountSettled: toAmountString(settled), settlementStatus: paymentStatusFor(note.grandTotal, settled) })
      .where(eq(n.id, noteId));
  }
  return { allocated, left: unallocated };
}

/**
 * A bill being cancelled gives back what notes without a bill paid of it:
 * their credit is free again (on the customer's account).
 */
export async function releaseNoteAllocations(tx: Tx, invoiceId: string, now: string): Promise<Dec> {
  const a = schema.noteAllocations;
  const rows = await tx
    .update(a)
    .set({ reversedAt: now })
    .where(and(eq(a.invoiceId, invoiceId), isNull(a.reversedAt)))
    .returning({ noteId: a.noteId, amount: a.amount });
  const n = schema.creditDebitNotes;
  for (const r of rows) {
    const [note] = await tx
      .update(n)
      .set({ amountSettled: sql`${n.amountSettled} - ${r.amount}` })
      .where(eq(n.id, r.noteId))
      .returning({ grandTotal: n.grandTotal, amountSettled: n.amountSettled });
    await tx.update(n).set({ settlementStatus: paymentStatusFor(note!.grandTotal, note!.amountSettled) }).where(eq(n.id, r.noteId));
  }
  return rows.reduce((s, r) => s.plus(r.amount), dec(0));
}

/** A note without a bill being cancelled: the bills it paid owe that again. */
export async function reverseNoteAllocations(tx: Tx, noteId: string, now: string): Promise<void> {
  const a = schema.noteAllocations;
  const rows = await tx
    .select({ id: a.id, invoiceId: a.invoiceId, amount: a.amount })
    .from(a)
    .where(and(eq(a.noteId, noteId), isNull(a.reversedAt)))
    .orderBy(asc(a.invoiceId));
  for (const r of rows) {
    const [inv] = await tx.select({ balanceDue: schema.invoices.balanceDue }).from(schema.invoices).where(eq(schema.invoices.id, r.invoiceId)).for("update");
    await applyToDocument(tx, "customer", r.invoiceId, `-${r.amount}`, toAmountString(dec(inv!.balanceDue).plus(r.amount)));
    await tx.update(a).set({ reversedAt: now }).where(eq(a.id, r.id));
  }
}

/** The bills a note without a bill went to. */
export async function noteAllocationsOf(tx: Tx, noteId: string) {
  const a = schema.noteAllocations;
  return tx
    .select({ invoiceId: a.invoiceId, invoiceNumber: schema.invoices.invoiceNumber, invoiceDate: schema.invoices.invoiceDate, amount: a.amount, reversedAt: a.reversedAt })
    .from(a)
    .innerJoin(schema.invoices, eq(schema.invoices.id, a.invoiceId))
    .where(eq(a.noteId, noteId))
    .orderBy(asc(a.createdAt), asc(schema.invoices.invoiceDate), asc(schema.invoices.invoiceNumber));
}

/** Credit notes without a bill that paid part of this bill. */
export async function invoiceNoteCredits(tx: Tx, invoiceId: string) {
  const a = schema.noteAllocations;
  const n = schema.creditDebitNotes;
  return tx
    .select({ noteId: a.noteId, noteNumber: n.noteNumber, noteDate: n.noteDate, amount: a.amount, reversedAt: a.reversedAt })
    .from(a)
    .innerJoin(n, eq(n.id, a.noteId))
    .where(eq(a.invoiceId, invoiceId))
    .orderBy(asc(n.noteDate), asc(a.id));
}

type Warning = { code: string; params: Record<string, string> };

/**
 * Goods a customer brings back without their bill, posted in one
 * transaction: a numbered credit note priced and taxed like a bill (the
 * customer's last billed rate, else the rate list's, unless a rate is given),
 * stock back into the godown, the customer's account credited, GST register
 * rows, and the credit applied to their open bills oldest due first.
 */
export async function postLooseReturn(tx: Tx, ctx: RequestCtx, deps: AppDeps, body: LooseReturnInput, clientId: string | null) {
  const businessId = ctx.businessId;
  const today = deps.clock.today(ctx.timeZone);
  const noteDate = body.noteDate ?? today;
  if (noteDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "noteDate");
  if (await periodLocked(tx, businessId, noteDate)) throw conflict("GST_PERIOD_LOCKED");

  const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const [customer] = await tx
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, body.customerId), eq(schema.customers.businessId, businessId), isNull(schema.customers.deletedAt)));
  if (!customer) throw badRequest("REFERENCE_NOT_FOUND", {}, "customerId");
  // An export or a supply to SEZ is credited only against its bill (the note takes its zero-rated terms).
  if (zeroRatedKindFor(customer.gstRegistration)) throw badRequest("RETURN_NEEDS_BILL", {}, "customerId");

  const [wh] = await tx
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(and(eq(schema.warehouses.businessId, businessId), isNull(schema.warehouses.deletedAt), body.warehouseId ? eq(schema.warehouses.id, body.warehouseId) : eq(schema.warehouses.isDefault, true)));
  if (!wh) throw body.warehouseId ? badRequest("REFERENCE_NOT_FOUND", {}, "warehouseId") : new ApiError(409, "NO_DEFAULT_WAREHOUSE");

  const productIds = [...new Set(body.lines.map((l) => l.productId))];
  const products = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.businessId, businessId), inArray(schema.products.id, productIds), isNull(schema.products.deletedAt)));
  const altUnits = await tx.select().from(schema.productUnits).where(inArray(schema.productUnits.productId, productIds));
  const units = await tx.select().from(schema.units).where(eq(schema.units.businessId, businessId));
  const categories = await taxCategoriesOf(tx, businessId);
  let priceLevelId = customer.priceLevelId;
  if (!priceLevelId) {
    const [def] = await tx
      .select({ id: schema.priceLevels.id })
      .from(schema.priceLevels)
      .where(and(eq(schema.priceLevels.businessId, businessId), eq(schema.priceLevels.isDefault, true)));
    priceLevelId = def?.id ?? null;
  }
  const prices = priceLevelId
    ? await tx
        .select()
        .from(schema.productPrices)
        .where(and(inArray(schema.productPrices.productId, productIds), eq(schema.productPrices.priceLevelId, priceLevelId)))
    : [];
  const last = await lastBilledRates(tx, businessId, customer.id, productIds);
  const batchIds = body.lines.map((l) => l.batchId).filter((b): b is string => Boolean(b));
  const batches = batchIds.length ? await tx.select().from(schema.batches).where(and(eq(schema.batches.businessId, businessId), inArray(schema.batches.id, batchIds))) : [];

  const registration = business!.gstRegistration as BusinessGstRegistration;
  const supplyType = determineSupplyType({
    supplierStateCode: business!.stateCode,
    placeOfSupplyStateCode: customer.stateCode,
    recipientRegistration: customer.gstRegistration as PartyGstRegistration,
  });

  const prepared = body.lines.map((line, i) => {
    const product = products.find((p) => p.id === line.productId);
    if (!product) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
    if (dec(line.qty).lte(0)) throw badRequest("QTY_NOT_POSITIVE", {}, `lines[${i}].qty`);
    const unitId = line.unitId ?? product.baseUnitId;
    let factor = "1";
    if (unitId !== product.baseUnitId) {
      const alt = altUnits.find((u) => u.productId === product.id && u.unitId === unitId);
      if (!alt) throw badRequest("UNIT_NOT_ON_PRODUCT", { product: product.name }, `lines[${i}].unitId`);
      factor = alt.conversionFactor;
    }
    if (line.batchId && !batches.some((b) => b.id === line.batchId && b.productId === product.id)) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].batchId`);
    // The rate: as given, else the customer's last billed one (in this unit, or scaled from another), else the rate list's.
    const billed = last.find((l) => l.productId === product.id && l.unitId === unitId) ?? last.find((l) => l.productId === product.id);
    // As on a bill: a pack without its own price on the rate list is the stock unit's price times the pack.
    const listPrice = prices.find((p) => p.productId === product.id && p.unitId === unitId);
    const basePrice = listPrice ?? prices.find((p) => p.productId === product.id && p.unitId === product.baseUnitId);
    let rate: Dec;
    let discountPercent: string;
    if (line.rate !== undefined) {
      rate = dec(line.rate);
      discountPercent = line.discountPercent ?? "0";
    } else if (billed) {
      rate = billed.unitId === unitId ? dec(billed.rate) : roundRate(dec(billed.rate).dividedBy(billed.conversionFactor).times(factor));
      discountPercent = line.discountPercent ?? billed.discountPercent;
    } else {
      rate = listPrice ? dec(listPrice.price) : roundRate(dec(basePrice?.price ?? product.sellingPrice).times(factor));
      discountPercent = line.discountPercent ?? basePrice?.discountPercent ?? "0";
    }
    const category = categories.get(product.taxCategoryId);
    if (!category) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
    const tax = resolveTax(category, { date: noteDate, unitValue: rate.dividedBy(factor), unitValueIncludesTax: product.pricesIncludeTax });
    const uqc = units.find((u) => u.id === product.baseUnitId)?.uqc ?? null;
    const engine: DocumentLineInput = {
      key: `L${i + 1}`,
      qty: line.qty,
      rate,
      rateIncludesTax: product.pricesIncludeTax,
      discountPercent,
      discountAmount: "0",
      conversionFactor: factor,
      tax,
      hsnCode: product.hsnCode,
      uqc,
    };
    return { line, product, unitId, factor, discountPercent, tax, uqc, unitCost: billed?.unitCost ?? product.avgCost, engine };
  });

  const settings = await getSettings(tx, businessId, ["invoice.round_off"] as const);
  const totals = calculateDocument({ lines: prepared.map((p) => p.engine), supplyType, chargeTax: chargesGst(registration), roundOff: settings["invoice.round_off"] });
  const grandTotal = totals.grandTotal;
  if (body.clientTotals && !dec(body.clientTotals.grandTotal).eq(grandTotal)) {
    throw new ApiError(422, "TOTALS_MISMATCH", { field: "grandTotal", expected: grandTotal.toFixed(2), received: dec(body.clientTotals.grandTotal).toFixed(2) });
  }

  const numbering = await nextDocumentNumber(tx, businessId, "credit_note", noteDate, business!.financialYearStartMonth);
  const id = uuidv7();
  const address = { line1: customer.addressLine1, line2: customer.addressLine2, city: customer.city, stateCode: customer.stateCode, pincode: customer.pincode };
  await tx.insert(schema.creditDebitNotes).values({
    id,
    businessId,
    noteType: "credit",
    partyType: "customer",
    customerId: customer.id,
    noteNumber: numbering.number,
    seriesId: numbering.seriesId,
    financialYear: numbering.financialYear,
    noteDate,
    reason: body.reason,
    invoiceId: null,
    affectsStock: body.restock,
    warehouseId: wh.id,
    partyName: customer.businessName ?? customer.name,
    partyGstin: customer.gstin,
    partyStateCode: customer.stateCode,
    billingAddress: address,
    placeOfSupply: customer.stateCode,
    supplyType,
    isReverseCharge: false,
    taxEngineVersion: TAX_ENGINE_VERSION,
    status: "posted",
    grossTotal: toAmountString(totals.grossTotal),
    discountTotal: toAmountString(totals.discountTotal),
    taxableTotal: toAmountString(totals.taxableTotal),
    cgstTotal: toAmountString(totals.cgstTotal),
    sgstTotal: toAmountString(totals.sgstTotal),
    igstTotal: toAmountString(totals.igstTotal),
    cessTotal: toAmountString(totals.cessTotal),
    roundOff: toAmountString(totals.roundOff),
    grandTotal: toAmountString(grandTotal),
    amountSettled: "0",
    settlementStatus: grandTotal.isZero() ? "paid" : "unpaid",
    notes: body.notes ?? null,
    postedAt: deps.clock.now().toISOString(),
    clientId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  const itemIds = prepared.map(() => uuidv7());
  await tx.insert(schema.creditDebitNoteItems).values(
    prepared.map((p, i) => {
      const l = totals.lines[i]!;
      return {
        id: itemIds[i]!,
        businessId,
        noteId: id,
        lineNo: i + 1,
        productId: p.product.id,
        productName: p.product.name,
        hsnCode: p.product.hsnCode,
        uqc: p.uqc,
        unitId: p.unitId,
        conversionFactor: p.factor,
        qty: toQtyString(l.qty),
        freeQty: "0",
        qtyBase: toQtyString(l.qtyBase),
        rate: toRateString(l.rate),
        rateIncludesTax: p.product.pricesIncludeTax,
        discountPercent: p.discountPercent,
        grossAmount: toAmountString(l.gross),
        discountAmount: toAmountString(l.lineDiscount),
        documentDiscountShare: toAmountString(l.documentDiscountShare),
        taxableValue: toAmountString(l.taxable),
        cgstAmount: toAmountString(l.cgst),
        sgstAmount: toAmountString(l.sgst),
        igstAmount: toAmountString(l.igst),
        cessAmount: toAmountString(l.cess),
        taxability: p.tax.kind,
        taxCategoryId: p.product.taxCategoryId,
        taxRateId: p.tax.ruleId,
        gstRate: l.gstRate.toFixed(3),
        cgstRate: l.cgstRate.toFixed(3),
        sgstRate: l.sgstRate.toFixed(3),
        igstRate: l.igstRate.toFixed(3),
        cessRate: l.cessRate.toFixed(3),
        lineTotal: toAmountString(l.total),
        batchId: p.line.batchId ?? null,
        unitCost: toRateString(p.unitCost),
        originalLineId: null,
      };
    }),
  );

  // Stock back into the godown, in a stable product order.
  const warnings: Warning[] = [];
  if (body.restock) {
    for (const i of prepared.map((_, k) => k).sort((a, b) => prepared[a]!.product.id.localeCompare(prepared[b]!.product.id))) {
      const p = prepared[i]!;
      await postStockMovement(
        tx,
        {
          businessId,
          productId: p.product.id,
          productName: p.product.name,
          warehouseId: wh.id,
          batchId: p.line.batchId ?? null,
          date: noteDate,
          type: "sale_return",
          qty: toQtyString(totals.lines[i]!.qtyBase),
          unitCost: toRateString(p.unitCost),
          refType: "credit_note",
          refId: id,
          refLineId: itemIds[i]!,
          refNumber: numbering.number,
          reason: body.reason,
          userId: ctx.userId,
        },
        "allow",
      );
    }
  }

  if (grandTotal.gt(0)) {
    await postPartyEntry(tx, {
      businessId,
      party: { type: "customer", id: customer.id },
      date: noteDate,
      docType: "credit_note",
      docId: id,
      docNumber: numbering.number,
      credit: toAmountString(grandTotal),
      narration: "Goods returned without a bill",
      userId: ctx.userId,
    });
  }

  await tx.insert(schema.gstTransactions).values(
    prepared.map((p, i) => {
      const l = totals.lines[i]!;
      return {
        businessId,
        direction: "outward" as const,
        docType: "credit_note" as const,
        docId: id,
        docLineId: itemIds[i]!,
        docNumber: numbering.number,
        docDate: noteDate,
        originalDocNumber: null,
        originalDocDate: null,
        returnPeriod: noteDate.slice(0, 7),
        partyName: customer.businessName ?? customer.name,
        partyGstin: customer.gstin,
        partyRegistration: customer.gstRegistration,
        partyStateCode: customer.stateCode,
        placeOfSupply: customer.stateCode,
        supplyType,
        isReverseCharge: false,
        taxability: p.tax.kind,
        hsnCode: p.product.hsnCode,
        uqc: p.uqc,
        qty: toQtyString(l.qtyBase),
        taxableValue: toAmountString(l.taxable),
        gstRate: l.gstRate.toFixed(3),
        cgstAmount: toAmountString(l.cgst),
        sgstAmount: toAmountString(l.sgst),
        igstAmount: toAmountString(l.igst),
        cessAmount: toAmountString(l.cess),
        documentValue: toAmountString(grandTotal),
      };
    }),
  );

  const { allocated } = await allocateNoteCredit(tx, businessId, id);
  await audit(tx, ctx, {
    action: "credit_note.posted",
    entityType: "note",
    entityId: id,
    entityLabel: `${numbering.number} (${customer.businessName ?? customer.name})`,
    changes: { grandTotal: toAmountString(grandTotal), restock: body.restock, withoutBill: true, settled: toAmountString(allocated), lines: prepared.map((p, i) => [p.product.name, toQtyString(totals.lines[i]!.qty)]) },
  });
  await tx.insert(schema.outboxEvents).values({
    businessId,
    eventType: "credit_note.posted",
    aggregateType: "note",
    aggregateId: id,
    payload: { customerId: customer.id, grandTotal: toAmountString(grandTotal) },
  });
  return { id, warnings };
}

/**
 * A debit note on a bill, posted in one transaction: numbered, the taxable
 * amount spread over the bill's lines (by the value they still carry, or as
 * given per line) with each line's GST, the bill asking for that much more,
 * the customer's account debited, GST register rows against the bill.
 */
export async function postDebitNote(tx: Tx, ctx: RequestCtx, deps: AppDeps, invoiceId: string, body: DebitNoteInput, clientId: string | null) {
  const given = [body.amount, body.percent, body.lines].filter((x) => x !== undefined).length;
  if (given !== 1) throw badRequest("NOTE_AMOUNT_REQUIRED", {}, "amount");
  const businessId = ctx.businessId;
  const today = deps.clock.today(ctx.timeZone);
  const noteDate = body.noteDate ?? today;
  if (noteDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "noteDate");
  if (await periodLocked(tx, businessId, noteDate)) throw conflict("GST_PERIOD_LOCKED");

  const inv = schema.invoices;
  const [doc] = await tx.select().from(inv).where(and(eq(inv.id, invoiceId), eq(inv.businessId, businessId))).for("update");
  if (!doc) throw notFound("invoice");
  if (doc.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: doc.status });
  if (noteDate < doc.invoiceDate) throw badRequest("NOTE_BEFORE_DOCUMENT", { date: doc.invoiceDate }, "noteDate");
  const docNumber = doc.invoiceNumber ?? "";

  const ii = schema.invoiceItems;
  const items = await tx.select().from(ii).where(eq(ii.invoiceId, doc.id)).orderBy(asc(ii.lineNo)).for("update");
  // The value each line still carries after earlier notes: the weights to spread the amount by.
  const ni = schema.creditDebitNoteItems;
  const n = schema.creditDebitNotes;
  const earlier = await tx
    .select({ lineId: ni.originalLineId, taxable: sql<string>`sum(case when ${n.noteType} = 'credit' then ${ni.taxableValue} else -${ni.taxableValue} end)` })
    .from(ni)
    .innerJoin(n, eq(n.id, ni.noteId))
    .where(and(inArray(ni.originalLineId, items.map((i) => i.id)), eq(n.status, "posted")))
    .groupBy(ni.originalLineId);
  const left = new Map<string, Dec>(items.map((i) => [i.id, dec(i.taxableValue).minus(earlier.find((e) => e.lineId === i.id)?.taxable ?? 0)]));
  // Goods given free carry no value to raise.
  const priced = items.filter((i) => !i.schemeFree && dec(i.taxableValue).gt(0));

  const wanted = new Map<string, Dec>();
  if (body.lines) {
    body.lines.forEach((l, i) => {
      if (!priced.some((p) => p.id === l.lineId)) throw badRequest("RETURN_LINE_NOT_ON_DOCUMENT", {}, `lines[${i}].lineId`);
      wanted.set(l.lineId, (wanted.get(l.lineId) ?? dec(0)).plus(l.amount));
    });
  } else {
    const weightOf = (i: (typeof items)[number]) => (left.get(i.id)!.gt(0) ? left.get(i.id)! : dec(0));
    let base = priced.reduce((s, i) => s.plus(weightOf(i)), dec(0));
    // Everything already credited back: the bill's own values are the weights.
    const weight = base.gt(0) ? weightOf : (i: (typeof items)[number]) => dec(i.taxableValue);
    if (!base.gt(0)) base = priced.reduce((s, i) => s.plus(i.taxableValue), dec(0));
    if (!base.gt(0)) throw badRequest("NOTE_AMOUNT_REQUIRED", {}, "amount");
    const target = body.amount !== undefined ? dec(body.amount) : roundAmount(base.times(body.percent!).dividedBy(100));
    let spread = dec(0);
    const open = priced.filter((i) => weight(i).gt(0));
    open.forEach((i, k) => {
      const share = k === open.length - 1 ? target.minus(spread) : roundAmount(target.times(weight(i)).dividedBy(base));
      spread = spread.plus(share);
      wanted.set(i.id, share);
    });
  }
  const lines = items
    .filter((i) => wanted.get(i.id)?.gt(0))
    .map((item) => {
      const taxable = wanted.get(item.id)!;
      const pct = (r: string) => roundAmount(taxable.times(r).dividedBy(100));
      const share = { taxable, cgst: pct(item.cgstRate), sgst: pct(item.sgstRate), igst: pct(item.igstRate), cess: pct(item.cessRate) };
      return { item, share, total: taxable.plus(share.cgst).plus(share.sgst).plus(share.igst).plus(share.cess) };
    });
  if (!lines.length) throw badRequest("NOTE_AMOUNT_REQUIRED", {}, "amount");

  const sum = (k: "taxable" | "cgst" | "sgst" | "igst" | "cess") => lines.reduce((acc, l) => acc.plus(l.share[k]), dec(0));
  const settings = await getSettings(tx, businessId, ["invoice.round_off"] as const);
  const { rounded: grandTotal, roundOff } = applyRoundOff(lines.reduce((acc, l) => acc.plus(l.total), dec(0)), settings["invoice.round_off"]);
  if (body.clientTotals && !dec(body.clientTotals.grandTotal).eq(grandTotal)) {
    throw new ApiError(422, "TOTALS_MISMATCH", { field: "grandTotal", expected: grandTotal.toFixed(2), received: dec(body.clientTotals.grandTotal).toFixed(2) });
  }

  const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  // Our debit notes share one series (to customers here, to suppliers for purchase returns).
  const numbering = await nextDocumentNumber(tx, businessId, "debit_note", noteDate, business!.financialYearStartMonth);
  const [customer] = await tx.select({ registration: schema.customers.gstRegistration }).from(schema.customers).where(eq(schema.customers.id, doc.customerId));
  const id = uuidv7();
  await tx.insert(n).values({
    id,
    businessId,
    noteType: "debit",
    partyType: "customer",
    customerId: doc.customerId,
    noteNumber: numbering.number,
    seriesId: numbering.seriesId,
    financialYear: numbering.financialYear,
    noteDate,
    reason: body.reason,
    invoiceId: doc.id,
    affectsStock: false,
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
    grossTotal: toAmountString(sum("taxable")),
    discountTotal: "0",
    taxableTotal: toAmountString(sum("taxable")),
    cgstTotal: toAmountString(sum("cgst")),
    sgstTotal: toAmountString(sum("sgst")),
    igstTotal: toAmountString(sum("igst")),
    cessTotal: toAmountString(sum("cess")),
    roundOff: toAmountString(roundOff),
    grandTotal: toAmountString(grandTotal),
    amountSettled: "0",
    settlementStatus: "unpaid",
    notes: body.notes ?? null,
    postedAt: deps.clock.now().toISOString(),
    clientId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  const itemIds = lines.map(() => uuidv7());
  await tx.insert(ni).values(
    lines.map((l, i) => {
      const it = l.item;
      return {
        id: itemIds[i]!,
        businessId,
        noteId: id,
        lineNo: i + 1,
        productId: it.productId,
        productName: it.productName,
        hsnCode: it.hsnCode,
        uqc: it.uqc,
        unitId: it.unitId,
        conversionFactor: it.conversionFactor,
        // The value changes, not the goods: the line's quantity is kept for reference only.
        qty: it.qty,
        freeQty: "0",
        qtyBase: it.qtyBase,
        rate: toRateString(l.share.taxable.dividedBy(it.qty)),
        rateIncludesTax: false,
        discountPercent: "0",
        grossAmount: toAmountString(l.share.taxable),
        discountAmount: "0",
        documentDiscountShare: "0",
        taxableValue: toAmountString(l.share.taxable),
        cgstAmount: toAmountString(l.share.cgst),
        sgstAmount: toAmountString(l.share.sgst),
        igstAmount: toAmountString(l.share.igst),
        cessAmount: toAmountString(l.share.cess),
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
        unitCost: "0",
        originalLineId: it.id,
      };
    }),
  );

  // The bill asks for more: its balance and payment status follow.
  const debited = dec(doc.debited).plus(grandTotal);
  await tx
    .update(inv)
    .set({
      debited: toAmountString(debited),
      balanceDue: toAmountString(dec(doc.balanceDue).plus(grandTotal)),
      paymentStatus: paymentStatusFor(dec(doc.grandTotal).plus(debited), doc.amountPaid),
      version: doc.version + 1,
      updatedBy: ctx.userId,
    })
    .where(eq(inv.id, doc.id));
  const label = body.reason === "rate_difference" ? "Rate difference" : "Charges";
  await postPartyEntry(tx, {
    businessId,
    party: { type: "customer", id: doc.customerId },
    date: noteDate,
    docType: "debit_note",
    docId: id,
    docNumber: numbering.number,
    debit: toAmountString(grandTotal),
    narration: `${label} on ${docNumber}`,
    userId: ctx.userId,
  });
  await tx.insert(schema.gstTransactions).values(
    lines.map((l, i) => ({
      businessId,
      direction: "outward" as const,
      docType: "debit_note" as const,
      docId: id,
      docLineId: itemIds[i]!,
      docNumber: numbering.number,
      docDate: noteDate,
      originalDocNumber: docNumber,
      originalDocDate: doc.invoiceDate,
      returnPeriod: noteDate.slice(0, 7),
      partyName: doc.partyName,
      partyGstin: doc.partyGstin,
      partyRegistration: customer!.registration,
      partyStateCode: doc.partyStateCode,
      placeOfSupply: doc.placeOfSupply,
      supplyType: doc.supplyType,
      isReverseCharge: false,
      taxability: l.item.taxability,
      hsnCode: l.item.hsnCode,
      uqc: l.item.uqc,
      qty: "0",
      taxableValue: toAmountString(l.share.taxable),
      gstRate: l.item.gstRate,
      cgstAmount: toAmountString(l.share.cgst),
      sgstAmount: toAmountString(l.share.sgst),
      igstAmount: toAmountString(l.share.igst),
      cessAmount: toAmountString(l.share.cess),
      documentValue: toAmountString(grandTotal),
      // A note on an export or a supply to SEZ is reported with it.
      zeroRatedType: doc.zeroRatedType,
    })),
  );
  await audit(tx, ctx, {
    action: "debit_note.posted",
    entityType: "note",
    entityId: id,
    entityLabel: `${numbering.number} (${docNumber})`,
    changes: { reason: body.reason, taxable: toAmountString(sum("taxable")), grandTotal: toAmountString(grandTotal) },
  });
  await tx.insert(schema.outboxEvents).values({
    businessId,
    eventType: "debit_note.posted",
    aggregateType: "note",
    aggregateId: id,
    payload: { invoiceId: doc.id, customerId: doc.customerId, grandTotal: toAmountString(grandTotal) },
  });
  return { id, warnings: [] as Warning[] };
}

/**
 * A customer's debit note cancelled: the bill asks for that much less again.
 * Refused once the bill's balance no longer covers it (a payment took it):
 * that payment comes off the bill first.
 */
export async function undoDebitOnInvoice(tx: Tx, ctx: RequestCtx, invoiceId: string, amount: string): Promise<void> {
  const inv = schema.invoices;
  const [doc] = await tx.select().from(inv).where(eq(inv.id, invoiceId)).for("update");
  if (!doc) throw notFound("invoice");
  if (dec(doc.balanceDue).lt(amount)) throw conflict("DEBIT_NOTE_PAID", { balance: doc.balanceDue });
  const debited = dec(doc.debited).minus(amount);
  await tx
    .update(inv)
    .set({
      debited: toAmountString(debited),
      balanceDue: toAmountString(dec(doc.balanceDue).minus(amount)),
      paymentStatus: paymentStatusFor(dec(doc.grandTotal).plus(debited), doc.amountPaid),
      version: doc.version + 1,
      updatedBy: ctx.userId,
    })
    .where(eq(inv.id, invoiceId));
}
