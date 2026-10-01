import { AllocationInput, CancelBody, PaymentBody, PaymentListQuery } from "@digitalbahi/contracts";
import { allocatePayment, dec, type OpenDocument } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { postPartyEntry } from "../../services/party-ledger.js";
import { applyToDocument, recordPayment } from "../../services/payments.js";
import { getSetting } from "../../services/settings.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const ChequeBody = z.strictObject({ status: z.enum(["deposited", "cleared", "bounced"]), reason: z.string().trim().max(300).optional() });
const AllocateBody = z.strictObject({ allocations: z.array(AllocationInput).max(200).optional() });
const AccountBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  type: z.enum(["cash", "bank", "upi", "wallet", "card"]),
  bankName: z.string().trim().max(100).optional(),
  accountNumberLast4: z.string().regex(/^\d{4}$/).optional(),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
  upiId: z.string().trim().max(100).optional(),
  isDefault: z.boolean().default(false),
});

type PaymentRow = typeof schema.payments.$inferSelect;

export async function paymentDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [p] = await tx.select().from(schema.payments).where(and(eq(schema.payments.id, id), eq(schema.payments.businessId, ctx.businessId)));
  if (!p) throw notFound("payment");
  const allocations = await tx.execute<{ id: string; document_id: string; document_number: string | null; amount: string; reversed_at: string | null }>(sql`
    select a.id, coalesce(a.invoice_id, a.purchase_id) as document_id,
           coalesce(i.invoice_number, pu.supplier_invoice_number) as document_number, a.amount::text, a.reversed_at
    from payment_allocations a
    left join invoices i on i.id = a.invoice_id
    left join purchases pu on pu.id = a.purchase_id
    where a.payment_id = ${id}
    order by a.allocated_at`);
  const party =
    p.partyType === "customer"
      ? (await tx.select({ id: schema.customers.id, name: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})` }).from(schema.customers).where(eq(schema.customers.id, p.customerId!)))[0]
      : p.partyType === "employee"
        ? (await tx.select({ id: schema.employees.id, name: schema.employees.name }).from(schema.employees).where(eq(schema.employees.id, p.employeeId!)))[0]
        : (await tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, p.supplierId!)))[0];
  const { businessId: _b, ...rest } = p;
  return {
    ...rest,
    party,
    allocations: allocations.rows.map((a) => ({ id: a.id, documentId: a.document_id, documentNumber: a.document_number, amount: a.amount, reversedAt: a.reversed_at })),
  };
}

/** Undo a payment (cancellation or bounced cheque): allocations reversed, ledger reversed, number kept. */
async function reversePayment(tx: Tx, ctx: RequestCtx, p: PaymentRow, reason: string, now: string, today: string, bounced: boolean) {
  const partyType = p.partyType as "customer" | "supplier";
  const partyId = (partyType === "customer" ? p.customerId : p.supplierId)!;
  const partyTable = partyType === "customer" ? schema.customers : schema.suppliers;
  await tx.select({ id: partyTable.id }).from(partyTable).where(eq(partyTable.id, partyId)).for("update");

  const a = schema.paymentAllocations;
  const live = await tx.select().from(a).where(and(eq(a.paymentId, p.id), isNull(a.reversedAt)));
  for (const alloc of live) {
    const docId = (alloc.invoiceId ?? alloc.purchaseId)!;
    const table = alloc.invoiceId ? schema.invoices : schema.purchases;
    const [doc] = await tx.select({ balanceDue: table.balanceDue, status: table.status }).from(table).where(eq(table.id, docId)).for("update");
    if (doc!.status === "posted") {
      await applyToDocument(tx, alloc.invoiceId ? "customer" : "supplier", docId, `-${alloc.amount}`, dec(doc!.balanceDue).plus(alloc.amount).toFixed(2));
    }
    await tx.update(a).set({ reversedAt: now }).where(eq(a.id, alloc.id));
  }
  await tx
    .update(schema.payments)
    .set({
      status: "cancelled",
      cancelledAt: now,
      cancelledBy: ctx.userId,
      cancelReason: reason,
      unallocatedAmount: "0",
      ...(bounced ? { chequeStatus: "bounced" as const } : {}),
      updatedBy: ctx.userId,
    })
    .where(eq(schema.payments.id, p.id));
  const [original] = await tx
    .select({ id: schema.partyLedgerEntries.id })
    .from(schema.partyLedgerEntries)
    .where(and(eq(schema.partyLedgerEntries.docId, p.id), eq(schema.partyLedgerEntries.docType, p.direction === "in" ? "payment_in" : "payment_out")));
  await postPartyEntry(tx, {
    businessId: ctx.businessId,
    party: { type: partyType, id: partyId },
    date: today,
    docType: bounced ? "cheque_bounce" : `${p.direction === "in" ? "payment_in" : "payment_out"}_cancel`,
    docId: p.id,
    docNumber: p.paymentNumber,
    ...(p.direction === "in" ? { debit: p.amount } : { credit: p.amount }),
    narration: bounced ? `Cheque bounced${reason ? `: ${reason}` : ""}` : `Cancelled: ${reason}`,
    reversesEntryId: original?.id ?? null,
    userId: ctx.userId,
  });
  await audit(tx, ctx, {
    action: bounced ? "payment.cheque_bounced" : "payment.cancelled",
    entityType: "payment",
    entityId: p.id,
    entityLabel: p.paymentNumber ?? undefined,
    changes: { amount: p.amount, reason, reversedAllocations: live.length },
  });
}

export const paymentsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** Collection from a customer (in) or payment to a supplier (out). */
  r.post("/payments", { preHandler: guard(deps), schema: { tags: ["payments"], body: PaymentBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const permission = body.direction === "in" ? "payment.collect" : "payment.pay";
    if (!can(ctx, permission)) throw forbidden(permission);
    if (body.direction === "in" && !body.customerId) throw badRequest("PARTY_REQUIRED", {}, "customerId");
    if (body.direction === "out" && !body.supplierId) throw badRequest("PARTY_REQUIRED", {}, "supplierId");
    if (body.customerId && body.supplierId) throw badRequest("PARTY_REQUIRED", {}, "supplierId");
    if (body.method === "cheque" && !body.referenceNumber) throw badRequest("CHEQUE_NUMBER_REQUIRED", {}, "referenceNumber");
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");

    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        const [existing] = await tx
          .select({ id: schema.payments.id })
          .from(schema.payments)
          .where(and(eq(schema.payments.businessId, ctx.businessId), eq(schema.payments.clientId, clientId)));
        if (existing) return { replay: true, detail: await paymentDetail(tx, ctx, existing.id) };
      }
      const today = deps.clock.today(ctx.timeZone);
      const date = body.paymentDate ?? today;
      if (date > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "paymentDate");
      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const party = body.customerId
        ? (await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(and(eq(schema.customers.id, body.customerId), eq(schema.customers.businessId, ctx.businessId))))[0]
        : (await tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(and(eq(schema.suppliers.id, body.supplierId!), eq(schema.suppliers.businessId, ctx.businessId))))[0];
      if (!party) throw badRequest("REFERENCE_NOT_FOUND", {}, body.customerId ? "customerId" : "supplierId");
      const mode = await getSetting(tx, ctx.businessId, "payments.allocation");
      const allocations = body.allocations ?? (mode === "manual" ? [] : undefined);
      const res = await recordPayment(tx, ctx, business!.financialYearStartMonth, {
        direction: body.direction,
        party: body.customerId ? { type: "customer", id: party.id, name: party.name } : { type: "supplier", id: party.id, name: party.name },
        date,
        amount: body.amount,
        method: body.method,
        referenceNumber: body.referenceNumber ?? null,
        chequeDate: body.chequeDate ?? null,
        chequeBank: body.chequeBank ?? null,
        paymentAccountId: body.paymentAccountId ?? null,
        notes: body.notes ?? null,
        ...(allocations ? { allocations } : {}),
        clientId,
      });
      await tx.insert(schema.outboxEvents).values({
        businessId: ctx.businessId,
        eventType: body.direction === "in" ? "payment.received" : "payment.made",
        aggregateType: "payment",
        aggregateId: res.id,
        payload: { amount: body.amount, method: body.method },
      });
      return { replay: false, detail: await paymentDetail(tx, ctx, res.id) };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.detail);
  });

  r.get("/payments", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], querystring: PaymentListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const p = schema.payments;
    const where: SQL[] = [eq(p.businessId, ctx.businessId)];
    if (q.direction !== "all") where.push(eq(p.direction, q.direction));
    if (q.customerId) where.push(eq(p.customerId, q.customerId));
    if (q.supplierId) where.push(eq(p.supplierId, q.supplierId));
    if (q.method) where.push(eq(p.method, q.method));
    if (q.from) where.push(sql`${p.paymentDate} >= ${q.from}`);
    if (q.to) where.push(sql`${p.paymentDate} <= ${q.to}`);
    if (q.q) where.push(sql`(${p.paymentNumber} ilike ${`%${q.q.replace(/[\\%_]/g, "\\$&")}%`} or ${p.referenceNumber} = ${q.q})`);
    if (cursor) where.push(sql`(${p.paymentDate}, ${p.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: p.id,
          paymentNumber: p.paymentNumber,
          paymentDate: p.paymentDate,
          direction: p.direction,
          partyType: p.partyType,
          customerId: p.customerId,
          supplierId: p.supplierId,
          partyName: sql<string>`coalesce((select coalesce(c.business_name, c.name) from customers c where c.id = "payments"."customer_id"), (select name from suppliers s where s.id = "payments"."supplier_id"), (select name from employees e where e.id = "payments"."employee_id"))`,
          amount: p.amount,
          method: p.method,
          referenceNumber: p.referenceNumber,
          chequeStatus: p.chequeStatus,
          unallocatedAmount: p.unallocatedAmount,
          status: p.status,
        })
        .from(p)
        .where(and(...where))
        .orderBy(sql`${p.paymentDate} desc, ${p.id} desc`)
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.paymentDate, id: x.id }));
  });

  r.get("/payments/:id", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => paymentDetail(tx, request.ctx, request.params.id)),
  );

  r.post("/payments/:id/cancel", { preHandler: guard(deps, "payment.cancel"), schema: { tags: ["payments"], params: IdParams, body: CancelBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [p] = await tx.select().from(schema.payments).where(and(eq(schema.payments.id, request.params.id), eq(schema.payments.businessId, ctx.businessId))).for("update");
      if (!p) throw notFound("payment");
      if (p.status !== "posted") throw conflict("PAYMENT_NOT_POSTED", { status: p.status });
      if (p.partyType === "employee") throw conflict("EMPLOYEE_PAYMENT_LOCKED");
      await reversePayment(tx, ctx, p, request.body.reason, deps.clock.now().toISOString(), deps.clock.today(ctx.timeZone), false);
      return paymentDetail(tx, ctx, p.id);
    });
  });

  /** Cheque life cycle; a bounce reverses the payment and re-opens the invoices it settled. */
  r.post("/payments/:id/cheque", { preHandler: guard(deps, "payment.collect"), schema: { tags: ["payments"], params: IdParams, body: ChequeBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [p] = await tx.select().from(schema.payments).where(and(eq(schema.payments.id, request.params.id), eq(schema.payments.businessId, ctx.businessId))).for("update");
      if (!p) throw notFound("payment");
      if (p.method !== "cheque") throw conflict("NOT_A_CHEQUE");
      if (p.partyType === "employee" && request.body.status === "bounced") throw conflict("EMPLOYEE_PAYMENT_LOCKED");
      if (p.status !== "posted" || p.chequeStatus === "bounced" || p.chequeStatus === "cleared") throw conflict("PAYMENT_NOT_POSTED", { status: p.chequeStatus ?? p.status });
      if (request.body.status === "bounced") {
        if (!can(ctx, "payment.cancel")) throw forbidden("payment.cancel");
        await reversePayment(tx, ctx, p, request.body.reason ?? "", deps.clock.now().toISOString(), deps.clock.today(ctx.timeZone), true);
      } else {
        await tx.update(schema.payments).set({ chequeStatus: request.body.status, updatedBy: ctx.userId }).where(eq(schema.payments.id, p.id));
        await audit(tx, ctx, { action: `payment.cheque_${request.body.status}`, entityType: "payment", entityId: p.id, entityLabel: p.paymentNumber ?? undefined });
      }
      return paymentDetail(tx, ctx, p.id);
    });
  });

  /** Apply an advance (unallocated money) to open invoices / bills. */
  r.post("/payments/:id/allocate", { preHandler: guard(deps, "payment.allocate"), schema: { tags: ["payments"], params: IdParams, body: AllocateBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [p] = await tx.select().from(schema.payments).where(and(eq(schema.payments.id, request.params.id), eq(schema.payments.businessId, ctx.businessId))).for("update");
      if (!p) throw notFound("payment");
      if (p.status !== "posted") throw conflict("PAYMENT_NOT_POSTED", { status: p.status });
      if (dec(p.unallocatedAmount).lte(0)) throw conflict("NOTHING_TO_ALLOCATE");
      const isCustomer = p.partyType === "customer";
      const partyTable = isCustomer ? schema.customers : schema.suppliers;
      await tx.select({ id: partyTable.id }).from(partyTable).where(eq(partyTable.id, (isCustomer ? p.customerId : p.supplierId)!)).for("update");
      let open: OpenDocument[];
      if (isCustomer) {
        const i = schema.invoices;
        open = (
          await tx
            .select({ id: i.id, number: i.invoiceNumber, date: i.invoiceDate, dueDate: i.dueDate, balance: i.balanceDue })
            .from(i)
            .where(and(eq(i.businessId, ctx.businessId), eq(i.customerId, p.customerId!), eq(i.status, "posted"), gt(i.balanceDue, "0")))
            .for("update")
        ).map((d) => ({ id: d.id, number: d.number ?? "", date: d.date, dueDate: d.dueDate ?? d.date, balance: d.balance }));
      } else {
        const pu = schema.purchases;
        open = (
          await tx
            .select({ id: pu.id, number: pu.supplierInvoiceNumber, date: pu.supplierInvoiceDate, dueDate: pu.dueDate, balance: pu.balanceDue })
            .from(pu)
            .where(and(eq(pu.businessId, ctx.businessId), eq(pu.supplierId, p.supplierId!), eq(pu.status, "posted"), gt(pu.balanceDue, "0")))
            .for("update")
        ).map((d) => ({ id: d.id, number: d.number, date: d.date, dueDate: d.dueDate ?? d.date, balance: d.balance }));
      }
      if (!open.length) throw conflict("NO_OPEN_DOCUMENTS");
      const { allocations, unallocated } = allocatePayment(p.unallocatedAmount, open, request.body.allocations);
      const byId = new Map(open.map((d) => [d.id, d]));
      for (const a of allocations) {
        await tx.insert(schema.paymentAllocations).values({
          id: uuidv7(),
          businessId: ctx.businessId,
          paymentId: p.id,
          ...(isCustomer ? { invoiceId: a.documentId } : { purchaseId: a.documentId }),
          amount: a.amount.toFixed(2),
          allocatedBy: ctx.userId,
        });
        await applyToDocument(tx, isCustomer ? "customer" : "supplier", a.documentId, a.amount.toFixed(2), dec(byId.get(a.documentId)!.balance).minus(a.amount).toFixed(2));
      }
      await tx.update(schema.payments).set({ unallocatedAmount: unallocated.toFixed(2), updatedBy: ctx.userId }).where(eq(schema.payments.id, p.id));
      await audit(tx, ctx, {
        action: "payment.allocated",
        entityType: "payment",
        entityId: p.id,
        entityLabel: p.paymentNumber ?? undefined,
        changes: { allocations: allocations.map((a) => [a.documentNumber, a.amount.toFixed(2)]) },
      });
      return paymentDetail(tx, ctx, p.id);
    });
  });

  // ---------------------------------------------------------------- payment accounts (cash, bank, UPI)
  r.get("/payment-accounts", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx.select().from(schema.paymentAccounts).where(eq(schema.paymentAccounts.businessId, request.ctx.businessId)).orderBy(schema.paymentAccounts.name),
    ),
  }));

  r.post("/payment-accounts", { preHandler: guard(deps, "settings.update"), schema: { tags: ["payments"], body: AccountBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const id = uuidv7();
      if (request.body.isDefault) {
        await tx
          .update(schema.paymentAccounts)
          .set({ isDefault: false })
          .where(and(eq(schema.paymentAccounts.businessId, ctx.businessId), eq(schema.paymentAccounts.type, request.body.type)));
      }
      const [acc] = await tx
        .insert(schema.paymentAccounts)
        .values({ ...request.body, id, businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "payment_account.created", entityType: "payment_account", entityId: id, entityLabel: acc!.name });
      return acc!;
    });
    return reply.code(201).send(row);
  });
};
