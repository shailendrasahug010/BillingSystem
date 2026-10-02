import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import { rootMessage } from "../lib/errors.js";
import { NOTIFICATION_EVENTS, notifyForEvent } from "./notification-events.js";
import { planPushes, PUSH_EVENT, sendPushes, type PlannedPush } from "./push-delivery.js";
import { refreshCustomer } from "./purchase-history.js";
import { refreshSalesDays, summaryDaysOf } from "./sales-daily.js";
import { getSettings } from "./settings.js";

/**
 * The outbox worker. Posting code writes an outbox_events row in the same
 * transaction as the change it describes; this worker hands each event to the
 * handlers that care, a few seconds later, and marks it processed. Nothing is
 * lost while it is stopped: the events wait.
 *
 * The handlers keep the purchase history (customer_product_stats and
 * customer_stats) of the customer an event is about, raise the
 * notifications events call for (new orders, leave requests: see
 * notification-events.ts), push new notifications to phones (planned in
 * the transaction, sent after it commits: push-delivery.ts) and work out
 * again the daily sales summaries of the days their documents fall on
 * (sales-daily.ts). Events no handler needs are marked processed as they are.
 *
 * Every business is handled in its own transaction under row-level security:
 * `outbox_pending_businesses` (a SECURITY DEFINER function) only says whose
 * events are waiting. Events are taken with FOR UPDATE SKIP LOCKED, so several
 * API servers can run the worker side by side.
 */

/** Events per business per round. */
const BATCH = 200;
/** Rounds per business per run, so one busy business cannot hold up the rest. */
const MAX_ROUNDS = 5;
/** Businesses per run. */
const BUSINESSES = 50;
/** After this many failures an event is set aside (processed, with its error kept). */
export const MAX_ATTEMPTS = 8;

/** Waits 1, 2, 4 … minutes between attempts, at most an hour. */
export const retryDelayMs = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;

type Event = typeof schema.outboxEvents.$inferSelect;

/** Event types whose customer's purchase history (and payment behaviour) can change. */
const CUSTOMER_EVENTS = new Set([
  "invoice.posted",
  "invoice.cancelled",
  "payment.received",
  "payment.cancelled",
  "payment.cheque_bounced",
  "credit_note.posted",
  "credit_note.cancelled",
  "debit_note.posted",
  "debit_note.cancelled",
]);

/** The customer each event is about, looked up from the record it names. */
async function customersOf(tx: Tx, events: Event[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = (type: string) => events.filter((e) => CUSTOMER_EVENTS.has(e.eventType) && e.aggregateType === type).map((e) => e.aggregateId);
  const lookups: Array<[string, string[], () => Promise<Array<{ id: string; customerId: string | null }>>]> = [
    ["invoice", ids("invoice"), () => tx.select({ id: schema.invoices.id, customerId: schema.invoices.customerId }).from(schema.invoices).where(inArray(schema.invoices.id, ids("invoice")))],
    ["payment", ids("payment"), () => tx.select({ id: schema.payments.id, customerId: schema.payments.customerId }).from(schema.payments).where(inArray(schema.payments.id, ids("payment")))],
    ["note", ids("note"), () => tx.select({ id: schema.creditDebitNotes.id, customerId: schema.creditDebitNotes.customerId }).from(schema.creditDebitNotes).where(inArray(schema.creditDebitNotes.id, ids("note")))],
  ];
  for (const [type, list, load] of lookups) {
    if (!list.length) continue;
    const found = new Map((await load()).map((r) => [r.id, r.customerId]));
    for (const e of events) {
      const customerId = e.aggregateType === type && CUSTOMER_EVENTS.has(e.eventType) ? found.get(e.aggregateId) : null;
      if (customerId) out.set(e.id, customerId);
    }
  }
  return out;
}

export interface OutboxResult {
  processed: number;
  failed: number;
}

/**
 * Handles one business's waiting events (up to MAX_ROUNDS x BATCH). The
 * events and the figures they lead to are written in one transaction; a
 * customer whose figures cannot be worked out fails alone (savepoint), and
 * only their events are retried later.
 */
export async function processBusinessOutbox(deps: AppDeps, businessId: string): Promise<OutboxResult> {
  const total: OutboxResult = { processed: 0, failed: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const failures: Array<{ job: string; details: Record<string, string>; error: unknown }> = [];
    const pushes: PlannedPush[] = [];
    const result = await withTenant(deps.db, { businessId, userId: "" }, async (tx) => {
      const now = deps.clock.now();
      const e = schema.outboxEvents;
      const events = await tx
        .select()
        .from(e)
        .where(and(eq(e.businessId, businessId), isNull(e.processedAt), lte(e.availableAt, now.toISOString())))
        .orderBy(asc(e.id))
        .limit(BATCH)
        .for("update", { skipLocked: true });
      if (!events.length) return null;

      const [business] = await tx.select({ timeZone: schema.businesses.timeZone }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
      const today = deps.clock.today(business?.timeZone);
      const windowDays = (await getSettings(tx, businessId, ["suggestions.window_days"] as const))["suggestions.window_days"];

      // Each handler runs in a savepoint: what fails is rolled back alone, and only its events are retried.
      const errorOf = new Map<number, unknown>();
      const customerOf = await customersOf(tx, events);
      for (const customerId of new Set(customerOf.values())) {
        try {
          await tx.transaction((sp) => refreshCustomer(sp, businessId, customerId, today, windowDays));
        } catch (error) {
          failures.push({ job: "outbox worker (purchase history of a customer)", details: { businessId, customerId }, error });
          for (const [eventId, c] of customerOf) if (c === customerId) errorOf.set(eventId, error);
        }
      }
      for (const ev of events) {
        if (!NOTIFICATION_EVENTS.has(ev.eventType) || errorOf.has(ev.id)) continue;
        try {
          await tx.transaction((sp) => notifyForEvent(sp, businessId, ev, now.toISOString()));
        } catch (error) {
          failures.push({ job: "outbox worker (notification for an event)", details: { businessId, event: `${ev.eventType} ${ev.aggregateId}` }, error });
          errorOf.set(ev.id, error);
        }
      }
      // The daily summaries of the days these documents fall on.
      const dayOf = await summaryDaysOf(tx, events.filter((ev) => !errorOf.has(ev.id)));
      if (dayOf.size) {
        try {
          await tx.transaction((sp) => refreshSalesDays(sp, businessId, [...new Set(dayOf.values())]));
        } catch (error) {
          failures.push({ job: "outbox worker (daily sales summaries)", details: { businessId, days: [...new Set(dayOf.values())].join(",") }, error });
          for (const id of dayOf.keys()) errorOf.set(id, error);
        }
      }
      // New notifications to push to phones (sent once this transaction has committed; at most once).
      const toPush = events.filter((ev) => ev.eventType === PUSH_EVENT);
      if (toPush.length && deps.push.driver !== "off") {
        try {
          pushes.push(...(await tx.transaction((sp) => planPushes(sp, businessId, toPush.map((ev) => ev.aggregateId)))));
        } catch (error) {
          failures.push({ job: "outbox worker (push messages for notifications)", details: { businessId }, error });
          for (const ev of toPush) errorOf.set(ev.id, error);
        }
      }

      const done = events.filter((ev) => !errorOf.has(ev.id)).map((ev) => ev.id);
      if (done.length) await tx.update(e).set({ processedAt: now.toISOString() }).where(inArray(e.id, done));
      for (const ev of events.filter((x) => errorOf.has(x.id))) {
        const attempts = ev.attempts + 1;
        const message = rootMessage(errorOf.get(ev.id));
        await tx
          .update(e)
          .set({
            attempts,
            lastError: attempts >= MAX_ATTEMPTS ? `gave up after ${attempts} attempts: ${message}` : message,
            availableAt: new Date(now.getTime() + retryDelayMs(attempts)).toISOString(),
            // Set aside after too many failures, so it does not clog the queue; the error log has it.
            ...(attempts >= MAX_ATTEMPTS ? { processedAt: now.toISOString() } : {}),
          })
          .where(eq(e.id, ev.id));
      }
      // Notifications raised this round wrote push events of their own: another round takes them now rather than at the next run.
      const raised = events.some((ev) => NOTIFICATION_EVENTS.has(ev.eventType) && !errorOf.has(ev.id));
      return { processed: done.length, failed: errorOf.size, more: events.length === BATCH || raised };
    });
    for (const f of failures) deps.errors.record(f.error, { reference: uuidv7(), source: "job", job: f.job, details: f.details });
    if (pushes.length) {
      await sendPushes(deps, businessId, pushes).catch((error: unknown) => deps.errors.record(error, { reference: uuidv7(), source: "job", job: "push messages to phones (recording how they went)", details: { businessId } }));
    }
    if (!result) break;
    total.processed += result.processed;
    total.failed += result.failed;
    if (!result.more) break;
  }
  return total;
}

/** Handles the waiting events of every business that has some. */
export async function processOutbox(deps: AppDeps): Promise<OutboxResult> {
  const pending = await deps.db.execute<{ business_id: string }>(
    sql`select business_id from outbox_pending_businesses(${deps.clock.now().toISOString()}::timestamptz, ${BUSINESSES})`,
  );
  const total: OutboxResult = { processed: 0, failed: 0 };
  for (const { business_id: businessId } of pending.rows) {
    const r = await processBusinessOutbox(deps, businessId);
    total.processed += r.processed;
    total.failed += r.failed;
  }
  return total;
}

/** Runs the worker every `seconds`; returns a function that stops it. */
export function startOutboxWorker(deps: AppDeps, seconds: number, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): () => void {
  if (seconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await processOutbox(deps);
      if (done.failed) log.warn(done, "outbox events failed (they will be tried again)");
    } catch (e) {
      log.warn({ err: rootMessage(e) }, "outbox worker could not run");
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "outbox worker (looking for waiting events)" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
