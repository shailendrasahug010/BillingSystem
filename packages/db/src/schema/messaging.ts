import { boolean, index, integer, jsonb, pgEnum, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, pk, tstz } from "./columns.js";
import { partyType } from "./enums.js";
import { businessId } from "./platform.js";

export const messageChannel = pgEnum("message_channel", ["whatsapp", "email"]);
export const messageStatus = pgEnum("message_status", ["queued", "sent", "delivered", "read", "failed"]);

/**
 * How a business sends WhatsApp and email: its own WhatsApp Business number
 * (Meta Cloud API, or a provider's webhook) and the platform's mail server
 * or its own SMTP. Secrets (access token, webhook secret, SMTP password) are
 * encrypted with the API's field cipher and never returned.
 */
export const messagingSettings = pgTable("messaging_settings", {
  id: pk(),
  businessId: businessId().unique("messaging_settings_business_uq"),
  /** none | meta | webhook */
  whatsappProvider: varchar({ length: 20 }).notNull().default("none"),
  /** The business's WhatsApp number as customers see it. */
  whatsappNumber: varchar({ length: 20 }),
  whatsappPhoneNumberId: varchar({ length: 40 }),
  whatsappWebhookUrl: text(),
  /** Meta access token or the webhook's signing secret (encrypted). */
  whatsappSecret: text(),
  /** Approved templates: a bill with a document header, and a payment reminder. */
  whatsappDocumentTemplate: varchar({ length: 100 }),
  whatsappReminderTemplate: varchar({ length: 100 }),
  whatsappTemplateLanguage: varchar({ length: 10 }).notNull().default("en"),
  /**
   * Delivery ticks: the random key in the address Meta (or the provider)
   * calls back with "delivered" / "read", also Meta's verify token.
   */
  whatsappStatusKey: varchar({ length: 40 }).unique("messaging_settings_status_key_uq"),
  /** Meta app secret that signs those callbacks (encrypted). */
  whatsappAppSecret: text(),
  /** none | platform | smtp */
  emailMode: varchar({ length: 20 }).notNull().default("platform"),
  smtpHost: text(),
  smtpPort: integer(),
  smtpSecure: boolean().notNull().default(false),
  smtpUser: text(),
  smtpPassword: text(),
  emailFromName: varchar({ length: 100 }),
  emailFromAddress: text(),
  emailReplyTo: text(),
  ...auditColumns,
});

/** Every WhatsApp and email sent (or tried) to a customer or supplier. */
export const messages = pgTable(
  "messages",
  {
    id: pk(),
    businessId: businessId(),
    channel: messageChannel().notNull(),
    /** invoice | note | receipt | reminder | test */
    kind: varchar({ length: 20 }).notNull(),
    documentId: uuid(),
    documentNumber: varchar({ length: 40 }),
    partyType: partyType(),
    partyId: uuid(),
    partyName: text(),
    recipient: text().notNull(),
    subject: text(),
    body: text().notNull(),
    attachmentName: text(),
    /** The WhatsApp template and its parameters, when one was used. */
    template: jsonb().$type<{ name: string; language: string; params: string[] }>(),
    locale: varchar({ length: 10 }).notNull().default("en"),
    status: messageStatus().notNull().default("queued"),
    provider: varchar({ length: 20 }),
    providerMessageId: text(),
    error: text(),
    attempts: integer().notNull().default(0),
    sentAt: tstz(),
    /** WhatsApp ticks, from the provider's status callbacks. */
    deliveredAt: tstz(),
    readAt: tstz(),
    ...auditColumns,
  },
  (t) => [index("messages_business_created_idx").on(t.businessId, t.createdAt), index("messages_document_idx").on(t.businessId, t.documentId), index("messages_queued_idx").on(t.businessId, t.status)],
);
