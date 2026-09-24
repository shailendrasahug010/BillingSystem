import { buildGstr1, buildGstr3b, dec, financialYearOf, gstr1Csv, type Gstr1CsvSection, type GstRegisterRow } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { toCsv } from "../reports/reports.js";
import type { ApiModule } from "../types.js";

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const PeriodParams = z.object({ period: Period });
const ReturnType = z.enum(["GSTR1", "GSTR3B"]);
const LockBody = z.strictObject({ returnType: ReturnType.default("GSTR1") });
const FiledBody = z.strictObject({ returnType: ReturnType.default("GSTR1"), arn: z.string().trim().min(5).max(30), notes: z.string().trim().max(300).optional() });
const FileQuery = z.object({
  period: Period,
  format: z.enum(["json", "csv"]).default("json"),
  section: z.enum(["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "hsn", "docs"]).default("b2b"),
});

type RegisterSqlRow = {
  direction: "outward" | "inward";
  doc_type: GstRegisterRow["docType"];
  doc_id: string;
  doc_number: string;
  doc_date: string;
  original_doc_number: string | null;
  original_doc_date: string | null;
  party_name: string | null;
  party_gstin: string | null;
  place_of_supply: string;
  supply_type: "intra_state" | "inter_state";
  is_reverse_charge: boolean;
  taxability: GstRegisterRow["taxability"];
  hsn_code: string | null;
  uqc: string | null;
  qty: string;
  taxable_value: string;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  cess_amount: string;
  document_value: string;
  itc_eligibility: string | null;
  is_cancelled: boolean;
};

const toRow = (r: RegisterSqlRow): GstRegisterRow => ({
  direction: r.direction,
  docType: r.doc_type,
  docId: r.doc_id,
  docNumber: r.doc_number,
  docDate: r.doc_date,
  originalDocNumber: r.original_doc_number,
  originalDocDate: r.original_doc_date,
  partyName: r.party_name,
  partyGstin: r.party_gstin,
  placeOfSupply: r.place_of_supply,
  supplyType: r.supply_type,
  isReverseCharge: r.is_reverse_charge,
  taxability: r.taxability,
  hsnCode: r.hsn_code,
  uqc: r.uqc,
  qty: r.qty,
  taxableValue: r.taxable_value,
  gstRate: r.gst_rate,
  cgst: r.cgst_amount,
  sgst: r.sgst_amount,
  igst: r.igst_amount,
  cess: r.cess_amount,
  documentValue: r.document_value,
  itcEligibility: r.itc_eligibility,
  isCancelled: r.is_cancelled,
});

async function register(tx: Tx, businessId: string, period: string, direction?: "outward"): Promise<GstRegisterRow[]> {
  const rows = await tx.execute<RegisterSqlRow>(sql`
    select direction::text, doc_type::text, doc_id, doc_number, doc_date::text, original_doc_number, original_doc_date::text,
           party_name, party_gstin, place_of_supply, supply_type::text, is_reverse_charge, taxability::text, hsn_code, uqc,
           qty::text, taxable_value::text, gst_rate::text, cgst_amount::text, sgst_amount::text, igst_amount::text, cess_amount::text,
           document_value::text, itc_eligibility::text, is_cancelled
    from gst_transactions
    where business_id = ${businessId} and return_period = ${period} ${direction ? sql`and direction = ${direction}` : sql``}
    order by doc_date, doc_number, id`);
  return rows.rows.map(toRow);
}

async function configValue<T>(tx: Tx, businessId: string, key: string, onDate: string): Promise<T | undefined> {
  const [row] = (
    await tx.execute<{ value: T }>(sql`
      select value from gst_config
      where key = ${key} and effective_from <= ${onDate} and (business_id is null or business_id = ${businessId})
      order by business_id nulls last, effective_from desc limit 1`)
  ).rows;
  return row?.value;
}

/** GSTR-1 for a month: register rows, original invoices of the notes, thresholds and HSN digits in force. */
async function gstr1For(tx: Tx, ctx: RequestCtx, period: string) {
  const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
  const rows = await register(tx, ctx.businessId, period, "outward");
  const first = `${period}-01`;
  const threshold = (await configValue<{ amount: number }>(tx, ctx.businessId, "b2cl_invoice_threshold", first))?.amount ?? 100000;
  // HSN digits depend on the previous financial year's turnover.
  const fy = financialYearOf(first, business!.financialYearStartMonth);
  const [turnover] = (
    await tx.execute<{ amount: string }>(sql`
      select coalesce(sum(case when doc_type = 'credit_note' then -taxable_value else taxable_value end), 0)::text as amount
      from gst_transactions
      where business_id = ${ctx.businessId} and direction = 'outward' and not is_cancelled
        and doc_date >= (${fy.startDate}::date - interval '1 year') and doc_date < ${fy.startDate}::date`)
  ).rows;
  const digitRules = (await configValue<{ rules: Array<{ maxTurnover: number | null; digits: number }> }>(tx, ctx.businessId, "hsn_min_digits", first))?.rules ?? [{ maxTurnover: null, digits: 4 }];
  const hsnMinDigits = digitRules.find((r) => r.maxTurnover === null || dec(turnover!.amount).lte(r.maxTurnover))?.digits ?? 4;
  const noteOriginals = [...new Set(rows.filter((r) => r.originalDocNumber).map((r) => r.originalDocNumber!))];
  const originals = noteOriginals.length
    ? (
        await tx.execute<{ doc_number: string; value: string; supply_type: "intra_state" | "inter_state" }>(sql`
          select doc_number, max(document_value)::text as value, max(supply_type::text) as supply_type
          from gst_transactions
          where business_id = ${ctx.businessId} and doc_type = 'invoice' and doc_number in ${sql`(${sql.join(noteOriginals.map((n) => sql`${n}`), sql`, `)})`}
          group by doc_number`)
      ).rows
    : [];
  const result = buildGstr1({
    gstin: business!.gstin ?? "",
    period,
    b2clThreshold: String(threshold),
    hsnMinDigits,
    rows,
    originalInvoices: new Map(originals.map((o) => [o.doc_number, { value: o.value, supplyType: o.supply_type }])),
  });
  const names = new Map(rows.filter((r) => r.partyGstin && r.partyName).map((r) => [r.partyGstin!, r.partyName!]));
  return { business: business!, result, names, hsnMinDigits, threshold };
}

async function periodStatus(tx: Tx, businessId: string, period: string) {
  const rows = await tx
    .select()
    .from(schema.gstReturnPeriods)
    .where(and(eq(schema.gstReturnPeriods.businessId, businessId), eq(schema.gstReturnPeriods.period, period)));
  const of = (type: "GSTR1" | "GSTR3B") => {
    const r = rows.find((x) => x.returnType === type);
    return { status: r?.status ?? "open", lockedAt: r?.lockedAt ?? null, filedAt: r?.filedAt ?? null, arn: r?.arn ?? null };
  };
  return { GSTR1: of("GSTR1"), GSTR3B: of("GSTR3B") };
}

export const gstModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const currentPeriod = (ctx: RequestCtx) => deps.clock.today(ctx.timeZone).slice(0, 7);

  /** Filing status of the last 12 months. */
  r.get("/gst/periods", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"] } }, async (request) => {
    const ctx = request.ctx;
    const rows = await tenant(ctx, (tx) =>
      tx.select().from(schema.gstReturnPeriods).where(eq(schema.gstReturnPeriods.businessId, ctx.businessId)).orderBy(desc(schema.gstReturnPeriods.period)).limit(48),
    );
    return { data: rows.map(({ businessId: _b, ...x }) => x) };
  });

  r.get("/gst/periods/:period", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], params: PeriodParams } }, async (request) =>
    tenant(request.ctx, async (tx) => ({ period: request.params.period, ...(await periodStatus(tx, request.ctx.businessId, request.params.period)) })),
  );

  /** Lock a month after filing: documents dated in it can then only be corrected with notes. */
  r.post("/gst/periods/:period/lock", { preHandler: guard(deps, "gst.lock_period"), schema: { tags: ["gst"], params: PeriodParams, body: LockBody } }, async (request) => {
    const ctx = request.ctx;
    const { period } = request.params;
    if (period > currentPeriod(ctx)) throw badRequest("GST_PERIOD_IN_FUTURE", {}, "period");
    return tenant(ctx, async (tx) => {
      const now = deps.clock.now().toISOString();
      const p = schema.gstReturnPeriods;
      const [existing] = await tx.select().from(p).where(and(eq(p.businessId, ctx.businessId), eq(p.returnType, request.body.returnType), eq(p.period, period))).for("update");
      if (existing && existing.status !== "open") throw conflict("GST_PERIOD_ALREADY_LOCKED", { status: existing.status });
      if (existing) await tx.update(p).set({ status: "locked", lockedAt: now, lockedBy: ctx.userId }).where(eq(p.id, existing.id));
      else await tx.insert(p).values({ businessId: ctx.businessId, returnType: request.body.returnType, period, status: "locked", lockedAt: now, lockedBy: ctx.userId });
      await audit(tx, ctx, { action: "gst.period_locked", entityType: "gst_period", entityLabel: `${request.body.returnType} ${period}` });
      return { period, ...(await periodStatus(tx, ctx.businessId, period)) };
    });
  });

  r.post("/gst/periods/:period/unlock", { preHandler: guard(deps, "gst.lock_period"), schema: { tags: ["gst"], params: PeriodParams, body: LockBody } }, async (request) => {
    const ctx = request.ctx;
    const { period } = request.params;
    return tenant(ctx, async (tx) => {
      const p = schema.gstReturnPeriods;
      const [existing] = await tx.select().from(p).where(and(eq(p.businessId, ctx.businessId), eq(p.returnType, request.body.returnType), eq(p.period, period))).for("update");
      if (!existing || existing.status === "open") throw conflict("GST_PERIOD_NOT_LOCKED");
      if (existing.status === "filed") throw conflict("GST_PERIOD_FILED");
      await tx.update(p).set({ status: "open", lockedAt: null, lockedBy: null }).where(eq(p.id, existing.id));
      await audit(tx, ctx, { action: "gst.period_unlocked", entityType: "gst_period", entityLabel: `${request.body.returnType} ${period}` });
      return { period, ...(await periodStatus(tx, ctx.businessId, period)) };
    });
  });

  /** Record that the return was filed (ARN from the portal); filing also locks the month. */
  r.post("/gst/periods/:period/filed", { preHandler: guard(deps, "gst.file"), schema: { tags: ["gst"], params: PeriodParams, body: FiledBody } }, async (request) => {
    const ctx = request.ctx;
    const { period } = request.params;
    if (period > currentPeriod(ctx)) throw badRequest("GST_PERIOD_IN_FUTURE", {}, "period");
    return tenant(ctx, async (tx) => {
      const now = deps.clock.now().toISOString();
      const p = schema.gstReturnPeriods;
      const [existing] = await tx.select().from(p).where(and(eq(p.businessId, ctx.businessId), eq(p.returnType, request.body.returnType), eq(p.period, period))).for("update");
      if (existing?.status === "filed") throw conflict("GST_PERIOD_FILED");
      const values = { status: "filed" as const, filedAt: now, arn: request.body.arn, notes: request.body.notes ?? null, lockedAt: existing?.lockedAt ?? now, lockedBy: existing?.lockedBy ?? ctx.userId };
      if (existing) await tx.update(p).set(values).where(eq(p.id, existing.id));
      else await tx.insert(p).values({ businessId: ctx.businessId, returnType: request.body.returnType, period, ...values });
      await audit(tx, ctx, { action: "gst.return_filed", entityType: "gst_period", entityLabel: `${request.body.returnType} ${period}`, changes: { arn: request.body.arn } });
      return { period, ...(await periodStatus(tx, ctx.businessId, period)) };
    });
  });

  /** GSTR-1 preview: tables, document summary and warnings to fix before downloading. */
  r.get("/gst/returns/gstr1", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: z.object({ period: Period }) } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const { business, result, hsnMinDigits, threshold } = await gstr1For(tx, ctx, request.query.period);
      return {
        period: request.query.period,
        gstin: business.gstin,
        version: result.version,
        b2clThreshold: dec(threshold).toFixed(2),
        hsnMinDigits,
        summary: result.summary,
        documents: result.documents,
        warnings: [...(business.gstin ? [] : [{ code: "BUSINESS_GSTIN_MISSING" }]), ...result.warnings],
        status: await periodStatus(tx, ctx.businessId, request.query.period),
      };
    });
  });

  /** GSTR-1 file for the offline tool: JSON (whole return) or one table as CSV. Each download is recorded. */
  r.get("/gst/returns/gstr1/file", { preHandler: guard(deps, "gst.export"), schema: { tags: ["gst"], querystring: FileQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    const out = await tenant(ctx, async (tx) => {
      const { business, result, names } = await gstr1For(tx, ctx, q.period);
      if (!business.gstin) throw conflict("BUSINESS_GSTIN_REQUIRED");
      await tx.insert(schema.gstExports).values({
        businessId: ctx.businessId,
        returnType: "GSTR1",
        period: q.period,
        formatterVersion: q.format === "json" ? result.version : `${result.version}/csv-${q.section}`,
        format: q.format,
        summary: result.summary,
        warnings: result.warnings,
        generatedBy: ctx.userId,
      });
      await audit(tx, ctx, { action: "gst.exported", entityType: "gst_period", entityLabel: `GSTR1 ${q.period}`, changes: { format: q.format, ...(q.format === "csv" ? { section: q.section } : {}) } });
      return { business, result, names };
    });
    const mmyyyy = `${q.period.slice(5, 7)}${q.period.slice(0, 4)}`;
    if (q.format === "json") {
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="GSTR1_${out.business.gstin}_${mmyyyy}.json"`);
      return JSON.stringify(out.result.json);
    }
    const [header, ...rows] = gstr1Csv(out.result, q.section as Gstr1CsvSection, out.names);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${q.section}_${mmyyyy}.csv"`);
    return toCsv(
      header!.map((label, i) => ({ key: String(i), label })),
      rows.map((r) => Object.fromEntries(r.map((v, i) => [String(i), v]))),
    );
  });

  /** GSTR-3B summary for a month (outward tax, ITC, indicative payment). */
  r.get("/gst/returns/gstr3b", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: z.object({ period: Period }) } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => ({
      ...buildGstr3b(request.query.period, await register(tx, ctx.businessId, request.query.period)),
      status: await periodStatus(tx, ctx.businessId, request.query.period),
    }));
  });

  r.get("/gst/exports", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: z.object({ period: Period.optional() }) } }, async (request) => {
    const ctx = request.ctx;
    const e = schema.gstExports;
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: e.id,
          returnType: e.returnType,
          period: e.period,
          formatterVersion: e.formatterVersion,
          format: e.format,
          warnings: sql<number>`jsonb_array_length(${e.warnings})`,
          generatedAt: e.generatedAt,
          generatedBy: sql<string | null>`(select u.name from users u where u.id = "gst_exports"."generated_by")`,
        })
        .from(e)
        .where(and(eq(e.businessId, ctx.businessId), ...(request.query.period ? [eq(e.period, request.query.period)] : [])))
        .orderBy(desc(e.generatedAt))
        .limit(50),
    );
    return { data: rows };
  });
};
