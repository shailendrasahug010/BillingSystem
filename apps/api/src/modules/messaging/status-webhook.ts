import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import type { AppDeps } from "../../lib/context.js";
import { notify } from "../../services/notifications.js";
import type { ApiModule } from "../types.js";

/** A status the provider reports for a message it sent. */
interface StatusEvent {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
  error: string | null;
}

const MetaPayload = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  metadata: z.object({ phone_number_id: z.string() }).partial().optional(),
                  messages: z
                    .array(z.object({ from: z.string(), timestamp: z.string().optional(), type: z.string().optional(), text: z.object({ body: z.string() }).optional() }))
                    .optional(),
                  statuses: z
                    .array(
                      z.object({
                        id: z.string(),
                        status: z.string(),
                        timestamp: z.string().optional(),
                        errors: z.array(z.object({ title: z.string().optional(), message: z.string().optional() })).optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** A provider behind the signed webhook reports the same way, without Meta's envelope. */
const ProviderPayload = z.object({
  statuses: z.array(z.object({ id: z.string(), status: z.string(), timestamp: z.union([z.string(), z.number()]).optional(), error: z.string().optional() })).default([]),
  /** Messages customers wrote (only STOP and START are acted on). */
  messages: z.array(z.object({ from: z.string(), text: z.string(), timestamp: z.union([z.string(), z.number()]).optional() })).default([]),
});

/** A message a customer wrote to the business's number. */
interface Reply {
  from: string;
  text: string;
  at: Date;
}

/** STOP (or बंद) stops payment reminders; START brings them back if the customer had stopped them so. */
const STOP = /^\s*(stop|unsubscribe|band|band karo|बंद|बंद करें|बंद करो)\s*[.!।]?\s*$/i;
const START = /^\s*(start|resume|shuru|शुरू|चालू)\s*[.!।]?\s*$/i;

const KNOWN = new Set(["sent", "delivered", "read", "failed"]);
const when = (ts: string | number | undefined) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

const sameSignature = (expected: string, given: string) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Moves messages forward only: sent → delivered → read. A late "delivered"
 * after "read" changes nothing; "failed" only replaces sent (or queued).
 */
async function applyStatuses(tx: Tx, businessId: string, events: StatusEvent[]): Promise<number> {
  const m = schema.messages;
  let changed = 0;
  for (const e of events) {
    const mine = and(eq(m.businessId, businessId), eq(m.providerMessageId, e.id), eq(m.channel, "whatsapp"));
    const at = e.at.toISOString();
    const rows =
      e.status === "read"
        ? await tx
            .update(m)
            .set({ status: "read", readAt: sql`coalesce(${m.readAt}, ${at}::timestamptz)`, deliveredAt: sql`coalesce(${m.deliveredAt}, ${at}::timestamptz)`, error: null, updatedAt: sql`now()` })
            .where(and(mine, inArray(m.status, ["queued", "sent", "delivered", "failed"])))
            .returning({ id: m.id })
        : e.status === "delivered"
          ? await tx
              .update(m)
              .set({ status: "delivered", deliveredAt: sql`coalesce(${m.deliveredAt}, ${at}::timestamptz)`, error: null, updatedAt: sql`now()` })
              .where(and(mine, inArray(m.status, ["queued", "sent", "failed"])))
              .returning({ id: m.id })
          : e.status === "sent"
            ? await tx
                .update(m)
                .set({ status: "sent", sentAt: sql`coalesce(${m.sentAt}, ${at}::timestamptz)`, updatedAt: sql`now()` })
                .where(and(mine, eq(m.status, "queued")))
                .returning({ id: m.id })
            : await tx
                .update(m)
                .set({ status: "failed", error: (e.error ?? "Not delivered").slice(0, 500), updatedAt: sql`now()` })
                .where(and(mine, inArray(m.status, ["queued", "sent"])))
                .returning({ id: m.id });
    changed += rows.length;
  }
  return changed;
}

/**
 * Customers who wrote STOP no longer get payment reminders (the staff who
 * send messages are told); START undoes a STOP of theirs, not a stop the
 * business set. Matched by the last ten digits of the mobile.
 */
async function applyReplies(tx: Tx, businessId: string, replies: Reply[]): Promise<void> {
  for (const r of replies) {
    const mobile = r.from.replace(/\D/g, "").slice(-10);
    if (mobile.length !== 10) continue;
    const sameMobile = sql`right(regexp_replace(coalesce(${schema.customers.mobile}, ''), '\\D', '', 'g'), 10) = ${mobile}`;
    if (STOP.test(r.text)) {
      const stopped = await tx
        .update(schema.customers)
        .set({ remindersOptOut: true, remindersOptOutAt: r.at.toISOString(), remindersOptOutBy: "reply", updatedAt: sql`now()` })
        .where(and(eq(schema.customers.businessId, businessId), sameMobile, eq(schema.customers.remindersOptOut, false), sql`${schema.customers.deletedAt} is null`))
        .returning({ id: schema.customers.id, name: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})` });
      for (const c of stopped) {
        await notify(
          tx,
          businessId,
          {
            type: "reminders_stopped",
            permission: "message.send",
            severity: "info",
            titleKey: "notifications.events.reminders_stopped",
            params: { customer: c.name },
            entityType: "customer",
            entityId: c.id,
            dedupeKey: `reminders_stopped:${c.id}:${r.at.toISOString()}`,
          },
          r.at.toISOString(),
        );
      }
    } else if (START.test(r.text)) {
      await tx
        .update(schema.customers)
        .set({ remindersOptOut: false, remindersOptOutAt: null, remindersOptOutBy: null, updatedAt: sql`now()` })
        .where(and(eq(schema.customers.businessId, businessId), sameMobile, eq(schema.customers.remindersOptOutBy, "reply")));
    }
  }
}

/** One transaction in the business the callback's key belongs to (none: null). */
async function inBusinessOfKey<T>(deps: AppDeps, key: string, fn: (tx: Tx, businessId: string) => Promise<T>): Promise<T | null> {
  return deps.db.transaction(async (tx) => {
    const found = await tx.execute<{ business_id: string | null }>(sql`select whatsapp_status_business(${key}) as business_id`);
    const businessId = found.rows[0]?.business_id;
    if (!businessId) return null;
    await tx.execute(sql`select set_config('app.business_id', ${businessId}, true), set_config('app.user_id', '', true)`);
    return fn(tx, businessId);
  });
}

/**
 * Delivery and read ticks for WhatsApp. Each business has its own callback
 * address (/webhooks/whatsapp/<key>), shown in Settings → WhatsApp, SMS & email:
 * - Meta calls GET once to check it (hub.verify_token = the key) and then
 *   POSTs status changes signed with the app's secret (X-Hub-Signature-256).
 * - A provider behind the business's own webhook POSTs { statuses: [...] }
 *   signed like our messages to it: HMAC-SHA256 of "<timestamp>.<body>" with
 *   the shared secret, sent in X-DigitalBahi-Timestamp / -Signature.
 * Unsigned or wrongly signed calls change nothing.
 */
export const messagingStatusModule: ApiModule = async (app, deps) => {
  await app.register(async (hooks) => {
    // The signature covers the exact bytes sent, so the body is kept raw here.
    hooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const limit = { rateLimit: { max: 3000, timeWindow: "1 minute" } };
    const Key = z.object({ key: z.string().min(16).max(40).regex(/^[A-Za-z0-9_-]+$/) });

    hooks.get("/webhooks/whatsapp/:key", { config: limit, schema: { hide: true } }, async (request, reply) => {
      const params = Key.safeParse(request.params);
      const q = request.query as Record<string, string | undefined>;
      if (!params.success || q["hub.mode"] !== "subscribe" || q["hub.verify_token"] !== params.data.key || !q["hub.challenge"]) throw new ApiError(403, "FORBIDDEN");
      const known = await inBusinessOfKey(deps, params.data.key, async () => true);
      if (!known) throw new ApiError(403, "FORBIDDEN");
      return reply.type("text/plain").send(q["hub.challenge"]);
    });

    hooks.post("/webhooks/whatsapp/:key", { config: limit, schema: { hide: true } }, async (request, reply) => {
      const params = Key.safeParse(request.params);
      const raw = request.body;
      if (!params.success || !Buffer.isBuffer(raw)) throw new ApiError(403, "FORBIDDEN");
      const result = await inBusinessOfKey(deps, params.data.key, async (tx, businessId) => {
        const [settings] = await tx.select().from(schema.messagingSettings).where(eq(schema.messagingSettings.businessId, businessId));
        if (!settings) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          return false;
        }
        const events: StatusEvent[] = [];
        const replies: Reply[] = [];
        if (settings.whatsappProvider === "meta") {
          const secret = settings.whatsappAppSecret ? deps.cipher.decrypt(settings.whatsappAppSecret) : null;
          const given = String(request.headers["x-hub-signature-256"] ?? "");
          if (!secret || !sameSignature(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`, given)) return false;
          const body = MetaPayload.safeParse(parsed);
          if (!body.success) return true;
          for (const entry of body.data.entry ?? []) {
            for (const change of entry.changes ?? []) {
              const value = change.value;
              // Statuses for another number of the same Meta account are not this business's.
              if (value?.metadata?.phone_number_id && settings.whatsappPhoneNumberId && value.metadata.phone_number_id !== settings.whatsappPhoneNumberId) continue;
              for (const st of value?.statuses ?? []) {
                if (!KNOWN.has(st.status)) continue;
                events.push({ id: st.id, status: st.status as StatusEvent["status"], at: when(st.timestamp), error: st.errors?.[0]?.title ?? st.errors?.[0]?.message ?? null });
              }
              for (const msg of value?.messages ?? []) if (msg.text?.body) replies.push({ from: msg.from, text: msg.text.body, at: when(msg.timestamp) });
            }
          }
        } else if (settings.whatsappProvider === "webhook") {
          const secret = settings.whatsappSecret ? deps.cipher.decrypt(settings.whatsappSecret) : null;
          const timestamp = String(request.headers["x-digitalbahi-timestamp"] ?? "");
          const given = String(request.headers["x-digitalbahi-signature"] ?? "");
          const fresh = Math.abs(deps.clock.now().getTime() / 1000 - Number(timestamp)) <= 300;
          if (!secret || !fresh || !sameSignature(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw.toString("utf8")}`).digest("hex")}`, given)) return false;
          const body = ProviderPayload.safeParse(parsed);
          if (!body.success) return true;
          for (const st of body.data.statuses) {
            if (!KNOWN.has(st.status)) continue;
            events.push({ id: st.id, status: st.status as StatusEvent["status"], at: when(st.timestamp), error: st.error ?? null });
          }
          for (const msg of body.data.messages) replies.push({ from: msg.from, text: msg.text, at: when(msg.timestamp) });
        } else return false;
        await applyStatuses(tx, businessId, events);
        await applyReplies(tx, businessId, replies);
        return true;
      });
      if (!result) throw new ApiError(403, "FORBIDDEN");
      // Meta retries anything but 200.
      return reply.code(200).send({ ok: true });
    });
  });
};
