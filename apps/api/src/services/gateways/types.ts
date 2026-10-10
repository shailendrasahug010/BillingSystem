import type { PaymentMethod } from "@digitalbahi/core";

/**
 * Payment gateways (Razorpay, Cashfree): the few calls Digital Bahi makes to
 * them, behind one interface so the rest of the API does not care which one a
 * business uses, and so tests and demos run against a stand-in ("fake") that
 * charges nobody.
 */

export type GatewayName = "razorpay" | "cashfree";

/** A business's keys, decrypted (never leave the server). */
export interface GatewayKeys {
  provider: GatewayName;
  environment: "test" | "live";
  keyId: string;
  keySecret: string;
  /** Razorpay's webhook secret; Cashfree signs webhooks with the key secret. */
  webhookSecret: string | null;
}

export interface NewLink {
  /** Our id for the link (payment_links.id): Razorpay's reference_id, Cashfree's link_id. */
  referenceId: string;
  /** Rupees, two decimals ("1250.00"). */
  amount: string;
  /** What the customer reads on the gateway's page. */
  description: string;
  customer: { name: string; mobile: string | null; email: string | null };
  expiresAt: Date;
  /** Take UPI only. */
  upiOnly: boolean;
  /** Shown to the business in the gateway's dashboard. */
  notes: Record<string, string>;
}

export interface MadeLink {
  /** The gateway's id for the link (Razorpay plink_…; for Cashfree our own link_id). */
  providerLinkId: string;
  /** Where the customer pays. */
  url: string;
}

export type LinkStatus = "created" | "partly_paid" | "paid" | "expired" | "cancelled";

/** A payment the gateway received on a link. */
export interface ReceivedPayment {
  providerPaymentId: string;
  /** Rupees, two decimals. */
  amount: string;
  method: PaymentMethod;
  /** UPI or bank reference (UTR / RRN), when known. */
  reference: string | null;
  /** ISO time. */
  paidAt: string;
}

/** How a link stands at the gateway: its status and the payments made on it. */
export interface LinkState {
  status: LinkStatus;
  amountPaid: string;
  payments: ReceivedPayment[];
}

/** What a webhook says, once its signature is checked: which link, and how it stands if the event carries that. */
export interface WebhookNotice {
  providerLinkId: string | null;
  referenceId: string | null;
  /** The link's state as the event reports it (the stand-in gateway uses it; live ones ask the gateway). */
  state: LinkState | null;
}

export interface GatewayClient {
  createLink(keys: GatewayKeys, link: NewLink): Promise<MadeLink>;
  fetchLink(keys: GatewayKeys, providerLinkId: string): Promise<LinkState>;
  cancelLink(keys: GatewayKeys, providerLinkId: string): Promise<void>;
  /** Throws GatewayError("GATEWAY_AUTH") when the gateway refuses the keys. */
  check(keys: GatewayKeys): Promise<void>;
}

export interface Gateways {
  /** live: calls the gateways; fake: a stand-in in this process (development, tests). */
  driver: "live" | "fake";
  client(provider: GatewayName): GatewayClient;
  /** Stand-in only: what a verified webhook reported, so the next fetchLink answers with it. */
  remember?(provider: GatewayName, providerLinkId: string, state: LinkState): void;
}

/** A gateway refused or could not be reached; `code` is one of the API's error codes. */
export class GatewayError extends Error {
  constructor(
    readonly code: "GATEWAY_AUTH_FAILED" | "GATEWAY_REFUSED" | "GATEWAY_UNREACHABLE",
    message: string,
    /** The gateway's own words, for the person who set it up. */
    readonly reason: string = "",
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Rupees ("12.50") to paise (1250) and back, without floating point. */
export function toPaise(rupees: string): number {
  const [whole, frac = ""] = rupees.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function fromPaise(paise: number): string {
  const p = Math.round(paise);
  return `${Math.trunc(p / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;
}

/** Any amount the gateway sends (number or string, rupees) as "12.50". */
export function rupees(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? fromPaise(Math.round(n * 100)) : "0.00";
}

/** A gateway's payment method name as ours. */
export function methodOf(name: unknown): PaymentMethod {
  const m = String(name ?? "").toLowerCase();
  if (m === "upi") return "upi";
  if (m.includes("card")) return "card";
  if (m === "netbanking" || m === "net_banking" || m === "nb" || m === "bank_transfer" || m === "emandate" || m === "nach") return "bank_transfer";
  return "other";
}
