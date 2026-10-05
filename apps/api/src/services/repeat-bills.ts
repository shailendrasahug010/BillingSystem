import { InvoiceBody } from "@digitalbahi/contracts";
import { dueRepeatDates, type RepeatFrequency } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps, RequestCtx } from "../lib/context.js";
import { loadAccess } from "../lib/access.js";
import { withTenant } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";
import { postInvoice } from "../modules/invoices/routes.js";
import { notify } from "./notifications.js";

const BUSINESSES = 200;

export interface RepeatRunResult {
  businesses: number;
  bills: number;
  failed: number;
}

const rootMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Who a repeat bill is made as: the person who set it up, with their own
 * rights plus back-dating (a missed bill keeps its own date) and the bill's
 * agreed rates. A credit or stock block still stops it unless they may override it.
 */
async function jobCtx(deps: AppDeps, businessId: string, timeZone: string, userId: string): Promise<RequestCtx | null> {
  const access = await loadAccess(deps.db, userId, businessId);
  if (!access) return null;
  const grants = access.grants.includes("*") ? access.grants : [...access.grants, "invoice.backdate", "invoice.override_price"];
  return { userId, userName: access.userName, businessId, sessionId: "", roleKey: access.roleKey, grants, isOwner: access.isOwner, timeZone, requestId: uuidv7(), ip: "", userAgent: "repeat bills" };
}

/**
 * Makes the repeat bills that are due today (and any missed while the server
 * was off) for one business. Each bill is posted in its own savepoint, so one
 * that is blocked does not undo the others; it keeps its date and is tried
 * again on the next run, with one notification a day saying why.
 */
export async function runRepeatBillsFor(tx: Tx, deps: AppDeps, businessId: string, timeZone: string): Promise<{ bills: number; failed: number; errors: unknown[] }> {
  const today = deps.clock.today(timeZone);
  const now = deps.clock.now().toISOString();
  const r = schema.recurringInvoices;
  const due = await tx
    .select({ row: r, customer: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})` })
    .from(r)
    .innerJoin(schema.customers, eq(schema.customers.id, r.customerId))
    .where(and(eq(r.businessId, businessId), eq(r.isActive, true), lte(r.nextDate, today), or(isNull(r.lastTriedOn), lt(r.lastTriedOn, today))))
    .orderBy(r.nextDate)
    .for("update", { of: r, skipLocked: true });
  let bills = 0;
  let failed = 0;
  const errors: unknown[] = [];
  const made: string[] = [];
  for (const { row, customer } of due) {
    const { dates } = dueRepeatDates(row.frequency as RepeatFrequency, row.nextDate, row.anchorDay, today, row.endDate);
    const ctx = await jobCtx(deps, businessId, timeZone, row.ownerId);
    let next = row.nextDate;
    let lastInvoiceId = row.lastInvoiceId;
    let count = row.billsMade;
    let error: string | null = null;
    for (const date of dates) {
      try {
        if (!ctx) throw new ApiError(409, "REPEAT_OWNER_INACTIVE");
        const body = InvoiceBody.parse({ ...row.template, invoiceDate: date });
        const { detail } = await tx.transaction((sp) => postInvoice(sp, ctx, deps, body, null));
        lastInvoiceId = detail.id;
        made.push(detail.invoiceNumber ?? "");
        count++;
        bills++;
        next = dueRepeatDates(row.frequency as RepeatFrequency, date, row.anchorDay, date, null).next;
      } catch (e) {
        failed++;
        error = e instanceof ApiError ? e.code : "REPEAT_BILL_FAILED";
        if (!(e instanceof ApiError)) errors.push(e);
        await notify(
          tx,
          businessId,
          {
            type: "repeat_bill_failed",
            permission: "invoice.create",
            severity: "warning",
            titleKey: "notifications.repeat_bill_failed.title",
            bodyKey: `errors.${error}`,
            params: { customer, date },
            entityType: "repeat_bill",
            entityId: row.id,
            dedupeKey: `repeat_bill:${row.id}:${today}`,
          },
          now,
        );
        break;
      }
    }
    // Past its end date with nothing more to make: it is finished.
    const finished = row.endDate !== null && next > row.endDate;
    await tx
      .update(r)
      .set({ nextDate: next, lastInvoiceId, billsMade: count, lastError: error, lastTriedOn: today, isActive: !finished, updatedAt: now })
      .where(eq(r.id, row.id));
  }
  if (made.length) {
    await notify(
      tx,
      businessId,
      {
        type: "repeat_bills_made",
        permission: "invoice.create",
        titleKey: "notifications.repeat_bills_made.title",
        bodyKey: "notifications.repeat_bills_made.body",
        params: { count: made.length, numbers: made.slice(0, 5).join(", ") },
        dedupeKey: `repeat_bills:${today}:${made[0]}`,
      },
      now,
    );
  }
  return { bills, failed, errors };
}

/** Every business with a repeat bill due, each in its own transaction. */
export async function runDueRepeatBills(deps: AppDeps): Promise<RepeatRunResult> {
  const now = deps.clock.now();
  const due = await deps.db.execute<{ business_id: string; time_zone: string }>(sql`select business_id, time_zone from recurring_invoices_due(${now.toISOString()}::timestamptz, ${BUSINESSES})`);
  const result: RepeatRunResult = { businesses: 0, bills: 0, failed: 0 };
  for (const { business_id: businessId, time_zone: timeZone } of due.rows) {
    const done = await withTenant(deps.db, { businessId, userId: "" }, (tx) => runRepeatBillsFor(tx, deps, businessId, timeZone));
    result.businesses++;
    result.bills += done.bills;
    result.failed += done.failed;
    for (const e of done.errors) deps.errors.record(e, { reference: uuidv7(), source: "job", job: "repeat bills", details: { businessId } });
  }
  return result;
}

/** Looks for due repeat bills every `seconds`; returns a function that stops it. */
export function startRepeatBillScheduler(deps: AppDeps, seconds: number, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): () => void {
  if (seconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runDueRepeatBills(deps);
      if (done.bills || done.failed) log.info(done, "repeat bills");
    } catch (e) {
      log.warn({ err: rootMessage(e) }, "repeat bills could not run");
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "repeat bills (looking for due bills)" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
