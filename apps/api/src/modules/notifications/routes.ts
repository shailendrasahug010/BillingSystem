import { isReminderType, REMINDER_TYPES, REMINDERS, reminderConfig } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { NotificationHub } from "../../services/notification-hub.js";
import { heldPermissions, isFor, notify, visibleTo } from "../../services/notifications.js";
import { checkReminder } from "../../services/reminders.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const TypeParams = z.object({ type: z.string().max(40) });
const ListQuery = z.object({
  status: z.enum(["all", "unread"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});
const RulePatch = z.strictObject({
  isActive: z.boolean().optional(),
  /** Settings that do not apply to the rule's type are ignored. */
  config: z
    .strictObject({
      hour: z.number().int().min(0).max(23).optional(),
      daysBefore: z.number().int().min(0).max(30).optional(),
      dayOfMonth: z.number().int().min(1).max(28).optional(),
      afterHours: z.number().int().min(1).max(168).optional(),
    })
    .optional(),
});

type Row = {
  id: string;
  type: string;
  severity: string;
  title_key: string;
  body_key: string | null;
  params: Record<string, unknown>;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  read_at: string | null;
};

const json = (r: Row) => ({
  id: r.id,
  type: r.type,
  severity: r.severity,
  titleKey: r.title_key,
  bodyKey: r.body_key,
  params: r.params,
  entityType: r.entity_type,
  entityId: r.entity_id,
  createdAt: r.created_at,
  readAt: r.read_at,
});

/** The person's unread notifications (not read, not dismissed). */
async function unreadCount(tx: Tx, ctx: RequestCtx): Promise<number> {
  const [row] = (
    await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from notifications n
      left join notification_receipts r on r.notification_id = n.id and r.user_id = ${ctx.userId}
      where n.business_id = ${ctx.businessId} and ${visibleTo(ctx.userId, heldPermissions(ctx.grants))}
        and r.read_at is null and r.dismissed_at is null`)
  ).rows;
  return row!.n;
}

/** The notification, if this person may see it. */
async function visible(tx: Tx, ctx: RequestCtx, id: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    select 1 from notifications n where n.id = ${id} and n.business_id = ${ctx.businessId} and ${visibleTo(ctx.userId, heldPermissions(ctx.grants))}`);
  return rows.rows.length > 0;
}

async function setReceipt(tx: Tx, ctx: RequestCtx, id: string, at: string, dismiss: boolean): Promise<void> {
  const r = schema.notificationReceipts;
  await tx
    .insert(r)
    .values({ notificationId: id, userId: ctx.userId, businessId: ctx.businessId, readAt: at, dismissedAt: dismiss ? at : null })
    .onConflictDoUpdate({
      target: [r.notificationId, r.userId],
      set: { readAt: sql`coalesce(${r.readAt}, excluded.read_at)`, ...(dismiss ? { dismissedAt: sql`coalesce(${r.dismissedAt}, excluded.dismissed_at)` } : {}) },
    });
}

const ruleJson = (type: (typeof REMINDER_TYPES)[number], row: { isActive: boolean; config: unknown; lastRunOn: string | null } | undefined) => ({
  type,
  permission: REMINDERS[type].permission,
  events: REMINDERS[type].events,
  isActive: row?.isActive ?? true,
  config: reminderConfig(type, row?.config),
  defaults: REMINDERS[type].defaults,
  lastRunOn: row?.lastRunOn ?? null,
});

export const notificationsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const hub = new NotificationHub(deps.config.databaseUrl, (e) => deps.errors.record(e, { reference: uuidv7(), source: "job", job: "notifications live stream (listening)" }));
  app.addHook("onClose", () => hub.close());

  /** The person's notifications, newest first: theirs and those for a permission their role has. */
  r.get("/notifications", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"], querystring: ListQuery } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    return tenant(ctx, async (tx) => {
      const rows = await tx.execute<Row>(sql`
        select n.id, n.type, n.severity::text, n.title_key, n.body_key, n.params, n.entity_type, n.entity_id, n.created_at, r.read_at
        from notifications n
        left join notification_receipts r on r.notification_id = n.id and r.user_id = ${ctx.userId}
        where n.business_id = ${ctx.businessId} and ${visibleTo(ctx.userId, heldPermissions(ctx.grants))} and r.dismissed_at is null
          ${q.status === "unread" ? sql`and r.read_at is null` : sql``}
          ${cursor ? sql`and (n.created_at, n.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by n.created_at desc, n.id desc
        limit ${q.limit + 1}`);
      const list = rows.rows.map((x) => ({ ...x, created_at: new Date(x.created_at).toISOString(), read_at: x.read_at ? new Date(x.read_at).toISOString() : null }));
      const { data, nextCursor } = page(list, q.limit, (x) => ({ v: x.created_at, id: x.id }));
      return { data: data.map(json), nextCursor, unread: await unreadCount(tx, ctx) };
    });
  });

  r.get("/notifications/unread-count", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"] } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    return tenant(ctx, async (tx) => ({ unread: await unreadCount(tx, ctx) }));
  });

  r.post("/notifications/:id/read", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"], params: IdParams } }, async (request, reply) => {
    const ctx: RequestCtx = request.ctx;
    await tenant(ctx, async (tx) => {
      if (!(await visible(tx, ctx, request.params.id))) throw notFound("notification");
      await setReceipt(tx, ctx, request.params.id, deps.clock.now().toISOString(), false);
    });
    return reply.code(204).send();
  });

  r.post("/notifications/:id/dismiss", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"], params: IdParams } }, async (request, reply) => {
    const ctx: RequestCtx = request.ctx;
    await tenant(ctx, async (tx) => {
      if (!(await visible(tx, ctx, request.params.id))) throw notFound("notification");
      await setReceipt(tx, ctx, request.params.id, deps.clock.now().toISOString(), true);
    });
    return reply.code(204).send();
  });

  /** Marks everything the person can see as read. */
  r.post("/notifications/read-all", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"] } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const now = deps.clock.now().toISOString();
    return tenant(ctx, async (tx) => {
      const res = await tx.execute<{ notification_id: string }>(sql`
        insert into notification_receipts (notification_id, user_id, business_id, read_at)
        select n.id, ${ctx.userId}, ${ctx.businessId}, ${now}::timestamptz from notifications n
        left join notification_receipts r on r.notification_id = n.id and r.user_id = ${ctx.userId}
        where n.business_id = ${ctx.businessId} and ${visibleTo(ctx.userId, heldPermissions(ctx.grants))} and r.read_at is null
        on conflict (notification_id, user_id) do update set read_at = excluded.read_at where notification_receipts.read_at is null
        returning notification_id`);
      return { marked: res.rows.length };
    });
  });

  /**
   * Server-sent events: `notification` (with the id) whenever one the person may
   * see is created, on any API server. The stream ends when the access token
   * would expire; the app opens it again with a fresh one.
   */
  r.get("/notifications/stream", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"] } }, async (request, reply) => {
    const ctx: RequestCtx = request.ctx;
    const held = new Set(heldPermissions(ctx.grants));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 5000\n\nevent: ready\ndata: {}\n\n");
    let unsubscribe: () => void = () => undefined;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      clearTimeout(expire);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const expire = setTimeout(end, deps.config.jwt.accessTtlSeconds * 1000);
    request.raw.on("close", end);
    try {
      const off = await hub.subscribe({
        businessId: ctx.businessId,
        wants: (p) => isFor(p, ctx.userId, held),
        send: (p) => res.write(`event: notification\ndata: ${JSON.stringify({ id: p.id })}\n\n`),
      });
      if (ended) off();
      else unsubscribe = off;
    } catch (e) {
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "notifications live stream (opening)" });
      res.write("event: unavailable\ndata: {}\n\n");
      end();
    }
  });

  /** The reminder rules, with their settings (defaults filled in). */
  r.get("/reminder-rules", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"] } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    return tenant(ctx, async (tx) => {
      const rows = await tx.select().from(schema.reminderRules).where(eq(schema.reminderRules.businessId, ctx.businessId));
      return { data: REMINDER_TYPES.map((type) => ruleJson(type, rows.find((x) => x.type === type))) };
    });
  });

  /** Switches a rule on or off and changes its settings. */
  r.patch("/reminder-rules/:type", { preHandler: guard(deps, "notification.configure"), schema: { tags: ["notifications"], params: TypeParams, body: RulePatch } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const { type } = request.params;
    if (!isReminderType(type)) throw notFound("reminder_rule");
    return tenant(ctx, async (tx) => {
      const t = schema.reminderRules;
      const [before] = await tx.select().from(t).where(and(eq(t.businessId, ctx.businessId), eq(t.type, type)));
      const isActive = request.body.isActive ?? before?.isActive ?? true;
      const config = reminderConfig(type, { ...reminderConfig(type, before?.config), ...request.body.config });
      const now = deps.clock.now().toISOString();
      const [row] = await tx
        .insert(t)
        .values({ businessId: ctx.businessId, type, isActive, config, updatedAt: now })
        .onConflictDoUpdate({ target: [t.businessId, t.type], set: { isActive, config, updatedAt: now } })
        .returning();
      await audit(tx, ctx, {
        action: "reminder_rule.updated",
        entityType: "reminder_rule",
        entityId: row!.id,
        entityLabel: type,
        changes: { isActive: [before?.isActive ?? true, isActive], config: [reminderConfig(type, before?.config), config] },
      });
      return ruleJson(type, row);
    });
  });

  /**
   * Runs a rule's check now, whatever its hour, so whoever sets it up sees
   * what it says. Its notification is the day's one: the scheduled check
   * later that day finds it there and leaves no second one.
   */
  r.post("/reminder-rules/:type/check", { preHandler: guard(deps, "notification.configure"), schema: { tags: ["notifications"], params: TypeParams } }, async (request) => {
    const ctx: RequestCtx = request.ctx;
    const { type } = request.params;
    if (!isReminderType(type)) throw notFound("reminder_rule");
    return tenant(ctx, async (tx) => {
      const t = schema.reminderRules;
      const [rule] = await tx.select().from(t).where(and(eq(t.businessId, ctx.businessId), eq(t.type, type)));
      if (rule && !rule.isActive) throw conflict("REMINDER_RULE_OFF");
      const n = await checkReminder(tx, ctx.businessId, type, deps.clock.today(ctx.timeZone), reminderConfig(type, rule?.config), deps.clock.now());
      if (!n) return { result: "nothing" as const, notificationId: null };
      const id = await notify(tx, ctx.businessId, n, deps.clock.now().toISOString());
      return { result: id ? ("raised" as const) : ("already" as const), notificationId: id };
    });
  });
};
