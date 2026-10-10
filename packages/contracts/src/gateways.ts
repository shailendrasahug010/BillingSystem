import { z } from "zod";
import { Id, Money, PageQuery } from "./common.js";

export const GatewayProvider = z.enum(["none", "razorpay", "cashfree"]);
export type GatewayProvider = z.infer<typeof GatewayProvider>;

/**
 * A business's payment gateway (Razorpay or Cashfree). keySecret and
 * webhookSecret are write-only: send a value to set it, null to clear it,
 * leave it out to keep it.
 */
export const PaymentGatewayBody = z.strictObject({
  provider: GatewayProvider,
  environment: z.enum(["test", "live"]).default("test"),
  /** Razorpay key id (rzp_test_… / rzp_live_…), or Cashfree app id. */
  keyId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{6,100}$/)
    .nullable()
    .optional(),
  keySecret: z.string().trim().min(8).max(500).nullable().optional(),
  /** Razorpay only: the secret typed when adding the webhook in Razorpay's dashboard. */
  webhookSecret: z.string().trim().min(6).max(500).nullable().optional(),
  paymentAccountId: Id.nullable().optional(),
  upiOnly: z.boolean().optional(),
  linkExpiryDays: z.number().int().min(1).max(180).optional(),
  linksInReminders: z.boolean().optional(),
});
export type PaymentGatewayBody = z.infer<typeof PaymentGatewayBody>;

/** The set-up as the Settings screen sees it (secrets only as "set" or not). */
export interface PaymentGatewayView {
  /** live: links are made at the gateway; fake: made here for testing, nothing is charged. */
  driver: "live" | "fake";
  provider: GatewayProvider;
  environment: "test" | "live";
  keyId: string | null;
  hasKeySecret: boolean;
  hasWebhookSecret: boolean;
  /** The key in the address the gateway reports payments to: /api/v1/webhooks/payments/<key>. */
  webhookKey: string | null;
  paymentAccountId: string | null;
  upiOnly: boolean;
  linkExpiryDays: number;
  linksInReminders: boolean;
  lastWebhookAt: string | null;
  /** Keys present: links can be made. */
  ready: boolean;
}

/** A link for one bill (its balance, or less) or for the customer's balance (or an amount). */
export const PaymentLinkBody = z.strictObject({
  customerId: Id,
  invoiceId: Id.optional(),
  amount: Money.optional(),
});
export type PaymentLinkBody = z.infer<typeof PaymentLinkBody>;

export const PaymentLinkStatus = z.enum(["created", "partly_paid", "paid", "expired", "cancelled"]);
export type PaymentLinkStatus = z.infer<typeof PaymentLinkStatus>;

export const PaymentLinkListQuery = PageQuery.extend({
  customerId: Id.optional(),
  invoiceId: Id.optional(),
  status: z.enum(["created", "partly_paid", "paid", "expired", "cancelled", "open", "all"]).default("all"),
});

export interface PaymentLinkView {
  id: string;
  provider: "razorpay" | "cashfree";
  environment: "test" | "live";
  customerId: string;
  customerName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  amount: string;
  amountPaid: string;
  description: string;
  url: string;
  status: PaymentLinkStatus;
  expiresAt: string;
  source: "staff" | "reminder" | "shop";
  paidAt: string | null;
  createdAt: string;
  /** Receipts made from the payments on it. */
  payments: Array<{ paymentId: string | null; paymentNumber: string | null; amount: string; method: string; reference: string | null; paidAt: string }>;
}

/** Whether online payment links can be made, for the buttons that make them. */
export interface PaymentLinksSetup {
  ready: boolean;
  provider: GatewayProvider;
  environment: "test" | "live";
}
