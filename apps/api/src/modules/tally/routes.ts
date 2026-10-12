import { IsoDate } from "@digitalbahi/contracts";
import { documentEntries, expenseEntries, findState, paymentEntries, TALLY_LEDGERS, tallyImportXml, type TallyInventoryLine, type TallyLedger, type TallyStockItem, type TallyVoucher } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, between, eq, inArray, isNull, ne } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import type { ApiModule } from "../types.js";

const ExportQuery = z.strictObject({ from: IsoDate, to: IsoDate });

interface Party {
  kind: "customer" | "supplier";
  name: string;
  code: string;
  gstin: string | null;
  stateCode: string | null;
  address: string[];
}

interface ItemLine {
  docId: string;
  productId: string;
  qty: string;
  freeQty: string;
  conversionFactor: string;
  taxableValue: string;
}

/**
 * The item lines of the period's documents, as Tally stock items in their
 * base unit (a box sold as 12 pieces is 12 pieces in Tally too), and the
 * stock item masters they need (a shared product name gets the code).
 */
async function itemLines(tx: Tx, businessId: string, ids: { invoices: string[]; purchases: string[]; notes: string[] }) {
  const ii = schema.invoiceItems;
  const pi = schema.purchaseItems;
  const ni = schema.creditDebitNoteItems;
  const pick = { productId: ii.productId, qty: ii.qty, freeQty: ii.freeQty, conversionFactor: ii.conversionFactor, taxableValue: ii.taxableValue };
  const [inv, pur, notes] = await Promise.all([
    ids.invoices.length ? tx.select({ docId: ii.invoiceId, ...pick }).from(ii).where(and(eq(ii.businessId, businessId), inArray(ii.invoiceId, ids.invoices))).orderBy(ii.lineNo) : [],
    ids.purchases.length
      ? tx
          .select({ docId: pi.purchaseId, productId: pi.productId, qty: pi.qty, freeQty: pi.freeQty, conversionFactor: pi.conversionFactor, taxableValue: pi.taxableValue })
          .from(pi)
          .where(and(eq(pi.businessId, businessId), inArray(pi.purchaseId, ids.purchases)))
          .orderBy(pi.lineNo)
      : [],
    ids.notes.length
      ? tx
          .select({ docId: ni.noteId, productId: ni.productId, qty: ni.qty, freeQty: ni.freeQty, conversionFactor: ni.conversionFactor, taxableValue: ni.taxableValue })
          .from(ni)
          .where(and(eq(ni.businessId, businessId), inArray(ni.noteId, ids.notes)))
          .orderBy(ni.lineNo)
      : [],
  ]);
  const all: ItemLine[] = [...inv, ...pur, ...notes];
  const productIds = [...new Set(all.map((l) => l.productId))];
  const items = new Map<string, TallyStockItem>();
  if (productIds.length) {
    const p = schema.products;
    const u = schema.units;
    const rows = await tx.select({ id: p.id, name: p.name, code: p.code, hsn: p.hsnCode, unit: u.symbol, decimals: u.decimals }).from(p).innerJoin(u, eq(u.id, p.baseUnitId)).where(inArray(p.id, productIds));
    const count = new Map<string, number>();
    for (const r of rows) count.set(r.name.toUpperCase(), (count.get(r.name.toUpperCase()) ?? 0) + 1);
    for (const r of rows) items.set(r.id, { name: count.get(r.name.toUpperCase())! > 1 ? `${r.name} (${r.code})` : r.name, unit: r.unit, unitDecimals: r.decimals, hsn: r.hsn });
  }
  const byDoc = new Map<string, ItemLine[]>();
  for (const l of all) byDoc.set(l.docId, [...(byDoc.get(l.docId) ?? []), l]);
  /** The document's lines for Tally, `sign` as its counter ledger goes (-1 a sale, +1 a purchase). */
  const linesOf = (docId: string, sign: 1 | -1): TallyInventoryLine[] | undefined => {
    const lines = byDoc.get(docId);
    if (!lines?.length) return undefined;
    const out: TallyInventoryLine[] = [];
    for (const l of lines) {
      const item = items.get(l.productId);
      const qty = Number(l.qty) * Number(l.conversionFactor);
      const value = Math.round(Number(l.taxableValue) * 100) / 100;
      if (!item || qty <= 0) return undefined;
      out.push({ item: item.name, unit: item.unit, qty, freeQty: Number(l.freeQty) * Number(l.conversionFactor), rate: value / qty, amount: sign * value });
    }
    return out;
  };
  return { stockItems: [...items.values()], linesOf };
}

/**
 * The period's books for the business's CA in Tally: sales, purchases,
 * credit and debit notes (item-wise, with the stock items they move),
 * receipts, payments and expenses, with the party ledgers (under Sundry
 * Debtors / Creditors) and the sales, purchase, GST, expense and round-off
 * ledgers they post to. Cancelled documents are left out.
 */
async function tallyExport(tx: Tx, ctx: RequestCtx, from: string, to: string) {
  const businessId = ctx.businessId;
  const [business] = await tx.select({ legalName: schema.businesses.legalName, tradeName: schema.businesses.tradeName }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const inv = schema.invoices;
  const pur = schema.purchases;
  const note = schema.creditDebitNotes;
  const pay = schema.payments;
  const exp = schema.expenses;
  const cat = schema.expenseCategories;
  const [invoices, purchases, notes, payments, expenses] = await Promise.all([
    tx.select().from(inv).where(and(eq(inv.businessId, businessId), eq(inv.status, "posted"), between(inv.invoiceDate, from, to))),
    tx.select().from(pur).where(and(eq(pur.businessId, businessId), eq(pur.status, "posted"), between(pur.receivedDate, from, to))),
    tx.select().from(note).where(and(eq(note.businessId, businessId), eq(note.status, "posted"), between(note.noteDate, from, to))),
    tx.select().from(pay).where(and(eq(pay.businessId, businessId), ne(pay.status, "cancelled"), between(pay.paymentDate, from, to), inArray(pay.partyType, ["customer", "supplier"]))),
    tx
      .select({ e: exp, category: cat.name })
      .from(exp)
      .innerJoin(cat, eq(cat.id, exp.categoryId))
      .where(and(eq(exp.businessId, businessId), eq(exp.status, "posted"), isNull(exp.deletedAt), between(exp.expenseDate, from, to))),
  ]);
  const { stockItems, linesOf } = await itemLines(tx, businessId, { invoices: invoices.map((i) => i.id), purchases: purchases.map((p) => p.id), notes: notes.map((n) => n.id) });

  // The parties, named as their ledgers will be (a shared name gets the party's code).
  const customerIds = new Set<string>([...invoices.map((i) => i.customerId), ...notes.flatMap((n) => (n.customerId ? [n.customerId] : [])), ...payments.flatMap((p) => (p.customerId ? [p.customerId] : []))]);
  const supplierIds = new Set<string>([...purchases.map((p) => p.supplierId), ...notes.flatMap((n) => (n.supplierId ? [n.supplierId] : [])), ...payments.flatMap((p) => (p.supplierId ? [p.supplierId] : []))]);
  const parties = new Map<string, Party>();
  if (customerIds.size) {
    const c = schema.customers;
    for (const r of await tx.select({ id: c.id, name: c.businessName, contact: c.name, code: c.code, gstin: c.gstin, stateCode: c.stateCode, a1: c.addressLine1, a2: c.addressLine2, city: c.city }).from(c).where(inArray(c.id, [...customerIds])))
      parties.set(r.id, { kind: "customer", name: r.name || r.contact, code: r.code, gstin: r.gstin, stateCode: r.stateCode, address: [r.a1, r.a2, r.city].filter((x): x is string => !!x) });
  }
  if (supplierIds.size) {
    const s = schema.suppliers;
    for (const r of await tx.select({ id: s.id, name: s.name, code: s.code, gstin: s.gstin, stateCode: s.stateCode, a1: s.addressLine1, a2: s.addressLine2, city: s.city }).from(s).where(inArray(s.id, [...supplierIds])))
      parties.set(r.id, { kind: "supplier", name: r.name, code: r.code, gstin: r.gstin, stateCode: r.stateCode, address: [r.a1, r.a2, r.city].filter((x): x is string => !!x) });
  }
  const nameCount = new Map<string, number>();
  for (const p of parties.values()) nameCount.set(p.name.toUpperCase(), (nameCount.get(p.name.toUpperCase()) ?? 0) + 1);
  const ledgerName = (id: string) => {
    const p = parties.get(id)!;
    return nameCount.get(p.name.toUpperCase())! > 1 ? `${p.name} (${p.code})` : p.name;
  };

  const vouchers: TallyVoucher[] = [];
  for (const i of invoices) {
    const party = ledgerName(i.customerId);
    vouchers.push({
      type: "Sales",
      date: i.invoiceDate,
      number: i.invoiceNumber ?? i.id,
      party,
      partyGstin: i.partyGstin,
      entries: documentEntries(i, party, "sales", 1),
      inventory: linesOf(i.id, -1),
      counterLedger: TALLY_LEDGERS.sales.name,
    });
  }
  for (const p of purchases) {
    const party = ledgerName(p.supplierId);
    vouchers.push({
      type: "Purchase",
      date: p.receivedDate,
      number: p.purchaseNumber ?? p.id,
      party,
      partyGstin: p.partyGstin,
      reference: p.supplierInvoiceNumber,
      referenceDate: p.supplierInvoiceDate,
      entries: documentEntries(p, party, "purchase", -1),
      inventory: linesOf(p.id, 1),
      counterLedger: TALLY_LEDGERS.purchase.name,
    });
  }
  for (const n of notes) {
    const partyId = n.customerId ?? n.supplierId;
    if (!partyId) continue;
    const party = ledgerName(partyId);
    const customer = !!n.customerId;
    // A credit note credits the party, a debit note debits it.
    const sign = n.noteType === "credit" ? -1 : 1;
    vouchers.push({
      type: n.noteType === "credit" ? "Credit Note" : "Debit Note",
      date: n.noteDate,
      number: n.noteNumber ?? n.id,
      party,
      partyGstin: n.partyGstin,
      reference: n.partyNoteNumber,
      narration: n.reason,
      entries: documentEntries(n, party, customer ? "sales" : "purchase", sign),
      // The counter ledger goes against the party.
      inventory: linesOf(n.id, sign === 1 ? -1 : 1),
      counterLedger: customer ? TALLY_LEDGERS.sales.name : TALLY_LEDGERS.purchase.name,
    });
  }
  for (const p of payments) {
    const partyId = p.customerId ?? p.supplierId;
    if (!partyId) continue;
    const party = ledgerName(partyId);
    vouchers.push({
      type: p.direction === "in" ? "Receipt" : "Payment",
      date: p.paymentDate,
      number: p.paymentNumber ?? p.id,
      party,
      reference: p.referenceNumber,
      narration: [p.method.replace(/_/g, " "), p.notes].filter(Boolean).join(" · "),
      entries: paymentEntries(p.amount, party, p.method === "cash", p.direction, p.tdsAmount),
    });
  }

  // Expenses: a payment voucher from cash or bank to the expense head (its category).
  const heads = new Set<string>();
  for (const { e, category } of expenses) {
    const claimable = e.itcEligibility !== null && e.itcEligibility !== "ineligible";
    const cash = e.paymentMethod === "cash";
    heads.add(category);
    vouchers.push({
      type: "Payment",
      date: e.expenseDate,
      number: e.expenseNumber ?? e.id,
      party: cash ? TALLY_LEDGERS.cash.name : TALLY_LEDGERS.bank.name,
      reference: e.referenceNumber,
      narration: [category, e.paidTo, e.notes].filter(Boolean).join(" · "),
      entries: expenseEntries({ ...e, claimable }, category, cash),
    });
  }

  const ledgers: TallyLedger[] = [
    ...[...parties.keys()].map((id) => {
      const p = parties.get(id)!;
      return { name: ledgerName(id), parent: p.kind === "customer" ? "Sundry Debtors" : "Sundry Creditors", gstin: p.gstin, stateName: findState(p.stateCode)?.name ?? null, address: p.address };
    }),
    ...[...heads].filter((h) => !Object.values(TALLY_LEDGERS).some((l) => l.name === h)).map((name) => ({ name, parent: "Indirect Expenses" })),
    ...Object.values(TALLY_LEDGERS).filter((l) => vouchers.some((v) => v.entries.some((e) => e.ledger === l.name))),
  ];
  const company = business?.tradeName || business?.legalName || null;
  await audit(tx, ctx, { action: "tally.exported", entityType: "business", entityLabel: `${from} – ${to}`, changes: { vouchers: vouchers.length, ledgers: ledgers.length, stockItems: stockItems.length } });
  return { xml: tallyImportXml({ company, ledgers, vouchers, stockItems }), count: vouchers.length };
}

export const tallyModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/tally/export", { preHandler: guard(deps, "gst.export"), schema: { tags: ["imports"], querystring: ExportQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const { from, to } = request.query;
    if (to < from) throw badRequest("PERIOD_END_BEFORE_START");
    const out = await withTenant(deps.db, ctx, (tx) => tallyExport(tx, ctx, from, to));
    reply.header("content-type", "application/xml; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="tally-vouchers-${from}-to-${to}.xml"`);
    reply.header("x-voucher-count", String(out.count));
    return out.xml;
  });
};
