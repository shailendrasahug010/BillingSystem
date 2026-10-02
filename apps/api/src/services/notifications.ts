import { hasPermission, NOTIFICATION_PERMISSIONS, reminderConfig, type Permission, type ReminderConfig, type ReminderType } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { PUSH_EVENT } from "./push-delivery.js";

/**
 * In-app notifications (Phase 5.2). A notification is stored once, as a
 * translation key and parameters (each person reads it in their own
 * language), addressed either to one person (`userId`) or to everyone whose
 * role has a permission. Each person's read / dismissed state is a row in
 * notification_receipts. Phones with the app also get it as a push message
 * (push-delivery.ts).
 */

/** PostgreSQL channel the API servers listen on to push new notifications to open apps. */
export const NOTIFY_CHANNEL = "notifications";

/** Notifications are kept this long, then deleted by the nightly job. */
export const NOTIFICATION_KEEP_DAYS = 90;

export interface NewNotification {
  /** A reminder type or an event kind (order_waiting, leave_decided ...). */
  type: string;
  /** Everyone with this permission sees it; null when it is for one person. */
  permission: Permission | null;
  /** The one person it is for. */
  userId?: string | null;
  severity?: "info" | "success" | "warning" | "critical";
  titleKey: string;
  bodyKey?: string | null;
  params?: Record<string, string | number | null>;
  /** The record to open from it. */
  entityType?: string | null;
  entityId?: string | null;
  /** Once per condition: a second notification with the same key is not created. */
  dedupeKey: string;
}

/** What the live stream tells the API servers about a new notification (never its content). */
export interface NotifyPayload {
  b: string;
  id: string;
  u: string | null;
  p: string | null;
}

/**
 * Creates the notification unless one with the same dedupe key exists, and
 * announces it to the open apps once the transaction commits (NOTIFY is
 * delivered on commit only). Returns its id, or null when it already existed.
 */
export async function notify(tx: Tx, businessId: string, n: NewNotification, at: string): Promise<string | null> {
  const t = schema.notifications;
  const [row] = await tx
    .insert(t)
    .values({
      id: uuidv7(),
      businessId,
      userId: n.userId ?? null,
      permission: n.permission,
      type: n.type,
      severity: n.severity ?? "info",
      titleKey: n.titleKey,
      bodyKey: n.bodyKey ?? null,
      params: n.params ?? {},
      entityType: n.entityType ?? null,
      entityId: n.entityId ?? null,
      dedupeKey: n.dedupeKey,
      deliveredChannels: ["in_app"],
      createdAt: at,
    })
    .onConflictDoNothing({ target: [t.businessId, t.dedupeKey], where: sql`${t.dedupeKey} is not null` })
    .returning({ id: t.id });
  if (!row) return null;
  const payload: NotifyPayload = { b: businessId, id: row.id, u: n.userId ?? null, p: n.permission };
  await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`);
  // Phones with the app get it as a push too: sent by the outbox worker once this commits (push-delivery.ts).
  await tx.execute(sql`
    insert into outbox_events (business_id, event_type, aggregate_type, aggregate_id, payload)
    select ${businessId}, ${PUSH_EVENT}, 'notification', ${row.id}, '{}'::jsonb
    where exists (select 1 from push_tokens where business_id = ${businessId})`);
  return row.id;
}

/** The permissions notifications go to that this person's role holds. */
export function heldPermissions(grants: Iterable<string>): string[] {
  const list = [...grants];
  return NOTIFICATION_PERMISSIONS.filter((p) => hasPermission(list, p));
}

/** Whether a notification (as announced on the live stream) is for this person. */
export function isFor(payload: Pick<NotifyPayload, "u" | "p">, userId: string, held: ReadonlySet<string>): boolean {
  return payload.u ? payload.u === userId : payload.p === null || held.has(payload.p);
}

/** SQL condition: notification `n` is for this person. */
export function visibleTo(userId: string, held: readonly string[]): SQL {
  const forPermission = held.length ? sql`n.permission in (${sql.join(held.map((p) => sql`${p}`), sql`, `)})` : sql`false`;
  return sql`(n.user_id = ${userId} or (n.user_id is null and (n.permission is null or ${forPermission})))`;
}

/** A reminder rule as it applies: on or off, with its settings (defaults filled in; on when no row). */
export async function reminderRule(tx: Tx, businessId: string, type: ReminderType): Promise<{ active: boolean; config: ReminderConfig }> {
  const [row] = await tx
    .select({ isActive: schema.reminderRules.isActive, config: schema.reminderRules.config })
    .from(schema.reminderRules)
    .where(and(eq(schema.reminderRules.businessId, businessId), eq(schema.reminderRules.type, type)));
  return { active: row?.isActive ?? true, config: reminderConfig(type, row?.config) };
}

