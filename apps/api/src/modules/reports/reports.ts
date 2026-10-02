import { CollectionReportQuery, OutstandingQuery, PurchaseReportQuery, SalesReportQuery } from "@digitalbahi/contracts";
import { ageDocuments, dec, type OpenDocument, type Permission } from "@digitalbahi/core";
import type { Tx } from "@digitalbahi/db";
import { sql, type SQL } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { assertRange } from "../../lib/period.js";
import { loadLetterhead } from "../../services/letterhead.js";
import { productSalesRows, summariesThrough } from "../../services/sales-daily.js";
import { pdfDate, renderReportPdf } from "../../services/pdf-report.js";
import { renderReportXlsx } from "../../services/xlsx-report.js";
import type { ApiModule } from "../types.js";

export const Format = { format: z.enum(["json", "csv", "pdf", "xlsx"]).default("json") };

/** Date buckets as fixed SQL (never user text). */
const TRUNC: Record<string, SQL> = {
  day: sql`'day'`,
  week: sql`'week'`,
  month: sql`'month'`,
  year: sql`'year'`,
};

export interface Column {
  key: string;
  label: string;
}

/** CSV with formula-injection protection (cells starting with = + - @ are prefixed). */
export function toCsv(columns: Column[], rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))].join("\r\n") + "\r\n";
}

export interface ReportMeta {
  /** Shown at the top of the PDF, e.g. "Sales by customer". */
  title: string;
  from?: string;
  to?: string;
  asOf?: string;
}

/**
 * A report as JSON (the screen), Excel (.xlsx: numbers and dates as such,
 * totals, frozen header), CSV or PDF (letterhead, title, period, table with
 * totals, page numbers). Files need report.export.
 */
export async function sendReport(
  reply: FastifyReply,
  ctx: RequestCtx,
  deps: AppDeps,
  format: "json" | "csv" | "pdf" | "xlsx",
  name: string,
  columns: Column[],
  body: { rows: Array<Record<string, unknown>>; totals?: Record<string, unknown> } & Record<string, unknown>,
  meta: ReportMeta,
  /** Who may take the file; most reports need report.export, some lists the permission that shows them. */
  exportPermission: Permission = "report.export",
) {
  if (format === "json") return body;
  if (!can(ctx, exportPermission)) throw forbidden(exportPermission);
  const period = meta.from && meta.to ? `${pdfDate(meta.from)} – ${pdfDate(meta.to)}` : meta.asOf ? `As of ${pdfDate(meta.asOf)}` : null;
  if (format === "xlsx") {
    const letterhead = await loadLetterhead(deps, ctx);
    const file = await renderReportXlsx({ firm: letterhead.name, title: meta.title, period, columns, rows: body.rows, totals: body.totals ?? null });
    reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("content-disposition", `attachment; filename="${name}.xlsx"`);
    return reply.send(file);
  }
  if (format === "pdf") {
    const pdf = await renderReportPdf({
      letterhead: await loadLetterhead(deps, ctx),
      title: meta.title,
      period,
      generatedAt: new Intl.DateTimeFormat("en-IN", { timeZone: ctx.timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(deps.clock.now()),
      columns,
      rows: body.rows,
      totals: body.totals ?? null,
    });
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `attachment; filename="${name}.pdf"`);
    return reply.send(pdf);
  }
  reply.header("content-type", "text/csv; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="${name}.csv"`);
  // UTF-8 BOM so Excel shows Hindi names correctly.
  return `\ufeff${toCsv(columns, body.rows)}`;
}

const moneyCols = (extra: Column[]): Column[] => [...extra, { key: "taxable", label: "Taxable" }, { key: "tax", label: "Tax" }, { key: "total", label: "Total" }];

export const reportsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  // ---------------------------------------------------------------- sales
  r.get("/reports/sales", { preHandler: guard(deps, "report.view_sales"), schema: { tags: ["reports"], querystring: SalesReportQuery.extend(Format) } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    assertRange(q.from, q.to);
    const b = ctx.businessId;
    const filters: SQL[] = [sql`i.business_id = ${b}`, sql`i.status = 'posted'`, sql`i.invoice_date between ${q.from} and ${q.to}`];
    if (q.customerId) filters.push(sql`i.customer_id = ${q.customerId}`);
    const itemLevel = ["product", "brand", "category"].includes(q.groupBy) || Boolean(q.productId || q.brandId);
    if (q.productId) filters.push(sql`ii.product_id = ${q.productId}`);
    if (q.brandId) filters.push(sql`p.brand_id = ${q.brandId}`);
    const where = sql.join(filters, sql` and `);

    const rows = await tenant(ctx, async (tx) => {
      // By product for every customer: past days from the daily summaries once they are complete, today from the bills.
      const through = q.groupBy === "product" && !q.customerId ? await summariesThrough(tx, b, deps.clock.today(ctx.timeZone)) : null;
      if (through) {
        const only = [...(q.productId ? [sql`s.product_id = ${q.productId}`] : []), ...(q.brandId ? [sql`p.brand_id = ${q.brandId}`] : [])];
        return (
          await tx.execute<{ key: string; label: string; invoices: number; qty: string; taxable: string; tax: string; total: string }>(sql`
            with s as (${productSalesRows(b, q.from, q.to, through)})
            select s.product_id::text as key, max(p.name) as label, sum(s.invoices)::int as invoices, sum(s.qty)::text as qty,
                   sum(s.taxable)::text as taxable, sum(s.tax)::text as tax, sum(s.taxable + s.tax)::text as total
            from s join products p on p.id = s.product_id
            ${only.length ? sql`where ${sql.join(only, sql` and `)}` : sql``}
            group by 1 order by sum(s.taxable) desc`)
        ).rows;
      }
      if (itemLevel) {
        const key = {
          product: { key: sql`ii.product_id::text`, label: sql`max(p.name)` },
          brand: { key: sql`coalesce(p.brand_id::text, '-')`, label: sql`coalesce(max(br.name), 'No brand')` },
          category: { key: sql`coalesce(p.category_id::text, '-')`, label: sql`coalesce(max(pc.name), 'No category')` },
        }[q.groupBy as "product" | "brand" | "category"] ?? { key: sql`date_trunc(${TRUNC[q.groupBy] ?? TRUNC.day!}, i.invoice_date)::date::text`, label: sql`date_trunc(${TRUNC[q.groupBy] ?? TRUNC.day!}, i.invoice_date)::date::text` };
        return (
          await tx.execute<{ key: string; label: string; invoices: number; qty: string; taxable: string; tax: string; total: string }>(sql`
            select ${key.key} as key, ${key.label} as label, count(distinct i.id)::int as invoices, sum(ii.qty_base)::text as qty,
                   sum(ii.taxable_value)::text as taxable, sum(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount)::text as tax,
                   sum(ii.line_total)::text as total
            from invoice_items ii
            join invoices i on i.id = ii.invoice_id
            join products p on p.id = ii.product_id
            left join brands br on br.id = p.brand_id
            left join product_categories pc on pc.id = p.category_id
            where ${where}
            group by 1 order by ${["day", "week", "month", "year"].includes(q.groupBy) ? sql`1` : sql`sum(ii.taxable_value) desc`}`)
        ).rows;
      }
      const key = {
        customer: { key: sql`i.customer_id::text`, label: sql`max(i.party_name)` },
        salesperson: { key: sql`coalesce(i.salesperson_id::text, '-')`, label: sql`coalesce(max(e.name), 'Unassigned')` },
      }[q.groupBy as "customer" | "salesperson"] ?? { key: sql`date_trunc(${TRUNC[q.groupBy]!}, i.invoice_date)::date::text`, label: sql`date_trunc(${TRUNC[q.groupBy]!}, i.invoice_date)::date::text` };
      return (
        await tx.execute<{ key: string; label: string; invoices: number; qty: string | null; taxable: string; tax: string; total: string }>(sql`
          select ${key.key} as key, ${key.label} as label, count(*)::int as invoices, null as qty,
                 sum(i.taxable_total)::text as taxable, sum(i.cgst_total + i.sgst_total + i.igst_total + i.cess_total)::text as tax,
                 sum(i.grand_total)::text as total
          from invoices i
          left join employees e on e.id = i.salesperson_id
          where ${where}
          group by 1 order by ${["customer", "salesperson"].includes(q.groupBy) ? sql`sum(i.grand_total) desc` : sql`1`}`)
      ).rows;
    });
    const out = rows.map((x) => ({
      key: x.key,
      label: x.label,
      invoices: x.invoices,
      ...(x.qty !== null ? { qty: dec(x.qty).toFixed(3) } : {}),
      taxable: dec(x.taxable).toFixed(2),
      tax: dec(x.tax).toFixed(2),
      total: dec(x.total).toFixed(2),
    }));
    const totals = out.reduce((acc, x) => ({ taxable: acc.taxable.plus(x.taxable), tax: acc.tax.plus(x.tax), total: acc.total.plus(x.total) }), { taxable: dec(0), tax: dec(0), total: dec(0) });
    return sendReport(reply, ctx, deps, q.format, `sales-${q.from}-${q.to}`, moneyCols([{ key: "label", label: q.groupBy }, { key: "invoices", label: "Invoices" }, ...(itemLevel ? [{ key: "qty", label: "Qty" }] : [])]), {
      from: q.from,
      to: q.to,
      groupBy: q.groupBy,
      rows: out,
      totals: { taxable: totals.taxable.toFixed(2), tax: totals.tax.toFixed(2), total: totals.total.toFixed(2) },
    }, { title: `Sales by ${q.groupBy}`, from: q.from, to: q.to });
  });

  // ---------------------------------------------------------------- collections
  r.get(
    "/reports/collections",
    { preHandler: guard(deps, "report.view_collection"), schema: { tags: ["reports"], querystring: CollectionReportQuery.extend(Format) } },
    async (request, reply) => {
      const ctx = request.ctx;
      const q = request.query;
      assertRange(q.from, q.to);
      const key =
        q.groupBy === "method"
          ? { key: sql`p.method::text`, label: sql`p.method::text` }
          : q.groupBy === "customer"
            ? { key: sql`p.customer_id::text`, label: sql`max(coalesce(c.business_name, c.name))` }
            : { key: sql`date_trunc(${TRUNC[q.groupBy]!}, p.payment_date)::date::text`, label: sql`date_trunc(${TRUNC[q.groupBy]!}, p.payment_date)::date::text` };
      const rows = await tenant(ctx, async (tx) =>
        (
          await tx.execute<{ key: string; label: string; count: number; amount: string }>(sql`
            select ${key.key} as key, ${key.label} as label, count(*)::int as count, sum(p.amount)::text as amount
            from payments p left join customers c on c.id = p.customer_id
            where p.business_id = ${ctx.businessId} and p.status = 'posted' and p.direction = 'in' and p.payment_date between ${q.from} and ${q.to}
            group by 1 order by ${q.groupBy === "customer" || q.groupBy === "method" ? sql`sum(p.amount) desc` : sql`1`}`)
        ).rows,
      );
      const out = rows.map((x) => ({ key: x.key, label: x.label, count: x.count, amount: dec(x.amount).toFixed(2) }));
      const total = out.reduce((acc, x) => acc.plus(x.amount), dec(0));
      return sendReport(reply, ctx, deps, q.format, `collections-${q.from}-${q.to}`, [{ key: "label", label: q.groupBy }, { key: "count", label: "Receipts" }, { key: "amount", label: "Amount" }], {
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
        rows: out,
        totals: { amount: total.toFixed(2) },
      }, { title: `Collections by ${q.groupBy}`, from: q.from, to: q.to });
    },
  );

  // ---------------------------------------------------------------- purchases
  r.get(
    "/reports/purchases",
    { preHandler: guard(deps, "report.view_purchase"), schema: { tags: ["reports"], querystring: PurchaseReportQuery.extend(Format) } },
    async (request, reply) => {
      const ctx = request.ctx;
      const q = request.query;
      assertRange(q.from, q.to);
      const itemLevel = q.groupBy === "product" || q.groupBy === "brand";
      const rows = await tenant(ctx, async (tx) => {
        const base = sql`p.business_id = ${ctx.businessId} and p.status = 'posted' and p.supplier_invoice_date between ${q.from} and ${q.to}`;
        if (itemLevel) {
          const key = q.groupBy === "product" ? { key: sql`pi.product_id::text`, label: sql`max(pi.product_name)` } : { key: sql`coalesce(pr.brand_id::text, '-')`, label: sql`coalesce(max(br.name), 'No brand')` };
          return (
            await tx.execute<{ key: string; label: string; bills: number; taxable: string; tax: string; total: string }>(sql`
              select ${key.key} as key, ${key.label} as label, count(distinct p.id)::int as bills, sum(pi.taxable_value)::text as taxable,
                     sum(pi.cgst_amount + pi.sgst_amount + pi.igst_amount + pi.cess_amount)::text as tax, sum(pi.line_total)::text as total
              from purchase_items pi join purchases p on p.id = pi.purchase_id
              join products pr on pr.id = pi.product_id left join brands br on br.id = pr.brand_id
              where ${base} group by 1 order by sum(pi.taxable_value) desc`)
          ).rows;
        }
        const key =
          q.groupBy === "supplier"
            ? { key: sql`p.supplier_id::text`, label: sql`max(p.party_name)` }
            : { key: sql`date_trunc(${TRUNC[q.groupBy]!}, p.supplier_invoice_date)::date::text`, label: sql`date_trunc(${TRUNC[q.groupBy]!}, p.supplier_invoice_date)::date::text` };
        return (
          await tx.execute<{ key: string; label: string; bills: number; taxable: string; tax: string; total: string }>(sql`
            select ${key.key} as key, ${key.label} as label, count(*)::int as bills, sum(p.taxable_total)::text as taxable,
                   sum(p.cgst_total + p.sgst_total + p.igst_total + p.cess_total)::text as tax, sum(p.grand_total)::text as total
            from purchases p where ${base}
            group by 1 order by ${q.groupBy === "supplier" ? sql`sum(p.grand_total) desc` : sql`1`}`)
        ).rows;
      });
      const out = rows.map((x) => ({ key: x.key, label: x.label, bills: x.bills, taxable: dec(x.taxable).toFixed(2), tax: dec(x.tax).toFixed(2), total: dec(x.total).toFixed(2) }));
      const total = out.reduce((acc, x) => acc.plus(x.total), dec(0));
      return sendReport(reply, ctx, deps, q.format, `purchases-${q.from}-${q.to}`, moneyCols([{ key: "label", label: q.groupBy }, { key: "bills", label: "Bills" }]), {
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
        rows: out,
        totals: { total: total.toFixed(2) },
      }, { title: `Purchases by ${q.groupBy}`, from: q.from, to: q.to });
    },
  );

  // ---------------------------------------------------------------- outstanding with aging
  r.get(
    "/reports/outstanding",
    { preHandler: guard(deps, "report.view_outstanding"), schema: { tags: ["reports"], querystring: OutstandingQuery.extend(Format) } },
    async (request, reply) => {
      const ctx = request.ctx;
      const q = request.query;
      const today = deps.clock.today(ctx.timeZone);
      const asOf = q.asOf ?? today;
      if (asOf > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "asOf");
      const edges = q.buckets.split(",").map(Number);
      if (edges.some((e, i) => i > 0 && e <= edges[i - 1]!)) throw badRequest("INVALID_SETTING_VALUE", { key: "buckets" }, "buckets");
      const docs = await tenant(ctx, async (tx) =>
        q.party === "customer"
          ? (
              await tx.execute<{ party_id: string; name: string; mobile: string | null; id: string; number: string; date: string; due_date: string; balance: string }>(sql`
                select c.id as party_id, coalesce(c.business_name, c.name) as name, c.mobile, i.id, i.invoice_number as number, i.invoice_date::text as date,
                       coalesce(i.due_date, i.invoice_date)::text as due_date, i.balance_due::text as balance
                from invoices i join customers c on c.id = i.customer_id
                where i.business_id = ${ctx.businessId} and i.status = 'posted' and i.balance_due > 0 and i.invoice_date <= ${asOf}`)
            ).rows
          : (
              await tx.execute<{ party_id: string; name: string; mobile: string | null; id: string; number: string; date: string; due_date: string; balance: string }>(sql`
                select s.id as party_id, s.name, s.mobile, p.id, p.supplier_invoice_number as number, p.supplier_invoice_date::text as date,
                       coalesce(p.due_date, p.supplier_invoice_date)::text as due_date, p.balance_due::text as balance
                from purchases p join suppliers s on s.id = p.supplier_id
                where p.business_id = ${ctx.businessId} and p.status = 'posted' and p.balance_due > 0 and p.supplier_invoice_date <= ${asOf}`)
            ).rows,
      );
      const byParty = new Map<string, { name: string; mobile: string | null; docs: OpenDocument[] }>();
      for (const d of docs) {
        const entry = byParty.get(d.party_id) ?? { name: d.name, mobile: d.mobile, docs: [] };
        entry.docs.push({ id: d.id, number: d.number, date: d.date, dueDate: d.due_date, balance: d.balance });
        byParty.set(d.party_id, entry);
      }
      const labels = ageDocuments([], { asOf, edges, basis: q.basis }).buckets.map((x) => x.label);
      const rows = [...byParty].map(([partyId, p]) => {
        const aged = ageDocuments(p.docs, { asOf, edges, basis: q.basis });
        const oldest = p.docs.reduce((m, d) => (d.dueDate < m ? d.dueDate : m), p.docs[0]!.dueDate);
        return {
          partyId,
          name: p.name,
          mobile: p.mobile,
          documents: p.docs.length,
          total: aged.total.toFixed(2),
          notDue: aged.notDue.toFixed(2),
          ...Object.fromEntries(aged.buckets.map((x) => [`d${x.label}`, x.amount.toFixed(2)])),
          buckets: aged.buckets.map((x) => ({ label: x.label, amount: x.amount.toFixed(2), count: x.count })),
          oldestDueDate: oldest,
        };
      });
      rows.sort((a, b) => Number(b.total) - Number(a.total));
      const totals = { total: rows.reduce((acc, x) => acc.plus(x.total), dec(0)).toFixed(2), notDue: rows.reduce((acc, x) => acc.plus(x.notDue), dec(0)).toFixed(2) };
      return sendReport(
        reply,
        ctx,
        deps,
        q.format,
        `outstanding-${q.party}-${asOf}`,
        [
          { key: "name", label: q.party === "customer" ? "Customer" : "Supplier" },
          { key: "mobile", label: "Mobile" },
          { key: "documents", label: "Bills" },
          { key: "notDue", label: "Not due" },
          ...labels.map((l) => ({ key: `d${l}`, label: `${l} days` })),
          { key: "total", label: "Total" },
        ],
        { party: q.party, asOf, basis: q.basis, bucketLabels: labels, rows, totals },
        { title: q.party === "customer" ? "Customer outstanding" : "Supplier outstanding", asOf },
      );
    },
  );

  // ---------------------------------------------------------------- GST summary for a return period
  r.get(
    "/reports/gst",
    { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) } },
    async (request) => {
      const ctx = request.ctx;
      const period = request.query.period;
      return tenant(ctx, async (tx) => {
        const b = ctx.businessId;
        const [threshold] = (
          await tx.execute<{ amount: string }>(sql`
            select (value->>'amount') as amount from gst_config
            where key = 'b2cl_invoice_threshold' and effective_from <= ${`${period}-01`} and (business_id is null or business_id = ${b})
            order by business_id nulls last, effective_from desc limit 1`)
        ).rows;
        const limit = threshold?.amount ?? "100000";
        const signedHeads = sql`sum(taxable_value * sign)::text as taxable, sum(cgst_amount * sign)::text as cgst, sum(sgst_amount * sign)::text as sgst, sum(igst_amount * sign)::text as igst, sum(cess_amount * sign)::text as cess`;
        const heads = sql`sum(taxable_value)::text as taxable, sum(cgst_amount)::text as cgst, sum(sgst_amount)::text as sgst, sum(igst_amount)::text as igst, sum(cess_amount)::text as cess`;
        const outward = (
          await tx.execute<{ section: string; gst_rate: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string; documents: number }>(sql`
            select case
                     when party_gstin is not null then 'B2B'
                     when supply_type = 'inter_state' and document_value > ${limit}::numeric then 'B2CL'
                     else 'B2CS' end as section,
                   gst_rate, count(distinct doc_id)::int as documents, ${heads}
            from gst_transactions
            where business_id = ${b} and direction = 'outward' and doc_type <> 'credit_note' and return_period = ${period} and not is_cancelled
            group by 1, 2 order by 1, 2`)
        ).rows;
        const inward = (
          await tx.execute<{ itc: string; reverse_charge: boolean; gst_rate: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string; documents: number }>(sql`
            select coalesce(itc_eligibility::text, 'eligible') as itc, is_reverse_charge as reverse_charge, gst_rate,
                   count(distinct doc_id)::int as documents, ${heads}
            from gst_transactions
            where business_id = ${b} and direction = 'inward' and doc_type not in ('debit_note', 'purchase_credit_note') and return_period = ${period} and not is_cancelled
            group by 1, 2, 3 order by 1, 2, 3`)
        ).rows;
        // Sales returns (credit notes, CDNR / CDNUR) and purchase returns (our debit notes to suppliers).
        const notes = (
          await tx.execute<{ direction: string; doc_type: string; registered: boolean; itc: string | null; gst_rate: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string; documents: number }>(sql`
            select direction::text, doc_type::text, party_gstin is not null as registered, itc_eligibility::text as itc, gst_rate,
                   count(distinct doc_id)::int as documents, ${heads}
            from gst_transactions
            where business_id = ${b} and doc_type in ('credit_note', 'debit_note', 'purchase_credit_note') and return_period = ${period} and not is_cancelled
            group by 1, 2, 3, 4, 5 order by 1, 2, 3, 5`)
        ).rows;
        const hsn = (
          await tx.execute<{ hsn_code: string | null; uqc: string | null; gst_rate: string; qty: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string }>(sql`
            select hsn_code, uqc, gst_rate, sum(qty * sign)::text as qty, ${signedHeads}
            from (select *, case when doc_type = 'credit_note' then -1 else 1 end as sign from gst_transactions) g
            where business_id = ${b} and direction = 'outward' and return_period = ${period} and not is_cancelled
            group by 1, 2, 3 order by 1, 3`)
        ).rows;
        const [cancelled] = (
          await tx.execute<{ n: number }>(sql`select count(distinct doc_id)::int as n from gst_transactions where business_id = ${b} and direction = 'outward' and return_period = ${period} and is_cancelled`)
        ).rows;
        const [lock] = (
          await tx.execute<{ status: string }>(sql`select status::text from gst_return_periods where business_id = ${b} and return_type = 'GSTR1' and period = ${period}`)
        ).rows;
        const m = (v: string | null | undefined) => dec(v ?? 0).toFixed(2);
        const tax = (rows: Array<{ cgst: string; sgst: string; igst: string; cess: string }>) =>
          rows.reduce((acc, x) => ({ cgst: acc.cgst.plus(x.cgst), sgst: acc.sgst.plus(x.sgst), igst: acc.igst.plus(x.igst), cess: acc.cess.plus(x.cess) }), {
            cgst: dec(0),
            sgst: dec(0),
            igst: dec(0),
            cess: dec(0),
          });
        const minus = (a: ReturnType<typeof tax>, b: ReturnType<typeof tax>) => ({ cgst: a.cgst.minus(b.cgst), sgst: a.sgst.minus(b.sgst), igst: a.igst.minus(b.igst), cess: a.cess.minus(b.cess) });
        const outTax = minus(tax(outward), tax(notes.filter((x) => x.direction === "outward")));
        const itc = minus(tax(inward.filter((x) => x.itc !== "ineligible")), tax(notes.filter((x) => x.direction === "inward" && x.itc !== "ineligible")));
        return {
          period,
          status: lock?.status ?? "open",
          b2clThreshold: m(limit),
          outward: outward.map((x) => ({ section: x.section, gstRate: x.gst_rate, documents: x.documents, taxable: m(x.taxable), cgst: m(x.cgst), sgst: m(x.sgst), igst: m(x.igst), cess: m(x.cess) })),
          inward: inward.map((x) => ({ itcEligibility: x.itc, reverseCharge: x.reverse_charge, gstRate: x.gst_rate, documents: x.documents, taxable: m(x.taxable), cgst: m(x.cgst), sgst: m(x.sgst), igst: m(x.igst), cess: m(x.cess) })),
          notes: notes.map((x) => ({
            kind: x.doc_type as "credit_note" | "debit_note" | "purchase_credit_note",
            registered: x.registered,
            gstRate: x.gst_rate,
            documents: x.documents,
            taxable: m(x.taxable),
            cgst: m(x.cgst),
            sgst: m(x.sgst),
            igst: m(x.igst),
            cess: m(x.cess),
          })),
          hsnSummary: hsn.map((x) => ({ hsnCode: x.hsn_code, uqc: x.uqc, gstRate: x.gst_rate, qty: dec(x.qty).toFixed(3), taxable: m(x.taxable), cgst: m(x.cgst), sgst: m(x.sgst), igst: m(x.igst), cess: m(x.cess) })),
          cancelledDocuments: cancelled!.n,
          /** Indicative only: output tax less eligible ITC, per head, before cross-utilisation rules. */
          estimate: {
            outputTax: { cgst: m(outTax.cgst.toString()), sgst: m(outTax.sgst.toString()), igst: m(outTax.igst.toString()), cess: m(outTax.cess.toString()) },
            eligibleItc: { cgst: m(itc.cgst.toString()), sgst: m(itc.sgst.toString()), igst: m(itc.igst.toString()), cess: m(itc.cess.toString()) },
          },
        };
      });
    },
  );
};
