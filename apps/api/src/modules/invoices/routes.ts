import { CancelBody, InvoiceBody, InvoiceListQuery, InvoiceReviewBody, ShippingBillBody } from "@digitalbahi/contracts";
import { addDays, amountInWords, dec, evaluateCredit, taxComponentLabels, toAmountString, toQtyString, toRateString, type DocumentTotals, type OpenDocument } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { lockIdempotencyKey, withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { offlineInvoiceNumber } from "../../services/devices.js";
import { notify } from "../../services/notifications.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { postPartyEntry } from "../../services/party-ledger.js";
import { recordPayment, releaseAllocations } from "../../services/payments.js";
import { prepareSale, type PreparedSale, type ReviewReason } from "../../services/sales-document.js";
import { getSetting } from "../../services/settings.js";
import { postStockMovement } from "../../services/stock.js";
import { likeContains } from "../catalog/products.js";
import { assertNoPostedReturns, documentReturns } from "../notes/routes.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });

interface Warning {
  code: string;
  params: Record<string, string | number>;
}

const money = (d: { toFixed(n: number): string }) => d.toFixed(2);

function totalsOut(t: DocumentTotals) {
  return {
    lineCount: t.lineCount,
    grossTotal: money(t.grossTotal),
    discountTotal: money(t.discountTotal),
    taxableTotal: money(t.taxableTotal),
    cgstTotal: money(t.cgstTotal),
    sgstTotal: money(t.sgstTotal),
    igstTotal: money(t.igstTotal),
    cessTotal: money(t.cessTotal),
    taxTotal: money(t.taxTotal),
    chargesTotal: money(t.chargesTotal),
    roundOff: money(t.roundOff),
    grandTotal: money(t.grandTotal),
    amountPaid: money(t.amountPaid),
    balanceDue: money(t.balanceDue),
    excessPaid: money(t.excessPaid),
    paymentStatus: t.paymentStatus,
    lines: t.lines.map((l) => ({
      key: l.key,
      qty: l.qty.toFixed(3),
      rate: l.rate.toFixed(4),
      gross: money(l.gross),
      discount: money(l.discount),
      taxable: money(l.taxable),
      gstRate: l.gstRate.toFixed(3),
      cgst: money(l.cgst),
      sgst: money(l.sgst),
      igst: money(l.igst),
      cess: money(l.cess),
      total: money(l.total),
    })),
    rateBreakup: t.rateBreakup.map((r) => ({
      gstRate: r.gstRate.toFixed(3),
      taxable: money(r.taxable),
      cgst: money(r.cgst),
      sgst: money(r.sgst),
      igst: money(r.igst),
      cess: money(r.cess),
    })),
  };
}

async function openInvoices(tx: Tx, businessId: string, customerId: string): Promise<OpenDocument[]> {
  const i = schema.invoices;
  const rows = await tx
    .select({ id: i.id, number: i.invoiceNumber, date: i.invoiceDate, dueDate: i.dueDate, balance: i.balanceDue })
    .from(i)
    .where(and(eq(i.businessId, businessId), eq(i.customerId, customerId), eq(i.status, "posted"), gt(i.balanceDue, "0")));
  return rows.map((r) => ({ id: r.id, number: r.number ?? "", date: r.date, dueDate: r.dueDate ?? r.date, balance: r.balance }));
}

/**
 * Credit check against the business policy; returns warnings or throws when
 * blocked. A bill made offline is never refused: `blocked` says it went past
 * a blocking limit (it is then held for review).
 */
function checkCredit(ctx: RequestCtx, sale: PreparedSale, outstanding: string, open: OpenDocument[], offline = false): Warning[] & { blocked?: boolean } {
  const newAmount = sale.totals.grandTotal.minus(sale.totals.amountPaid);
  const result = evaluateCredit({
    creditLimit: sale.customer.creditLimit,
    outstanding,
    newAmount: newAmount.isNegative() ? "0" : newAmount,
    openDocuments: open,
    asOf: sale.invoiceDate,
    policy: sale.settings["credit.policy"],
  });
  const warnings = result.reasons.map((r) => ({ code: r.code, params: r.params }));
  const blocked = result.level === "block" && !can(ctx, "invoice.override_credit_limit");
  if (blocked && !offline) {
    const first = result.reasons[0]!;
    throw new ApiError(409, "CREDIT_BLOCKED", { reason: first.code, ...first.params });
  }
  return Object.assign(warnings, { blocked });
}

export async function invoiceDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [inv] = await tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.businessId, ctx.businessId)));
  if (!inv) throw notFound("invoice");
  const items = await tx
    .select()
    .from(schema.invoiceItems)
    .where(eq(schema.invoiceItems.invoiceId, id))
    .orderBy(asc(schema.invoiceItems.lineNo));
  const schemeIds = [...new Set(items.map((i) => i.schemeId).filter((x): x is string => x !== null))];
  const schemeNames = schemeIds.length ? await tx.select({ id: schema.schemes.id, name: schema.schemes.name }).from(schema.schemes).where(inArray(schema.schemes.id, schemeIds)) : [];
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
    .where(eq(schema.paymentAllocations.invoiceId, id));
  const [biz] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
  const returns = await documentReturns(tx, { invoiceId: id });
  const [reviewer] = inv.reviewedBy ? await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, inv.reviewedBy)) : [];
  const showCost = can(ctx, "product.view_cost");
  const { businessId: _b, costTotal, ...rest } = inv;
  return {
    ...rest,
    ...(showCost ? { costTotal } : {}),
    returns,
    /** Who marked it reviewed, for a bill made offline that was held. */
    reviewerName: reviewer?.name ?? null,
    seller: {
      legalName: biz!.legalName,
      tradeName: biz!.tradeName,
      gstin: biz!.gstin,
      stateCode: biz!.stateCode,
      addressLine1: biz!.addressLine1,
      addressLine2: biz!.addressLine2,
      city: biz!.city,
      pincode: biz!.pincode,
      phone: biz!.phone,
    },
    taxLabels: taxComponentLabels(inv.placeOfSupply),
    amountInWords: amountInWords(inv.grandTotal, inv.printLocale),
    items: items.map(({ businessId: _ib, unitCost, ...item }) => ({ ...item, schemeName: schemeNames.find((x) => x.id === item.schemeId)?.name ?? null, ...(showCost ? { unitCost } : {}) })),
    payments,
  };
}

/**
 * Posts an invoice in the caller's transaction (used by POST /invoices and by
 * converting a sales order). `link` ties the invoice and its lines to the
 * order they fulfil.
 */
export async function postInvoice(
  tx: Tx,
  ctx: RequestCtx,
  deps: AppDeps,
  body: z.output<typeof InvoiceBody>,
  clientId: string | null,
  link?: { salesOrderId: string; orderItemIds: string[] },
) {
  const today = deps.clock.today(ctx.timeZone);
  // An order's lines keep the schemes they were given when it was taken.
  const sale = await prepareSale(tx, ctx, body, today, { trustSchemes: link !== undefined });
  const t = sale.totals;
  const warnings: Warning[] = [];
  const review: ReviewReason[] = [...sale.review];

  // 1. Number (locks the series row: gap-free, never duplicated). A bill made
  //    offline keeps the number its device gave it.
  const numbering = body.offline
    ? await offlineInvoiceNumber(tx, ctx, body.offline, sale.invoiceDate, sale.business.financialYearStartMonth)
    : await nextDocumentNumber(tx, ctx.businessId, "invoice", sale.invoiceDate, sale.business.financialYearStartMonth);
  const id = uuidv7();
  const c = sale.customer;
  const address = { line1: c.addressLine1, line2: c.addressLine2, city: c.city, stateCode: c.stateCode, pincode: c.pincode };
  let costTotal = dec(0);
  sale.lines.forEach((p, i) => {
    const l = t.lines[i]!;
    costTotal = costTotal.plus(l.qtyBase.plus(p.freeQtyBase).times(p.avgCost));
  });

  // 2. Invoice + lines with the full tax snapshot. Payment fields start
  //    unpaid; the payment step below settles them.
  await tx.insert(schema.invoices).values({
    id,
    businessId: ctx.businessId,
    invoiceNumber: numbering.number,
    seriesId: numbering.seriesId,
    financialYear: numbering.financialYear,
    invoiceDate: sale.invoiceDate,
    dueDate: addDays(sale.invoiceDate, c.creditDays),
    documentKind: sale.documentKind,
    customerId: c.id,
    partyName: c.businessName ?? c.name,
    partyGstin: c.gstin,
    partyStateCode: c.stateCode,
    billingAddress: address,
    shippingAddress: body.shipToStateCode ? { ...address, stateCode: body.shipToStateCode } : address,
    placeOfSupply: sale.placeOfSupply,
    supplyType: sale.supplyType,
    taxEngineVersion: "gst-line@1",
    warehouseId: sale.warehouseId,
    priceLevelId: sale.priceLevelId,
    salespersonId: body.salespersonId ?? null,
    status: "posted",
    grossTotal: toAmountString(t.grossTotal),
    discountTotal: toAmountString(t.discountTotal),
    documentDiscountPercent: body.documentDiscount?.percent ?? "0",
    documentDiscountAmount: body.documentDiscount?.amount ?? "0",
    taxableTotal: toAmountString(t.taxableTotal),
    cgstTotal: toAmountString(t.cgstTotal),
    sgstTotal: toAmountString(t.sgstTotal),
    igstTotal: toAmountString(t.igstTotal),
    cessTotal: toAmountString(t.cessTotal),
    charges: t.charges.map((ch) => ({
      key: ch.key,
      label: ch.label,
      taxable: money(ch.taxable),
      gstRate: ch.gstRate.toFixed(3),
      cgst: money(ch.cgst),
      sgst: money(ch.sgst),
      igst: money(ch.igst),
      cess: money(ch.cess),
      total: money(ch.total),
    })),
    chargesTotal: toAmountString(t.chargesTotal),
    roundOff: toAmountString(t.roundOff),
    grandTotal: toAmountString(t.grandTotal),
    amountPaid: "0",
    balanceDue: toAmountString(t.grandTotal),
    paymentStatus: t.grandTotal.isZero() ? "paid" : "unpaid",
    costTotal: toAmountString(costTotal),
    notes: body.notes ?? null,
    printLocale: body.printLocale ?? sale.settings["invoice.default_print_locale"],
    zeroRatedType: sale.zeroRatedType,
    shippingBillNumber: sale.shippingBill.number,
    shippingBillDate: sale.shippingBill.date,
    portCode: sale.shippingBill.portCode,
    lutArn: sale.lutArn,
    postedAt: deps.clock.now().toISOString(),
    postedBy: ctx.userId,
    clientId,
    deviceId: body.offline?.deviceId ?? null,
    salesOrderId: link?.salesOrderId ?? null,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  const itemIds = sale.lines.map(() => uuidv7());
  await tx.insert(schema.invoiceItems).values(
    sale.lines.map((p, i) => {
      const l = t.lines[i]!;
      return {
        id: itemIds[i]!,
        businessId: ctx.businessId,
        invoiceId: id,
        orderItemId: link?.orderItemIds[i] ?? null,
        lineNo: i + 1,
        productId: p.productId,
        productName: p.productName,
        hsnCode: p.hsnCode,
        uqc: p.uqc,
        unitId: p.unitId,
        batchId: p.batchId,
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
        unitCost: toRateString(p.avgCost),
        schemeId: p.schemeId,
        schemeDiscount: p.schemeDiscount,
        schemeFree: p.schemeFree,
      };
    }),
  );

  // 3. Stock out, locking balances in product order (deadlock-free).
  const setPolicy = sale.settings["stock.negative_policy"];
  const policy = body.offline && setPolicy === "block" ? "warn" : setPolicy;
  const order = sale.lines.map((_, i) => i).sort((a, b) => sale.lines[a]!.productId.localeCompare(sale.lines[b]!.productId));
  for (const i of order) {
    const p = sale.lines[i]!;
    const qty = t.lines[i]!.qtyBase.plus(p.freeQtyBase);
    const moved = await postStockMovement(
      tx,
      {
        businessId: ctx.businessId,
        productId: p.productId,
        productName: p.productName,
        warehouseId: sale.warehouseId,
        batchId: p.batchId,
        date: sale.invoiceDate,
        type: "sale",
        qty: toQtyString(qty),
        unitCost: p.avgCost,
        refType: "invoice",
        refId: id,
        refLineId: itemIds[i]!,
        refNumber: numbering.number,
        userId: ctx.userId,
      },
      policy,
    );
    if (moved.warning) {
      const params = { product: p.productName, available: moved.warning.available.toString(), requested: moved.warning.requested.toString() };
      warnings.push({ code: "insufficient_stock", params });
      // Short of stock where the business blocks it: the bill made offline is held.
      if (policy !== setPolicy) review.push({ code: "stock_short", params });
    }
  }

  // 4. Credit policy, with the customer row locked.
  // NO KEY UPDATE: it serialises balance changes without clashing with the key-share lock other
  // bills take on the customer by referring to it (FOR UPDATE would, and two bills deadlock).
  const [locked] = await tx.select({ balance: schema.customers.balance }).from(schema.customers).where(eq(schema.customers.id, c.id)).for("no key update");
  const open = (await openInvoices(tx, ctx.businessId, c.id)).filter((d) => d.id !== id);
  const credit = checkCredit(ctx, sale, locked!.balance, open, Boolean(body.offline));
  warnings.push(...credit);
  if (credit.blocked) {
    for (const w of credit) review.push({ code: w.code === "overdue_invoices" ? "credit_overdue" : "credit_limit", params: { customer: c.businessName ?? c.name, ...w.params } });
  }

  // 5. Customer ledger debit.
  await postPartyEntry(tx, {
    businessId: ctx.businessId,
    party: { type: "customer", id: c.id },
    date: sale.invoiceDate,
    docType: "invoice",
    docId: id,
    docNumber: numbering.number,
    debit: toAmountString(t.grandTotal),
    narration: `Sales invoice ${numbering.number}`,
    userId: ctx.userId,
  });

  // 6. GST register: one row per line (and per taxable charge).
  const gstBase = {
    businessId: ctx.businessId,
    direction: "outward" as const,
    docType: "invoice" as const,
    docId: id,
    docNumber: numbering.number,
    docDate: sale.invoiceDate,
    returnPeriod: sale.invoiceDate.slice(0, 7),
    partyName: c.businessName ?? c.name,
    partyGstin: c.gstin,
    partyRegistration: c.gstRegistration,
    partyStateCode: c.stateCode,
    placeOfSupply: sale.placeOfSupply,
    supplyType: sale.supplyType,
    documentValue: toAmountString(t.grandTotal),
    zeroRatedType: sale.zeroRatedType,
  };
  await tx.insert(schema.gstTransactions).values([
    ...sale.lines.map((p, i) => {
      const l = t.lines[i]!;
      return {
        ...gstBase,
        docLineId: itemIds[i]!,
        taxability: p.taxability,
        hsnCode: p.hsnCode,
        uqc: p.uqc,
        qty: toQtyString(l.qtyBase),
        taxableValue: money(l.taxable),
        gstRate: l.gstRate.toFixed(3),
        cgstAmount: money(l.cgst),
        sgstAmount: money(l.sgst),
        igstAmount: money(l.igst),
        cessAmount: money(l.cess),
      };
    }),
    ...t.charges
      .filter((ch) => ch.gstRate.gt(0))
      .map((ch) => ({
        ...gstBase,
        taxability: "taxable" as const,
        taxableValue: money(ch.taxable),
        gstRate: ch.gstRate.toFixed(3),
        cgstAmount: money(ch.cgst),
        sgstAmount: money(ch.sgst),
        igstAmount: money(ch.igst),
        cessAmount: money(ch.cess),
      })),
  ]);

  // 7. Money received with the invoice.
  let payment = null;
  if (body.payment && dec(body.payment.amount).gt(0)) {
    const settle = t.amountPaid.gt(t.grandTotal) ? t.grandTotal : t.amountPaid;
    payment = await recordPayment(tx, ctx, sale.business.financialYearStartMonth, {
      direction: "in",
      party: { type: "customer", id: c.id, name: c.name },
      date: sale.invoiceDate,
      amount: body.payment.amount,
      method: body.payment.method,
      referenceNumber: body.payment.reference ?? null,
      paymentAccountId: body.payment.paymentAccountId ?? null,
      allocations: settle.gt(0) ? [{ documentId: id, amount: settle.toFixed(2) }] : [],
    });
  }

  // 8. Made offline and broke a rule meanwhile: posted, and held for a manager.
  if (review.length) {
    await tx.update(schema.invoices).set({ reviewStatus: "needs_review", reviewReasons: review }).where(eq(schema.invoices.id, id));
    await notify(
      tx,
      ctx.businessId,
      {
        type: "offline_review",
        permission: "invoice.review",
        severity: "warning",
        titleKey: "notifications.events.offline_review",
        bodyKey: `notifications.review.${review[0]!.code}`,
        params: { ...review[0]!.params, number: numbering.number, customer: c.businessName ?? c.name, total: toAmountString(t.grandTotal), reasons: review.length },
        entityType: "invoice",
        entityId: id,
        dedupeKey: `invoice:${id}:review`,
      },
      deps.clock.now().toISOString(),
    );
  }

  await audit(tx, ctx, {
    action: "invoice.posted",
    entityType: "invoice",
    entityId: id,
    entityLabel: numbering.number,
    changes: {
      customer: c.name,
      grandTotal: toAmountString(t.grandTotal),
      ...(sale.rateOverridden ? { rateOverridden: true } : {}),
      ...(warnings.length ? { warnings: warnings.map((w) => w.code) } : {}),
      ...(body.offline ? { savedOffline: body.offline.savedAt ?? true, device: body.offline.deviceId } : {}),
      ...(review.length ? { heldForReview: review.map((r) => r.code) } : {}),
    },
  });
  await tx.insert(schema.outboxEvents).values({
    businessId: ctx.businessId,
    eventType: "invoice.posted",
    aggregateType: "invoice",
    aggregateId: id,
    payload: { customerId: c.id, invoiceDate: sale.invoiceDate, grandTotal: toAmountString(t.grandTotal) },
  });
  return { detail: { ...(await invoiceDetail(tx, ctx, id)), ...(payment ? { payment } : {}) }, warnings };
}

export const invoicesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** Totals, stock and credit warnings for a draft, without saving anything. */
  r.post("/invoices/preview", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], body: InvoiceBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const sale = await prepareSale(tx, ctx, request.body, deps.clock.today(ctx.timeZone));
      const warnings: Warning[] = [];
      const need = new Map<string, { name: string; qty: ReturnType<typeof dec> }>();
      sale.totals.lines.forEach((l, i) => {
        const p = sale.lines[i]!;
        const prev = need.get(p.productId);
        need.set(p.productId, { name: p.productName, qty: (prev?.qty ?? dec(0)).plus(l.qtyBase).plus(p.freeQtyBase) });
      });
      for (const [productId, n] of need) {
        const [bal] = await tx
          .select({ qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)::text` })
          .from(schema.stockBalances)
          .where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.warehouseId, sale.warehouseId)));
        if (n.qty.gt(bal!.qty)) {
          warnings.push({ code: "insufficient_stock", params: { product: n.name, available: dec(bal!.qty).toString(), requested: n.qty.toString() } });
        }
      }
      try {
        warnings.push(...checkCredit(ctx, sale, sale.customer.balance, await openInvoices(tx, ctx.businessId, sale.customer.id)));
      } catch (e) {
        if (e instanceof ApiError && e.code === "CREDIT_BLOCKED") warnings.push({ code: "credit_blocked", params: e.params });
        else throw e;
      }
      return {
        invoiceDate: sale.invoiceDate,
        documentKind: sale.documentKind,
        placeOfSupply: sale.placeOfSupply,
        supplyType: sale.supplyType,
        zeroRatedType: sale.zeroRatedType,
        taxLabels: taxComponentLabels(sale.placeOfSupply),
        lines: sale.lines.map((l) => ({ key: l.key, productId: l.productId, productName: l.productName, unitId: l.unitId, listRate: l.listRate, hsnCode: l.hsnCode })),
        totals: totalsOut(sale.totals),
        warnings,
      };
    });
  });

  /**
   * Posts an invoice in one transaction: number, tax snapshot, stock out,
   * customer ledger debit, GST register, optional payment, audit, outbox.
   * An Idempotency-Key header makes retries (flaky network, offline sync) safe.
   */
  r.post("/invoices", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], body: InvoiceBody } }, async (request, reply) => {
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
        if (existing) return { replay: true, detail: await invoiceDetail(tx, ctx, existing.id), warnings: [] as Warning[] };
      }
      return { replay: false, ...(await postInvoice(tx, ctx, deps, body, clientId)) };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send({ ...result.detail, warnings: result.warnings });
  });

  r.get("/invoices", { preHandler: guard(deps, "invoice.view"), schema: { tags: ["invoices"], querystring: InvoiceListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const i = schema.invoices;
    const where: SQL[] = [eq(i.businessId, ctx.businessId), sql`${i.status} <> 'draft'`];
    if (q.customerId) where.push(eq(i.customerId, q.customerId));
    if (q.from) where.push(sql`${i.invoiceDate} >= ${q.from}`);
    if (q.to) where.push(sql`${i.invoiceDate} <= ${q.to}`);
    if (q.status !== "all") where.push(eq(i.status, q.status));
    if (q.paymentStatus === "open") where.push(sql`${i.status} = 'posted' and ${i.balanceDue} > 0`);
    else if (q.paymentStatus !== "all") where.push(eq(i.paymentStatus, q.paymentStatus));
    if (q.q) where.push(sql`(${i.invoiceNumber} ilike ${likeContains(q.q)} or ${i.partyName} ilike ${likeContains(q.q)})`);
    if (q.review) where.push(eq(i.reviewStatus, q.review));
    if (cursor) where.push(sql`(${i.invoiceDate}, ${i.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          invoiceDate: i.invoiceDate,
          dueDate: i.dueDate,
          customerId: i.customerId,
          partyName: i.partyName,
          partyGstin: i.partyGstin,
          grandTotal: i.grandTotal,
          amountPaid: i.amountPaid,
          balanceDue: i.balanceDue,
          paymentStatus: i.paymentStatus,
          status: i.status,
          reviewStatus: i.reviewStatus,
        })
        .from(i)
        .where(and(...where))
        .orderBy(sql`${i.invoiceDate} desc, ${i.id} desc`)
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.invoiceDate, id: x.id }));
  });

  /**
   * An export's shipping bill (number, date, port), usually known only after the invoice.
   * It is not part of the tax: changing it is allowed after the month's GSTR-1 is locked.
   */
  r.patch(
    "/invoices/:id/shipping-bill",
    { preHandler: guard(deps, "invoice.update"), schema: { tags: ["invoices"], params: IdParams, body: ShippingBillBody } },
    async (request) => {
      const ctx = request.ctx;
      const body = request.body;
      return tenant(ctx, async (tx) => {
        const [inv] = await tx
          .select()
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, request.params.id), eq(schema.invoices.businessId, ctx.businessId)));
        if (!inv) throw notFound("invoice");
        if (!inv.zeroRatedType?.startsWith("EXP")) throw badRequest("SHIPPING_BILL_NOT_EXPORT");
        if (inv.status === "cancelled") throw new ApiError(409, "INVOICE_CANCELLED");
        if (body.shippingBillDate && body.shippingBillDate < inv.invoiceDate) throw badRequest("SHIPPING_BILL_BEFORE_INVOICE", {}, "shippingBillDate");
        const next = { shippingBillNumber: body.shippingBillNumber, shippingBillDate: body.shippingBillDate, portCode: body.portCode };
        const changes = Object.fromEntries(
          (Object.keys(next) as Array<keyof typeof next>).flatMap((k) => (inv[k] !== next[k] ? [[k, [inv[k], next[k]]]] : [])),
        );
        if (Object.keys(changes).length) {
          await tx.update(schema.invoices).set({ ...next, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(eq(schema.invoices.id, inv.id));
          await audit(tx, ctx, { action: "invoice.shipping_bill_updated", entityType: "invoice", entityId: inv.id, entityLabel: inv.invoiceNumber ?? undefined, changes });
        }
        return invoiceDetail(tx, ctx, inv.id);
      });
    },
  );

  r.get("/invoices/:id", { preHandler: guard(deps, "invoice.view"), schema: { tags: ["invoices"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => invoiceDetail(tx, request.ctx, request.params.id)),
  );

  /**
   * Voids a posted invoice. The number stays used; stock comes back, the
   * customer ledger gets a reversing credit, GST rows are flagged cancelled
   * and any payment becomes an advance. Blocked by the DB when the GST
   * period is locked.
   */
  /** How many bills made offline are held for review (the Invoices screen's tab). */
  r.get("/invoices/review-count", { preHandler: guard(deps, "invoice.view"), schema: { tags: ["invoices"] } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.businessId, ctx.businessId), eq(schema.invoices.reviewStatus, "needs_review")));
      return { count: row!.n };
    });
  });

  /**
   * Marks a bill held for review as reviewed: the manager accepts it as it is
   * (after a credit note, a word with the salesperson …). Cancelling it
   * instead settles the review too. Whoever made the bill is told.
   */
  r.post(
    "/invoices/:id/review",
    { preHandler: guard(deps, "invoice.review"), schema: { tags: ["invoices"], params: IdParams, body: InvoiceReviewBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [inv] = await tx
          .select()
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, request.params.id), eq(schema.invoices.businessId, ctx.businessId)))
          .for("update");
        if (!inv) throw notFound("invoice");
        if (inv.reviewStatus !== "needs_review") throw conflict("NOT_HELD_FOR_REVIEW");
        const now = deps.clock.now().toISOString();
        const note = request.body.note || null;
        await tx
          .update(schema.invoices)
          .set({ reviewStatus: "reviewed", reviewedBy: ctx.userId, reviewedAt: now, reviewNote: note, updatedBy: ctx.userId })
          .where(eq(schema.invoices.id, inv.id));
        await audit(tx, ctx, {
          action: "invoice.reviewed",
          entityType: "invoice",
          entityId: inv.id,
          entityLabel: inv.invoiceNumber ?? undefined,
          changes: { reasons: (inv.reviewReasons ?? []).map((x) => x.code), ...(note ? { note } : {}) },
        });
        if (inv.postedBy && inv.postedBy !== ctx.userId) {
          const [reviewer] = await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ctx.userId));
          await notify(
            tx,
            ctx.businessId,
            {
              type: "offline_reviewed",
              permission: null,
              userId: inv.postedBy,
              severity: "success",
              titleKey: "notifications.events.offline_reviewed",
              params: { number: inv.invoiceNumber, customer: inv.partyName, reviewer: reviewer?.name ?? null, note },
              entityType: "invoice",
              entityId: inv.id,
              dedupeKey: `invoice:${inv.id}:reviewed`,
            },
            now,
          );
        }
        return invoiceDetail(tx, ctx, inv.id);
      });
    },
  );

  r.post(
    "/invoices/:id/cancel",
    { preHandler: guard(deps, "invoice.cancel"), schema: { tags: ["invoices"], params: IdParams, body: CancelBody } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [inv] = await tx
          .select()
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, request.params.id), eq(schema.invoices.businessId, ctx.businessId)))
          .for("update");
        if (!inv) throw notFound("invoice");
        if (inv.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: inv.status });
        await assertNoPostedReturns(tx, { invoiceId: inv.id });
        const windowHours = await getSetting(tx, ctx.businessId, "invoice.edit_window_hours");
        const ageHours = (deps.clock.now().getTime() - Date.parse(inv.postedAt ?? inv.createdAt)) / 3_600_000;
        if (windowHours > 0 && ageHours > windowHours && !ctx.isOwner) throw conflict("EDIT_WINDOW_CLOSED", { hours: windowHours });

        const now = deps.clock.now().toISOString();
        const today = deps.clock.today(ctx.timeZone);
        const items = await tx.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
        for (const item of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
          const qty = dec(item.qtyBase).plus(dec(item.freeQty).times(item.conversionFactor));
          await postStockMovement(
            tx,
            {
              businessId: ctx.businessId,
              productId: item.productId,
              productName: item.productName,
              warehouseId: inv.warehouseId,
              batchId: item.batchId,
              date: today,
              type: "sale_return",
              qty: toQtyString(qty),
              unitCost: item.unitCost,
              refType: "invoice_cancel",
              refId: inv.id,
              refLineId: item.id,
              refNumber: inv.invoiceNumber,
              reason: request.body.reason,
              userId: ctx.userId,
            },
            "allow",
          );
        }
        const released = await releaseAllocations(tx, { invoiceId: inv.id }, now);
        await tx
          .update(schema.invoices)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelledBy: ctx.userId,
            cancelReason: request.body.reason,
            amountPaid: "0",
            balanceDue: "0",
            paymentStatus: "unpaid",
            // Cancelling a bill held for review settles the review.
            ...(inv.reviewStatus === "needs_review" ? { reviewStatus: "reviewed" as const, reviewedBy: ctx.userId, reviewedAt: now, reviewNote: request.body.reason } : {}),
            version: inv.version + 1,
            updatedBy: ctx.userId,
          })
          .where(eq(schema.invoices.id, inv.id));
        const [original] = await tx
          .select({ id: schema.partyLedgerEntries.id })
          .from(schema.partyLedgerEntries)
          .where(and(eq(schema.partyLedgerEntries.docType, "invoice"), eq(schema.partyLedgerEntries.docId, inv.id)));
        await postPartyEntry(tx, {
          businessId: ctx.businessId,
          party: { type: "customer", id: inv.customerId },
          date: today,
          docType: "invoice_cancel",
          docId: inv.id,
          docNumber: inv.invoiceNumber,
          credit: inv.grandTotal,
          narration: `Cancelled: ${request.body.reason}`,
          reversesEntryId: original?.id ?? null,
          userId: ctx.userId,
        });
        await tx
          .update(schema.gstTransactions)
          .set({ isCancelled: true })
          .where(and(eq(schema.gstTransactions.docType, "invoice"), eq(schema.gstTransactions.docId, inv.id), eq(schema.gstTransactions.businessId, ctx.businessId)));
        await audit(tx, ctx, {
          action: "invoice.cancelled",
          entityType: "invoice",
          entityId: inv.id,
          entityLabel: inv.invoiceNumber ?? undefined,
          changes: { reason: request.body.reason, grandTotal: inv.grandTotal, releasedToAdvance: released },
        });
        await tx.insert(schema.outboxEvents).values({
          businessId: ctx.businessId,
          eventType: "invoice.cancelled",
          aggregateType: "invoice",
          aggregateId: inv.id,
          payload: { customerId: inv.customerId },
        });
        return invoiceDetail(tx, ctx, inv.id);
      });
    },
  );
};
