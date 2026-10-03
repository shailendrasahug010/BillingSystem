import { MessageListQuery, MessagingSettingsBody, ReminderBody, SendDocumentBody, TestMessageBody } from "@digitalbahi/contracts";
import { schema, type Tx } from "@digitalbahi/db";
import { createTranslator, formatCurrency, formatDate, isLocaleCode, type LocaleCode } from "@digitalbahi/i18n";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, forbidden } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { getSettings } from "../../services/settings.js";
import { businessContact, channelsFor, deliverLogged, loadSettings, pumpMessages, ready, recipient, resolveChannels, type Channel, type MessageRow, type SettingsRow } from "../../services/messaging/queue.js";
import type { Channels } from "../../services/messaging/transport.js";
import { invoicePdfFile, notePdfFile, receiptPdfFile, type PdfFile } from "../documents/routes.js";
import type { ApiModule } from "../types.js";

export { channelsFor, ready };

// ---------------------------------------------------------------- channels

function settingsView(deps: AppDeps, row: SettingsRow | null, channels: Channels) {
  return {
    driver: deps.messenger.driver,
    platformEmail: Boolean(deps.config.messaging.smtpUrl && deps.config.messaging.mailFrom),
    whatsapp: {
      provider: row?.whatsappProvider ?? "none",
      number: row?.whatsappNumber ?? null,
      phoneNumberId: row?.whatsappPhoneNumberId ?? null,
      webhookUrl: row?.whatsappWebhookUrl ?? null,
      hasSecret: Boolean(row?.whatsappSecret),
      /** Delivery ticks: the key in the callback address (also Meta's verify token). */
      statusKey: row?.whatsappStatusKey ?? null,
      hasAppSecret: Boolean(row?.whatsappAppSecret),
      documentTemplate: row?.whatsappDocumentTemplate ?? null,
      reminderTemplate: row?.whatsappReminderTemplate ?? null,
      templateLanguage: row?.whatsappTemplateLanguage ?? "en",
      templateLanguageHi: row?.whatsappTemplateLanguageHi ?? null,
      ready: ready(deps, channels, "whatsapp"),
    },
    sms: {
      provider: row?.smsProvider ?? "none",
      webhookUrl: row?.smsWebhookUrl ?? null,
      hasSecret: Boolean(row?.smsSecret),
      senderId: row?.smsSenderId ?? null,
      reminderTemplate: row?.smsReminderTemplate ?? null,
      reminderTemplateHi: row?.smsReminderTemplateHi ?? null,
      ready: ready(deps, channels, "sms"),
    },
    email: {
      mode: row?.emailMode ?? "platform",
      smtpHost: row?.smtpHost ?? null,
      smtpPort: row?.smtpPort ?? null,
      smtpSecure: row?.smtpSecure ?? false,
      smtpUser: row?.smtpUser ?? null,
      hasPassword: Boolean(row?.smtpPassword),
      fromName: row?.emailFromName ?? null,
      fromAddress: row?.emailFromAddress ?? null,
      replyTo: row?.emailReplyTo ?? null,
      ready: ready(deps, channels, "email"),
    },
  };
}

/** Webhooks and mail servers must be public hosts: a business cannot point the server at its own network. */
function assertPublicHost(deps: AppDeps, host: string, field: string): void {
  if (deps.config.env !== "production") return;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || (isIP(h) === 4 && privateV4.test(h)) || (isIP(h) === 6 && /^(::1?$|f[cd]|fe80)/.test(h))) {
    throw badRequest("PRIVATE_HOST_NOT_ALLOWED", { host }, field);
  }
}

// ---------------------------------------------------------------- recipients

function pickRecipient(channel: Channel, party: { name: string; mobile: string | null; email: string | null } | null, to: string | undefined): string {
  const raw = to ?? (channel === "email" ? party?.email : party?.mobile) ?? null;
  if (!raw) throw badRequest("MESSAGE_NO_RECIPIENT", { channel, party: party?.name ?? "" }, "to");
  const r = recipient(channel, raw);
  if (!r) throw badRequest("MESSAGE_RECIPIENT_INVALID", { channel, to: raw }, "to");
  return r;
}

// ---------------------------------------------------------------- routes

const IdParams = z.object({ id: z.uuid() });

export const messagingModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const channelsOf = (tx: Tx, businessId: string) => Promise.all([loadSettings(tx, businessId), businessContact(tx, businessId)]).then(([row, b]) => ({ row, business: b, channels: resolveChannels(deps, row, b) }));

  /** What the send buttons need: which channels work (no settings detail). */
  r.get("/messaging/channels", { preHandler: guard(deps, "message.send"), schema: { tags: ["messaging"] } }, async (request) =>
    tenant(request.ctx, async (tx) => {
      const { row, channels } = await channelsOf(tx, request.ctx.businessId);
      const view = settingsView(deps, row, channels);
      return { driver: view.driver, whatsapp: { ready: view.whatsapp.ready, number: view.whatsapp.number }, email: { ready: view.email.ready }, sms: { ready: view.sms.ready } };
    }),
  );

  r.get("/messaging/settings", { preHandler: guard(deps, "settings.view"), schema: { tags: ["messaging"] } }, async (request) =>
    tenant(request.ctx, async (tx) => {
      const { row, channels } = await channelsOf(tx, request.ctx.businessId);
      return settingsView(deps, row, channels);
    }),
  );

  r.put("/messaging/settings", { preHandler: guard(deps, "settings.update"), schema: { tags: ["messaging"], body: MessagingSettingsBody } }, async (request) => {
    const ctx = request.ctx;
    const { whatsappSecret, whatsappAppSecret, smtpPassword, smsSecret, ...plain } = request.body;
    for (const field of ["whatsappWebhookUrl", "smsWebhookUrl"] as const) {
      if (!plain[field]) continue;
      const url = new URL(plain[field]);
      if (deps.config.env === "production" && url.protocol !== "https:") throw badRequest("WEBHOOK_NOT_HTTPS", {}, field);
      assertPublicHost(deps, url.hostname, field);
    }
    if (plain.smtpHost) assertPublicHost(deps, plain.smtpHost, "smtpHost");
    return tenant(ctx, async (tx) => {
      const values = {
        ...plain,
        ...(whatsappSecret !== undefined ? { whatsappSecret: whatsappSecret === null ? null : deps.cipher.encrypt(whatsappSecret) } : {}),
        ...(smtpPassword !== undefined ? { smtpPassword: smtpPassword === null ? null : deps.cipher.encrypt(smtpPassword) } : {}),
        ...(whatsappAppSecret !== undefined ? { whatsappAppSecret: whatsappAppSecret === null ? null : deps.cipher.encrypt(whatsappAppSecret) } : {}),
        ...(smsSecret !== undefined ? { smsSecret: smsSecret === null ? null : deps.cipher.encrypt(smsSecret) } : {}),
        updatedBy: ctx.userId,
      };
      await tx
        .insert(schema.messagingSettings)
        .values({ id: uuidv7(), businessId: ctx.businessId, ...values, createdBy: ctx.userId })
        .onConflictDoUpdate({ target: schema.messagingSettings.businessId, set: { ...values, updatedAt: sql`now()` } });
      // The address for delivery ticks, made once.
      await tx
        .update(schema.messagingSettings)
        .set({ whatsappStatusKey: sql`coalesce(${schema.messagingSettings.whatsappStatusKey}, ${randomBytes(18).toString("base64url")})` })
        .where(eq(schema.messagingSettings.businessId, ctx.businessId));
      // Which settings changed, never the secrets themselves.
      await audit(tx, ctx, { action: "messaging.updated", entityType: "setting", entityLabel: "messaging", changes: { fields: Object.keys(request.body) } });
      const { row, channels } = await channelsOf(tx, ctx.businessId);
      return settingsView(deps, row, channels);
    });
  });

  /** A test message to check the set-up. */
  r.post("/messaging/test", { preHandler: guard(deps, "settings.update"), schema: { tags: ["messaging"], body: TestMessageBody } }, async (request) => {
    const ctx = request.ctx;
    const { channel } = request.body;
    const { row } = await tenant(ctx, async (tx) => {
      const { channels, business } = await channelsOf(tx, ctx.businessId);
      if (!ready(deps, channels, channel)) throw conflict("MESSAGING_NOT_CONFIGURED", { channel });
      const to = recipient(channel, request.body.to);
      if (!to) throw badRequest("MESSAGE_RECIPIENT_INVALID", { channel, to: request.body.to }, "to");
      const { t } = createTranslator("en");
      const [row] = await tx
        .insert(schema.messages)
        .values({ id: uuidv7(), businessId: ctx.businessId, channel, kind: "test", recipient: to, subject: t("messages.subject.test", { business: business.name }), body: t("messages.test", { business: business.name }), createdBy: ctx.userId })
        .returning();
      return { row: row! };
    });
    const channels = await tenant(ctx, (tx) => channelsOf(tx, ctx.businessId).then((c) => c.channels));
    const sent = await deliverLogged(deps, ctx, row, channels, null);
    if (sent.status === "failed") throw new ApiError(502, "MESSAGE_SEND_FAILED", { reason: sent.error ?? "" });
    return sent;
  });

  /** Sends an invoice, note or receipt with its PDF, now; the result is logged either way. */
  r.post("/messages/send", { preHandler: guard(deps, "message.send"), schema: { tags: ["messaging"], body: SendDocumentBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const need = body.documentType === "invoice" ? "invoice.view" : body.documentType === "note" ? "note.view" : "payment.view";
    if (!can(ctx, need)) throw forbidden(need);
    const { channels, row: settings } = await tenant(ctx, (tx) => channelsOf(tx, ctx.businessId));
    if (!ready(deps, channels, body.channel)) throw conflict("MESSAGING_NOT_CONFIGURED", { channel: body.channel });
    const load = body.documentType === "invoice" ? invoicePdfFile : body.documentType === "note" ? notePdfFile : receiptPdfFile;
    const file: PdfFile = await load(deps, ctx, body.documentId, body.locale);
    const to = pickRecipient(body.channel, file.party, body.to);
    const templateName = body.channel === "whatsapp" && channels.whatsapp.provider !== "none" ? settings?.whatsappDocumentTemplate : null;
    const row = await tenant(ctx, async (tx) => {
      const [row] = await tx
        .insert(schema.messages)
        .values({
          id: uuidv7(),
          businessId: ctx.businessId,
          channel: body.channel,
          kind: body.documentType,
          documentId: body.documentId,
          documentNumber: file.number,
          partyType: file.party?.type ?? null,
          partyId: file.party?.id ?? null,
          partyName: file.party?.name ?? null,
          recipient: to,
          subject: body.channel === "email" ? file.message.subject : null,
          body: file.message.text,
          attachmentName: file.filename,
          template: templateName ? { name: templateName, language: settings?.whatsappTemplateLanguage ?? "en", params: file.message.params } : null,
          locale: file.locale,
          createdBy: ctx.userId,
        })
        .returning();
      return row!;
    });
    const sent = await deliverLogged(deps, ctx, row, channels, { filename: file.filename, content: file.pdf, contentType: "application/pdf" });
    void pumpMessages(deps, ctx);
    if (sent.status === "failed") return reply.code(502).send({ error: { code: "MESSAGE_SEND_FAILED", params: { reason: sent.error ?? "" }, requestId: request.id }, message: sent });
    return sent;
  });

  /** Customers with a balance, for payment reminders. */
  r.get("/messages/reminders", { preHandler: guard(deps, "message.send"), schema: { tags: ["messaging"] } }, async (request) => {
    const ctx = request.ctx;
    if (!can(ctx, "customer.view")) throw forbidden("customer.view");
    const today = deps.clock.today(ctx.timeZone);
    return tenant(ctx, async (tx) => ({ data: await reminderRows(tx, ctx.businessId, today, null) }));
  });

  /** Queues payment reminders and sends them one after another in the background. */
  r.post("/messages/reminders", { preHandler: guard(deps, "message.send"), schema: { tags: ["messaging"], body: ReminderBody } }, async (request, reply) => {
    const ctx = request.ctx;
    if (!can(ctx, "customer.view")) throw forbidden("customer.view");
    const { channel } = request.body;
    const today = deps.clock.today(ctx.timeZone);
    const result = await tenant(ctx, async (tx) => {
      const { channels, business, row: settings } = await channelsOf(tx, ctx.businessId);
      if (!ready(deps, channels, channel)) throw conflict("MESSAGING_NOT_CONFIGURED", { channel });
      const [defaults] = await Promise.all([getSettings(tx, ctx.businessId, ["invoice.default_print_locale"])]);
      const locale: LocaleCode = request.body.locale ?? (isLocaleCode(defaults["invoice.default_print_locale"] as string) ? (defaults["invoice.default_print_locale"] as LocaleCode) : "en");
      const { t } = createTranslator(locale);
      const money = (v: string) => formatCurrency(v, locale);
      const rows = await reminderRows(tx, ctx.businessId, today, request.body.customerIds);
      const skipped: Array<{ customerId: string; name: string; reason: "no_contact" | "no_balance" | "opted_out" }> = [];
      const queued: string[] = [];
      for (const c of rows) {
        if (Number(c.balance) <= 0) {
          skipped.push({ customerId: c.id, name: c.name, reason: "no_balance" });
          continue;
        }
        // They asked not to get payment reminders (or replied STOP).
        if (c.optedOut) {
          skipped.push({ customerId: c.id, name: c.name, reason: "opted_out" });
          continue;
        }
        const to = recipient(channel, (channel === "email" ? c.email : c.mobile) ?? "");
        if (!to) {
          skipped.push({ customerId: c.id, name: c.name, reason: "no_contact" });
          continue;
        }
        const params = { party: c.name, business: business.name, balance: money(c.balance), overdue: money(c.overdue), since: c.oldestDue ? formatDate(c.oldestDue) : "" };
        const text = Number(c.overdue) > 0 ? t("messages.reminder", params) : t("messages.reminderBalance", params);
        const templateName = channel === "whatsapp" && channels.whatsapp.provider !== "none" ? settings?.whatsappReminderTemplate : null;
        const smsTemplate = channel === "sms" ? ((locale === "hi" ? settings?.smsReminderTemplateHi : null) ?? settings?.smsReminderTemplate ?? null) : null;
        const [row] = await tx
          .insert(schema.messages)
          .values({
            id: uuidv7(),
            businessId: ctx.businessId,
            channel,
            kind: "reminder",
            partyType: "customer",
            partyId: c.id,
            partyName: c.name,
            recipient: to,
            subject: channel === "email" ? t("messages.subject.reminder", { business: business.name }) : null,
            body: text,
            template: templateName
              ? { name: templateName, language: (locale === "hi" ? settings?.whatsappTemplateLanguageHi : null) ?? settings?.whatsappTemplateLanguage ?? "en", params: [c.name, params.balance, params.overdue, business.name] }
              : smsTemplate
                ? { name: smsTemplate, language: locale, params: [] }
                : null,
            locale,
            createdBy: ctx.userId,
          })
          .returning({ id: schema.messages.id });
        queued.push(row!.id);
      }
      for (const id of request.body.customerIds) if (!rows.some((c) => c.id === id)) skipped.push({ customerId: id, name: "", reason: "no_balance" });
      await audit(tx, ctx, { action: "messages.reminders", entityType: "message", entityLabel: channel, changes: { queued: queued.length, skipped: skipped.length } });
      return { queued: queued.length, skipped };
    });
    void pumpMessages(deps, ctx);
    return reply.code(202).send(result);
  });

  r.get("/messages", { preHandler: guard(deps, "message.view"), schema: { tags: ["messaging"], querystring: MessageListQuery } }, async (request) => {
    const q = request.query;
    const m = schema.messages;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [eq(m.businessId, request.ctx.businessId)];
    if (q.channel) where.push(eq(m.channel, q.channel));
    if (q.status) where.push(eq(m.status, q.status));
    if (q.kind) where.push(eq(m.kind, q.kind));
    if (q.documentId) where.push(eq(m.documentId, q.documentId));
    if (q.partyId) where.push(eq(m.partyId, q.partyId));
    if (q.q) where.push(sql`(${m.partyName} ilike ${`%${q.q.replace(/[%_\\]/g, "\\$&")}%`} or ${m.documentNumber} ilike ${`%${q.q.replace(/[%_\\]/g, "\\$&")}%`} or ${m.recipient} ilike ${`%${q.q.replace(/[%_\\]/g, "\\$&")}%`})`);
    if (cursor) where.push(sql`(${m.createdAt}, ${m.id}) < (${String(cursor.v)}::timestamptz, ${cursor.id}::uuid)`);
    const rows = await tenant(request.ctx, (tx) =>
      tx
        .select({
          id: m.id,
          channel: m.channel,
          kind: m.kind,
          documentId: m.documentId,
          documentNumber: m.documentNumber,
          partyType: m.partyType,
          partyId: m.partyId,
          partyName: m.partyName,
          recipient: m.recipient,
          subject: m.subject,
          body: m.body,
          attachmentName: m.attachmentName,
          status: m.status,
          provider: m.provider,
          providerMessageId: m.providerMessageId,
          error: m.error,
          attempts: m.attempts,
          sentAt: m.sentAt,
          deliveredAt: m.deliveredAt,
          readAt: m.readAt,
          automatic: m.automatic,
          createdAt: m.createdAt,
          sentBy: schema.users.name,
        })
        .from(m)
        .leftJoin(schema.users, eq(schema.users.id, m.createdBy))
        .where(and(...where))
        .orderBy(desc(m.createdAt), desc(m.id))
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.createdAt, id: x.id }));
  });

  /** Tries a failed message again (reminders and tests; documents are re-sent from the document). */
  r.post("/messages/:id/retry", { preHandler: guard(deps, "message.send"), schema: { tags: ["messaging"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const [row] = await tx
        .update(schema.messages)
        .set({ status: "queued", error: null, updatedAt: sql`now()` })
        .where(and(eq(schema.messages.id, request.params.id), eq(schema.messages.businessId, ctx.businessId), eq(schema.messages.status, "failed"), inArray(schema.messages.kind, ["reminder", "test"])))
        .returning();
      if (!row) throw conflict("MESSAGE_NOT_RETRYABLE");
      return row;
    });
    void pumpMessages(deps, ctx);
    return row;
  });
};

/** Customers with an outstanding balance: overdue part and the oldest overdue date. */
async function reminderRows(tx: Tx, businessId: string, today: string, ids: string[] | null) {
  const res = await tx.execute<{ id: string; name: string; mobile: string | null; email: string | null; balance: string; overdue: string; oldest_due: string | null; reminders_opt_out: boolean }>(sql`
    select c.id, coalesce(c.business_name, c.name) as name, c.mobile, c.email, c.balance::text, c.reminders_opt_out,
           coalesce(od.amount, 0)::text as overdue, od.oldest::text as oldest_due
    from customers c
    left join lateral (
      select sum(i.balance_due) as amount, min(i.due_date) as oldest from invoices i
      where i.customer_id = c.id and i.status = 'posted' and i.balance_due > 0 and i.due_date < ${today}
    ) od on true
    where c.business_id = ${businessId} and c.deleted_at is null
      and ${ids ? sql`c.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`c.balance > 0`}
    order by coalesce(od.amount, 0) desc, c.balance desc
    limit 500`);
  return res.rows.map((r) => ({ id: r.id, name: r.name, mobile: r.mobile, email: r.email, balance: r.balance, overdue: r.overdue, oldestDue: r.oldest_due, optedOut: r.reminders_opt_out }));
}
