import { Money } from "@vyapaar/contracts";
import { ageDocuments, dec } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { getSettings } from "../../services/settings.js";
import type { ApiModule } from "../types.js";
import { Format, sendReport } from "./reports.js";

const OutstandingListQuery = z.object({
  /** One city (as written on the customers, any case); "-" for customers without one. */
  city: z.string().trim().max(100).optional(),
  routeId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  /** "due": promised by today and not paid since; "any": any open promise. */
  promise: z.enum(["due", "any"]).optional(),
  sort: z.enum(["amount", "overdue", "name", "oldest", "promise"]).default("amount"),
  ...Format,
});

const IdParams = z.object({ customerId: z.uuid() });

const NoteBody = z.strictObject({
  customerId: z.uuid(),
  kind: z.enum(["promise", "note"]),
  note: z.string().trim().max(500).optional(),
  promisedAmount: Money.optional(),
  promisedOn: z.iso.date().optional(),
});

/**
 * The customer's open promise: the latest one made after their last payment
 * (a payment since then settles it, whatever the amount).
 */
const openPromise = (customer: SQL) => sql`
  select n.promised_on, n.promised_amount, n.note from collection_notes n
  where n.customer_id = ${customer} and n.kind = 'promise'
    and n.created_at > coalesce((select max(p.created_at) from payments p where p.customer_id = ${customer} and p.status = 'posted' and p.direction = 'in'), '-infinity'::timestamptz)
  order by n.created_at desc limit 1`;

const likeContains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Money to collect, for the people who collect it: every customer who owes,
 * with the city and route they are in, so a collector going to Dewas sees
 * Dewas only. The list downloads (Excel, PDF with a "Collected" column to
 * fill in, CSV) and prints for whoever may see it (customer.view_ledger);
 * each download is noted in the audit log. One customer opens with the bills
 * still open, their age and the last payments.
 */
export const collectionsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.get(
    "/collections/outstanding",
    { preHandler: guard(deps, "customer.view_ledger"), schema: { tags: ["reports"], querystring: OutstandingListQuery } },
    async (request, reply) => {
      const ctx = request.ctx;
      const q = request.query;
      const today = deps.clock.today(ctx.timeZone);
      const b = ctx.businessId;
      const filters: SQL[] = [sql`c.business_id = ${b}`, sql`c.deleted_at is null`, sql`c.balance > 0`];
      if (q.city === "-") filters.push(sql`nullif(trim(c.city), '') is null`);
      else if (q.city) filters.push(sql`lower(trim(c.city)) = lower(${q.city})`);
      if (q.routeId) filters.push(sql`c.route_id = ${q.routeId}`);
      if (q.q) {
        const like = likeContains(q.q);
        filters.push(sql`(c.name ilike ${like} or c.business_name ilike ${like} or c.code ilike ${like} or c.mobile ilike ${like} or c.city ilike ${like})`);
      }
      if (q.overdue === "true") filters.push(sql`coalesce(od.overdue, 0) > 0`);
      if (q.promise === "due") filters.push(sql`pr.promised_on <= ${today}`);
      if (q.promise === "any") filters.push(sql`pr.promised_on is not null`);
      const order = {
        amount: sql`c.balance desc, c.name`,
        overdue: sql`coalesce(od.overdue, 0) desc, c.balance desc`,
        name: sql`coalesce(c.business_name, c.name)`,
        oldest: sql`od.oldest_due asc nulls last, c.balance desc`,
        promise: sql`pr.promised_on asc nulls last, c.balance desc`,
      }[q.sort];

      const { rows, cities } = await tenant(ctx, async (tx) => {
        const rows = (
          await tx.execute<{
            id: string;
            code: string;
            name: string;
            business_name: string | null;
            mobile: string | null;
            city: string | null;
            address_line1: string | null;
            route_id: string | null;
            route_name: string | null;
            balance: string;
            overdue: string;
            open_bills: number;
            oldest_due: string | null;
            last_payment_date: string | null;
            last_payment_amount: string | null;
            promised_on: string | null;
            promised_amount: string | null;
            promise_note: string | null;
            note_kind: string | null;
            note_text: string | null;
            note_on: string | null;
          }>(sql`
            select c.id, c.code, c.name, c.business_name, c.mobile, c.city, c.address_line1, c.route_id, r.name as route_name, c.balance::text,
                   coalesce(od.overdue, 0)::text as overdue, coalesce(od.open_bills, 0)::int as open_bills, od.oldest_due::text as oldest_due,
                   lp.payment_date::text as last_payment_date, lp.amount::text as last_payment_amount,
                   pr.promised_on::text as promised_on, pr.promised_amount::text as promised_amount, pr.note as promise_note,
                   ln.kind as note_kind, ln.note as note_text, ln.visited_on::text as note_on
            from customers c
            left join sales_routes r on r.id = c.route_id
            left join lateral (
              select sum(i.balance_due) filter (where coalesce(i.due_date, i.invoice_date) < ${today}) as overdue,
                     count(*) as open_bills,
                     min(coalesce(i.due_date, i.invoice_date)) as oldest_due
              from invoices i where i.customer_id = c.id and i.status = 'posted' and i.balance_due > 0
            ) od on true
            left join lateral (
              select p.payment_date, p.amount from payments p
              where p.customer_id = c.id and p.status = 'posted' and p.direction = 'in'
              order by p.payment_date desc, p.created_at desc limit 1
            ) lp on true
            left join lateral (${openPromise(sql`c.id`)}) pr on true
            left join lateral (
              select n.kind, n.note, n.visited_on from collection_notes n where n.customer_id = c.id order by n.created_at desc limit 1
            ) ln on true
            where ${sql.join(filters, sql` and `)}
            order by ${order}
            limit 5000`)
        ).rows;
        // Every place with money owed (whatever is filtered), for the city picker.
        const cities = (
          await tx.execute<{ city: string; customers: number; total: string }>(sql`
            select coalesce(min(nullif(trim(c.city), '')), '') as city, count(*)::int as customers, sum(c.balance)::text as total
            from customers c
            where c.business_id = ${b} and c.deleted_at is null and c.balance > 0
            group by lower(coalesce(nullif(trim(c.city), ''), ''))
            order by sum(c.balance) desc`)
        ).rows;
        return { rows, cities };
      });

      const data = rows.map((c) => {
        const oldest = c.oldest_due;
        return {
          customerId: c.id,
          code: c.code,
          name: c.business_name ?? c.name,
          contactName: c.business_name && c.business_name !== c.name ? c.name : null,
          mobile: c.mobile,
          city: c.city?.trim() || null,
          address: c.address_line1,
          routeId: c.route_id,
          route: c.route_name,
          outstanding: dec(c.balance).toFixed(2),
          overdue: dec(c.overdue).toFixed(2),
          openBills: c.open_bills,
          oldestDueDate: oldest,
          daysOverdue: oldest && oldest < today ? Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000) : 0,
          lastPaymentDate: c.last_payment_date,
          lastPaymentAmount: c.last_payment_amount ? dec(c.last_payment_amount).toFixed(2) : null,
          promise: c.promised_on ? { date: c.promised_on, amount: c.promised_amount ? dec(c.promised_amount).toFixed(2) : null, note: c.promise_note } : null,
          lastNote: c.note_on ? { kind: c.note_kind as "promise" | "note", note: c.note_text, date: c.note_on } : null,
        };
      });
      const totals = {
        customers: data.length,
        outstanding: data.reduce((acc, x) => acc.plus(x.outstanding), dec(0)).toFixed(2),
        overdue: data.reduce((acc, x) => acc.plus(x.overdue), dec(0)).toFixed(2),
      };

      if (q.format !== "json") {
        await tenant(ctx, (tx) =>
          audit(tx, ctx, { action: "outstanding.exported", entityType: "customer", changes: { format: q.format, city: q.city ?? null, routeId: q.routeId ?? null, promise: q.promise ?? null, rows: data.length } }),
        );
      }
      const place = q.city && q.city !== "-" ? q.city : null;
      return sendReport(
        reply,
        ctx,
        deps,
        q.format,
        `outstanding${place ? `-${place.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}-${today}`,
        [
          { key: "name", label: "Customer" },
          { key: "mobile", label: "Mobile" },
          { key: "place", label: "City / route" },
          { key: "openBills", label: "Bills" },
          { key: "oldestDue", label: "Oldest due" },
          { key: "promisedOn", label: "Promised" },
          { key: "overdue", label: "Overdue" },
          { key: "outstanding", label: "Outstanding" },
          // Left blank for the collector to write in (PDF and print).
          ...(q.format === "pdf" ? [{ key: "collected", label: "Collected" }] : []),
        ],
        {
          asOf: today,
          cities: cities.map((c) => ({ city: c.city || null, customers: c.customers, total: dec(c.total).toFixed(2) })),
          rows: data.map((x) => ({
            ...x,
            place: [x.city, x.route].filter(Boolean).join(" · "),
            oldestDue: x.oldestDueDate ?? "",
            promisedOn: x.promise?.date ?? "",
            collected: "",
          })),
          totals,
        },
        { title: place ? `Outstanding · ${place}` : "Outstanding to collect", asOf: today },
        "customer.view_ledger",
      );
    },
  );

  r.get(
    "/collections/outstanding/:customerId",
    { preHandler: guard(deps, "customer.view_ledger"), schema: { tags: ["reports"], params: IdParams } },
    async (request) => {
      const ctx = request.ctx;
      const today = deps.clock.today(ctx.timeZone);
      return tenant(ctx, async (tx) => {
        const [c] = await tx
          .select({ customer: schema.customers, route: schema.salesRoutes.name })
          .from(schema.customers)
          .leftJoin(schema.salesRoutes, eq(schema.salesRoutes.id, schema.customers.routeId))
          .where(and(eq(schema.customers.id, request.params.customerId), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
        if (!c) throw notFound("customer");
        const settings = await getSettings(tx, ctx.businessId, ["reports.aging_buckets"] as const);
        const bills = (
          await tx.execute<{ id: string; number: string; date: string; due_date: string; total: string; paid: string; balance: string }>(sql`
            select id, invoice_number as number, invoice_date::text as date, coalesce(due_date, invoice_date)::text as due_date,
                   grand_total::text as total, amount_paid::text as paid, balance_due::text as balance
            from invoices
            where business_id = ${ctx.businessId} and customer_id = ${c.customer.id} and status = 'posted' and balance_due > 0
            order by coalesce(due_date, invoice_date), invoice_date, invoice_number`)
        ).rows;
        const payments = (
          await tx.execute<{ id: string; number: string | null; date: string; amount: string; method: string }>(sql`
            select id, payment_number as number, payment_date::text as date, amount::text, method::text
            from payments
            where business_id = ${ctx.businessId} and customer_id = ${c.customer.id} and status = 'posted' and direction = 'in'
            order by payment_date desc, created_at desc limit 5`)
        ).rows;
        const [promise] = (await tx.execute<{ promised_on: string; promised_amount: string | null; note: string | null }>(openPromise(sql`${c.customer.id}`))).rows;
        const notes = await tx
          .select({
            id: schema.collectionNotes.id,
            kind: schema.collectionNotes.kind,
            note: schema.collectionNotes.note,
            promisedAmount: schema.collectionNotes.promisedAmount,
            promisedOn: schema.collectionNotes.promisedOn,
            visitedOn: schema.collectionNotes.visitedOn,
            createdAt: schema.collectionNotes.createdAt,
            by: schema.users.name,
          })
          .from(schema.collectionNotes)
          .leftJoin(schema.users, eq(schema.users.id, schema.collectionNotes.createdBy))
          .where(and(eq(schema.collectionNotes.businessId, ctx.businessId), eq(schema.collectionNotes.customerId, c.customer.id)))
          .orderBy(desc(schema.collectionNotes.createdAt))
          .limit(10);
        const aged = ageDocuments(
          bills.map((x) => ({ id: x.id, number: x.number, date: x.date, dueDate: x.due_date, balance: x.balance })),
          { asOf: today, edges: settings["reports.aging_buckets"], basis: "due_date" },
        );
        const onBills = bills.reduce((acc, x) => acc.plus(x.balance), dec(0));
        const k = c.customer;
        return {
          asOf: today,
          customer: {
            id: k.id,
            code: k.code,
            name: k.businessName ?? k.name,
            contactName: k.businessName && k.businessName !== k.name ? k.name : null,
            mobile: k.mobile,
            altMobile: k.altMobile,
            email: k.email,
            address: [k.addressLine1, k.addressLine2].filter(Boolean).join(", ") || null,
            city: k.city,
            pincode: k.pincode,
            stateCode: k.stateCode,
            gstin: k.gstin,
            route: c.route,
            creditLimit: k.creditLimit,
            creditDays: k.creditDays,
          },
          outstanding: dec(k.balance).toFixed(2),
          overdue: aged.buckets.reduce((acc, x) => acc.plus(x.amount), dec(0)).toFixed(2),
          notDue: aged.notDue.toFixed(2),
          /** Opening balance and the like, owed but not on an open bill. */
          other: dec(k.balance).minus(onBills).gt(0) ? dec(k.balance).minus(onBills).toFixed(2) : "0.00",
          aging: aged.buckets.map((x) => ({ label: x.label, amount: x.amount.toFixed(2), count: x.count })),
          bills: bills.map((x) => ({
            id: x.id,
            number: x.number,
            date: x.date,
            dueDate: x.due_date,
            total: dec(x.total).toFixed(2),
            paid: dec(x.paid).toFixed(2),
            balance: dec(x.balance).toFixed(2),
            daysOverdue: x.due_date < today ? Math.round((Date.parse(today) - Date.parse(x.due_date)) / 86_400_000) : 0,
          })),
          payments: payments.map((p) => ({ id: p.id, number: p.number, date: p.date, amount: dec(p.amount).toFixed(2), method: p.method })),
          promise: promise ? { date: promise.promised_on, amount: promise.promised_amount ? dec(promise.promised_amount).toFixed(2) : null, note: promise.note } : null,
          notes: notes.map((n) => ({ ...n, kind: n.kind as "promise" | "note", promisedAmount: n.promisedAmount ? dec(n.promisedAmount).toFixed(2) : null })),
        };
      });
    },
  );

  /**
   * Nothing (or not all) received on a visit: a note, or the customer's
   * promise to pay by a date. The Idempotency-Key (a UUID made on the device)
   * becomes the note's id, so a note saved offline and sent twice is one note.
   */
  r.post(
    "/collections/notes",
    { preHandler: guard(deps, "payment.collect"), schema: { tags: ["reports"], body: NoteBody } },
    async (request, reply) => {
      const ctx = request.ctx;
      const body = request.body;
      const key = request.headers["idempotency-key"];
      const clientId = typeof key === "string" && z.uuid().safeParse(key).success ? key : null;
      if (key !== undefined && !clientId) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
      const today = deps.clock.today(ctx.timeZone);
      if (body.kind === "promise") {
        if (!body.promisedOn) throw badRequest("PROMISE_DATE_REQUIRED", {}, "promisedOn");
        if (body.promisedOn < today) throw badRequest("PROMISE_DATE_PAST", {}, "promisedOn");
        if (Date.parse(body.promisedOn) - Date.parse(today) > 366 * 86_400_000) throw badRequest("PROMISE_DATE_TOO_FAR", {}, "promisedOn");
        if (body.promisedAmount !== undefined && !dec(body.promisedAmount).gt(0)) throw badRequest("VALIDATION_FAILED", {}, "promisedAmount");
      } else if (!body.note) throw badRequest("NOTE_REQUIRED", {}, "note");
      const result = await tenant(ctx, async (tx) => {
        const read = async (id: string) => {
          const [row] = await tx
            .select({ note: schema.collectionNotes, by: schema.users.name })
            .from(schema.collectionNotes)
            .leftJoin(schema.users, eq(schema.users.id, schema.collectionNotes.createdBy))
            .where(and(eq(schema.collectionNotes.id, id), eq(schema.collectionNotes.businessId, ctx.businessId)));
          return row ? { ...row.note, by: row.by } : null;
        };
        if (clientId) {
          const existing = await read(clientId);
          if (existing) return { replay: true, note: existing };
        }
        const [customer] = await tx
          .select({ id: schema.customers.id, name: schema.customers.name })
          .from(schema.customers)
          .where(and(eq(schema.customers.id, body.customerId), eq(schema.customers.businessId, ctx.businessId), isNull(schema.customers.deletedAt)));
        if (!customer) throw notFound("customer");
        const id = clientId ?? uuidv7();
        const inserted = await tx
          .insert(schema.collectionNotes)
          .values({
            id,
            businessId: ctx.businessId,
            customerId: customer.id,
            kind: body.kind,
            note: body.note || null,
            promisedAmount: body.kind === "promise" && body.promisedAmount ? dec(body.promisedAmount).toFixed(2) : null,
            promisedOn: body.kind === "promise" ? body.promisedOn! : null,
            visitedOn: today,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          })
          .onConflictDoNothing({ target: schema.collectionNotes.id })
          .returning({ id: schema.collectionNotes.id });
        // The id is taken by a row this business cannot see: not a key this device made for it.
        if (inserted.length === 0) throw badRequest("INVALID_IDEMPOTENCY_KEY", {}, "Idempotency-Key");
        await audit(tx, ctx, {
          action: body.kind === "promise" ? "collection.promise_noted" : "collection.note_added",
          entityType: "customer",
          entityId: customer.id,
          entityLabel: customer.name,
          changes: { kind: body.kind, note: body.note ?? null, promisedOn: body.promisedOn ?? null, promisedAmount: body.promisedAmount ?? null },
        });
        return { replay: false, note: (await read(id))! };
      });
      return reply.code(result.replay ? 200 : 201).send(result.note);
    },
  );
};
