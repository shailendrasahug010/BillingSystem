import { createHmac, timingSafeEqual } from "node:crypto";
import { fromPaise, GatewayError, methodOf, parseJson, toPaise, type GatewayClient, type GatewayKeys, type LinkState, type LinkStatus, type NewLink, type ReceivedPayment, type WebhookNotice } from "./types.js";

/**
 * Razorpay Payment Links (https://razorpay.com/docs/api/payments/payment-links/):
 * basic auth with the key id and secret; amounts in paise. A link reports
 * its payments in its own record; the UTR / RRN of each comes from the
 * payment itself. Webhooks are signed with the secret typed in Razorpay's
 * dashboard: X-Razorpay-Signature, the hex HMAC-SHA256 of the raw body.
 */

const STATUS: Record<string, LinkStatus> = {
  created: "created",
  partially_paid: "partly_paid",
  paid: "paid",
  expired: "expired",
  cancelled: "cancelled",
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const paise = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const isoFromSeconds = (v: unknown) => new Date((Number(v) || Date.now() / 1000) * 1000).toISOString();

/** An Indian mobile as Razorpay wants it (+91 and ten digits); null when it is not one. */
function contact(mobile: string | null): string | null {
  const d = (mobile ?? "").replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

/** A payment on a link as Razorpay lists it ({ payment_id, amount, method, status, created_at }) or as a payment entity. */
function paymentOf(p: Record<string, unknown>): ReceivedPayment | null {
  const id = str(p.payment_id) ?? str(p.id);
  const status = String(p.status ?? "");
  if (!id || (status && status !== "captured" && status !== "authorized")) return null;
  const acquirer = obj(p.acquirer_data);
  return {
    providerPaymentId: id,
    amount: fromPaise(paise(p.amount)),
    method: methodOf(p.method),
    reference: (str(acquirer.rrn) ?? str(acquirer.upi_transaction_id) ?? str(acquirer.bank_transaction_id))?.slice(0, 40) ?? null,
    paidAt: isoFromSeconds(p.created_at),
  };
}

/** A payment link record (or the entity in a webhook) as our link state. */
export function razorpayLinkState(link: Record<string, unknown>, extra: ReceivedPayment[] = []): LinkState {
  const listed = Array.isArray(link.payments) ? (link.payments as unknown[]).map((p) => paymentOf(obj(p))).filter((p): p is ReceivedPayment => p !== null) : [];
  const byId = new Map([...listed, ...extra].map((p) => [p.providerPaymentId, p]));
  return { status: STATUS[String(link.status)] ?? "created", amountPaid: fromPaise(paise(link.amount_paid)), payments: [...byId.values()] };
}

export function verifyRazorpayWebhook(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** payment_link.paid / partially_paid / expired / cancelled; anything else is not ours (null). */
export function parseRazorpayWebhook(body: unknown): WebhookNotice | null {
  const b = obj(body);
  const event = String(b.event ?? "");
  if (!event.startsWith("payment_link.")) return null;
  const payload = obj(b.payload);
  const link = obj(obj(payload.payment_link).entity);
  const payment = obj(obj(payload.payment).entity);
  const providerLinkId = str(link.id);
  const referenceId = str(link.reference_id);
  if (!providerLinkId && !referenceId) return null;
  const paid = Object.keys(payment).length ? paymentOf(payment) : null;
  return { providerLinkId, referenceId, state: razorpayLinkState(link, paid ? [paid] : []) };
}

export class RazorpayClient implements GatewayClient {
  constructor(private readonly base = "https://api.razorpay.com") {}

  private async call<T>(keys: GatewayKeys, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64")}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new GatewayError("GATEWAY_UNREACHABLE", `Razorpay could not be reached: ${(e as Error).message}`, (e as Error).message);
    }
    const text = await res.text();
    const json = parseJson(text);
    if (res.status === 401) throw new GatewayError("GATEWAY_AUTH_FAILED", "Razorpay refused the key id or secret", "401");
    if (!res.ok) {
      const reason = String(obj(obj(json).error).description ?? text ?? res.status).slice(0, 300);
      throw new GatewayError(res.status >= 500 ? "GATEWAY_UNREACHABLE" : "GATEWAY_REFUSED", `Razorpay answered ${res.status}: ${reason}`, reason);
    }
    return json as T;
  }

  async createLink(keys: GatewayKeys, link: NewLink) {
    const phone = contact(link.customer.mobile);
    const made = await this.call<Record<string, unknown>>(keys, "POST", "/v1/payment_links", {
      amount: toPaise(link.amount),
      currency: "INR",
      accept_partial: false,
      expire_by: Math.floor(link.expiresAt.getTime() / 1000),
      reference_id: link.referenceId,
      description: link.description.slice(0, 2048),
      customer: { name: link.customer.name.slice(0, 50), ...(phone ? { contact: phone } : {}), ...(link.customer.email ? { email: link.customer.email } : {}) },
      // The business sends the link itself (WhatsApp, the bill, the shop's page).
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: link.notes,
      ...(link.upiOnly ? { upi_link: true } : {}),
    });
    const id = str(made.id);
    const url = str(made.short_url);
    if (!id || !url) throw new GatewayError("GATEWAY_REFUSED", "Razorpay made no link", "no id or short_url");
    return { providerLinkId: id, url };
  }

  async fetchLink(keys: GatewayKeys, providerLinkId: string): Promise<LinkState> {
    const link = await this.call<Record<string, unknown>>(keys, "GET", `/v1/payment_links/${encodeURIComponent(providerLinkId)}`);
    const state = razorpayLinkState(link);
    // The UTR / RRN is on the payment, not on the link's list of payments.
    const payments: ReceivedPayment[] = [];
    for (const p of state.payments) {
      const full = await this.call<Record<string, unknown>>(keys, "GET", `/v1/payments/${encodeURIComponent(p.providerPaymentId)}`).catch(() => null);
      payments.push(full ? { ...p, ...(paymentOf(full) ?? {}), providerPaymentId: p.providerPaymentId } : p);
    }
    return { ...state, payments };
  }

  async cancelLink(keys: GatewayKeys, providerLinkId: string): Promise<void> {
    await this.call(keys, "POST", `/v1/payment_links/${encodeURIComponent(providerLinkId)}/cancel`);
  }

  async check(keys: GatewayKeys): Promise<void> {
    await this.call(keys, "GET", "/v1/payment_links?count=1");
  }
}
