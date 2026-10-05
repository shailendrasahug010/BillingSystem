import { match2b, monthBounds, parseGstr2b, type BookBill } from "@digitalbahi/core";
import { schema } from "@digitalbahi/db";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { withTenant } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import type { ApiModule } from "../types.js";

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** How far back a bill on the statement is looked for in the books (suppliers report old bills late). */
const LOOK_BACK_MONTHS = 12;

/** The first day of the month so many months before. */
const monthsBefore = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 10);
};

/**
 * GSTR-2B matching: the statement's JSON file, from the GST portal, against
 * the purchase bills entered. Nothing is kept: the file is read, matched and
 * the result returned.
 */
export const gstr2bModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/gst/gstr2b/match",
    {
      preHandler: guard(deps, "gst.view"),
      bodyLimit: 25 * 1024 * 1024,
      schema: { tags: ["gst"], querystring: z.strictObject({ period: Period.optional() }), body: z.record(z.string(), z.unknown()) },
    },
    async (request) => {
      const ctx = request.ctx;
      let parsed;
      try {
        parsed = parseGstr2b(request.body);
      } catch {
        throw badRequest("GSTR2B_NOT_RECOGNISED", {}, "file");
      }
      const month = parsed.period ?? request.query.period;
      if (!month) throw badRequest("GSTR2B_NO_PERIOD", {}, "period");
      const p = schema.purchases;
      return withTenant(deps.db, ctx, async (tx) => {
        const [business] = await tx.select({ gstin: schema.businesses.gstin }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
        const rows = await tx
          .select({
            id: p.id,
            supplierGstin: p.partyGstin,
            supplierName: p.partyName,
            number: p.supplierInvoiceNumber,
            date: p.supplierInvoiceDate,
            value: p.grandTotal,
            taxable: p.taxableTotal,
            igst: p.igstTotal,
            cgst: p.cgstTotal,
            sgst: p.sgstTotal,
            cess: p.cessTotal,
          })
          .from(p)
          .where(
            and(
              eq(p.businessId, ctx.businessId),
              eq(p.status, "posted"),
              isNotNull(p.partyGstin),
              gte(p.supplierInvoiceDate, monthsBefore(month, LOOK_BACK_MONTHS)),
              lte(p.supplierInvoiceDate, monthBounds(month).end),
            ),
          );
        const books: BookBill[] = rows.map((b) => ({
          id: b.id,
          supplierGstin: b.supplierGstin!,
          supplierName: b.supplierName,
          number: b.number,
          date: b.date,
          value: Number(b.value),
          taxable: Number(b.taxable),
          igst: Number(b.igst),
          cgst: Number(b.cgst),
          sgst: Number(b.sgst),
          cess: Number(b.cess),
        }));
        const result = match2b(parsed, books, month);
        // Suppliers already in the list, by GSTIN: a bill not entered opens a purchase for them.
        const gstins = [...new Set(result.rows.filter((x) => x.status === "not_in_books").map((x) => x.supplierGstin))];
        const known = gstins.length
          ? await tx
              .select({ id: schema.suppliers.id, gstin: sql<string>`upper(${schema.suppliers.gstin})` })
              .from(schema.suppliers)
              .where(and(eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt), inArray(sql`upper(${schema.suppliers.gstin})`, gstins)))
          : [];
        return {
          period: month,
          gstin: parsed.gstin,
          /** The statement is for another GSTIN than the business's. */
          otherGstin: Boolean(parsed.gstin && business?.gstin && parsed.gstin !== business.gstin.toUpperCase()),
          notes: parsed.notes,
          summary: result.summary,
          rows: result.rows,
          suppliers: Object.fromEntries(known.map((s) => [s.gstin, s.id])),
        };
      });
    },
  );
};
