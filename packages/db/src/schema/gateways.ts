import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, pk, tstz } from "./columns.js";
import { paymentMethod } from "./enums.js";
import { customers } from "./parties.js";
import { paymentAccounts, payments } from "./payments.js";
import { businessId } from "./platform.js";
import { invoices } from "./sales.js";

/**
 * Online payments through a payment gateway the business has an account with
 * (Razorpay or Cashfree): its keys, kept encrypted with the API's field
 * cipher and never returned, and how its payment links behave.
 */
export const paymentGatewaySettings = pgTable(
  "payment_gateway_settings",
  {
    id: pk(),
    businessId: businessId().unique("payment_gateway_settings_business_uq"),
    /** none | razorpay | cashfree */
    provider: varchar({ length: 20 }).notNull().default("none"),
    /** test | live: the gateway's test (sandbox) or live account. */
    environment: varchar({ length: 10 }).notNull().default("test"),
    /** Razorpay key id, or Cashfree app id (client id). */
    keyId: varchar({ length: 100 }),
    /** Razorpay key secret, or Cashfree secret key (encrypted). */
    keySecret: text(),
    /** Razorpay webhook secret (encrypted); Cashfree signs its webhooks with the secret key. */
    webhookSecret: text(),
    /** The random key in the address the gateway reports payments to (/webhooks/payments/<key>). */
    webhookKey: varchar({ length: 40 }).unique("payment_gateway_settings_webhook_key_uq"),
    /** Account the gateway pays the money into: receipts made from online payments go to it. */
    paymentAccountId: uuid().references(() => paymentAccounts.id),
    /** Links take UPI only (no card or net-banking fees). */
    upiOnly: boolean().notNull().default(false),
    /** Days a payment link can be paid. */
    linkExpiryDays: integer().notNull().default(15),
    /** Payment reminders carry a link to pay the balance online. */
    linksInReminders: boolean().notNull().default(true),
    /** When the gateway last reported a payment (or anything) to the webhook address. */
    lastWebhookAt: tstz(),
    ...auditColumns,
  },
  (t) => [
    check("payment_gateway_settings_provider_chk", sql`${t.provider} in ('none', 'razorpay', 'cashfree')`),
    check("payment_gateway_settings_environment_chk", sql`${t.environment} in ('test', 'live')`),
    check("payment_gateway_settings_expiry_chk", sql`${t.linkExpiryDays} between 1 and 180`),
  ],
);

export const paymentLinkStatus = pgEnum("payment_link_status", ["created", "partly_paid", "paid", "expired", "cancelled"]);

/**
 * A payment link sent to a customer: for one bill, or for what they owe.
 * Paying it (the gateway's webhook, or the API checking open links) makes a
 * receipt for the customer, applied to that bill first.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: pk(),
    businessId: businessId(),
    /** razorpay | cashfree */
    provider: varchar({ length: 20 }).notNull(),
    /** test | live, as the gateway was set up when the link was made. */
    environment: varchar({ length: 10 }).notNull(),
    /** The customer asked to pay. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** The bill it is for; null: the customer's balance. */
    invoiceId: uuid().references(() => invoices.id),
    /** Amount asked. */
    amount: money().notNull(),
    /** Amount the gateway has received on it so far. */
    amountPaid: money().notNull().default("0"),
    /** What the customer sees on the gateway's page. */
    description: text().notNull(),
    /** The gateway's id for the link (Razorpay plink_…, Cashfree link id). */
    providerLinkId: varchar({ length: 80 }).notNull(),
    /** The address the customer opens to pay. */
    url: text().notNull(),
    /** created, partly_paid, paid, expired or cancelled. */
    status: paymentLinkStatus().notNull().default("created"),
    /** After this the gateway refuses payments on it. */
    expiresAt: tstz().notNull(),
    /** staff (sent from a bill or customer), reminder (put in a payment reminder) or shop (asked for on the shop's order page). */
    source: varchar({ length: 10 }).notNull().default("staff"),
    /** When it was paid in full. */
    paidAt: tstz(),
    /** When the API last asked the gateway how the link stands. */
    lastCheckedAt: tstz(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_links_provider_uq").on(t.provider, t.providerLinkId),
    index("payment_links_customer_idx").on(t.businessId, t.customerId, t.createdAt),
    index("payment_links_invoice_idx").on(t.businessId, t.invoiceId),
    index("payment_links_open_idx").on(t.businessId, t.status, t.expiresAt),
    check("payment_links_amount_chk", sql`${t.amount} > 0 and ${t.amountPaid} >= 0`),
    check("payment_links_source_chk", sql`${t.source} in ('staff', 'reminder', 'shop')`),
  ],
);

/**
 * A payment the gateway received on a link, and the receipt it was recorded
 * as. One row per gateway payment id, so a payment reported twice (webhook
 * and a status check, or a retried webhook) is recorded once.
 */
export const gatewayPayments = pgTable(
  "gateway_payments",
  {
    id: pk(),
    businessId: businessId(),
    /** The link paid. */
    linkId: uuid()
      .notNull()
      .references(() => paymentLinks.id),
    /** razorpay | cashfree */
    provider: varchar({ length: 20 }).notNull(),
    /** The gateway's id for the payment (Razorpay pay_…, Cashfree payment id). */
    providerPaymentId: varchar({ length: 80 }).notNull(),
    /** Amount paid. */
    amount: money().notNull(),
    /** How the customer paid: upi, card, bank_transfer (net banking) or other. */
    method: paymentMethod().notNull(),
    /** UPI or bank reference (UTR / RRN) when the gateway gives one. */
    reference: varchar({ length: 40 }),
    /** When the customer paid. */
    paidAt: tstz().notNull(),
    /** The receipt it was recorded as. */
    paymentId: uuid().references(() => payments.id),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gateway_payments_provider_uq").on(t.provider, t.providerPaymentId),
    index("gateway_payments_link_idx").on(t.linkId),
    check("gateway_payments_amount_chk", sql`${t.amount} > 0`),
  ],
);
