import { daysBetween } from "../dates.js";
import type { Permission } from "../rbac/permissions.js";

/**
 * Reminder rules (Phase 5.2). Each business has one rule per type, seeded on;
 * the owner can switch a rule off and change its settings. Daily rules look
 * at the business once a day after their hour (in its time zone) and leave
 * one notification when there is something to act on; event rules notify as
 * things happen (a new order, a leave request). Who sees a notification is
 * decided by `permission`: everyone whose role has it (and notification.view).
 */
export const REMINDER_TYPES = [
  "customer_payment_due",
  "supplier_payment_due",
  "low_stock",
  "expiring_stock",
  "pending_orders",
  "to_pack",
  "to_dispatch",
  "leave_request",
  "salary_due",
  "devices_unsynced",
  "orders_waiting",
  "customer_reminders",
  "daily_summary",
] as const;

export type ReminderType = (typeof REMINDER_TYPES)[number];

/** Settings a rule can have; each type uses some of them. */
export interface ReminderConfig {
  /** Hour of the day (0–23, the business's time zone) after which the daily check runs. */
  hour: number;
  /** Payment reminders: bills falling due within this many days are mentioned too. */
  daysBefore?: number;
  /** Salary reminder: from this day of the month, if last month's salaries are not paid. */
  dayOfMonth?: number;
  /** Devices reminder: work waiting on a device that has not reported for this many hours; orders: waiting this long at one step. */
  afterHours?: number;
  /** Payment reminders to customers: the first this many days after a bill falls due. */
  firstAfterDays?: number;
  /** ... then again every this many days ... */
  repeatDays?: number;
  /** ... at most this many times for the same overdue bills. */
  maxCount?: number;
  /** ... to customers owing at least this much overdue (rupees). */
  minAmount?: number;
  /** ... by WhatsApp, SMS, email, or WhatsApp and SMS where WhatsApp cannot reach. */
  channel?: ReminderChannel;
  /** Daily summary: the mobile numbers it goes to (none: the business's own phone). */
  recipients?: string[];
}

/** Numbers a daily summary can go to. */
export const MAX_SUMMARY_RECIPIENTS = 5;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

export const REMINDER_CHANNELS = ["whatsapp_or_sms", "whatsapp", "sms", "email"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export interface ReminderDefinition {
  type: ReminderType;
  /** Who sees what it raises. */
  permission: Permission;
  defaults: ReminderConfig;
  /** Also notifies as things happen (new orders, leave requests), not only in the daily check. */
  events: boolean;
  /** Checked every hour from its hour on, not once a day. */
  hourly?: boolean;
  /** Off until the business turns it on (it writes to customers). */
  offByDefault?: boolean;
}

export const REMINDERS: Record<ReminderType, ReminderDefinition> = {
  customer_payment_due: { type: "customer_payment_due", permission: "customer.view_ledger", defaults: { hour: 9, daysBefore: 3 }, events: false },
  supplier_payment_due: { type: "supplier_payment_due", permission: "payment.pay", defaults: { hour: 9, daysBefore: 3 }, events: false },
  low_stock: { type: "low_stock", permission: "purchase.create", defaults: { hour: 9 }, events: false },
  expiring_stock: { type: "expiring_stock", permission: "inventory.view", defaults: { hour: 9 }, events: false },
  pending_orders: { type: "pending_orders", permission: "order.confirm", defaults: { hour: 9 }, events: true },
  to_pack: { type: "to_pack", permission: "packing.pack", defaults: { hour: 9 }, events: true },
  to_dispatch: { type: "to_dispatch", permission: "dispatch.dispatch", defaults: { hour: 9 }, events: true },
  leave_request: { type: "leave_request", permission: "leave.approve", defaults: { hour: 10 }, events: true },
  salary_due: { type: "salary_due", permission: "payroll.run", defaults: { hour: 10, dayOfMonth: 1 }, events: false },
  // Phase 5.3: phones and PCs holding work made offline (or refused by the server) that has not reached it.
  devices_unsynced: { type: "devices_unsynced", permission: "settings.update", defaults: { hour: 9, afterHours: 24 }, events: false },
  // Orders that have waited too long at one step (to confirm, pack or dispatch): looked at every hour.
  orders_waiting: { type: "orders_waiting", permission: "order.confirm", defaults: { hour: 9, afterHours: 4 }, events: false, hourly: true },
  // Payment reminders sent to customers themselves (WhatsApp, SMS or email); staff are told how many went.
  customer_reminders: {
    type: "customer_reminders",
    permission: "message.send",
    defaults: { hour: 10, firstAfterDays: 1, repeatDays: 7, maxCount: 3, minAmount: 100, channel: "whatsapp_or_sms" },
    events: false,
    offByDefault: true,
  },
  // The day in figures (sales, collections, payments, expenses, what is owed) sent to the owner's phone in the evening.
  daily_summary: {
    type: "daily_summary",
    permission: "report.view_sales",
    defaults: { hour: 20, channel: "whatsapp_or_sms", recipients: [] },
    events: false,
    offByDefault: true,
  },
};

export const isReminderType = (value: string): value is ReminderType => (REMINDER_TYPES as readonly string[]).includes(value);

/** A stored config with the type's defaults filled in and out-of-range values replaced. */
export function reminderConfig(type: ReminderType, stored: unknown): ReminderConfig {
  const d = REMINDERS[type].defaults;
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);
  return {
    hour: int(s.hour, 0, 23, d.hour),
    ...(d.daysBefore !== undefined ? { daysBefore: int(s.daysBefore, 0, 30, d.daysBefore) } : {}),
    ...(d.dayOfMonth !== undefined ? { dayOfMonth: int(s.dayOfMonth, 1, 28, d.dayOfMonth) } : {}),
    ...(d.afterHours !== undefined ? { afterHours: int(s.afterHours, 1, 168, d.afterHours) } : {}),
    ...(d.firstAfterDays !== undefined ? { firstAfterDays: int(s.firstAfterDays, 0, 90, d.firstAfterDays) } : {}),
    ...(d.repeatDays !== undefined ? { repeatDays: int(s.repeatDays, 1, 60, d.repeatDays) } : {}),
    ...(d.maxCount !== undefined ? { maxCount: int(s.maxCount, 1, 10, d.maxCount) } : {}),
    ...(d.minAmount !== undefined ? { minAmount: int(s.minAmount, 0, 10_000_000, d.minAmount) } : {}),
    ...(d.recipients !== undefined
      ? {
          recipients: Array.isArray(s.recipients)
            ? [...new Set(s.recipients.filter((m): m is string => typeof m === "string").map((m) => m.replace(/\D/g, "").slice(-10)).filter((m) => INDIAN_MOBILE.test(m)))].slice(0, MAX_SUMMARY_RECIPIENTS)
            : d.recipients,
        }
      : {}),
    ...(d.channel !== undefined ? { channel: (REMINDER_CHANNELS as readonly unknown[]).includes(s.channel) ? (s.channel as ReminderChannel) : d.channel } : {}),
  };
}

/**
 * Whether a customer gets an automatic payment reminder today: the oldest
 * overdue bill fell due at least `firstAfterDays` ago, fewer than `maxCount`
 * went out since it fell due, and the last one is `repeatDays` old. Paying
 * the overdue bills starts the count again (the oldest due date moves on).
 */
export function customerReminderDue(input: { today: string; oldestDue: string; sentSinceDue: number; lastSentOn: string | null; config: ReminderConfig }): { due: boolean; reason: "not_yet" | "enough" | "too_soon" | "due"; daysOverdue: number } {
  const c = { ...REMINDERS.customer_reminders.defaults, ...input.config };
  const daysOverdue = daysBetween(input.oldestDue, input.today);
  if (daysOverdue < c.firstAfterDays!) return { due: false, reason: "not_yet", daysOverdue };
  if (input.sentSinceDue >= c.maxCount!) return { due: false, reason: "enough", daysOverdue };
  if (input.lastSentOn && daysBetween(input.lastSentOn, input.today) < c.repeatDays!) return { due: false, reason: "too_soon", daysOverdue };
  return { due: true, reason: "due", daysOverdue };
}

/** Every permission a notification can be addressed to (to find which of them a person holds): the reminder rules', invoice.review for bills made offline that are held, and invoice.create for repeat bills. */
export const NOTIFICATION_PERMISSIONS: readonly Permission[] = [...new Set([...Object.values(REMINDERS).map((r) => r.permission), "invoice.review" as const, "invoice.create" as const])];
