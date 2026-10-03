import { hasPermission, type Permission } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { createTranslator, isLocaleCode, notificationText } from "@digitalbahi/i18n";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import type { PushMessage } from "./push.js";

/**
 * Notifications as push messages to phones (Phase 5.2). Creating a
 * notification in a business that has registered phones writes an outbox
 * event (PUSH_EVENT); the outbox worker plans the pushes inside its
 * transaction (who the notification is for, in each phone's language) and
 * sends them once that has committed. A push goes at most once: one lost in a
 * crash is not repeated (the inbox has the notification anyway).
 */

/** The outbox event a new notification writes when the business has phones to push to. */
export const PUSH_EVENT = "notification.created";

/**
 * SQL condition: the phone's sign-in (push_tokens.session_id) is still on and
 * working in the token's business. Signing out, a removed device or member,
 * and moving the sign-in to another business all stop the pushes.
 */
export function liveSession(token: string): SQL {
  const t = sql.raw(token);
  return sql`exists (select 1 from refresh_tokens rt where rt.family_id = ${t}.session_id and rt.business_id = ${t}.business_id
    and rt.revoked_at is null and rt.rotated_at is null and rt.expires_at > now())`;
}

type Phone = {
  id: string;
  token: string;
  locale: string;
  user_id: string;
  grants: string[];
};

/** The phones in the business that may get pushes now: a working sign-in of an active member, with what their role may see. */
async function phones(tx: Tx, businessId: string): Promise<Phone[]> {
  const res = await tx.execute<Phone & { is_owner: boolean }>(sql`
    select pt.id, pt.token, pt.locale, pt.user_id, bm.is_owner, array_remove(array_agg(rp."grant"), null) as grants
    from push_tokens pt
    join business_members bm on bm.business_id = pt.business_id and bm.user_id = pt.user_id and bm.is_active
    join users u on u.id = pt.user_id and u.is_active
    left join role_permissions rp on rp.role_id = bm.role_id
    where pt.business_id = ${businessId} and ${liveSession("pt")}
    group by pt.id, bm.is_owner`);
  // The owner sees everything, whatever their role says (as on sign-in).
  return res.rows.map((r) => ({ ...r, grants: r.is_owner ? ["*"] : (r.grants ?? []) }));
}

export interface PlannedPush {
  /** Empty for a test push. */
  notificationId: string;
  tokenId: string;
  message: PushMessage;
}

/** The pushes for these notifications: each to the phones of the people it is for (as the inbox shows it), in the phone's language. */
export async function planPushes(tx: Tx, businessId: string, notificationIds: string[]): Promise<PlannedPush[]> {
  if (!notificationIds.length) return [];
  const to = (await phones(tx, businessId)).filter((p) => hasPermission(p.grants, "notification.view"));
  if (!to.length) return [];
  const n = schema.notifications;
  const rows = await tx.select().from(n).where(and(eq(n.businessId, businessId), inArray(n.id, notificationIds)));
  const out: PlannedPush[] = [];
  for (const row of rows) {
    for (const phone of to) {
      const forThem = row.userId ? row.userId === phone.user_id : row.permission === null || hasPermission(phone.grants, row.permission as Permission);
      if (!forThem) continue;
      const text = notificationText({ titleKey: row.titleKey, bodyKey: row.bodyKey, params: row.params as Record<string, unknown> }, createTranslator(isLocaleCode(phone.locale) ? phone.locale : "en"));
      out.push({
        notificationId: row.id,
        tokenId: phone.id,
        message: {
          token: phone.token,
          title: text.title,
          body: text.body,
          tag: row.entityId ? `${row.type}:${row.entityId}` : row.type,
          urgent: row.severity === "warning" || row.severity === "critical",
          data: { notificationId: row.id, businessId, type: row.type, ...(row.entityType && row.entityId ? { entityType: row.entityType, entityId: row.entityId } : {}) },
        },
      });
    }
  }
  return out;
}

export interface PushRun {
  sent: number;
  failed: number;
  /** Tokens FCM said no longer work, deleted. */
  removed: number;
}

/**
 * Sends planned pushes (outside any transaction, a few at a time) and records
 * how they went: tokens FCM says are gone are deleted, phones that got one
 * are stamped, and notifications that reached a phone list "push" among
 * their channels. Other failures go to the error log, once per run.
 */
export async function sendPushes(deps: AppDeps, businessId: string, planned: PlannedPush[]): Promise<PushRun> {
  const run: PushRun = { sent: 0, failed: 0, removed: 0 };
  if (!planned.length || deps.push.driver === "off") return run;
  const reached = new Set<string>();
  const worked = new Set<string>();
  const gone = new Set<string>();
  const errors: string[] = [];
  for (let i = 0; i < planned.length; i += 10) {
    const batch = planned.slice(i, i + 10);
    const results = await Promise.all(batch.map((p) => deps.push.send(p.message).catch((e: unknown) => ({ ok: false as const, error: (e as Error).message, invalidToken: false }))));
    results.forEach((r, j) => {
      const p = batch[j]!;
      if (r.ok) {
        run.sent++;
        if (p.notificationId) reached.add(p.notificationId);
        worked.add(p.tokenId);
      } else {
        run.failed++;
        if (r.invalidToken) gone.add(p.tokenId);
        else errors.push(r.error);
      }
    });
  }
  run.removed = gone.size;
  if (reached.size || gone.size) {
    await withTenant(deps.db, { businessId, userId: "" }, async (tx) => {
      const t = schema.pushTokens;
      if (gone.size) await tx.delete(t).where(inArray(t.id, [...gone]));
      if (worked.size) await tx.update(t).set({ lastPushAt: deps.clock.now().toISOString() }).where(inArray(t.id, [...worked]));
      if (reached.size) {
        const ids = sql.join([...reached].map((id) => sql`${id}::uuid`), sql`, `);
        await tx.execute(sql`update notifications set delivered_channels = array_append(coalesce(delivered_channels, '{}'), 'push')
          where id in (${ids}) and not ('push' = any(coalesce(delivered_channels, '{}')))`);
      }
    });
  }
  if (errors.length) {
    deps.errors.record(new Error(`${errors.length} push message(s) not sent; first: ${errors[0]}`), { reference: uuidv7(), source: "job", job: "push messages to phones (FCM)", details: { businessId } });
  }
  return run;
}
