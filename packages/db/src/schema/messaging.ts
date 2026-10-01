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
  /** Meta Cloud API phone number id of the business's WhatsApp number. */
  whatsappPhoneNumberId: varchar({ length: 40 }),
  /** The provider's address messages are posted to (webhook provider). */
  whatsappWebhookUrl: text(),
  /** Meta access token or the webhook's signing secret (encrypted). */
  whatsappSecret: text(),
  /** Approved templates: a bill with a document header, and a payment reminder. */
  whatsappDocumentTemplate: varchar({ length: 100 }),
  /** Name of the approved template for payment reminders. */
  whatsappReminderTemplate: varchar({ length: 100 }),
  /** Language code of the templates (en, hi ...). */
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
  /** The firm's own mail server (smtp mode). */
  smtpHost: text(),
  /** Its port (465 with SSL, 587 with STARTTLS). */
  smtpPort: integer(),
  /** Connect with SSL/TLS from the start (port 465). */
  smtpSecure: boolean().notNull().default(false),
  /** User name on the mail server. */
  smtpUser: text(),
  /** Password on the mail server, encrypted; never returned. */
  smtpPassword: text(),
  /** Name the emails come from (the firm's name by default). */
  emailFromName: varchar({ length: 100 }),
  /** Address the emails come from. */
  emailFromAddress: text(),
  /** Address replies go to (the firm's email by default). */
  emailReplyTo: text(),
  ...auditColumns,
});

/** Every WhatsApp and email sent (or tried) to a customer or supplier. */
export const messages = pgTable(
  "messages",
  {
    id: pk(),
    businessId: businessId(),
    /** whatsapp or email. */
    channel: messageChannel().notNull(),
    /** invoice | note | receipt | reminder | backup | test */
    kind: varchar({ length: 20 }).notNull(),
    /** The invoice, note or receipt sent. */
    documentId: uuid(),
    /** Its number, for the log. */
    documentNumber: varchar({ length: 40 }),
    /** customer or supplier. */
    partyType: partyType(),
    /** The customer or supplier. */
    partyId: uuid(),
    /** Their name at the time. */
    partyName: text(),
    /** WhatsApp number (international digits) or email address it went to. */
    recipient: text().notNull(),
    /** Email subject. */
    subject: text(),
    /** The text sent. */
    body: text().notNull(),
    /** File name of the PDF attached. */
    attachmentName: text(),
    /** The WhatsApp template and its parameters, when one was used. */
    template: jsonb().$type<{ name: string; language: string; params: string[] }>(),
    /** Language of the message (en or hi). */
    locale: varchar({ length: 10 }).notNull().default("en"),
    /** queued, sent, delivered, read or failed. */
    status: messageStatus().notNull().default("queued"),
    /** Who sent it: meta, webhook or smtp; log in test mode (recorded, not sent). */
    provider: varchar({ length: 20 }),
    /** The provider's id for the message, matched by the status callbacks. */
    providerMessageId: text(),
    /** Why sending failed. */
    error: text(),
    /** Times sending was tried. */
    attempts: integer().notNull().default(0),
    /** When it was sent. */
    sentAt: tstz(),
    /** WhatsApp ticks, from the provider's status callbacks. */
    deliveredAt: tstz(),
    /** When WhatsApp reported it read. */
    readAt: tstz(),
    ...auditColumns,
  },
  (t) => [index("messages_business_created_idx").on(t.businessId, t.createdAt), index("messages_document_idx").on(t.businessId, t.documentId), index("messages_queued_idx").on(t.businessId, t.status)],
);
