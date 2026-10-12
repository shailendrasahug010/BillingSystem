import { IsoDate } from "@digitalbahi/contracts";
import { dec, partyPan, taxQuarterOf, tcsDueDate, tdsDueDate, toAmountString } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { purchaseTdsContext } from "../../services/tds.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const MonthQuery = z.object({ month: Month });
const RangeQuery = z.object({ from: IsoDate, to: IsoDate });
const SupplierTdsQuery = z.object({ date: IsoDate.optional() });
const Kind = z.enum(["tds", "tcs"]);
const ChallanBody = z.strictObject({
  /** TDS kept back on purchase bills (the default), or TCS collected on sales. */
  kind: Kind.default("tds"),
  periodMonth: Month,
  depositDate: IsoDate,
  bsrCode: z.string().trim().regex(/^\d{7}$/),
  challanSerial: z.string().trim().regex(/^\d{5}$/),
  interest: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).optional(),
  lateFee: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).optional(),
  notes: z.string().trim().max(300).optional(),
});

const monthBounds = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
};

/** A challan as the screens show it: with the number of bills it paid (purchase bills for TDS, sales bills for TCS). */
async function challanView(tx: Tx, businessId: string, id: string) {
  const [c] = await tx.select().from(schema.tdsChallans).where(and(eq(schema.tdsChallans.id, id), eq(schema.tdsChallans.businessId, businessId)));
  if (!c) throw notFound("tds_challan");
  const [bills] =
    c.kind === "tcs"
      ? await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.invoices)
          .where(and(eq(schema.invoices.businessId, businessId), eq(schema.invoices.tcsChallanId, id)))
      : await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.purchases)
          .where(and(eq(schema.purchases.businessId, businessId), eq(schema.purchases.tdsChallanId, id)));
  const { businessId: _b, ...rest } = c;
  return { ...rest, bills: Number(bills?.n ?? 0) };
}

/**
 * Income tax deducted at source. What the business kept back on its
 * purchase bills (393(1), old 194Q) month by month, with the challans that
 * paid it to the government and when each month is due; and what customers
 * deducted on their payments, quarter by quarter, with their certificates,
 * to match against Form 26AS.
 */
export const tdsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** The purchase bill screen's TDS: the rule for this supplier and what was bought from them this tax year. */
  r.get("/suppliers/:id/tds", { preHandler: guard(deps, "purchase.create"), schema: { tags: ["purchases"], params: IdParams, querystring: SupplierTdsQuery } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [s] = await tx
        .select({ id: schema.suppliers.id, pan: schema.suppliers.pan, gstin: schema.suppliers.gstin, stateCode: schema.suppliers.stateCode, tdsExempt: schema.suppliers.tdsExempt })
        .from(schema.suppliers)
        .where(and(eq(schema.suppliers.id, request.params.id), eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt)));
      if (!s) throw notFound("supplier");
      return purchaseTdsContext(tx, ctx.businessId, s, request.query.date ?? deps.clock.today(ctx.timeZone));
    });
  });

  /** TDS kept back on the month's purchase bills (by bill date): each bill, the challan that paid it, and the due date. */
  r.get("/tds/deducted", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: MonthQuery } }, async (request) => {
    const ctx = request.ctx;
    const { month } = request.query;
    const { from, to } = monthBounds(month);
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{
          id: string;
          purchase_number: string | null;
          supplier_invoice_number: string;
          supplier_invoice_date: string;
          supplier_id: string;
          party_name: string;
          pan: string | null;
          gstin: string | null;
          taxable_total: string;
          tds_base: string;
          tds_rate: string | null;
          tds_amount: string;
          challan_id: string | null;
          bsr_code: string | null;
          challan_serial: string | null;
          deposit_date: string | null;
        }>(sql`
          select p.id, p.purchase_number, p.supplier_invoice_number, p.supplier_invoice_date::text, p.supplier_id, p.party_name,
                 s.pan, s.gstin, p.taxable_total::text, p.tds_base::text, p.tds_rate::text, p.tds_amount::text,
                 c.id as challan_id, c.bsr_code, c.challan_serial, c.deposit_date::text
          from purchases p
          join suppliers s on s.id = p.supplier_id
          left join tds_challans c on c.id = p.tds_challan_id
          where p.business_id = ${ctx.businessId} and p.status = 'posted' and p.tds_amount > 0
            and p.supplier_invoice_date between ${from}::date and ${to}::date
          order by p.supplier_invoice_date, p.id`)
      ).rows,
    );
    const total = rows.reduce((acc, x) => acc.plus(x.tds_amount), dec(0));
    const paid = rows.filter((x) => x.challan_id).reduce((acc, x) => acc.plus(x.tds_amount), dec(0));
    const dueDate = tdsDueDate(month);
    const today = deps.clock.today(ctx.timeZone);
    return {
      month,
      dueDate,
      total: toAmountString(total),
      paid: toAmountString(paid),
      pending: toAmountString(total.minus(paid)),
      overdue: total.minus(paid).gt(0) && today > dueDate,
      data: rows.map((x) => ({
        purchaseId: x.id,
        purchaseNumber: x.purchase_number,
        supplierInvoiceNumber: x.supplier_invoice_number,
        date: x.supplier_invoice_date,
        supplierId: x.supplier_id,
        partyName: x.party_name,
        pan: partyPan({ pan: x.pan, gstin: x.gstin }),
        billValue: x.taxable_total,
        base: x.tds_base,
        rate: x.tds_rate,
        tds: x.tds_amount,
        challan: x.challan_id ? { id: x.challan_id, bsrCode: x.bsr_code!, challanSerial: x.challan_serial!, depositDate: x.deposit_date! } : null,
      })),
    };
  });

  r.get("/tds/challans", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: z.object({ month: Month.optional(), kind: Kind.default("tds") }) } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const c = schema.tdsChallans;
      const rows = await tx
        .select({ id: c.id })
        .from(c)
        .where(and(eq(c.businessId, ctx.businessId), eq(c.kind, request.query.kind), request.query.month ? eq(c.periodMonth, request.query.month) : sql`true`))
        .orderBy(desc(c.depositDate), desc(c.id))
        .limit(200);
      const data = [];
      for (const row of rows) data.push(await challanView(tx, ctx.businessId, row.id));
      return { data };
    });
  });

  /**
   * The month's TDS (or TCS) paid to the government: every purchase bill (or sales bill) of the month with
   * some, not yet on a challan, goes on this one.
   */
  r.post("/tds/challans", { preHandler: guard(deps, "gst.file"), schema: { tags: ["gst"], body: ChallanBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const today = deps.clock.today(ctx.timeZone);
    if (body.depositDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "depositDate");
    if (body.depositDate < `${body.periodMonth}-01`) throw badRequest("CHALLAN_BEFORE_MONTH", {}, "depositDate");
    const view = await tenant(ctx, async (tx) => {
      const { from, to } = monthBounds(body.periodMonth);
      const p = schema.purchases;
      const i = schema.invoices;
      const bills =
        body.kind === "tcs"
          ? (
              await tx
                .select({ id: i.id, amount: i.tcsAmount })
                .from(i)
                .where(and(eq(i.businessId, ctx.businessId), eq(i.status, "posted"), isNull(i.tcsChallanId), sql`${i.tcsAmount} > 0`, sql`${i.invoiceDate} between ${from}::date and ${to}::date`))
                .for("update")
            )
          : await tx
              .select({ id: p.id, amount: p.tdsAmount })
              .from(p)
              .where(and(eq(p.businessId, ctx.businessId), eq(p.status, "posted"), isNull(p.tdsChallanId), sql`${p.tdsAmount} > 0`, sql`${p.supplierInvoiceDate} between ${from}::date and ${to}::date`))
              .for("update");
      if (!bills.length) throw conflict("NOTHING_TO_DEPOSIT", { month: body.periodMonth });
      const id = uuidv7();
      const taxAmount = bills.reduce((acc, b) => acc.plus(b.amount), dec(0));
      await tx.insert(schema.tdsChallans).values({
        id,
        businessId: ctx.businessId,
        kind: body.kind,
        periodMonth: body.periodMonth,
        depositDate: body.depositDate,
        bsrCode: body.bsrCode,
        challanSerial: body.challanSerial,
        taxAmount: toAmountString(taxAmount),
        interest: body.interest ?? "0",
        lateFee: body.lateFee ?? "0",
        notes: body.notes ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      const ids = sql.join(bills.map((b) => sql`${b.id}::uuid`), sql`, `);
      if (body.kind === "tcs") await tx.update(i).set({ tcsChallanId: id }).where(and(eq(i.businessId, ctx.businessId), sql`${i.id} in (${ids})`));
      else await tx.update(p).set({ tdsChallanId: id }).where(and(eq(p.businessId, ctx.businessId), sql`${p.id} in (${ids})`));
      await audit(tx, ctx, {
        action: body.kind === "tcs" ? "tcs.challan_recorded" : "tds.challan_recorded",
        entityType: "tds_challan",
        entityId: id,
        entityLabel: `${body.bsrCode}/${body.challanSerial}`,
        changes: { month: body.periodMonth, depositDate: body.depositDate, tax: toAmountString(taxAmount), bills: bills.length },
      });
      return challanView(tx, ctx.businessId, id);
    });
    return reply.code(201).send(view);
  });

  /** A challan recorded by mistake: its bills' TDS (or TCS) is unpaid again. */
  r.delete("/tds/challans/:id", { preHandler: guard(deps, "gst.file"), schema: { tags: ["gst"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const c = await challanView(tx, ctx.businessId, request.params.id);
      if (c.kind === "tcs") {
        await tx
          .update(schema.invoices)
          .set({ tcsChallanId: null })
          .where(and(eq(schema.invoices.businessId, ctx.businessId), eq(schema.invoices.tcsChallanId, c.id)));
      } else {
        await tx
          .update(schema.purchases)
          .set({ tdsChallanId: null })
          .where(and(eq(schema.purchases.businessId, ctx.businessId), eq(schema.purchases.tdsChallanId, c.id)));
      }
      await tx.delete(schema.tdsChallans).where(eq(schema.tdsChallans.id, c.id));
      await audit(tx, ctx, {
        action: c.kind === "tcs" ? "tcs.challan_removed" : "tds.challan_removed",
        entityType: "tds_challan",
        entityId: c.id,
        entityLabel: `${c.bsrCode}/${c.challanSerial}`,
        changes: { month: c.periodMonth, tax: c.taxAmount },
      });
    });
    return reply.code(204).send();
  });

  /** TCS collected on the month's sales bills (by bill date): each bill, its goods and rate, the challan that paid it, and the due date. */
  r.get("/tcs/collected", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: MonthQuery } }, async (request) => {
    const ctx = request.ctx;
    const { month } = request.query;
    const { from, to } = monthBounds(month);
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{
          id: string;
          invoice_number: string | null;
          invoice_date: string;
          customer_id: string;
          party_name: string;
          pan: string | null;
          gstin: string | null;
          grand_total: string;
          tcs_amount: string;
          tcs: Array<{ goods: string; rate: string; base: string; amount: string }> | null;
          challan_id: string | null;
          bsr_code: string | null;
          challan_serial: string | null;
          deposit_date: string | null;
        }>(sql`
          select i.id, i.invoice_number, i.invoice_date::text, i.customer_id, i.party_name, c.pan, c.gstin,
                 i.grand_total::text, i.tcs_amount::text, i.tcs,
                 ch.id as challan_id, ch.bsr_code, ch.challan_serial, ch.deposit_date::text
          from invoices i
          join customers c on c.id = i.customer_id
          left join tds_challans ch on ch.id = i.tcs_challan_id
          where i.business_id = ${ctx.businessId} and i.status = 'posted' and i.tcs_amount > 0
            and i.invoice_date between ${from}::date and ${to}::date
          order by i.invoice_date, i.invoice_number, i.id`)
      ).rows,
    );
    const total = rows.reduce((acc, x) => acc.plus(x.tcs_amount), dec(0));
    const paid = rows.filter((x) => x.challan_id).reduce((acc, x) => acc.plus(x.tcs_amount), dec(0));
    const dueDate = tcsDueDate(month);
    const today = deps.clock.today(ctx.timeZone);
    return {
      month,
      dueDate,
      total: toAmountString(total),
      paid: toAmountString(paid),
      pending: toAmountString(total.minus(paid)),
      overdue: total.minus(paid).gt(0) && today > dueDate,
      data: rows.map((x) => ({
        invoiceId: x.id,
        invoiceNumber: x.invoice_number,
        date: x.invoice_date,
        customerId: x.customer_id,
        partyName: x.party_name,
        pan: partyPan({ pan: x.pan, gstin: x.gstin }),
        billValue: x.grand_total,
        parts: x.tcs ?? [],
        tcs: x.tcs_amount,
        challan: x.challan_id ? { id: x.challan_id, bsrCode: x.bsr_code!, challanSerial: x.challan_serial!, depositDate: x.deposit_date! } : null,
      })),
    };
  });

  /** TDS customers deducted on their payments in a period, with their certificates: to match against Form 26AS. */
  r.get("/tds/received", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: RangeQuery } }, async (request) => {
    const ctx = request.ctx;
    const { from, to } = request.query;
    if (from > to) throw badRequest("INVALID_RANGE", {}, "from");
    const rows = await tenant(ctx, async (tx) =>
      (
        await tx.execute<{
          id: string;
          payment_number: string | null;
          payment_date: string;
          customer_id: string;
          party_name: string;
          pan: string | null;
          gstin: string | null;
          amount: string;
          tds_amount: string;
          tds_section: string | null;
          tds_certificate: string | null;
        }>(sql`
          select p.id, p.payment_number, p.payment_date::text, p.customer_id, coalesce(c.business_name, c.name) as party_name, c.pan, c.gstin,
                 p.amount::text, p.tds_amount::text, p.tds_section, p.tds_certificate
          from payments p
          join customers c on c.id = p.customer_id
          where p.business_id = ${ctx.businessId} and p.status = 'posted' and p.tds_amount > 0
            and p.payment_date between ${from}::date and ${to}::date
          order by p.payment_date, p.id
          limit 5000`)
      ).rows,
    );
    // Quarter by quarter, as Form 26AS and the deductors' returns have it.
    const quarters = new Map<string, { quarter: string; tds: ReturnType<typeof dec>; receipts: number; withCertificate: number }>();
    for (const x of rows) {
      const q = taxQuarterOf(x.payment_date);
      const key = `${q.year} Q${q.quarter}`;
      const acc = quarters.get(key) ?? { quarter: key, tds: dec(0), receipts: 0, withCertificate: 0 };
      acc.tds = acc.tds.plus(x.tds_amount);
      acc.receipts += 1;
      if (x.tds_certificate) acc.withCertificate += 1;
      quarters.set(key, acc);
    }
    const total = rows.reduce((acc, x) => acc.plus(x.tds_amount), dec(0));
    return {
      from,
      to,
      total: toAmountString(total),
      quarters: [...quarters.values()].map((q) => ({ quarter: q.quarter, tds: toAmountString(q.tds), receipts: q.receipts, withCertificate: q.withCertificate })),
      data: rows.map((x) => ({
        paymentId: x.id,
        paymentNumber: x.payment_number,
        date: x.payment_date,
        customerId: x.customer_id,
        partyName: x.party_name,
        pan: partyPan({ pan: x.pan, gstin: x.gstin }),
        amount: x.amount,
        tds: x.tds_amount,
        section: x.tds_section,
        certificate: x.tds_certificate,
      })),
    };
  });
};
