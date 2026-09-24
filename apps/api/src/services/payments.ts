import { allocatePayment, dec, paymentStatusFor, toAmountString, type OpenDocument, type PaymentMethod } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { audit } from "../lib/audit.js";
import type { RequestCtx } from "../lib/context.js";
import { badRequest } from "../lib/errors.js";
import { nextDocumentNumber } from "./numbering.js";
import { postPartyEntry } from "./party-ledger.js";

export interface PaymentInput {
  direction: "in" | "out";
  party: { type: "customer"; id: string; name: string } | { type: "supplier"; id: string; name: string };
  date: string;
  amount: string;
  method: PaymentMethod;
  referenceNumber?: string | null;
  chequeDate?: string | null;
  chequeBank?: string | null;
  paymentAccountId?: string | null;
  notes?: string | null;
  /** Explicit allocations; omitted = oldest due first. */
  allocations?: ReadonlyArray<{ documentId: string; amount: string }>;
  clientId?: string | null;
}

export interface PaymentResult {
  id: string;
  paymentNumber: string;
  allocations: Array<{ documentId: string; documentNumber: string; amount: string }>;
  unallocated: string;
}

/** Open (partly unpaid) invoices of a customer or purchases of a supplier, locked for update. */
async function lockOpenDocuments(tx: Tx, businessId: string, party: PaymentInput["party"]): Promise<OpenDocument[]> {
  if (party.type === "customer") {
    const i = schema.invoices;
    const rows = await tx
      .select({ id: i.id, number: i.invoiceNumber, date: i.invoiceDate, dueDate: i.dueDate, balance: i.balanceDue })
      .from(i)
      .where(and(eq(i.businessId, businessId), eq(i.customerId, party.id), eq(i.status, "posted"), gt(i.balanceDue, "0")))
      .orderBy(asc(i.id))
      .for("update");
    return rows.map((r) => ({ id: r.id, number: r.number ?? "", date: r.date, dueDate: r.dueDate ?? r.date, balance: r.balance }));
  }
  const p = schema.purchases;
  const rows = await tx
    .select({ id: p.id, number: p.supplierInvoiceNumber, date: p.supplierInvoiceDate, dueDate: p.dueDate, balance: p.balanceDue })
    .from(p)
    .where(and(eq(p.businessId, businessId), eq(p.supplierId, party.id), eq(p.status, "posted"), gt(p.balanceDue, "0")))
    .orderBy(asc(p.id))
    .for("update");
  return rows.map((r) => ({ id: r.id, number: r.number, date: r.date, dueDate: r.dueDate ?? r.date, balance: r.balance }));
}

async function defaultAccountId(tx: Tx, businessId: string, method: PaymentMethod): Promise<string | null> {
  if (method !== "cash") return null;
  const [acc] = await tx
    .select({ id: schema.paymentAccounts.id })
    .from(schema.paymentAccounts)
    .where(and(eq(schema.paymentAccounts.businessId, businessId), eq(schema.paymentAccounts.type, "cash"), eq(schema.paymentAccounts.isActive, true)))
    .orderBy(sql`${schema.paymentAccounts.isDefault} desc`)
    .limit(1);
  return acc?.id ?? null;
}

/**
 * Receipt from a customer or payment to a supplier: numbered payment row,
 * allocations (explicit, else oldest due first), document balances updated,
 * party ledger entry, audit. Anything not allocated stays as an advance.
 */
export async function recordPayment(tx: Tx, ctx: RequestCtx, financialYearStartMonth: number, input: PaymentInput): Promise<PaymentResult> {
  const businessId = ctx.businessId;
  if (input.paymentAccountId) {
    const [acc] = await tx
      .select({ id: schema.paymentAccounts.id })
      .from(schema.paymentAccounts)
      .where(and(eq(schema.paymentAccounts.id, input.paymentAccountId), eq(schema.paymentAccounts.businessId, businessId)));
    if (!acc) throw badRequest("REFERENCE_NOT_FOUND", {}, "paymentAccountId");
  }
  // Lock order everywhere: party row first, then its documents, then the number series.
  const partyTable = input.party.type === "customer" ? schema.customers : schema.suppliers;
  const [party] = await tx
    .select({ id: partyTable.id })
    .from(partyTable)
    .where(and(eq(partyTable.id, input.party.id), eq(partyTable.businessId, businessId)))
    .for("update");
  if (!party) throw badRequest("REFERENCE_NOT_FOUND", {}, input.party.type === "customer" ? "customerId" : "supplierId");
  const open = await lockOpenDocuments(tx, businessId, input.party);
  const { allocations, unallocated } = allocatePayment(input.amount, open, input.allocations);
  const docType = input.direction === "in" ? "payment_in" : "payment_out";
  const numbering = await nextDocumentNumber(tx, businessId, docType, input.date, financialYearStartMonth);
  const id = uuidv7();

  await tx.insert(schema.payments).values({
    id,
    businessId,
    paymentNumber: numbering.number,
    seriesId: numbering.seriesId,
    financialYear: numbering.financialYear,
    direction: input.direction,
    partyType: input.party.type,
    customerId: input.party.type === "customer" ? input.party.id : null,
    supplierId: input.party.type === "supplier" ? input.party.id : null,
    paymentDate: input.date,
    amount: toAmountString(input.amount),
    method: input.method,
    paymentAccountId: input.paymentAccountId ?? (await defaultAccountId(tx, businessId, input.method)),
    referenceNumber: input.referenceNumber ?? null,
    chequeDate: input.chequeDate ?? null,
    chequeBank: input.chequeBank ?? null,
    chequeStatus: input.method === "cheque" ? "pending" : null,
    unallocatedAmount: toAmountString(unallocated),
    status: "posted",
    notes: input.notes ?? null,
    clientId: input.clientId ?? null,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });

  const byId = new Map(open.map((d) => [d.id, d]));
  for (const a of allocations) {
    await tx.insert(schema.paymentAllocations).values({
      id: uuidv7(),
      businessId,
      paymentId: id,
      ...(input.party.type === "customer" ? { invoiceId: a.documentId } : { purchaseId: a.documentId }),
      amount: toAmountString(a.amount),
      allocatedBy: ctx.userId,
    });
    const newBalance = dec(byId.get(a.documentId)!.balance).minus(a.amount);
    await applyToDocument(tx, input.party.type, a.documentId, a.amount.toFixed(2), newBalance.toFixed(2));
  }

  await postPartyEntry(tx, {
    businessId,
    party: input.party,
    date: input.date,
    docType,
    docId: id,
    docNumber: numbering.number,
    ...(input.direction === "in" ? { credit: toAmountString(input.amount) } : { debit: toAmountString(input.amount) }),
    narration: `${input.method.toUpperCase()}${input.referenceNumber ? ` ${input.referenceNumber}` : ""}`,
    userId: ctx.userId,
  });

  await audit(tx, ctx, {
    action: input.direction === "in" ? "payment.received" : "payment.made",
    entityType: "payment",
    entityId: id,
    entityLabel: numbering.number,
    changes: { party: input.party.name, amount: toAmountString(input.amount), method: input.method, allocations: allocations.map((a) => [a.documentNumber, a.amount.toFixed(2)]) },
  });

  return {
    id,
    paymentNumber: numbering.number,
    allocations: allocations.map((a) => ({ documentId: a.documentId, documentNumber: a.documentNumber, amount: a.amount.toFixed(2) })),
    unallocated: unallocated.toFixed(2),
  };
}

/** Moves amount_paid / balance_due / payment_status of an invoice or purchase by an allocation. */
export async function applyToDocument(tx: Tx, partyType: "customer" | "supplier", documentId: string, paidDelta: string, newBalance: string): Promise<void> {
  const table = partyType === "customer" ? schema.invoices : schema.purchases;
  const [doc] = await tx
    .update(table)
    .set({ amountPaid: sql`${table.amountPaid} + ${paidDelta}`, balanceDue: newBalance })
    .where(eq(table.id, documentId))
    .returning({ grandTotal: table.grandTotal, amountPaid: table.amountPaid });
  await tx
    .update(table)
    .set({ paymentStatus: paymentStatusFor(doc!.grandTotal, doc!.amountPaid) })
    .where(eq(table.id, documentId));
}

/**
 * Releases the allocations pointing at a cancelled document: the money stays
 * with the party as an advance (payment.unallocated_amount grows).
 */
export async function releaseAllocations(tx: Tx, target: { invoiceId: string } | { purchaseId: string }, now: string): Promise<string> {
  const a = schema.paymentAllocations;
  const where = "invoiceId" in target ? eq(a.invoiceId, target.invoiceId) : eq(a.purchaseId, target.purchaseId);
  const rows = await tx
    .update(a)
    .set({ reversedAt: now })
    .where(and(where, isNull(a.reversedAt)))
    .returning({ paymentId: a.paymentId, amount: a.amount });
  let released = dec(0);
  for (const r of rows) {
    released = released.plus(r.amount);
    await tx
      .update(schema.payments)
      .set({ unallocatedAmount: sql`${schema.payments.unallocatedAmount} + ${r.amount}` })
      .where(eq(schema.payments.id, r.paymentId));
  }
  return released.toFixed(2);
}
