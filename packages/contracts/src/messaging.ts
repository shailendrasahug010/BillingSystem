import { z } from "zod";
import { Id, PageQuery } from "./common.js";

export const MessageChannel = z.enum(["whatsapp", "email"]);

const text = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * A business's WhatsApp and email set-up. Secrets (whatsappSecret,
 * smtpPassword) are write-only: send a value to set it, null to clear it,
 * leave it out to keep it.
 */
export const MessagingSettingsBody = z.strictObject({
  whatsappProvider: z.enum(["none", "meta", "webhook"]).optional(),
  whatsappNumber: text(20),
  whatsappPhoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{5,30}$/)
    .nullable()
    .optional(),
  whatsappWebhookUrl: z.url({ protocol: /^https?$/ }).max(500).nullable().optional(),
  whatsappSecret: z.string().min(8).max(2000).nullable().optional(),
  whatsappDocumentTemplate: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,100}$/)
    .nullable()
    .optional(),
  whatsappReminderTemplate: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,100}$/)
    .nullable()
    .optional(),
  whatsappTemplateLanguage: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/)
    .optional(),
  emailMode: z.enum(["none", "platform", "smtp"]).optional(),
  smtpHost: text(200),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: text(200),
  smtpPassword: z.string().max(500).nullable().optional(),
  emailFromName: text(100),
  emailFromAddress: z.email().max(200).nullable().optional(),
  emailReplyTo: z.email().max(200).nullable().optional(),
});

/** Send an invoice, credit / debit note or receipt, with its PDF. */
export const SendDocumentBody = z.strictObject({
  channel: MessageChannel,
  documentType: z.enum(["invoice", "note", "receipt"]),
  documentId: Id,
  /** Another mobile number or email address than the party's. */
  to: z.string().trim().min(3).max(200).optional(),
  locale: z.enum(["en", "hi"]).optional(),
});

/** Payment reminders to customers with a balance (sent one after another in the background). */
export const ReminderBody = z.strictObject({
  channel: MessageChannel,
  customerIds: z.array(Id).min(1).max(200),
  locale: z.enum(["en", "hi"]).optional(),
});

export const TestMessageBody = z.strictObject({
  channel: MessageChannel,
  to: z.string().trim().min(3).max(200),
});

export const MessageListQuery = PageQuery.extend({
  channel: MessageChannel.optional(),
  status: z.enum(["queued", "sent", "delivered", "read", "failed"]).optional(),
  kind: z.enum(["invoice", "note", "receipt", "reminder", "test"]).optional(),
  documentId: z.uuid().optional(),
  partyId: z.uuid().optional(),
});
