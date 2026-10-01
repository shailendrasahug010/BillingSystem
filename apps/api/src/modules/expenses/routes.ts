import { CancelBody, ExpenseBody, ExpenseCategoryBody, ExpenseCategoryPatch, ExpenseListQuery, ExpenseReportQuery } from "@digitalbahi/contracts";
import { calculateTaxLine, dec, determineSupplyType, normalizeGstin, taxAt, toAmountString, validateGstin } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { assertRange } from "../../lib/period.js";
import { periodLocked } from "../../services/gst-period.js";
import { nextDocumentNumber } from "../../services/numbering.js";
import { assertOwned } from "../../services/owned.js";
import { sendReport } from "../reports/reports.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const e = schema.expenses;

const categoryName = sql<string>`(select c.name from expense_categories c where c.id = "expenses"."category_id")`;
const categoryNameHi = sql<string | null>`(select c.name_hi from expense_categories c where c.id = "expenses"."category_id")`;

async function expenseDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [row] = await tx
    .select({ expense: e, categoryName, categoryNameHi, accountName: sql<string | null>`(select a.name from payment_accounts a where a.id = "expenses"."payment_account_id")` })
    .from(e)
    .where(and(eq(e.id, id), eq(e.businessId, ctx.businessId)));
  if (!row) throw notFound("expense");
  const { businessId: _b, deletedAt: _d, deletedBy: _db, ...rest } = row.expense;
  return { ...rest, categoryName: row.categoryName, categoryNameHi: row.categoryNameHi, accountName: row.accountName };
}

export const expensesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  // ---------------------------------------------------------------- categories
  r.get("/expense-categories", { preHandler: guard(deps, "expense.view"), schema: { tags: ["expenses"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx
        .select({ id: schema.expenseCategories.id, name: schema.expenseCategories.name, nameHi: schema.expenseCategories.nameHi, isSystem: schema.expenseCategories.isSystem, isActive: schema.expenseCategories.isActive })
        .from(schema.expenseCategories)
        .where(eq(schema.expenseCategories.businessId, request.ctx.businessId))
        .orderBy(schema.expenseCategories.name),
    ),
  }));

  r.post("/expense-categories", { preHandler: guard(deps, "expense.create"), schema: { tags: ["expenses"], body: ExpenseCategoryBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const [c] = await tx
        .insert(schema.expenseCategories)
        .values({ id: uuidv7(), businessId: ctx.businessId, name: request.body.name, nameHi: request.body.nameHi ?? null, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "expense_category.created", entityType: "expense_category", entityId: c!.id, entityLabel: c!.name });
      return c!;
    });
    return reply.code(201).send({ id: row.id, name: row.name, nameHi: row.nameHi, isSystem: row.isSystem, isActive: row.isActive });
  });

  r.patch("/expense-categories/:id", { preHandler: guard(deps, "expense.update"), schema: { tags: ["expenses"], params: IdParams, body: ExpenseCategoryPatch } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const c = schema.expenseCategories;
      const [before] = await tx.select().from(c).where(and(eq(c.id, request.params.id), eq(c.businessId, ctx.businessId))).for("update");
      if (!before) throw notFound("expense_category");
      const [after] = await tx.update(c).set({ ...request.body, updatedBy: ctx.userId }).where(eq(c.id, before.id)).returning();
      await audit(tx, ctx, { action: "expense_category.updated", entityType: "expense_category", entityId: before.id, entityLabel: after!.name, changes: diff(before, request.body) });
      return { id: after!.id, name: after!.name, nameHi: after!.nameHi, isSystem: after!.isSystem, isActive: after!.isActive };
    });
  });

  // ---------------------------------------------------------------- expenses
  /** Record an expense paid now; GST with the vendor's GSTIN goes to the GST register for input tax credit. */
  r.post("/expenses", { preHandler: guard(deps, "expense.create"), schema: { tags: ["expenses"], body: ExpenseBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");

    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        const [existing] = await tx.select({ id: e.id }).from(e).where(and(eq(e.businessId, ctx.businessId), eq(e.clientId, clientId)));
        if (existing) return { replay: true, detail: await expenseDetail(tx, ctx, existing.id) };
      }
      const today = deps.clock.today(ctx.timeZone);
      const date = body.expenseDate ?? today;
      if (date > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "expenseDate");

      const [category] = await tx
        .select({ id: schema.expenseCategories.id, name: schema.expenseCategories.name, isActive: schema.expenseCategories.isActive })
        .from(schema.expenseCategories)
        .where(and(eq(schema.expenseCategories.id, body.categoryId), eq(schema.expenseCategories.businessId, ctx.businessId)));
      if (!category || !category.isActive) throw badRequest("REFERENCE_NOT_FOUND", {}, "categoryId");
      await assertOwned(tx, schema.paymentAccounts, ctx.businessId, body.paymentAccountId, "paymentAccountId");
      const supplier = body.supplierId
        ? (await tx.select({ id: schema.suppliers.id, name: schema.suppliers.name, gstin: schema.suppliers.gstin }).from(schema.suppliers).where(and(eq(schema.suppliers.id, body.supplierId), eq(schema.suppliers.businessId, ctx.businessId))))[0]
        : undefined;
      if (body.supplierId && !supplier) throw badRequest("REFERENCE_NOT_FOUND", {}, "supplierId");

      const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const gstRate = dec(body.gstRate);
      const vendorGstin = body.vendorGstin ? normalizeGstin(body.vendorGstin) : (supplier?.gstin ?? null);
      if (gstRate.gt(0)) {
        if (!vendorGstin) throw badRequest("EXPENSE_GSTIN_REQUIRED", {}, "vendorGstin");
        const issues = validateGstin(vendorGstin);
        if (issues.length) throw badRequest("INVALID_GSTIN", { issue: issues[0]! }, "vendorGstin");
        if (await periodLocked(tx, ctx.businessId, date)) throw conflict("GST_PERIOD_LOCKED");
      }
      const supplyType = vendorGstin ? determineSupplyType({ supplierStateCode: vendorGstin.slice(0, 2), placeOfSupplyStateCode: business!.stateCode }) : "intra_state";
      const line = calculateTaxLine(
        { qty: 1, rate: body.amount, rateIncludesTax: body.amountIncludesTax, tax: taxAt(gstRate) },
        { supplyType, chargeTax: gstRate.gt(0) },
      );
      if (line.taxable.lte(0)) throw badRequest("AMOUNT_NOT_POSITIVE", {}, "amount");
      const total = line.taxable.plus(line.taxTotal);
      // Only a regular GST registration can claim input tax credit.
      const itc = business!.gstRegistration === "regular" ? body.itcEligibility : "ineligible";
      const numbering = await nextDocumentNumber(tx, ctx.businessId, "expense", date, business!.financialYearStartMonth, { name: "Expense", pattern: "EXP/{FYS}/{SEQ:5}" });
      const id = uuidv7();
      const paidTo = body.paidTo ?? supplier?.name ?? null;
      await tx.insert(e).values({
        id,
        businessId: ctx.businessId,
        expenseNumber: numbering.number,
        expenseDate: date,
        categoryId: category.id,
        paidTo,
        supplierId: supplier?.id ?? null,
        amount: toAmountString(line.taxable),
        vendorGstin: gstRate.gt(0) ? vendorGstin : null,
        gstRate: gstRate.toFixed(3),
        cgstAmount: toAmountString(line.cgst),
        sgstAmount: toAmountString(line.sgst),
        igstAmount: toAmountString(line.igst),
        itcEligibility: gstRate.gt(0) ? itc : null,
        totalAmount: toAmountString(total),
        paymentMethod: body.paymentMethod,
        paymentAccountId: body.paymentAccountId ?? null,
        referenceNumber: body.referenceNumber ?? null,
        notes: body.notes ?? null,
        status: "posted",
        clientId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      if (gstRate.gt(0)) {
        await tx.insert(schema.gstTransactions).values({
          businessId: ctx.businessId,
          direction: "inward",
          docType: "expense",
          docId: id,
          // The vendor's bill number is what the GST portal shows for this credit.
          docNumber: body.referenceNumber ?? numbering.number,
          docDate: date,
          returnPeriod: date.slice(0, 7),
          partyName: paidTo,
          partyGstin: vendorGstin,
          partyRegistration: "regular",
          partyStateCode: vendorGstin!.slice(0, 2),
          placeOfSupply: business!.stateCode,
          supplyType,
          taxability: "taxable",
          taxableValue: toAmountString(line.taxable),
          gstRate: gstRate.toFixed(3),
          cgstAmount: toAmountString(line.cgst),
          sgstAmount: toAmountString(line.sgst),
          igstAmount: toAmountString(line.igst),
          documentValue: toAmountString(total),
          itcEligibility: itc,
        });
      }
      await audit(tx, ctx, {
        action: "expense.posted",
        entityType: "expense",
        entityId: id,
        entityLabel: numbering.number,
        changes: { category: category.name, amount: toAmountString(line.taxable), gst: toAmountString(line.taxTotal), total: toAmountString(total), method: body.paymentMethod },
      });
      await tx.insert(schema.outboxEvents).values({
        businessId: ctx.businessId,
        eventType: "expense.posted",
        aggregateType: "expense",
        aggregateId: id,
        payload: { total: toAmountString(total), categoryId: category.id },
      });
      return { replay: false, detail: await expenseDetail(tx, ctx, id) };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.detail);
  });

  r.get("/expenses", { preHandler: guard(deps, "expense.view"), schema: { tags: ["expenses"], querystring: ExpenseListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [eq(e.businessId, ctx.businessId)];
    if (q.status !== "all") where.push(eq(e.status, q.status));
    if (q.categoryId) where.push(eq(e.categoryId, q.categoryId));
    if (q.method) where.push(eq(e.paymentMethod, q.method));
    if (q.from) where.push(sql`${e.expenseDate} >= ${q.from}`);
    if (q.to) where.push(sql`${e.expenseDate} <= ${q.to}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(sql`(${e.expenseNumber} ilike ${like} or ${e.paidTo} ilike ${like} or ${e.referenceNumber} ilike ${like} or ${e.notes} ilike ${like})`);
    }
    const filtered = and(...where);
    if (cursor) where.push(sql`(${e.expenseDate}, ${e.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    return tenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          id: e.id,
          expenseNumber: e.expenseNumber,
          expenseDate: e.expenseDate,
          categoryId: e.categoryId,
          categoryName,
          categoryNameHi,
          paidTo: e.paidTo,
          amount: e.amount,
          gst: sql<string>`(${e.cgstAmount} + ${e.sgstAmount} + ${e.igstAmount})::text`,
          totalAmount: e.totalAmount,
          paymentMethod: e.paymentMethod,
          referenceNumber: e.referenceNumber,
          status: e.status,
        })
        .from(e)
        .where(and(...where))
        .orderBy(sql`${e.expenseDate} desc, ${e.id} desc`)
        .limit(q.limit + 1);
      // Totals for the whole filter (first page only; later pages reuse them).
      const totals = cursor
        ? null
        : (
            await tx
              .select({
                count: sql<number>`count(*)::int`,
                amount: sql<string>`coalesce(sum(${e.amount}), 0)::text`,
                gst: sql<string>`coalesce(sum(${e.cgstAmount} + ${e.sgstAmount} + ${e.igstAmount}), 0)::text`,
                total: sql<string>`coalesce(sum(${e.totalAmount}), 0)::text`,
              })
              .from(e)
              .where(filtered)
          )[0];
      return { ...page(rows, q.limit, (x) => ({ v: x.expenseDate, id: x.id })), totals };
    });
  });

  r.get("/expenses/:id", { preHandler: guard(deps, "expense.view"), schema: { tags: ["expenses"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => expenseDetail(tx, request.ctx, request.params.id)),
  );

  r.post("/expenses/:id/cancel", { preHandler: guard(deps, "expense.delete"), schema: { tags: ["expenses"], params: IdParams, body: CancelBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [x] = await tx.select().from(e).where(and(eq(e.id, request.params.id), eq(e.businessId, ctx.businessId))).for("update");
      if (!x) throw notFound("expense");
      if (x.status !== "posted") throw conflict("EXPENSE_NOT_POSTED", { status: x.status });
      if (dec(x.gstRate).gt(0) && (await periodLocked(tx, ctx.businessId, x.expenseDate))) throw conflict("GST_PERIOD_LOCKED");
      await tx
        .update(e)
        .set({ status: "cancelled", cancelledAt: deps.clock.now().toISOString(), cancelledBy: ctx.userId, cancelReason: request.body.reason, updatedBy: ctx.userId, version: x.version + 1 })
        .where(eq(e.id, x.id));
      await tx
        .update(schema.gstTransactions)
        .set({ isCancelled: true })
        .where(and(eq(schema.gstTransactions.docType, "expense"), eq(schema.gstTransactions.docId, x.id), eq(schema.gstTransactions.businessId, ctx.businessId)));
      await audit(tx, ctx, { action: "expense.cancelled", entityType: "expense", entityId: x.id, entityLabel: x.expenseNumber ?? undefined, changes: { total: x.totalAmount, reason: request.body.reason } });
      return expenseDetail(tx, ctx, x.id);
    });
  });

  /** Expenses by category, month, year or payment method (CSV with report.export). */
  r.get("/reports/expenses", { preHandler: guard(deps, "expense.view"), schema: { tags: ["reports"], querystring: ExpenseReportQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    const group = {
      category: { key: sql`x.category_id::text`, label: sql`max(c.name)`, labelHi: sql`max(c.name_hi)`, order: sql`sum(x.total_amount) desc` },
      month: { key: sql`to_char(x.expense_date, 'YYYY-MM')`, label: sql`to_char(x.expense_date, 'YYYY-MM')`, labelHi: sql`null`, order: sql`1` },
      year: { key: sql`to_char(x.expense_date, 'YYYY')`, label: sql`to_char(x.expense_date, 'YYYY')`, labelHi: sql`null`, order: sql`1` },
      method: { key: sql`x.payment_method::text`, label: sql`x.payment_method::text`, labelHi: sql`null`, order: sql`sum(x.total_amount) desc` },
    }[q.groupBy];
    const { rows, totals } = await tenant(ctx, async (tx) => {
      const where = sql`x.business_id = ${ctx.businessId} and x.status = 'posted' and x.expense_date between ${q.from} and ${q.to}`;
      const rows = (
        await tx.execute<{ key: string; label: string; label_hi: string | null; count: number; amount: string; gst: string; itc: string; total: string }>(sql`
          select ${group.key} as key, ${group.label} as label, ${group.labelHi} as label_hi, count(*)::int as count,
                 sum(x.amount)::text as amount, sum(x.cgst_amount + x.sgst_amount + x.igst_amount)::text as gst,
                 sum(case when x.itc_eligibility in ('eligible', 'input_services', 'capital_goods') then x.cgst_amount + x.sgst_amount + x.igst_amount else 0 end)::text as itc,
                 sum(x.total_amount)::text as total
          from expenses x join expense_categories c on c.id = x.category_id
          where ${where}
          group by 1 order by ${group.order}`)
      ).rows;
      const [t] = (
        await tx.execute<{ count: number; amount: string; gst: string; total: string }>(sql`
          select count(*)::int as count, coalesce(sum(x.amount), 0)::text as amount,
                 coalesce(sum(x.cgst_amount + x.sgst_amount + x.igst_amount), 0)::text as gst, coalesce(sum(x.total_amount), 0)::text as total
          from expenses x where ${where}`)
      ).rows;
      return { rows, totals: t! };
    });
    return sendReport(
      reply,
      ctx,
      deps,
      q.format,
      `expenses-${q.from}-${q.to}`,
      [
        { key: "label", label: q.groupBy },
        { key: "count", label: "Expenses" },
        { key: "amount", label: "Amount" },
        { key: "gst", label: "GST" },
        { key: "itc", label: "ITC" },
        { key: "total", label: "Total" },
      ],
      {
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
        rows: rows.map((x) => ({ key: x.key, label: x.label, labelHi: x.label_hi, count: x.count, amount: x.amount, gst: x.gst, itc: x.itc, total: x.total })),
        totals,
      },
      { title: `Expenses by ${q.groupBy}`, from: q.from, to: q.to },
    );
  });
};
