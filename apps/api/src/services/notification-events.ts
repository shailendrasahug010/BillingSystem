import { REMINDERS, type ReminderType } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { sql } from "drizzle-orm";
import { notify, reminderRule } from "./notifications.js";
import { getSettings } from "./settings.js";

/**
 * Notifications raised as things happen (Phase 5.2), from outbox events: an
 * order waiting for confirmation, to be packed or to go out; a leave request
 * to decide, and its decision for the employee. Each belongs to a reminder
 * rule and is not raised while that rule is switched off.
 */

type Event = typeof schema.outboxEvents.$inferSelect;

export const NOTIFICATION_EVENTS: ReadonlySet<string> = new Set(["sales_order.created", "sales_order.status_changed", "leave.requested", "leave.decided"]);

/** Order statuses that someone has to act on, with the rule they belong to and the workflow step that must be in use. */
const ORDER_STEPS: Record<string, { rule: ReminderType; kind: string; step: "requireConfirmation" | "usePacking" | "useDispatch" }> = {
  pending: { rule: "pending_orders", kind: "order_waiting", step: "requireConfirmation" },
  confirmed: { rule: "to_pack", kind: "order_to_pack", step: "usePacking" },
  packed: { rule: "to_dispatch", kind: "order_to_dispatch", step: "useDispatch" },
};

async function orderEvent(tx: Tx, businessId: string, ev: Event, at: string): Promise<void> {
  const payload = ev.payload as { to?: string; status?: string };
  const [o] = (
    await tx.execute<{ id: string; number: string | null; status: string; total: string; customer: string }>(sql`
      select o.id, o.order_number as number, o.status::text as status, o.grand_total::text as total, coalesce(c.business_name, c.name) as customer
      from sales_orders o join customers c on c.id = o.customer_id
      where o.id = ${ev.aggregateId} and o.business_id = ${businessId}`)
  ).rows;
  if (!o) return;
  const status = payload.to ?? payload.status ?? o.status;
  const step = ORDER_STEPS[status];
  if (!step) return;
  const workflow = (await getSettings(tx, businessId, ["orders.workflow"] as const))["orders.workflow"];
  if (workflow[step.step] === false) return;
  if (!(await reminderRule(tx, businessId, step.rule)).active) return;
  await notify(
    tx,
    businessId,
    {
      type: step.kind,
      permission: REMINDERS[step.rule].permission,
      titleKey: `notifications.events.${step.kind}`,
      params: { number: o.number, customer: o.customer, total: o.total },
      entityType: "sales_order",
      entityId: o.id,
      dedupeKey: `order:${o.id}:${status}`,
    },
    at,
  );
}

async function leaveEvent(tx: Tx, businessId: string, ev: Event, at: string): Promise<void> {
  if (!(await reminderRule(tx, businessId, "leave_request")).active) return;
  const [r] = (
    await tx.execute<{ id: string; employee: string; user_id: string | null; code: string; from_date: string; to_date: string; days: string; status: string }>(sql`
      select lr.id, e.name as employee, lt.code, lr.from_date::text, lr.to_date::text, lr.days::text, lr.status::text,
             -- The employee's sign-in: linked, or the member of this business with the employee's mobile number.
             coalesce(e.user_id, (
               select bm.user_id from business_members bm join users u on u.id = bm.user_id
               where bm.business_id = lr.business_id and bm.is_active and u.mobile = e.mobile limit 1)) as user_id
      from leave_requests lr join employees e on e.id = lr.employee_id join leave_types lt on lt.id = lr.leave_type_id
      where lr.id = ${ev.aggregateId} and lr.business_id = ${businessId}`)
  ).rows;
  if (!r) return;
  const params = { employee: r.employee, type: r.code, from: r.from_date, to: r.to_date, count: Number(r.days) };
  if (ev.eventType === "leave.requested") {
    await notify(
      tx,
      businessId,
      { type: "leave_requested", permission: REMINDERS.leave_request.permission, titleKey: "notifications.events.leave_requested", params, entityType: "leave_request", entityId: r.id, dedupeKey: `leave:${r.id}:requested` },
      at,
    );
    return;
  }
  // The decision goes to the employee, when they use the app.
  if (!r.user_id || (r.status !== "approved" && r.status !== "rejected")) return;
  await notify(
    tx,
    businessId,
    {
      type: `leave_${r.status}`,
      permission: null,
      userId: r.user_id,
      severity: r.status === "approved" ? "success" : "warning",
      titleKey: `notifications.events.leave_${r.status}`,
      params,
      entityType: "leave_request",
      entityId: r.id,
      dedupeKey: `leave:${r.id}:decided`,
    },
    at,
  );
}

/** Raises the notification an outbox event calls for, if any. */
export async function notifyForEvent(tx: Tx, businessId: string, ev: Event, at: string): Promise<void> {
  if (ev.eventType.startsWith("sales_order.")) return orderEvent(tx, businessId, ev, at);
  if (ev.eventType.startsWith("leave.")) return leaveEvent(tx, businessId, ev, at);
}
