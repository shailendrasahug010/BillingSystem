import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { AppDeps } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import type { Channels, Outgoing } from "./transport.js";

/**
 * The business's channels and the queue of messages to send: used by the
 * messaging routes (documents, reminders sent by hand, tests) and by the
 * automatic payment reminders the daily rule sends (services/reminders.ts).
 */

export type Channel = "whatsapp" | "email" | "sms";
export type SettingsRow = typeof schema.messagingSettings.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
/** Who the queue works for: a person's request, or a rule (no user). */
export interface QueueCtx {
  businessId: string;
  userId: string;
  userName?: string | null;
}

export async function loadSettings(tx: Tx, businessId: string): Promise<SettingsRow | null> {
  const [row] = await tx.select().from(schema.messagingSettings).where(eq(schema.messagingSettings.businessId, businessId));
  return row ?? null;
}

export async function businessContact(tx: Tx, businessId: string) {
  const [b] = await tx.select({ name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})`, email: schema.businesses.email }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
  return b!;
}

/** The business's channels with secrets decrypted (never leaves the server). */
export function resolveChannels(deps: AppDeps, row: SettingsRow | null, business: { name: string; email: string | null }): Channels {
  const secret = (sealed: string | null) => (sealed ? deps.cipher.decrypt(sealed) : null);
  const w = row?.whatsappProvider ?? "none";
  const whatsapp: Channels["whatsapp"] =
    w === "meta" && row?.whatsappPhoneNumberId && row.whatsappSecret
      ? { provider: "meta", phoneNumberId: row.whatsappPhoneNumberId, token: secret(row.whatsappSecret)! }
      : w === "webhook" && row?.whatsappWebhookUrl && row.whatsappSecret
        ? { provider: "webhook", url: row.whatsappWebhookUrl, secret: secret(row.whatsappSecret)! }
        : { provider: "none" };
  const mode = row?.emailMode ?? "platform";
  const replyTo = row?.emailReplyTo ?? business.email;
  const fromName = (row?.emailFromName ?? business.name).replace(/["<>]/g, "");
  const platform = deps.config.messaging;
  const email: Channels["email"] =
    mode === "smtp" && row?.smtpHost && row.emailFromAddress
      ? {
          mode: "smtp",
          host: row.smtpHost,
          port: row.smtpPort ?? (row.smtpSecure ? 465 : 587),
          secure: row.smtpSecure,
          user: row.smtpUser,
          password: secret(row.smtpPassword),
          from: `"${fromName}" <${row.emailFromAddress}>`,
          replyTo,
        }
      : mode === "platform" && platform.smtpUrl && platform.mailFrom
        ? { mode: "platform", smtpUrl: platform.smtpUrl, from: `"${fromName} via Digital Bahi" <${platform.mailFrom}>`, replyTo }
        : { mode: "none" };
  const sms: Channels["sms"] =
    row?.smsProvider === "webhook" && row.smsWebhookUrl && row.smsSecret ? { provider: "webhook", url: row.smsWebhookUrl, secret: secret(row.smsSecret)!, senderId: row.smsSenderId } : { provider: "none" };
  return { whatsapp, email, sms };
}

/** A business's channels, ready to send (other modules: backups by email). */
export async function channelsFor(deps: AppDeps, tx: Tx, businessId: string): Promise<Channels> {
  return resolveChannels(deps, await loadSettings(tx, businessId), await businessContact(tx, businessId));
}

/** In "log" mode every channel works (messages are recorded, not sent). */
export const ready = (deps: AppDeps, channels: Channels, channel: Channel) =>
  deps.messenger.driver === "log" ||
  (channel === "whatsapp" ? channels.whatsapp.provider !== "none" : channel === "sms" ? channels.sms.provider !== "none" : channels.email.mode !== "none");

/** Indian mobile to international digits (WhatsApp and SMS); an email address as given. */
export function recipient(channel: Channel, value: string): string | null {
  if (channel === "email") return z.email().safeParse(value.trim()).success ? value.trim() : null;
  const digits = value.replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  return null;
}

export function toOutgoing(row: MessageRow, attachment: Outgoing["attachment"]): Outgoing {
  return { channel: row.channel, to: row.recipient, subject: row.subject, text: row.body, attachment, template: row.template ?? null };
}

/** Sends one logged message and records how it went. */
export async function deliverLogged(deps: AppDeps, ctx: QueueCtx, row: MessageRow, channels: Channels, attachment: Outgoing["attachment"]): Promise<MessageRow> {
  let patch: Partial<MessageRow>;
  try {
    const d = await deps.messenger.deliver(channels, toOutgoing(row, attachment));
    patch = { status: "sent", provider: d.provider, providerMessageId: d.providerMessageId, error: null, sentAt: deps.clock.now().toISOString() };
  } catch (err) {
    patch = { status: "failed", error: (err as Error).message.slice(0, 500) };
  }
  return withTenant(deps.db, ctx, async (tx) => {
    const [updated] = await tx
      .update(schema.messages)
      .set({ ...patch, attempts: sql`${schema.messages.attempts} + 1`, updatedAt: sql`now()` })
      .where(eq(schema.messages.id, row.id))
      .returning();
    return updated!;
  });
}

const pumping = new Map<string, Promise<void>>();

/**
 * Sends the business's queued messages one after another, in the background
 * (one sender per business and API server). The promise ends when the queue
 * is empty, for callers that wait (tests, the daily rule's summary).
 */
export function pumpMessages(deps: AppDeps, ctx: QueueCtx): Promise<void> {
  const running = pumping.get(ctx.businessId);
  if (running) return running;
  const work = (async () => {
    try {
      for (;;) {
        const { rows, channels } = await withTenant(deps.db, ctx, async (tx) => {
          const rows = await tx
            .select()
            .from(schema.messages)
            .where(and(eq(schema.messages.businessId, ctx.businessId), eq(schema.messages.status, "queued")))
            .orderBy(schema.messages.createdAt)
            .limit(10);
          return { rows, channels: resolveChannels(deps, await loadSettings(tx, ctx.businessId), await businessContact(tx, ctx.businessId)) };
        });
        if (!rows.length) break;
        for (const row of rows) await deliverLogged(deps, ctx, row, channels, null);
      }
    } catch (e) {
      // Left queued; the next send for this business picks them up.
      deps.errors.record(e, {
        reference: uuidv7(),
        source: "job",
        job: "sending queued WhatsApp / SMS / email messages",
        ...(ctx.userId ? { user: { id: ctx.userId, name: ctx.userName ?? null, businessId: ctx.businessId } } : {}),
      });
    } finally {
      pumping.delete(ctx.businessId);
    }
  })();
  pumping.set(ctx.businessId, work);
  return work;
}
