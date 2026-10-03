import { zeroRatedDeclaration, type Permission, type ZeroRatedType } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { createTranslator, formatCurrency, formatDate, isLocaleCode, type LocaleCode } from "@digitalbahi/i18n";
import { inArray, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { loadLetterhead } from "../../services/letterhead.js";
import { renderDocumentPdf, renderReceiptPdf, type DocumentPdfLine } from "../../services/pdf-document.js";
import { getSettings } from "../../services/settings.js";
import { invoiceDetail } from "../invoices/routes.js";
import { noteDetail } from "../notes/routes.js";
import { paymentDetail } from "../payments/routes.js";
import type { ApiModule } from "../types.js";

/** A document as a PDF file, with who it is for (for WhatsApp and email). */
export interface PdfFile {
  pdf: Buffer;
  filename: string;
  number: string;
  date: string;
  amount: string;
  balance: string | null;
  locale: LocaleCode;
  party: { type: "customer" | "supplier" | "employee"; id: string; name: string; mobile: string | null; email: string | null } | null;
  /** The message that goes with the file (WhatsApp text, email subject and body) and the template parameters: party, number, amount, business. */
  message: { text: string; subject: string; params: string[] };
}

const IdParams = z.object({ id: z.uuid() });
const PdfQuery = z.object({ locale: z.enum(["en", "hi"]).optional() });

const fileName = (number: string) => `${number.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "document"}.pdf`;

async function partyContact(tx: Tx, type: "customer" | "supplier" | "employee", id: string | null): Promise<PdfFile["party"]> {
  if (!id) return null;
  if (type === "employee") {
    const [e] = await tx.select({ name: schema.employees.name, mobile: schema.employees.mobile }).from(schema.employees).where(eq(schema.employees.id, id));
    return e ? { type, id, name: e.name, mobile: e.mobile, email: null } : null;
  }
  const t = type === "customer" ? schema.customers : schema.suppliers;
  const [p] = await tx.select({ name: t.name, mobile: t.mobile, email: t.email }).from(t).where(eq(t.id, id));
  return p ? { type, id, ...p } : null;
}

/** Hindi product names, unit symbols and batch numbers for the lines of a document. */
async function lineExtras(tx: Tx, items: Array<{ productId: string; unitId: string; batchId?: string | null }>) {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const unitIds = [...new Set(items.map((i) => i.unitId))];
  const batchIds = [...new Set(items.map((i) => i.batchId).filter(Boolean))] as string[];
  const [products, units, batches] = await Promise.all([
    productIds.length ? tx.select({ id: schema.products.id, nameLocal: schema.products.nameLocal }).from(schema.products).where(inArray(schema.products.id, productIds)) : [],
    unitIds.length ? tx.select({ id: schema.units.id, symbol: schema.units.symbol }).from(schema.units).where(inArray(schema.units.id, unitIds)) : [],
    batchIds.length ? tx.select({ id: schema.batches.id, number: schema.batches.batchNumber, expiry: schema.batches.expiryDate }).from(schema.batches).where(inArray(schema.batches.id, batchIds)) : [],
  ]);
  return {
    localName: new Map(products.map((p) => [p.id, p.nameLocal])),
    unit: new Map(units.map((u) => [u.id, u.symbol])),
    batch: new Map(batches.map((b) => [b.id, b.expiry ? `${b.number} · ${b.expiry.split("-").reverse().join("/")}` : b.number])),
  };
}

/** The stored line of an invoice or note (its tax snapshot). */
interface Item {
  productId: string;
  productName: string;
  hsnCode: string | null;
  unitId: string;
  batchId: string | null;
  qty: string;
  rate: string;
  discountPercent: string;
  taxableValue: string;
  gstRate: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
}

function pdfLines(items: Item[], extras: Awaited<ReturnType<typeof lineExtras>>, locale: LocaleCode): DocumentPdfLine[] {
  return items.map((i) => ({
    name: (locale === "hi" && extras.localName.get(i.productId)) || i.productName,
    batch: i.batchId ? (extras.batch.get(i.batchId) ?? null) : null,
    hsn: i.hsnCode ?? "",
    qty: i.qty,
    unit: extras.unit.get(i.unitId) ?? "",
    rate: i.rate,
    discountPercent: i.discountPercent,
    taxable: i.taxableValue,
    gstRate: i.gstRate,
    cgst: i.cgstAmount,
    sgst: i.sgstAmount,
    igst: i.igstAmount,
    total: i.lineTotal,
  }));
}

type Address = { line1?: string | null; line2?: string | null; city?: string | null; pincode?: string | null } | null;
const addressText = (a: Address) => [a?.line1, a?.line2, [a?.city, a?.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

const pickLocale = (asked: string | undefined, stored: string | null | undefined, fallback: unknown): LocaleCode =>
  isLocaleCode(asked) ? asked : isLocaleCode(stored) ? stored : isLocaleCode(fallback as string) ? (fallback as LocaleCode) : "en";

/** The lines an export or SEZ invoice carries: its declaration, the LUT it was made under, the shipping bill. */
function zeroRatedPrint(inv: Awaited<ReturnType<typeof invoiceDetail>>, locale: LocaleCode) {
  const { t } = createTranslator(locale);
  const sb = [inv.shippingBillNumber, inv.shippingBillDate ? formatDate(inv.shippingBillDate) : null, inv.portCode].filter(Boolean).join(" · ");
  return {
    declaration: zeroRatedDeclaration(inv.zeroRatedType as ZeroRatedType),
    lut: inv.lutArn ? t("invoice.export.lutLine", { arn: inv.lutArn }) : null,
    shippingBill: sb ? t("invoice.export.shippingBillLine", { bill: sb }) : null,
  };
}

export async function invoicePdfFile(deps: AppDeps, ctx: RequestCtx, id: string, asked?: string): Promise<PdfFile> {
  const letterhead = await loadLetterhead(deps, ctx);
  const data = await withTenant(deps.db, ctx, async (tx) => {
    const inv = await invoiceDetail(tx, ctx, id);
    const settings = await getSettings(tx, ctx.businessId, ["invoice.terms", "invoice.default_print_locale", "invoice.payment_details"]);
    const locale = pickLocale(asked, inv.printLocale, settings["invoice.default_print_locale"]);
    const extras = await lineExtras(tx, inv.items);
    const party = await partyContact(tx, "customer", inv.customerId);
    return { inv, settings, locale, extras, party };
  });
  const { inv, locale } = data;
  const credited = (inv.returns ?? []).filter((r) => r.status === "posted").reduce((s, r) => s + Number(r.amountSettled), 0);
  const pdf = await renderDocumentPdf({
    letterhead,
    locale,
    kind: "invoice",
    billOfSupply: inv.documentKind === "bill_of_supply",
    cancelled: inv.status === "cancelled",
    number: inv.invoiceNumber!,
    date: inv.invoiceDate,
    dueDate: inv.dueDate,
    against: null,
    placeOfSupply: inv.placeOfSupply,
    reverseCharge: inv.isReverseCharge,
    intraState: inv.supplyType === "intra_state",
    buyer: { businessName: inv.partyName, name: data.party?.name ?? null, address: addressText(inv.billingAddress as Address), stateCode: inv.partyStateCode ?? inv.placeOfSupply, gstin: inv.partyGstin },
    lines: pdfLines(inv.items, data.extras, locale),
    totals: { taxable: inv.taxableTotal, cgst: inv.cgstTotal, sgst: inv.sgstTotal, igst: inv.igstTotal, cess: inv.cessTotal, roundOff: inv.roundOff, grandTotal: inv.grandTotal },
    // The amount paid includes what returns settled; the bill shows them apart.
    paid: (Number(inv.amountPaid) - credited).toFixed(2),
    credited: credited.toFixed(2),
    balance: inv.balanceDue,
    reason: null,
    terms: (data.settings["invoice.terms"] as string) || null,
    payment: data.settings["invoice.payment_details"],
    zeroRated: inv.zeroRatedType ? zeroRatedPrint(inv, locale) : null,
    einvoice: inv.irn ? { irn: inv.irn, ackNumber: inv.irnAckNumber, ackDate: inv.irnAckDate, signedQrCode: inv.signedQrCode } : null,
    ewayBill: inv.ewayBillNumber ? { number: inv.ewayBillNumber, date: inv.ewayBillDate, validUntil: inv.ewayBillValidUntil } : null,
  });
  const { t } = createTranslator(locale);
  const money = (v: string) => formatCurrency(v, locale);
  const number = inv.invoiceNumber!;
  const due = inv.status !== "cancelled" && Number(inv.balanceDue) > 0;
  const text = t(due ? "share.invoiceDue" : "share.invoice", {
    party: inv.partyName,
    number,
    date: formatDate(inv.invoiceDate),
    amount: money(inv.grandTotal),
    balance: money(inv.balanceDue),
    due: formatDate(inv.dueDate ?? inv.invoiceDate),
    business: letterhead.name,
  });
  const message = { text, subject: t("messages.subject.invoice", { number, business: letterhead.name }), params: [inv.partyName, number, money(inv.grandTotal), letterhead.name] };
  return { pdf, filename: fileName(number), number, date: inv.invoiceDate, amount: inv.grandTotal, balance: inv.status === "cancelled" ? null : inv.balanceDue, locale, party: data.party, message };
}

export async function notePdfFile(deps: AppDeps, ctx: RequestCtx, id: string, asked?: string): Promise<PdfFile> {
  const letterhead = await loadLetterhead(deps, ctx);
  const data = await withTenant(deps.db, ctx, async (tx) => {
    const note = await noteDetail(tx, ctx, id);
    const settings = await getSettings(tx, ctx.businessId, ["invoice.default_print_locale"]);
    const locale = pickLocale(asked, null, settings["invoice.default_print_locale"]);
    const extras = await lineExtras(tx, note.items);
    const party = note.partyType === "customer" ? await partyContact(tx, "customer", note.customerId) : await partyContact(tx, "supplier", note.supplierId);
    return { note, locale, extras, party };
  });
  const { note, locale } = data;
  const number = note.noteNumber ?? "";
  const pdf = await renderDocumentPdf({
    letterhead,
    locale,
    kind: note.noteType === "credit" ? "credit_note" : "debit_note",
    billOfSupply: false,
    cancelled: note.status === "cancelled",
    number,
    date: note.noteDate,
    dueDate: null,
    against: note.original ? { number: note.original.number ?? "", date: note.original.date } : null,
    placeOfSupply: note.placeOfSupply,
    reverseCharge: note.isReverseCharge,
    einvoice: note.irn ? { irn: note.irn, ackNumber: note.irnAckNumber, ackDate: note.irnAckDate, signedQrCode: note.signedQrCode } : null,
    intraState: note.supplyType === "intra_state",
    buyer: { businessName: note.partyName, name: data.party?.name ?? null, address: addressText(note.billingAddress as Address), stateCode: note.partyStateCode ?? note.placeOfSupply, gstin: note.partyGstin },
    lines: pdfLines(note.items, data.extras, locale),
    totals: { taxable: note.taxableTotal, cgst: note.cgstTotal, sgst: note.sgstTotal, igst: note.igstTotal, cess: note.cessTotal, roundOff: note.roundOff, grandTotal: note.grandTotal },
    paid: null,
    credited: null,
    balance: null,
    reason: note.notes ?? null,
    terms: null,
  });
  const { t } = createTranslator(locale);
  const kind = t(note.noteType === "credit" ? "notes.creditNote" : "notes.debitNote");
  const amount = formatCurrency(note.grandTotal, locale);
  const message = {
    text: t("share.note", { party: note.partyName, kind, number, date: formatDate(note.noteDate), amount, business: letterhead.name }),
    subject: t("messages.subject.note", { kind, number, business: letterhead.name }),
    params: [note.partyName, number, amount, letterhead.name],
  };
  return { pdf, filename: fileName(number), number, date: note.noteDate, amount: note.grandTotal, balance: null, locale, party: data.party, message };
}

export async function receiptPdfFile(deps: AppDeps, ctx: RequestCtx, id: string, asked?: string): Promise<PdfFile> {
  const letterhead = await loadLetterhead(deps, ctx);
  const data = await withTenant(deps.db, ctx, async (tx) => {
    const p = await paymentDetail(tx, ctx, id);
    const settings = await getSettings(tx, ctx.businessId, ["invoice.default_print_locale"]);
    const locale = pickLocale(asked, null, settings["invoice.default_print_locale"]);
    const partyType = p.partyType as "customer" | "supplier" | "employee";
    const party = await partyContact(tx, partyType, p.customerId ?? p.supplierId ?? p.employeeId ?? null);
    return { p, locale, party };
  });
  const { p, locale } = data;
  const number = p.paymentNumber ?? "";
  const pdf = await renderReceiptPdf({
    letterhead,
    locale,
    direction: p.direction as "in" | "out",
    number,
    date: p.paymentDate,
    cancelled: p.status === "cancelled",
    partyName: p.party?.name ?? data.party?.name ?? "",
    amount: p.amount,
    method: p.method,
    reference: p.referenceNumber,
    chequeDate: p.chequeDate,
    chequeBank: p.chequeBank,
    bills: p.allocations.filter((a) => !a.reversedAt).map((a) => ({ number: a.documentNumber, amount: a.amount })),
    onAccount: p.unallocatedAmount,
    notes: p.notes,
  });
  const { t } = createTranslator(locale);
  const partyName = p.party?.name ?? data.party?.name ?? "";
  const amount = formatCurrency(p.amount, locale);
  const bills = p.allocations.filter((a) => !a.reversedAt).map((a) => a.documentNumber).filter(Boolean).join(", ");
  const message = {
    text: t(p.direction === "in" ? "share.receipt" : "share.payment", {
      party: partyName,
      amount,
      method: t(`paymentMethod.${p.method}` as "paymentMethod.cash") + (p.referenceNumber ? ` (${p.referenceNumber})` : ""),
      date: formatDate(p.paymentDate),
      number,
      bills: bills || "—",
      business: letterhead.name,
    }),
    subject: t(p.direction === "in" ? "messages.subject.receipt" : "messages.subject.payment", { number, business: letterhead.name }),
    params: [partyName, number, amount, letterhead.name],
  };
  return { pdf, filename: fileName(number), number, date: p.paymentDate, amount: p.amount, balance: null, locale, party: data.party, message };
}

function sendPdf(reply: FastifyReply, file: PdfFile) {
  reply.header("content-type", "application/pdf");
  reply.header("content-disposition", `attachment; filename="${file.filename}"`);
  reply.header("cache-control", "private, no-store");
  return reply.send(file.pdf);
}

/** PDF files of invoices, credit / debit notes and receipts, made on the server. */
export const documentsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const opts = (permission: Permission, tag: string) => ({ preHandler: guard(deps, permission), schema: { tags: [tag], params: IdParams, querystring: PdfQuery } });

  r.get("/invoices/:id/pdf", opts("invoice.view", "invoices"), async (request, reply) => sendPdf(reply, await invoicePdfFile(deps, request.ctx, request.params.id, request.query.locale)));
  r.get("/notes/:id/pdf", opts("note.view", "notes"), async (request, reply) => sendPdf(reply, await notePdfFile(deps, request.ctx, request.params.id, request.query.locale)));
  r.get("/payments/:id/pdf", opts("payment.view", "payments"), async (request, reply) => sendPdf(reply, await receiptPdfFile(deps, request.ctx, request.params.id, request.query.locale)));
};
