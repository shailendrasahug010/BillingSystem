import { IsoDate } from "@digitalbahi/contracts";
import { nextRepeatDate, REPEAT_FREQUENCIES, type RepeatFrequency } from "@digitalbahi/core";
import { schema } from "@digitalbahi/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { ApiModule } from "../types.js";

const Id = z.uuid();

const CreateBody = z.strictObject({
  /** The bill to repeat. */
  invoiceId: Id,
  frequency: z.enum(REPEAT_FREQUENCIES),
  /** Date of the first repeat (after the bill itself). */
  startDate: IsoDate,
  endDate: IsoDate.nullable().optional(),
});

const PatchBody = z.strictObject({
  isActive: z.boolean().optional(),
  nextDate: IsoDate.optional(),
  endDate: IsoDate.nullable().optional(),
});

/**
 * Repeat bills: a bill set to be made again every week or month for its
 * customer, with the same lines and rates. The bills themselves are made by
 * the repeat-bill job (services/repeat-bills.ts).
 */
export const repeatBillsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const t = schema.recurringInvoices;

  const list = (businessId: string, where = sql`true`) =>
    withTenant(deps.db, { businessId, userId: "" }, (tx) =>
      tx
        .select({
          id: t.id,
          customerId: t.customerId,
          customerName: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})`,
          frequency: t.frequency,
          anchorDay: t.anchorDay,
          nextDate: t.nextDate,
          endDate: t.endDate,
          isActive: t.isActive,
          billsMade: t.billsMade,
          lastError: t.lastError,
          sourceInvoiceId: t.sourceInvoiceId,
          sourceNumber: sql<string | null>`(select invoice_number from invoices where id = ${t.sourceInvoiceId})`,
          lastInvoiceId: t.lastInvoiceId,
          lastNumber: sql<string | null>`(select invoice_number from invoices where id = ${t.lastInvoiceId})`,
          /** The source bill's total: what each repeat comes to at today's tax rates. */
          amount: sql<string | null>`(select grand_total::text from invoices where id = ${t.sourceInvoiceId})`,
          createdAt: t.createdAt,
        })
        .from(t)
        .innerJoin(schema.customers, eq(schema.customers.id, t.customerId))
        .where(and(eq(t.businessId, businessId), where))
        .orderBy(desc(t.isActive), asc(t.nextDate)),
    );

  r.get("/repeat-bills", { preHandler: guard(deps, "invoice.view"), schema: { tags: ["invoices"], querystring: z.strictObject({ invoiceId: Id.optional() }) } }, async (request) => {
    const { invoiceId } = request.query;
    return { data: await list(request.ctx.businessId, invoiceId ? sql`${t.sourceInvoiceId} = ${invoiceId}` : sql`true`) };
  });

  r.post("/repeat-bills", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], body: CreateBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    if (body.endDate && body.endDate < body.startDate) throw badRequest("REPEAT_END_BEFORE_START", {}, "endDate");
    const today = deps.clock.today(ctx.timeZone);
    if (body.startDate < today) throw badRequest("REPEAT_START_IN_PAST", {}, "startDate");
    const id = await withTenant(deps.db, ctx, async (tx) => {
      const [inv] = await tx.select().from(schema.invoices).where(and(eq(schema.invoices.id, body.invoiceId), eq(schema.invoices.businessId, ctx.businessId)));
      if (!inv) throw notFound("invoice");
      if (inv.status !== "posted" || (inv.documentKind !== "tax_invoice" && inv.documentKind !== "bill_of_supply")) throw conflict("REPEAT_BILL_NOT_ALLOWED", { status: inv.status });
      if (inv.zeroRatedType) throw conflict("REPEAT_BILL_NOT_ALLOWED", { status: "zero_rated" });
      const items = await tx.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id)).orderBy(asc(schema.invoiceItems.lineNo));
      // The bill as POST /invoices takes it: same customer, lines, rates, discounts and charges; no date or payment.
      const template = {
        customerId: inv.customerId,
        ...(inv.warehouseId ? { warehouseId: inv.warehouseId } : {}),
        lines: items.map((i) => ({
          productId: i.productId,
          unitId: i.unitId,
          qty: i.qty,
          freeQty: i.freeQty,
          rate: i.rate,
          discountPercent: i.discountPercent,
          discountAmount: Number(i.discountPercent) > 0 ? "0" : i.discountAmount,
        })),
        ...(Number(inv.documentDiscountPercent) > 0 || Number(inv.documentDiscountAmount) > 0
          ? { documentDiscount: { ...(Number(inv.documentDiscountPercent) > 0 ? { percent: inv.documentDiscountPercent } : { amount: inv.documentDiscountAmount }) } }
          : {}),
        charges: ((inv.charges ?? []) as Array<{ label: string; taxable: string; gstRate: string }>).map((c) => ({ label: c.label, amount: c.taxable, ...(Number(c.gstRate) > 0 ? { gstRate: c.gstRate } : {}) })),
        ...(inv.notes ? { notes: inv.notes } : {}),
        ...(inv.salespersonId ? { salespersonId: inv.salespersonId } : {}),
        ...(inv.printLocale === "hi" || inv.printLocale === "en" ? { printLocale: inv.printLocale } : {}),
      };
      const [row] = await tx
        .insert(t)
        .values({
          businessId: ctx.businessId,
          customerId: inv.customerId,
          sourceInvoiceId: inv.id,
          frequency: body.frequency,
          anchorDay: Number(body.startDate.slice(8, 10)),
          nextDate: body.startDate,
          endDate: body.endDate ?? null,
          template,
          ownerId: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: t.id });
      await audit(tx, ctx, { action: "repeat_bill.created", entityType: "invoice", entityId: inv.id, entityLabel: inv.invoiceNumber ?? undefined, changes: { frequency: body.frequency, startDate: body.startDate, endDate: body.endDate ?? null } });
      return row!.id;
    });
    const [out] = await list(ctx.businessId, sql`${t.id} = ${id}`);
    return reply.code(201).send(out);
  });

  r.patch("/repeat-bills/:id", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], params: z.strictObject({ id: Id }), body: PatchBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    const today = deps.clock.today(ctx.timeZone);
    if (body.nextDate && body.nextDate < today) throw badRequest("REPEAT_START_IN_PAST", {}, "nextDate");
    await withTenant(deps.db, ctx, async (tx) => {
      const [row] = await tx.select().from(t).where(and(eq(t.id, request.params.id), eq(t.businessId, ctx.businessId))).for("update");
      if (!row) throw notFound("repeat_bill");
      const next = body.nextDate ?? row.nextDate;
      const end = body.endDate === undefined ? row.endDate : body.endDate;
      if (end && end < next) throw badRequest("REPEAT_END_BEFORE_START", {}, "endDate");
      // Starting again after a pause: bills missed while it was paused are not made; the next one on its schedule is.
      let resumeFrom = next;
      if (body.isActive && !row.isActive && !body.nextDate) while (resumeFrom < today) resumeFrom = nextRepeatDate(row.frequency as RepeatFrequency, resumeFrom, row.anchorDay);
      await tx
        .update(t)
        .set({
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          nextDate: resumeFrom,
          ...(body.nextDate ? { anchorDay: Number(body.nextDate.slice(8, 10)) } : {}),
          endDate: end,
          lastError: null,
          lastTriedOn: null,
          updatedBy: ctx.userId,
          updatedAt: deps.clock.now().toISOString(),
        })
        .where(eq(t.id, row.id));
      await audit(tx, ctx, { action: "repeat_bill.updated", entityType: "invoice", entityId: row.sourceInvoiceId ?? undefined, changes: body });
    });
    const [out] = await list(ctx.businessId, sql`${t.id} = ${request.params.id}`);
    return out;
  });

  r.delete("/repeat-bills/:id", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["invoices"], params: z.strictObject({ id: Id }) } }, async (request, reply) => {
    const ctx = request.ctx;
    await withTenant(deps.db, ctx, async (tx) => {
      const [row] = await tx.delete(t).where(and(eq(t.id, request.params.id), eq(t.businessId, ctx.businessId))).returning();
      if (!row) throw notFound("repeat_bill");
      await audit(tx, ctx, { action: "repeat_bill.deleted", entityType: "invoice", entityId: row.sourceInvoiceId ?? undefined, changes: { frequency: row.frequency, billsMade: row.billsMade } });
    });
    return reply.code(204).send();
  });
};
