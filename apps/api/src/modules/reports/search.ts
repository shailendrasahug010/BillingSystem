import { SearchQuery } from "@vyapaar/contracts";
import { normalizeIndianMobile } from "@vyapaar/core";
import { sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { can, guard } from "../../lib/access.js";
import { withTenant } from "../../lib/db.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";

/**
 * Global search (Ctrl+K): customers, products, invoices, suppliers and
 * payments in one call. Each section appears only if the caller may view it.
 */
export const searchModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/search", { preHandler: guard(deps), schema: { tags: ["search"], querystring: SearchQuery } }, async (request) => {
    const ctx = request.ctx;
    const { q, limit } = request.query;
    const like = likeContains(q);
    const prefix = `${q.replace(/[\\%_]/g, "\\$&")}%`;
    const mobile = normalizeIndianMobile(q);
    const upper = q.toUpperCase();
    const b = ctx.businessId;
    return withTenant(deps.db, ctx, async (tx) => {
      const out: Record<string, unknown[]> = {};
      if (can(ctx, "customer.view")) {
        out.customers = (
          await tx.execute(sql`
            select id, code, name, business_name as "businessName", mobile, city, balance::text
            from customers
            where business_id = ${b} and deleted_at is null
              and (name ilike ${like} or business_name ilike ${like} or code ilike ${prefix} or gstin = ${upper} or mobile = ${mobile ?? q})
            order by (name ilike ${prefix}) desc, name limit ${limit}`)
        ).rows;
      }
      if (can(ctx, "product.view")) {
        out.products = (
          await tx.execute(sql`
            select p.id, p.code, p.name, p.name_local as "nameLocal", p.selling_price::text as "sellingPrice",
                   coalesce((select sum(qty) from stock_balances sb where sb.product_id = p.id), 0)::text as stock
            from products p
            where p.business_id = ${b} and p.deleted_at is null
              and (p.name ilike ${like} or p.name_local ilike ${like} or p.code ilike ${prefix} or p.sku = ${q}
                   or array_to_string(p.aliases, ' ') ilike ${like}
                   or exists (select 1 from product_barcodes pb where pb.product_id = p.id and pb.barcode = ${q}))
            order by (p.name ilike ${prefix}) desc, p.name limit ${limit}`)
        ).rows;
      }
      if (can(ctx, "invoice.view")) {
        out.invoices = (
          await tx.execute(sql`
            select id, invoice_number as "invoiceNumber", invoice_date::text as "invoiceDate", party_name as "partyName",
                   grand_total::text as "grandTotal", status, payment_status as "paymentStatus"
            from invoices
            where business_id = ${b} and status <> 'draft' and (invoice_number ilike ${like} or party_name ilike ${like})
            order by invoice_date desc, id desc limit ${limit}`)
        ).rows;
      }
      if (can(ctx, "supplier.view")) {
        out.suppliers = (
          await tx.execute(sql`
            select id, code, name, company_name as "companyName", mobile, balance::text
            from suppliers
            where business_id = ${b} and deleted_at is null
              and (name ilike ${like} or company_name ilike ${like} or code ilike ${prefix} or gstin = ${upper} or mobile = ${mobile ?? q})
            order by name limit ${limit}`)
        ).rows;
      }
      if (can(ctx, "payment.view")) {
        out.payments = (
          await tx.execute(sql`
            select id, payment_number as "paymentNumber", payment_date::text as "paymentDate", direction, amount::text, method, status
            from payments
            where business_id = ${b} and (payment_number ilike ${like} or reference_number = ${q})
            order by payment_date desc limit ${limit}`)
        ).rows;
      }
      return { q, ...out };
    });
  });
};
