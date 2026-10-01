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
  /** Devices reminder: work waiting on a device that has not reported for this many hours. */
  afterHours?: number;
}

export interface ReminderDefinition {
  type: ReminderType;
  /** Who sees what it raises. */
  permission: Permission;
  defaults: ReminderConfig;
  /** Also notifies as things happen (new orders, leave requests), not only in the daily check. */
  events: boolean;
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
  };
}

/** Every permission a notification can be addressed to (to find which of them a person holds): the reminder rules', and invoice.review for bills made offline that are held. */
export const NOTIFICATION_PERMISSIONS: readonly Permission[] = [...new Set([...Object.values(REMINDERS).map((r) => r.permission), "invoice.review" as const])];
