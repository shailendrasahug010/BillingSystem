import { addDays, isReminderType, REMINDERS, reminderConfig, type ReminderConfig, type ReminderType } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import { notify, type NewNotification } from "./notifications.js";
import { getSettings } from "./settings.js";

/**
 * The daily reminder checks (Phase 5.2). Once a day after each rule's hour, in
 * the business's time zone, every active rule looks at the business and leaves
 * one notification when there is something to act on (bills overdue, stock
 * low, orders waiting ...). A rule is claimed for the day by moving its
 * last_run_on, and each notification carries a dedupe key, so a reminder
 * fires once per condition even with several API servers.
 */

/** Businesses per scheduler run. */
const BUSINESSES = 50;

/** The hour (0–23) of an instant in a time zone. */
export function localHour(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at)) % 24;
}

interface CheckContext {
  tx: Tx;
  businessId: string;
  today: string;
  /** The moment of the check (the API's clock). */
  at: Date;
  config: ReminderConfig;
}

type Check = (c: CheckContext) => Promise<NewNotification | null>;

const base = (type: ReminderType, today: string) => ({ type, permission: REMINDERS[type].permission, dedupeKey: `${type}:${today}` });

/** Bills to be paid to us (customers) or by us (suppliers): overdue, and falling due within `daysBefore`. */
async function dues(c: CheckContext, table: "invoices" | "purchases") {
  const until = addDays(c.today, c.config.daysBefore ?? 0);
  const party = table === "invoices" ? sql.raw("customer_id") : sql.raw("supplier_id");
  const [row] = (
    await c.tx.execute<{ overdue_count: number; overdue_amount: string; overdue_parties: number; due_count: number; due_amount: string }>(sql`
      select count(*) filter (where d.due < ${c.today})::int as overdue_count,
             coalesce(sum(d.balance_due) filter (where d.due < ${c.today}), 0)::numeric(15,2)::text as overdue_amount,
             count(distinct d.party) filter (where d.due < ${c.today})::int as overdue_parties,
             count(*) filter (where d.due between ${c.today} and ${until})::int as due_count,
             coalesce(sum(d.balance_due) filter (where d.due between ${c.today} and ${until}), 0)::numeric(15,2)::text as due_amount
      from (
        select ${party} as party, balance_due, coalesce(due_date, ${sql.raw(table === "invoices" ? "invoice_date" : "supplier_invoice_date")}) as due
        from ${sql.raw(table)} where business_id = ${c.businessId} and status = 'posted' and balance_due > 0
      ) d`)
  ).rows;
  return row!;
}

const CHECKS: Record<ReminderType, Check> = {
  async customer_payment_due(c) {
    const d = await dues(c, "invoices");
    if (!d.overdue_count && !d.due_count) return null;
    const params = { count: d.overdue_count, overdueAmount: d.overdue_amount, customers: d.overdue_parties, dueCount: d.due_count, dueAmount: d.due_amount, days: c.config.daysBefore ?? 0 };
    return d.overdue_count
      ? { ...base("customer_payment_due", c.today), severity: "warning", titleKey: "notifications.customer_payment_due.overdue", bodyKey: d.due_count ? "notifications.customer_payment_due.alsoDue" : null, params }
      : { ...base("customer_payment_due", c.today), titleKey: "notifications.customer_payment_due.soon", params: { ...params, count: d.due_count } };
  },

  async supplier_payment_due(c) {
    const d = await dues(c, "purchases");
    if (!d.overdue_count && !d.due_count) return null;
    const params = { count: d.overdue_count, overdueAmount: d.overdue_amount, suppliers: d.overdue_parties, dueCount: d.due_count, dueAmount: d.due_amount, days: c.config.daysBefore ?? 0 };
    return d.overdue_count
      ? { ...base("supplier_payment_due", c.today), severity: "warning", titleKey: "notifications.supplier_payment_due.overdue", bodyKey: d.due_count ? "notifications.supplier_payment_due.alsoDue" : null, params }
      : { ...base("supplier_payment_due", c.today), titleKey: "notifications.supplier_payment_due.soon", params: { ...params, count: d.due_count } };
  },

  async low_stock(c) {
    const rows = (
      await c.tx.execute<{ name: string; qty: string }>(sql`
        select p.name, coalesce(st.qty, 0)::text as qty
        from products p left join lateral (select sum(qty) as qty from stock_balances sb where sb.product_id = p.id) st on true
        where p.business_id = ${c.businessId} and p.deleted_at is null and p.is_active and p.min_stock is not null
          and coalesce(st.qty, 0) <= p.min_stock
        order by coalesce(st.qty, 0) / nullif(p.min_stock, 0) nulls first, p.name`)
    ).rows;
    if (!rows.length) return null;
    const out = rows.filter((r) => Number(r.qty) <= 0).length;
    return {
      ...base("low_stock", c.today),
      severity: out ? "warning" : "info",
      titleKey: "notifications.low_stock.title",
      bodyKey: out ? "notifications.low_stock.withOut" : "notifications.low_stock.body",
      params: { count: rows.length, outOfStock: out, product: rows[0]!.name },
    };
  },

  async expiring_stock(c) {
    const days = (await getSettings(c.tx, c.businessId, ["stock.expiry_warning_days"] as const))["stock.expiry_warning_days"];
    const rows = (
      await c.tx.execute<{ product: string; expiry: string }>(sql`
        select p.name as product, bt.expiry_date::text as expiry
        from batches bt join products p on p.id = bt.product_id
        where bt.business_id = ${c.businessId} and bt.expiry_date <= ${addDays(c.today, days)}
          and exists (select 1 from stock_balances sb where sb.batch_id = bt.id and sb.qty > 0)
        order by bt.expiry_date, p.name`)
    ).rows;
    if (!rows.length) return null;
    const expired = rows.filter((r) => r.expiry < c.today).length;
    return {
      ...base("expiring_stock", c.today),
      severity: expired ? "warning" : "info",
      titleKey: "notifications.expiring_stock.title",
      bodyKey: expired ? "notifications.expiring_stock.withExpired" : "notifications.expiring_stock.body",
      params: { count: rows.length, days, expired, product: rows[0]!.product, date: rows[0]!.expiry },
    };
  },

  async pending_orders(c) {
    return orderCount(c, "pending_orders", sql`status = 'pending'`, "requireConfirmation");
  },
  async to_pack(c) {
    return orderCount(c, "to_pack", sql`status in ('confirmed', 'packing')`, "usePacking");
  },
  async to_dispatch(c) {
    return orderCount(c, "to_dispatch", sql`status = 'packed'`, "useDispatch");
  },

  async leave_request(c) {
    const [row] = (await c.tx.execute<{ n: number }>(sql`select count(*)::int as n from leave_requests where business_id = ${c.businessId} and status = 'pending'`)).rows;
    if (!row!.n) return null;
    return { ...base("leave_request", c.today), titleKey: "notifications.leave_request.title", params: { count: row!.n } };
  },

  async devices_unsynced(c) {
    return devicesUnsynced(c);
  },

  async salary_due(c) {
    if (Number(c.today.slice(8, 10)) < (c.config.dayOfMonth ?? 1)) return null;
    const month = `${addDays(`${c.today.slice(0, 7)}-01`, -1).slice(0, 7)}`;
    const [row] = (
      await c.tx.execute<{ employees: number; status: string | null }>(sql`
        select (select count(*) from employees e where e.business_id = ${c.businessId} and e.deleted_at is null
                  and e.joining_date < ${`${c.today.slice(0, 7)}-01`} and e.status in ('active', 'on_notice'))::int as employees,
               (select r.status::text from payroll_runs r where r.business_id = ${c.businessId} and r.period_month = ${`${month}-01`}) as status`)
    ).rows;
    if (!row!.employees || row!.status === "paid") return null;
    const run = row!.status === "cancelled" ? null : row!.status;
    return {
      type: "salary_due",
      permission: REMINDERS.salary_due.permission,
      // Once a month, not daily: the condition is "last month's salaries not paid".
      dedupeKey: `salary_due:${month}`,
      severity: "warning",
      titleKey: "notifications.salary_due.title",
      bodyKey: run ? `notifications.salary_due.${run === "finalized" ? "finalized" : "draft"}` : "notifications.salary_due.noRun",
      params: { month, count: row!.employees },
    };
  },
};

/**
 * Phones and PCs holding work that has not reached the server: work made
 * offline on a device that has not reported for `afterHours` (it can report
 * only while online, so it is still away with it), or work the server
 * refused that waits on the device for someone to fix or remove.
 */
async function devicesUnsynced(c: CheckContext): Promise<NewNotification | null> {
  const since = new Date(c.at.getTime() - (c.config.afterHours ?? 24) * 3_600_000).toISOString();
  const rows = (
    await c.tx.execute<{ name: string; person: string; waiting: number; refused: number; oldest: string | null }>(sql`
      select d.name, u.name as person, d.queue_waiting as waiting, d.queue_refused as refused,
             (d.queue_oldest_at at time zone b.time_zone)::date::text as oldest
      from devices d join users u on u.id = d.user_id join businesses b on b.id = d.business_id
      where d.business_id = ${c.businessId} and d.revoked_at is null
        and (d.queue_refused > 0 or (d.queue_waiting > 0 and coalesce(d.queue_reported_at, d.last_seen_at) < ${since}::timestamptz))
      order by d.queue_refused desc, d.queue_oldest_at nulls last, d.name`)
  ).rows;
  if (!rows.length) return null;
  const first = rows[0]!;
  return {
    ...base("devices_unsynced", c.today),
    severity: "warning",
    titleKey: "notifications.devices_unsynced.title",
    bodyKey: first.refused > 0 ? "notifications.devices_unsynced.refused" : "notifications.devices_unsynced.body",
    params: {
      count: rows.length,
      device: first.name,
      person: first.person,
      waiting: first.waiting,
      refused: first.refused,
      date: first.oldest,
    },
  };
}

async function orderCount(c: CheckContext, type: "pending_orders" | "to_pack" | "to_dispatch", where: ReturnType<typeof sql>, step: "requireConfirmation" | "usePacking" | "useDispatch"): Promise<NewNotification | null> {
  const workflow = (await getSettings(c.tx, c.businessId, ["orders.workflow"] as const))["orders.workflow"];
  if (workflow[step] === false) return null;
  const [row] = (
    await c.tx.execute<{ n: number; oldest: string | null }>(sql`
      select count(*)::int as n, min(order_date)::text as oldest from sales_orders where business_id = ${c.businessId} and ${where}`)
  ).rows;
  if (!row!.n) return null;
  return { ...base(type, c.today), titleKey: `notifications.${type}.title`, params: { count: row!.n, date: row!.oldest } };
}

/** What a rule's check would raise today (for the checks themselves and their tests). */
export async function checkReminder(tx: Tx, businessId: string, type: ReminderType, today: string, config: ReminderConfig = reminderConfig(type, {}), at = new Date()): Promise<NewNotification | null> {
  return CHECKS[type]({ tx, businessId, today, at, config });
}

export interface ReminderRunResult {
  businesses: number;
  checked: number;
  notifications: number;
  failed: number;
}

/**
 * Runs the daily checks that are due now: for each business with a due rule,
 * claims each active rule whose hour has come (FOR UPDATE SKIP LOCKED, then
 * last_run_on = today) and leaves its notification. A check that fails is
 * written to the error log; its rule stays claimed for the day.
 */
export async function runDueReminders(deps: AppDeps): Promise<ReminderRunResult> {
  const now = deps.clock.now();
  const due = await deps.db.execute<{ business_id: string; time_zone: string }>(
    sql`select business_id, time_zone from reminder_rules_due(${now.toISOString()}::timestamptz, ${BUSINESSES})`,
  );
  const result: ReminderRunResult = { businesses: 0, checked: 0, notifications: 0, failed: 0 };
  for (const { business_id: businessId, time_zone: timeZone } of due.rows) {
    const today = deps.clock.today(timeZone);
    const hour = localHour(now, timeZone);
    const failures: Array<{ type: string; error: unknown }> = [];
    await withTenant(deps.db, { businessId, userId: "" }, async (tx) => {
      const r = schema.reminderRules;
      const rules = await tx
        .select()
        .from(r)
        .where(and(eq(r.businessId, businessId), eq(r.isActive, true), or(isNull(r.lastRunOn), lt(r.lastRunOn, today))))
        .for("update", { skipLocked: true });
      result.businesses++;
      for (const rule of rules) {
        if (!isReminderType(rule.type)) continue;
        const config = reminderConfig(rule.type, rule.config);
        if (hour < config.hour) continue;
        await tx.update(r).set({ lastRunOn: today, updatedAt: now.toISOString() }).where(eq(r.id, rule.id));
        result.checked++;
        try {
          // A savepoint: a failing check does not undo the others (or the claim).
          const created = await tx.transaction(async (sp) => {
            const n = await checkReminder(sp, businessId, rule.type as ReminderType, today, config, now);
            return n ? notify(sp, businessId, n, now.toISOString()) : null;
          });
          if (created) result.notifications++;
        } catch (error) {
          result.failed++;
          failures.push({ type: rule.type, error });
        }
      }
    });
    for (const f of failures) {
      deps.errors.record(f.error, { reference: uuidv7(), source: "job", job: `daily reminder check (${f.type})`, details: { businessId, today } });
    }
  }
  return result;
}

/** Looks for due reminder checks every `seconds`; returns a function that stops it. */
export function startReminderScheduler(deps: AppDeps, seconds: number, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): () => void {
  if (seconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runDueReminders(deps);
      if (done.notifications || done.failed) log.info(done, "daily reminders");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "daily reminders could not run");
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "daily reminders (looking for due checks)" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
