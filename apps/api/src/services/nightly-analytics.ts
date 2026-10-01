import { addDays } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import { NOTIFICATION_KEEP_DAYS } from "./notifications.js";
import { SYNC_KEEP_DAYS } from "./sync-changes.js";
import { processBusinessOutbox, rootMessage } from "./outbox-worker.js";
import {
  customerFigures,
  loadCustomerData,
  lockCustomer,
  mineStoreAssociations,
  purchaseFigures,
  readStoredFigures,
  writeFigures,
  type PurchaseFigures,
} from "./purchase-history.js";
import { getSettings } from "./settings.js";

/**
 * The nightly analytics job, once per business and day after NIGHTLY_ANALYTICS_HOUR
 * in its own time zone:
 *
 *  1. Handles the business's waiting outbox events, so what follows is not
 *     confused by work the worker simply has not reached yet.
 *  2. Drift check: for every customer with stored figures, works them out again
 *     for the day they were stored for and compares. A difference means the
 *     worker missed something (an event never written, a failed handler).
 *  3. Rebuilds every customer's figures for today (the window moves on daily).
 *  4. Mines the store-wide "bought together" rules into product_associations.
 *  5. Checks the cached balances against their ledgers: customers.balance and
 *     suppliers.balance against party_ledger_entries, stock_balances against
 *     stock_ledger. Mismatches are reported, not changed.
 *  6. Deletes processed outbox events older than OUTBOX_KEEP_DAYS,
 *     notifications older than NOTIFICATION_KEEP_DAYS and the pull feed's
 *     changes older than SYNC_KEEP_DAYS.
 *
 * What it found is kept in analytics_runs.details; drift and mismatches are
 * also written to the error log, where operators look.
 */

/** Customers per transaction while rebuilding (keeps transactions short). */
const CHUNK = 50;
/** Examples kept per finding. */
const EXAMPLES = 10;
/** Processed outbox events are kept this long (for looking into problems), then deleted. */
export const OUTBOX_KEEP_DAYS = 30;
/** Businesses per scheduler run. */
const BUSINESSES = 20;

export interface DriftReport {
  /** Customers checked (those with stored figures). */
  checked: number;
  /** Customers whose stored figures differed from a fresh computation. */
  customers: number;
  /** Product rows that differed (missing, extra or changed). */
  rows: number;
  examples: Array<{ customerId: string; summary: boolean; associations: boolean; products: string[] }>;
}

export type BalanceMismatch = {
  /** customer / supplier: their id; stock: "product/warehouse/batch". */
  key: string;
  cached: string;
  ledger: string;
};

export interface NightlyDetails {
  asOf: string;
  outbox: { processed: number; failed: number; deleted: number };
  /** Notifications older than NOTIFICATION_KEEP_DAYS deleted. */
  notificationsDeleted: number;
  /** Pull-feed changes older than SYNC_KEEP_DAYS deleted. */
  syncChangesDeleted: number;
  customers: number;
  statsRows: number;
  drift: DriftReport;
  associations: number;
  balances: Record<"customers" | "suppliers" | "stock", { mismatched: number; examples: BalanceMismatch[] }>;
  ms: number;
}

/** Rules field by field (jsonb does not keep the order of an object's keys). */
const ruleKey = (rules: PurchaseFigures["associations"]) => JSON.stringify(rules.map((r) => [r.productId, r.relatedProductId, r.pairCount, r.support, r.confidence, r.lift]));

/** Which products' rows differ between two sets of figures. */
function diffFigures(stored: PurchaseFigures, fresh: PurchaseFigures): DriftReport["examples"][number] & { rowCount: number } {
  const a = new Map(stored.rows.map((r) => [r.productId, JSON.stringify(r)]));
  const b = new Map(fresh.rows.map((r) => [r.productId, JSON.stringify(r)]));
  const products = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
  return {
    customerId: "",
    summary: JSON.stringify(stored.summary) !== JSON.stringify(fresh.summary),
    associations: ruleKey(stored.associations) !== ruleKey(fresh.associations),
    products: products.slice(0, 5),
    rowCount: products.length,
  };
}

/** Customers whose figures are rebuilt: those already stored, with bills in the window, or still owing. */
async function customersToRebuild(tx: Tx, businessId: string, since: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select customer_id as id from customer_stats where business_id = ${businessId}
    union
    select distinct customer_id from invoices
    where business_id = ${businessId} and status = 'posted' and (invoice_date >= ${since} or balance_due > 0)
    order by id`);
  return rows.rows.map((r) => r.id);
}

export async function checkBalances(tx: Tx, businessId: string): Promise<NightlyDetails["balances"]> {
  const take = (rows: BalanceMismatch[]) => ({ mismatched: rows.length, examples: rows.slice(0, EXAMPLES) });
  const customers = await tx.execute<BalanceMismatch>(sql`
    select c.id as key, c.balance::text as cached, coalesce(sum(l.debit - l.credit), 0)::numeric(15,2)::text as ledger
    from customers c left join party_ledger_entries l on l.customer_id = c.id and l.party_type = 'customer'
    where c.business_id = ${businessId}
    group by c.id having c.balance <> coalesce(sum(l.debit - l.credit), 0)
    order by c.id`);
  const suppliers = await tx.execute<BalanceMismatch>(sql`
    select s.id as key, s.balance::text as cached, coalesce(sum(l.credit - l.debit), 0)::numeric(15,2)::text as ledger
    from suppliers s left join party_ledger_entries l on l.supplier_id = s.id and l.party_type = 'supplier'
    where s.business_id = ${businessId}
    group by s.id having s.balance <> coalesce(sum(l.credit - l.debit), 0)
    order by s.id`);
  const stock = await tx.execute<BalanceMismatch>(sql`
    with l as (
      select product_id, warehouse_id, batch_id, sum(qty_in - qty_out) as qty
      from stock_ledger where business_id = ${businessId}
      group by product_id, warehouse_id, batch_id
    ), b as (
      select product_id, warehouse_id, batch_id, qty from stock_balances where business_id = ${businessId}
    )
    select concat_ws('/', coalesce(b.product_id, l.product_id), coalesce(b.warehouse_id, l.warehouse_id), coalesce(b.batch_id, l.batch_id)) as key,
           coalesce(b.qty, 0)::text as cached, coalesce(l.qty, 0)::numeric(15,3)::text as ledger
    from b full join l on l.product_id = b.product_id and l.warehouse_id = b.warehouse_id and l.batch_id is not distinct from b.batch_id
    where coalesce(b.qty, 0) <> coalesce(l.qty, 0)
    order by key`);
  return { customers: take(customers.rows), suppliers: take(suppliers.rows), stock: take(stock.rows) };
}

/** The nightly work for one business (its run already claimed). */
export async function nightlyForBusiness(deps: AppDeps, businessId: string, today: string): Promise<NightlyDetails> {
  const started = Date.now();
  const scope = { businessId, userId: "" };
  const outbox = await processBusinessOutbox(deps, businessId);
  const { windowDays, customers } = await withTenant(deps.db, scope, async (tx) => {
    const windowDays = (await getSettings(tx, businessId, ["suggestions.window_days"] as const))["suggestions.window_days"];
    return { windowDays, customers: await customersToRebuild(tx, businessId, addDays(today, -windowDays)) };
  });

  const drift: DriftReport = { checked: 0, customers: 0, rows: 0, examples: [] };
  let statsRows = 0;
  for (let i = 0; i < customers.length; i += CHUNK) {
    await withTenant(deps.db, scope, async (tx) => {
      for (const customerId of customers.slice(i, i + CHUNK)) {
        await lockCustomer(tx, customerId);
        const stored = await readStoredFigures(tx, customerId);
        const from = stored && stored.asOf < today ? stored.asOf : today;
        const until = stored && stored.asOf > today ? stored.asOf : today;
        const data = await loadCustomerData(tx, businessId, customerId, addDays(from, -windowDays), until);
        if (stored) {
          drift.checked++;
          const diff = diffFigures(stored, purchaseFigures(data, stored.asOf, windowDays));
          if (diff.summary || diff.associations || diff.rowCount) {
            drift.customers++;
            drift.rows += diff.rowCount;
            if (drift.examples.length < EXAMPLES) drift.examples.push({ customerId, summary: diff.summary, associations: diff.associations, products: diff.products });
          }
        }
        const fresh = customerFigures(data, today, windowDays);
        await writeFigures(tx, businessId, customerId, fresh);
        statsRows += fresh.rows.length;
      }
    });
  }

  return withTenant(deps.db, scope, async (tx) => {
    const associations = await mineStoreAssociations(tx, businessId, today);
    const balances = await checkBalances(tx, businessId);
    const cutoff = new Date(deps.clock.now().getTime() - OUTBOX_KEEP_DAYS * 86_400_000).toISOString();
    const deleted = await tx
      .delete(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.businessId, businessId), isNotNull(schema.outboxEvents.processedAt), lt(schema.outboxEvents.processedAt, cutoff)))
      .returning({ id: schema.outboxEvents.id });
    const oldNotifications = await tx
      .delete(schema.notifications)
      .where(and(eq(schema.notifications.businessId, businessId), lt(schema.notifications.createdAt, new Date(deps.clock.now().getTime() - NOTIFICATION_KEEP_DAYS * 86_400_000).toISOString())))
      .returning({ id: schema.notifications.id });
    const oldChanges = await tx
      .delete(schema.syncChanges)
      .where(and(eq(schema.syncChanges.businessId, businessId), lt(schema.syncChanges.createdAt, new Date(deps.clock.now().getTime() - SYNC_KEEP_DAYS * 86_400_000).toISOString())))
      .returning({ id: schema.syncChanges.entityId });
    return {
      asOf: today,
      outbox: { ...outbox, deleted: deleted.length },
      notificationsDeleted: oldNotifications.length,
      syncChangesDeleted: oldChanges.length,
      customers: customers.length,
      statsRows,
      drift,
      associations,
      balances,
      ms: Date.now() - started,
    };
  });
}

/** Problems worth an operator's attention, for the error log. */
function findings(d: NightlyDetails): string[] {
  const out: string[] = [];
  if (d.drift.customers) out.push(`purchase history of ${d.drift.customers} customer(s) had drifted from their bills (${d.drift.rows} product rows); rebuilt`);
  for (const [kind, b] of Object.entries(d.balances)) {
    if (b.mismatched) out.push(`${b.mismatched} cached ${kind} balance(s) differ from the ledger`);
  }
  return out;
}

export interface NightlyResult {
  runs: number;
  failed: number;
}

/**
 * Runs the nightly job for the businesses due now. A business's run is claimed
 * by inserting its analytics_runs row for the day (unique), so two API servers
 * never both run it; a failed run is not retried the same day.
 */
export async function runNightlyAnalytics(deps: AppDeps, options: { hour?: number } = {}): Promise<NightlyResult> {
  const hour = options.hour ?? deps.config.nightlyAnalytics.hour;
  const now = deps.clock.now();
  const due = await deps.db.execute<{ business_id: string; time_zone: string }>(
    sql`select business_id, time_zone from nightly_analytics_due(${now.toISOString()}::timestamptz, ${hour}, ${BUSINESSES})`,
  );
  const result: NightlyResult = { runs: 0, failed: 0 };
  for (const { business_id: businessId, time_zone: timeZone } of due.rows) {
    const today = deps.clock.today(timeZone);
    const scope = { businessId, userId: "" };
    const runId = await withTenant(deps.db, scope, async (tx) => {
      const [run] = await tx
        .insert(schema.analyticsRuns)
        .values({ id: uuidv7(), businessId, job: "nightly", asOf: today, status: "running", startedAt: now.toISOString() })
        .onConflictDoNothing()
        .returning({ id: schema.analyticsRuns.id });
      return run?.id ?? null;
    });
    if (!runId) continue;
    result.runs++;
    try {
      const details = await nightlyForBusiness(deps, businessId, today);
      await withTenant(deps.db, scope, (tx) =>
        tx.update(schema.analyticsRuns).set({ status: "completed", finishedAt: deps.clock.now().toISOString(), details }).where(eq(schema.analyticsRuns.id, runId)),
      );
      const found = findings(details);
      if (found.length) {
        deps.errors.record(new Error(`Nightly check: ${found.join("; ")}`), {
          reference: uuidv7(),
          source: "job",
          job: "nightly analytics (checks)",
          details: { businessId, asOf: today, runId },
        });
      }
    } catch (e) {
      result.failed++;
      const message = rootMessage(e);
      await withTenant(deps.db, scope, (tx) =>
        tx.update(schema.analyticsRuns).set({ status: "failed", finishedAt: deps.clock.now().toISOString(), error: message }).where(eq(schema.analyticsRuns.id, runId)),
      );
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "nightly analytics", details: { businessId, asOf: today, runId } });
    }
  }
  return result;
}

/** Looks for businesses due for their nightly run every `seconds`; returns a function that stops it. */
export function startNightlyScheduler(deps: AppDeps, seconds: number, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): () => void {
  if (seconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runNightlyAnalytics(deps);
      if (done.runs) log.info(done, "nightly analytics");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "nightly analytics could not run");
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "nightly analytics (looking for due businesses)" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
