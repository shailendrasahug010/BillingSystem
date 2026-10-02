import { z } from "zod";
import { Id, PageQuery } from "./common.js";

export const MessageChannel = z.enum(["whatsapp", "email"]);
/** Reminders and tests can also go by SMS (documents with their PDF cannot). */
export const ReminderChannel = z.enum(["whatsapp", "email", "sms"]);

const text = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * A business's WhatsApp, SMS and email set-up. Secrets (whatsappSecret,
 * whatsappAppSecret, smsSecret, smtpPassword) are write-only: send a value to
 * set it, null to clear it, leave it out to keep it.
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
  /** Meta app secret, to check the delivery-tick callbacks are Meta's. */
  whatsappAppSecret: z.string().min(8).max(500).nullable().optional(),
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
  /** The same templates' language code in Hindi, for customers who get messages in Hindi. */
  whatsappTemplateLanguageHi: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/)
    .nullable()
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
  smsProvider: z.enum(["none", "webhook"]).optional(),
  smsWebhookUrl: z.url({ protocol: /^https?$/ }).max(500).nullable().optional(),
  smsSecret: z.string().min(8).max(500).nullable().optional(),
  /** DLT sender id (header): 3 to 10 capital letters or digits. */
  smsSenderId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{3,10}$/)
    .nullable()
    .optional(),
  /** DLT template ids of the payment reminder, in English and in Hindi. */
  smsReminderTemplate: z
    .string()
    .trim()
    .regex(/^\d{6,40}$/)
    .nullable()
    .optional(),
  smsReminderTemplateHi: z
    .string()
    .trim()
    .regex(/^\d{6,40}$/)
    .nullable()
    .optional(),
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
  channel: ReminderChannel,
  customerIds: z.array(Id).min(1).max(200),
  locale: z.enum(["en", "hi"]).optional(),
});

export const TestMessageBody = z.strictObject({
  channel: ReminderChannel,
  to: z.string().trim().min(3).max(200),
});

export const MessageListQuery = PageQuery.extend({
  channel: ReminderChannel.optional(),
  status: z.enum(["queued", "sent", "delivered", "read", "failed"]).optional(),
  kind: z.enum(["invoice", "note", "receipt", "reminder", "test", "backup"]).optional(),
  documentId: z.uuid().optional(),
  partyId: z.uuid().optional(),
});
