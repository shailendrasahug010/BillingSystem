import {
  CustomerBody,
  CustomerCategoryBody,
  CustomerListQuery,
  CustomerPatch,
  LedgerQuery,
  patchOf,
  RouteBody,
  SupplierBody,
  SupplierListQuery,
  SupplierPatch,
} from "@digitalbahi/contracts";
import { dec, financialYearOf, normalizeIndianMobile, stateCodeFromGstin, validateGstin, validatePan } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextMasterCode } from "../../services/numbering.js";
import { assertOwned } from "../../services/owned.js";
import { postPartyEntry } from "../../services/party-ledger.js";
import { likeContains } from "../catalog/products.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
type PartyKind = "customer" | "supplier";

interface PartyTaxFields {
  stateCode?: string | undefined;
  gstin?: string | null | undefined;
  pan?: string | null | undefined;
  mobile?: string | null | undefined;
  altMobile?: string | null | undefined;
  gstRegistration?: string | undefined;
  email?: string | null | undefined;
}

const NEEDS_GSTIN = new Set(["regular", "composition", "sez"]);

/** State, GSTIN (checksum + state), PAN and mobile checks shared by customers and suppliers. */
async function normaliseParty<T extends PartyTaxFields>(tx: Tx, body: T, current?: PartyTaxFields): Promise<T> {
  const out = { ...body };
  const stateCode = body.stateCode ?? current?.stateCode;
  if (body.stateCode) {
    const [st] = await tx.select({ code: schema.states.code }).from(schema.states).where(eq(schema.states.code, body.stateCode));
    if (!st) throw badRequest("INVALID_STATE_CODE", {}, "stateCode");
  }
  const gstin = body.gstin !== undefined ? body.gstin : current?.gstin;
  if (body.gstin) {
    const issues = validateGstin(body.gstin);
    if (issues.length) throw badRequest("INVALID_GSTIN", { issue: issues[0]! }, "gstin");
  }
  if (gstin && stateCode && stateCodeFromGstin(gstin) !== stateCode) {
    throw badRequest("GSTIN_STATE_MISMATCH", { gstinState: stateCodeFromGstin(gstin) }, "gstin");
  }
  if (body.pan && validatePan(body.pan).length) throw badRequest("INVALID_PAN", {}, "pan");
  if (body.gstin && !body.pan) out.pan = body.gstin.slice(2, 12);
  for (const field of ["mobile", "altMobile"] as const) {
    const raw = body[field];
    if (raw) {
      const m = normalizeIndianMobile(raw);
      if (!m) throw badRequest("INVALID_MOBILE", {}, field);
      out[field] = m;
    }
  }
  if (body.email) out.email = body.email.toLowerCase();
  const registration = body.gstRegistration ?? current?.gstRegistration;
  if (registration && NEEDS_GSTIN.has(registration) && !gstin) throw badRequest("GSTIN_REQUIRED_FOR_B2B", {}, "gstin");
  return out;
}

/** Same mobile or GSTIN already on file: returned as a hint, never a hard error. */
async function possibleDuplicates(tx: Tx, kind: PartyKind, businessId: string, party: { id?: string; mobile?: string | null; gstin?: string | null }) {
  const table = kind === "customer" ? schema.customers : schema.suppliers;
  const match: SQL[] = [];
  if (party.mobile) match.push(eq(table.mobile, party.mobile));
  if (party.gstin) match.push(eq(table.gstin, party.gstin));
  if (!match.length) return [];
  return tx
    .select({ id: table.id, code: table.code, name: table.name, mobile: table.mobile, gstin: table.gstin })
    .from(table)
    .where(and(eq(table.businessId, businessId), isNull(table.deletedAt), or(...match), ...(party.id ? [ne(table.id, party.id)] : [])))
    .limit(5);
}

async function codeFor(tx: Tx, deps: AppDeps, ctx: RequestCtx, kind: PartyKind, given?: string): Promise<string> {
  if (given) return given.toUpperCase();
  const table = kind === "customer" ? schema.customers : schema.suppliers;
  return nextMasterCode(tx, ctx.businessId, kind, deps.clock.today(ctx.timeZone), async (c) => {
    const [x] = await tx.select({ id: table.id }).from(table).where(and(eq(table.businessId, ctx.businessId), eq(table.code, c), isNull(table.deletedAt)));
    return Boolean(x);
  });
}

/** Statement for a period: opening balance, entries with running balance, closing balance. */
async function partyLedger(tx: Tx, ctx: RequestCtx, kind: PartyKind, id: string, from: string, to: string) {
  const col = kind === "customer" ? sql`customer_id` : sql`supplier_id`;
  // Customers: receivable (debit - credit). Suppliers: payable (credit - debit).
  const sign = kind === "customer" ? sql`debit - credit` : sql`credit - debit`;
  const [opening] = (
    await tx.execute<{ amount: string }>(sql`
      select coalesce(sum(${sign}), 0)::text as amount from party_ledger_entries
      where business_id = ${ctx.businessId} and ${col} = ${id} and entry_date < ${from}`)
  ).rows;
  const entries = (
    await tx.execute<{ id: number; entry_date: string; doc_type: string; doc_id: string | null; doc_number: string | null; debit: string; credit: string; narration: string | null }>(sql`
      select id, entry_date::text, doc_type, doc_id, doc_number, debit, credit, narration from party_ledger_entries
      where business_id = ${ctx.businessId} and ${col} = ${id} and entry_date between ${from} and ${to}
      order by entry_date, id`)
  ).rows;
  let running = dec(opening!.amount);
  const lines = entries.map((e) => {
    running = kind === "customer" ? running.plus(e.debit).minus(e.credit) : running.plus(e.credit).minus(e.debit);
    return {
      id: e.id,
      date: e.entry_date,
      docType: e.doc_type,
      docId: e.doc_id,
      docNumber: e.doc_number,
      debit: e.debit,
      credit: e.credit,
      narration: e.narration,
      balance: running.toFixed(2),
    };
  });
  const totals = entries.reduce((acc, e) => ({ debit: acc.debit.plus(e.debit), credit: acc.credit.plus(e.credit) }), { debit: dec(0), credit: dec(0) });
  return {
    from,
    to,
    opening: dec(opening!.amount).toFixed(2),
    entries: lines,
    totalDebit: totals.debit.toFixed(2),
    totalCredit: totals.credit.toFixed(2),
    closing: running.toFixed(2),
  };
}

type CustomerRowDb = {
  id: string;
  code: string;
  name: string;
  business_name: string | null;
  customer_type: string;
  mobile: string | null;
  city: string | null;
  gstin: string | null;
  balance: string;
  credit_limit: string | null;
  credit_days: number;
  route_id: string | null;
  state_code: string;
  address_line1: string | null;
  pincode: string | null;
  price_level_id: string | null;
  category_id: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  overdue: string;
  gst_registration: string;
};

/**
 * Customers as the list (and the device's copy) shows them, with what is
 * overdue on `today`. `rest` is the WHERE condition on `c`, with any ORDER BY
 * and LIMIT after it.
 */
export async function customerRows(tx: Tx, today: string, rest: SQL) {
  const rows = (
    await tx.execute<CustomerRowDb>(sql`
      select c.id, c.code, c.name, c.business_name, c.customer_type, c.gst_registration::text, c.mobile, c.city, c.gstin, c.balance, c.credit_limit,
             c.credit_days, c.route_id, c.state_code, c.address_line1, c.pincode, c.price_level_id, c.category_id,
             c.is_active, c.version, c.created_at, coalesce(od.amount, 0)::text as overdue
      from customers c
      left join lateral (
        select sum(i.balance_due) as amount from invoices i
        where i.customer_id = c.id and i.status = 'posted' and i.balance_due > 0 and i.due_date < ${today}
      ) od on true
      where ${rest}`)
  ).rows;
  return rows.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    businessName: c.business_name,
    customerType: c.customer_type,
    /** regular, consumer, sez, overseas…: exports and supplies to SEZ are billed differently. */
    gstRegistration: c.gst_registration,
    mobile: c.mobile,
    city: c.city,
    gstin: c.gstin,
    balance: c.balance,
    overdue: c.overdue,
    creditLimit: c.credit_limit,
    creditDays: c.credit_days,
    routeId: c.route_id,
    stateCode: c.state_code,
    addressLine1: c.address_line1,
    pincode: c.pincode,
    priceLevelId: c.price_level_id,
    categoryId: c.category_id,
    isActive: c.is_active,
    /** For If-Match on edits (an edit made offline is checked against it). */
    version: c.version,
    createdAt: new Date(c.created_at).toISOString(),
  }));
}

/** Suppliers as the list (and the device's copy) shows them. */
export function supplierRows(tx: Tx, where: SQL | undefined) {
  const s = schema.suppliers;
  return tx
    .select({
      id: s.id,
      code: s.code,
      name: s.name,
      companyName: s.companyName,
      mobile: s.mobile,
      city: s.city,
      gstin: s.gstin,
      stateCode: s.stateCode,
      gstRegistration: s.gstRegistration,
      balance: s.balance,
      creditDays: s.creditDays,
      isActive: s.isActive,
    })
    .from(s)
    .where(where);
}

export const partiesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const periodOf = (ctx: RequestCtx, q: { from?: string | undefined; to?: string | undefined }) => {
    const today = deps.clock.today(ctx.timeZone);
    const from = q.from ?? financialYearOf(today).startDate;
    const to = q.to ?? today;
    if (to < from) throw badRequest("INVALID_PERIOD", {}, "to");
    return { from, to };
  };

  // ================================================================ customers
  async function customerDetail(tx: Tx, ctx: RequestCtx, id: string) {
    const [c] = await tx
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.id, id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
    if (!c) throw notFound("customer");
    const today = deps.clock.today(ctx.timeZone);
    const [s] = (
      await tx.execute<{
        overdue: string;
        open_invoices: number;
        last_invoice_date: string | null;
        total_sales: string;
        invoice_count: number;
        last_payment_date: string | null;
      }>(sql`
        select
          coalesce(sum(i.balance_due) filter (where i.due_date < ${today} and i.balance_due > 0), 0)::text as overdue,
          (count(*) filter (where i.balance_due > 0))::int as open_invoices,
          max(i.invoice_date)::text as last_invoice_date,
          coalesce(sum(i.grand_total), 0)::text as total_sales,
          count(*)::int as invoice_count,
          (select max(p.payment_date)::text from payments p
            where p.customer_id = ${id} and p.direction = 'in' and p.status = 'posted') as last_payment_date
        from invoices i
        where i.business_id = ${ctx.businessId} and i.customer_id = ${id} and i.status = 'posted'`)
    ).rows;
    const { businessId: _b, deletedAt: _d, deletedBy: _db, ...rest } = c;
    return {
      ...rest,
      summary: {
        balance: c.balance,
        overdue: s!.overdue,
        openInvoices: s!.open_invoices,
        invoiceCount: s!.invoice_count,
        totalSales: s!.total_sales,
        lastInvoiceDate: s!.last_invoice_date,
        lastPaymentDate: s!.last_payment_date,
        creditAvailable: c.creditLimit === null ? null : dec(c.creditLimit).minus(c.balance).toFixed(2),
      },
    };
  }

  r.get("/customers", { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"], querystring: CustomerListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const today = deps.clock.today(ctx.timeZone);
    const where: SQL[] = [sql`c.business_id = ${ctx.businessId}`, sql`c.deleted_at is null`];
    if (q.active !== "all") where.push(sql`c.is_active = ${q.active === "true"}`);
    if (q.type !== "all") where.push(sql`c.customer_type = ${q.type}`);
    if (q.routeId) where.push(sql`c.route_id = ${q.routeId}`);
    if (q.outstanding === "yes") where.push(sql`c.balance > 0`);
    if (q.outstanding === "overdue") where.push(sql`coalesce(od.amount, 0) > 0`);
    if (q.q) {
      const like = likeContains(q.q);
      const mobile = normalizeIndianMobile(q.q);
      where.push(sql`(c.name ilike ${like} or c.business_name ilike ${like} or c.code ilike ${like} or c.gstin = ${q.q.toUpperCase()}
        or c.mobile = ${mobile ?? q.q} or c.city ilike ${like})`);
    }
    const order = {
      name: { by: sql`c.name asc, c.id asc`, after: sql`(c.name, c.id) > (${String(cursor?.v)}, ${cursor?.id ?? null}::uuid)` },
      outstanding: { by: sql`c.balance desc, c.id desc`, after: sql`(c.balance, c.id) < (${String(cursor?.v)}::numeric, ${cursor?.id ?? null}::uuid)` },
      recent: { by: sql`c.created_at desc, c.id desc`, after: sql`(c.created_at, c.id) < (${String(cursor?.v)}::timestamptz, ${cursor?.id ?? null}::uuid)` },
    }[q.sort];
    if (cursor) where.push(order.after);
    const data = await tenant(ctx, (tx) => customerRows(tx, today, sql`${sql.join(where, sql` and `)} order by ${order.by} limit ${q.limit + 1}`));
    return page(data, q.limit, (c) => ({ v: q.sort === "name" ? c.name : q.sort === "outstanding" ? c.balance : c.createdAt, id: c.id }));
  });

  r.get("/customers/:id", { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => customerDetail(tx, request.ctx, request.params.id)),
  );

  /**
   * An Idempotency-Key (a UUID made on the device) becomes the customer's id,
   * so a customer added offline can be billed at once and the bills sync
   * after it; sending it again returns the same customer.
   */
  r.post("/customers", { preHandler: guard(deps, "customer.create"), schema: { tags: ["customers"], body: CustomerBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const key = request.headers["idempotency-key"];
    const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
    if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
    const result = await tenant(ctx, async (tx) => {
      if (clientId) {
        const [existing] = await tx
          .select({ id: schema.customers.id })
          .from(schema.customers)
          .where(and(eq(schema.customers.id, clientId), eq(schema.customers.businessId, ctx.businessId)));
        if (existing) return { replay: true, detail: { ...(await customerDetail(tx, ctx, existing.id)), duplicates: [] } };
      }
      const raw = request.body;
      if (raw.customerType === "b2b" && !raw.gstin) throw badRequest("GSTIN_REQUIRED_FOR_B2B", {}, "gstin");
      const body = await normaliseParty(tx, { ...raw, gstRegistration: raw.gstRegistration ?? (raw.gstin ? "regular" : "consumer") });
      await assertOwned(tx, schema.priceLevels, ctx.businessId, body.priceLevelId, "priceLevelId");
      await assertOwned(tx, schema.customerCategories, ctx.businessId, body.categoryId, "categoryId");
      await assertOwned(tx, schema.salesRoutes, ctx.businessId, body.routeId, "routeId");
      await assertOwned(tx, schema.employees, ctx.businessId, body.salesRepId, "salesRepId");
      const duplicates = await possibleDuplicates(tx, "customer", ctx.businessId, body);
      const code = await codeFor(tx, deps, ctx, "customer", body.code);
      const id = clientId ?? uuidv7();
      const today = deps.clock.today(ctx.timeZone);
      const inserted = await tx
        .insert(schema.customers)
        .values({
          ...body,
          id,
          code,
          businessId: ctx.businessId,
          openingBalanceDate: today,
          balance: "0",
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .onConflictDoNothing({ target: schema.customers.id })
        .returning({ id: schema.customers.id });
      // The id is taken by a row this business cannot see: not a key this device made for it.
      if (inserted.length === 0) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
      if (dec(body.openingBalance).gt(0)) {
        await postPartyEntry(tx, {
          businessId: ctx.businessId,
          party: { type: "customer", id },
          date: today,
          docType: "opening",
          docId: id,
          docNumber: code,
          ...(body.openingBalanceSide === "debit" ? { debit: body.openingBalance } : { credit: body.openingBalance }),
          narration: "Opening balance",
          userId: ctx.userId,
        });
      }
      await audit(tx, ctx, { action: "customer.created", entityType: "customer", entityId: id, entityLabel: `${code} ${body.name}` });
      return { replay: false, detail: { ...(await customerDetail(tx, ctx, id)), duplicates } };
    });
    if (result.replay) reply.header("idempotent-replay", "true");
    return reply.code(result.replay ? 200 : 201).send(result.detail);
  });

  r.patch("/customers/:id", { preHandler: guard(deps, "customer.update"), schema: { tags: ["customers"], params: IdParams, body: CustomerPatch } }, async (request) => {
    const ctx = request.ctx;
    const expectedVersion = request.headers["if-match"] ? Number(request.headers["if-match"]) : null;
    return tenant(ctx, async (tx) => {
      const [c] = await tx
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.id, request.params.id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)))
        .for("update");
      if (!c) throw notFound("customer");
      if (expectedVersion !== null && expectedVersion !== c.version) throw conflict("VERSION_CONFLICT", { current: c.version });
      const type = request.body.customerType ?? c.customerType;
      const gstin = request.body.gstin !== undefined ? request.body.gstin : c.gstin;
      if (type === "b2b" && !gstin) throw badRequest("GSTIN_REQUIRED_FOR_B2B", {}, "gstin");
      const body = await normaliseParty(tx, request.body, c);
      await assertOwned(tx, schema.priceLevels, ctx.businessId, body.priceLevelId, "priceLevelId");
      await assertOwned(tx, schema.customerCategories, ctx.businessId, body.categoryId, "categoryId");
      await assertOwned(tx, schema.salesRoutes, ctx.businessId, body.routeId, "routeId");
      await assertOwned(tx, schema.employees, ctx.businessId, body.salesRepId, "salesRepId");
      if (body.code) body.code = body.code.toUpperCase();
      const changes = diff(c, body);
      await tx
        .update(schema.customers)
        .set({ ...body, updatedBy: ctx.userId, version: c.version + 1 })
        .where(eq(schema.customers.id, c.id));
      if (Object.keys(changes).length) {
        await audit(tx, ctx, { action: "customer.updated", entityType: "customer", entityId: c.id, entityLabel: `${c.code} ${body.name ?? c.name}`, changes });
      }
      return customerDetail(tx, ctx, c.id);
    });
  });

  r.delete("/customers/:id", { preHandler: guard(deps, "customer.delete"), schema: { tags: ["customers"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [c] = await tx
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.id, request.params.id), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)))
        .for("update");
      if (!c) throw notFound("customer");
      if (!dec(c.balance).isZero()) throw conflict("PARTY_HAS_BALANCE", { balance: c.balance });
      await tx
        .update(schema.customers)
        .set({ deletedAt: deps.clock.now().toISOString(), deletedBy: ctx.userId, isActive: false })
        .where(eq(schema.customers.id, c.id));
      await audit(tx, ctx, { action: "customer.deleted", entityType: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}` });
    });
    return reply.code(204).send();
  });

  r.get(
    "/customers/:id/ledger",
    { preHandler: guard(deps, "customer.view_ledger"), schema: { tags: ["customers"], params: IdParams, querystring: LedgerQuery } },
    async (request) => {
      const ctx = request.ctx;
      const { from, to } = periodOf(ctx, request.query);
      return tenant(ctx, async (tx) => {
        const [c] = await tx
          .select({ id: schema.customers.id, code: schema.customers.code, name: schema.customers.name })
          .from(schema.customers)
          .where(and(eq(schema.customers.id, request.params.id), eq(schema.customers.businessId, ctx.businessId)));
        if (!c) throw notFound("customer");
        return { party: c, ...(await partyLedger(tx, ctx, "customer", c.id, from, to)) };
      });
    },
  );

  // ================================================================ suppliers
  async function supplierDetail(tx: Tx, ctx: RequestCtx, id: string) {
    const [s] = await tx
      .select()
      .from(schema.suppliers)
      .where(and(eq(schema.suppliers.id, id), eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt)));
    if (!s) throw notFound("supplier");
    const [stats] = (
      await tx.execute<{ total_purchases: string; purchase_count: number; last_purchase_date: string | null; last_payment_date: string | null }>(sql`
        select coalesce(sum(p.grand_total), 0)::text as total_purchases, count(*)::int as purchase_count,
               max(p.supplier_invoice_date)::text as last_purchase_date,
               (select max(pay.payment_date)::text from payments pay
                 where pay.supplier_id = ${id} and pay.direction = 'out' and pay.status = 'posted') as last_payment_date
        from purchases p where p.business_id = ${ctx.businessId} and p.supplier_id = ${id} and p.status = 'posted'`)
    ).rows;
    const { businessId: _b, deletedAt: _d, deletedBy: _db, bankAccountNumberEnc: _enc, ...rest } = s;
    return {
      ...rest,
      bankAccountNumberMasked: s.bankAccountLast4 ? `XXXXXX${s.bankAccountLast4}` : null,
      summary: {
        balance: s.balance,
        totalPurchases: stats!.total_purchases,
        purchaseCount: stats!.purchase_count,
        lastPurchaseDate: stats!.last_purchase_date,
        lastPaymentDate: stats!.last_payment_date,
      },
    };
  }

  const bankFields = (accountNumber: string | undefined) =>
    accountNumber ? { bankAccountNumberEnc: deps.cipher.encrypt(accountNumber), bankAccountLast4: accountNumber.slice(-4) } : {};

  r.get("/suppliers", { preHandler: guard(deps, "supplier.view"), schema: { tags: ["suppliers"], querystring: SupplierListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const s = schema.suppliers;
    const where: SQL[] = [eq(s.businessId, ctx.businessId), isNull(s.deletedAt)];
    if (q.active !== "all") where.push(eq(s.isActive, q.active === "true"));
    if (q.outstanding === "yes") where.push(sql`${s.balance} > 0`);
    if (q.q) {
      const like = likeContains(q.q);
      where.push(sql`(${s.name} ilike ${like} or ${s.companyName} ilike ${like} or ${s.code} ilike ${like} or ${s.gstin} = ${q.q.toUpperCase()} or ${s.mobile} = ${normalizeIndianMobile(q.q) ?? q.q})`);
    }
    if (cursor) where.push(sql`(${s.name}, ${s.id}) > (${String(cursor.v)}, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      supplierRows(tx, and(...where))
        .orderBy(asc(s.name), asc(s.id))
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.name, id: x.id }));
  });

  r.get("/suppliers/:id", { preHandler: guard(deps, "supplier.view"), schema: { tags: ["suppliers"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => supplierDetail(tx, request.ctx, request.params.id)),
  );

  r.post("/suppliers", { preHandler: guard(deps, "supplier.create"), schema: { tags: ["suppliers"], body: SupplierBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const result = await tenant(ctx, async (tx) => {
      const { bankAccountNumber, ...raw } = request.body;
      const body = await normaliseParty(tx, raw);
      const duplicates = await possibleDuplicates(tx, "supplier", ctx.businessId, body);
      const code = await codeFor(tx, deps, ctx, "supplier", body.code);
      const id = uuidv7();
      const today = deps.clock.today(ctx.timeZone);
      await tx.insert(schema.suppliers).values({
        ...body,
        ...bankFields(bankAccountNumber),
        id,
        code,
        businessId: ctx.businessId,
        openingBalanceDate: today,
        balance: "0",
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      if (dec(body.openingBalance).gt(0)) {
        await postPartyEntry(tx, {
          businessId: ctx.businessId,
          party: { type: "supplier", id },
          date: today,
          docType: "opening",
          docId: id,
          docNumber: code,
          ...(body.openingBalanceSide === "credit" ? { credit: body.openingBalance } : { debit: body.openingBalance }),
          narration: "Opening balance",
          userId: ctx.userId,
        });
      }
      await audit(tx, ctx, { action: "supplier.created", entityType: "supplier", entityId: id, entityLabel: `${code} ${body.name}` });
      return { ...(await supplierDetail(tx, ctx, id)), duplicates };
    });
    return reply.code(201).send(result);
  });

  r.patch("/suppliers/:id", { preHandler: guard(deps, "supplier.update"), schema: { tags: ["suppliers"], params: IdParams, body: SupplierPatch } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [s] = await tx
        .select()
        .from(schema.suppliers)
        .where(and(eq(schema.suppliers.id, request.params.id), eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt)))
        .for("update");
      if (!s) throw notFound("supplier");
      const { bankAccountNumber, ...raw } = request.body;
      const body = await normaliseParty(tx, raw, s);
      if (body.code) body.code = body.code.toUpperCase();
      const changes: Record<string, unknown> = diff(s, body);
      if (bankAccountNumber) changes.bankAccount = [s.bankAccountLast4 ? `XXXXXX${s.bankAccountLast4}` : null, `XXXXXX${bankAccountNumber.slice(-4)}`];
      await tx
        .update(schema.suppliers)
        .set({ ...body, ...bankFields(bankAccountNumber), updatedBy: ctx.userId, version: s.version + 1 })
        .where(eq(schema.suppliers.id, s.id));
      if (Object.keys(changes).length) {
        await audit(tx, ctx, { action: "supplier.updated", entityType: "supplier", entityId: s.id, entityLabel: `${s.code} ${body.name ?? s.name}`, changes });
      }
      return supplierDetail(tx, ctx, s.id);
    });
  });

  r.delete("/suppliers/:id", { preHandler: guard(deps, "supplier.delete"), schema: { tags: ["suppliers"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [s] = await tx
        .select()
        .from(schema.suppliers)
        .where(and(eq(schema.suppliers.id, request.params.id), eq(schema.suppliers.businessId, ctx.businessId), isNull(schema.suppliers.deletedAt)))
        .for("update");
      if (!s) throw notFound("supplier");
      if (!dec(s.balance).isZero()) throw conflict("PARTY_HAS_BALANCE", { balance: s.balance });
      await tx.update(schema.suppliers).set({ deletedAt: deps.clock.now().toISOString(), deletedBy: ctx.userId, isActive: false }).where(eq(schema.suppliers.id, s.id));
      await audit(tx, ctx, { action: "supplier.deleted", entityType: "supplier", entityId: s.id, entityLabel: `${s.code} ${s.name}` });
    });
    return reply.code(204).send();
  });

  r.get(
    "/suppliers/:id/ledger",
    { preHandler: guard(deps, "supplier.view_ledger"), schema: { tags: ["suppliers"], params: IdParams, querystring: LedgerQuery } },
    async (request) => {
      const ctx = request.ctx;
      const { from, to } = periodOf(ctx, request.query);
      return tenant(ctx, async (tx) => {
        const [s] = await tx
          .select({ id: schema.suppliers.id, code: schema.suppliers.code, name: schema.suppliers.name })
          .from(schema.suppliers)
          .where(and(eq(schema.suppliers.id, request.params.id), eq(schema.suppliers.businessId, ctx.businessId)));
        if (!s) throw notFound("supplier");
        return { party: s, ...(await partyLedger(tx, ctx, "supplier", s.id, from, to)) };
      });
    },
  );

  // ================================================================ customer categories and routes (beats)
  r.get("/customer-categories", { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx.select().from(schema.customerCategories).where(eq(schema.customerCategories.businessId, request.ctx.businessId)).orderBy(asc(schema.customerCategories.name)),
    ),
  }));

  r.post("/customer-categories", { preHandler: guard(deps, "customer.update"), schema: { tags: ["customers"], body: CustomerCategoryBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const [c] = await tx
        .insert(schema.customerCategories)
        .values({ ...request.body, id: uuidv7(), businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "customer_category.created", entityType: "customer_category", entityId: c!.id, entityLabel: c!.name });
      return c!;
    });
    return reply.code(201).send(row);
  });

  r.get("/routes", { preHandler: guard(deps, "customer.view"), schema: { tags: ["customers"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx.select().from(schema.salesRoutes).where(eq(schema.salesRoutes.businessId, request.ctx.businessId)).orderBy(asc(schema.salesRoutes.name)),
    ),
  }));

  r.post("/routes", { preHandler: guard(deps, "customer.update"), schema: { tags: ["customers"], body: RouteBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      await assertOwned(tx, schema.employees, ctx.businessId, request.body.salespersonId, "salespersonId");
      const [route] = await tx
        .insert(schema.salesRoutes)
        .values({ ...request.body, id: uuidv7(), businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "route.created", entityType: "route", entityId: route!.id, entityLabel: route!.name });
      return route!;
    });
    return reply.code(201).send(row);
  });

  r.patch(
    "/routes/:id",
    { preHandler: guard(deps, "customer.update"), schema: { tags: ["customers"], params: IdParams, body: patchOf(RouteBody.extend({ isActive: z.boolean() })) } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [route] = await tx.select().from(schema.salesRoutes).where(and(eq(schema.salesRoutes.id, request.params.id), eq(schema.salesRoutes.businessId, ctx.businessId)));
        if (!route) throw notFound("route");
        await assertOwned(tx, schema.employees, ctx.businessId, request.body.salespersonId, "salespersonId");
        const [row] = await tx.update(schema.salesRoutes).set({ ...request.body, updatedBy: ctx.userId }).where(eq(schema.salesRoutes.id, route.id)).returning();
        await audit(tx, ctx, { action: "route.updated", entityType: "route", entityId: route.id, entityLabel: row!.name, changes: diff(route, request.body) });
        return row!;
      });
    },
  );
};
