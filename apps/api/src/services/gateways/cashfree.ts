import { createHmac, timingSafeEqual } from "node:crypto";
import { GatewayError, methodOf, parseJson, rupees, type GatewayClient, type GatewayKeys, type LinkState, type LinkStatus, type NewLink, type ReceivedPayment, type WebhookNotice } from "./types.js";

/**
 * Cashfree Payment Links (https://docs.cashfree.com/reference/pg-new-apis-endpoint):
 * the app id and secret key in headers, API version 2023-08-01; amounts in
 * rupees. Our own id is the link's link_id. A paid link's payments are found
 * through the orders made on it. Webhooks are signed with the secret key:
 * x-webhook-signature is the base64 HMAC-SHA256 of x-webhook-timestamp
 * followed by the raw body.
 */

const API_VERSION = "2023-08-01";
const BASES = { test: "https://sandbox.cashfree.com/pg", live: "https://api.cashfree.com/pg" };

const STATUS: Record<string, LinkStatus> = {
  ACTIVE: "created",
  PARTIALLY_PAID: "partly_paid",
  PAID: "paid",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  TERMINATED: "cancelled",
  INACTIVE: "cancelled",
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/** Cashfree wants the ten digits. */
function phone(mobile: string | null): string | null {
  const d = (mobile ?? "").replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** An ISO time with India's offset, as Cashfree's link_expiry_time wants it. */
function istIso(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
}

/** A Cashfree payment ({ cf_payment_id, payment_status, payment_amount, payment_group, bank_reference, payment_time }). */
function paymentOf(p: Record<string, unknown>): ReceivedPayment | null {
  const id = str(p.cf_payment_id);
  if (!id || String(p.payment_status ?? "SUCCESS") !== "SUCCESS") return null;
  const time = str(p.payment_time) ?? str(p.payment_completion_time);
  return {
    providerPaymentId: id,
    amount: rupees(p.payment_amount),
    method: methodOf(p.payment_group ?? Object.keys(obj(p.payment_method))[0]),
    reference: str(p.bank_reference)?.slice(0, 40) ?? null,
    paidAt: time && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : new Date().toISOString(),
  };
}

export function verifyCashfreeWebhook(raw: Buffer, timestamp: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(timestamp + raw.toString("utf8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * PAYMENT_LINK_EVENT (the link's status changed) and PAYMENT_SUCCESS_WEBHOOK
 * for an order made on a link (its order_tags name the link). Anything else
 * is not ours (null).
 */
export function parseCashfreeWebhook(body: unknown): WebhookNotice | null {
  const b = obj(body);
  const type = String(b.type ?? "");
  const data = obj(b.data);
  if (type === "PAYMENT_LINK_EVENT") {
    const linkId = str(data.link_id);
    if (!linkId) return null;
    const order = obj(data.order);
    const payments: ReceivedPayment[] = [];
    const txn = str(order.transaction_id);
    if (txn && String(order.transaction_status ?? "") === "SUCCESS") {
      payments.push({ providerPaymentId: txn, amount: rupees(order.order_amount ?? data.link_amount_paid), method: "other", reference: null, paidAt: new Date().toISOString() });
    }
    return { providerLinkId: linkId, referenceId: linkId, state: { status: STATUS[String(data.link_status)] ?? "created", amountPaid: rupees(data.link_amount_paid), payments } };
  }
  if (type === "PAYMENT_SUCCESS_WEBHOOK") {
    const order = obj(data.order);
    const tags = obj(order.order_tags);
    const linkId = str(tags.link_id);
    if (!linkId) return null;
    const paid = paymentOf({ payment_status: "SUCCESS", ...obj(data.payment) });
    return { providerLinkId: linkId, referenceId: linkId, state: null, ...(paid ? { state: { status: "paid", amountPaid: paid.amount, payments: [paid] } } : {}) };
  }
  return null;
}

export class CashfreeClient implements GatewayClient {
  /** `base` replaces both addresses (a stand-in server in tests). */
  constructor(private readonly base: string | null = null) {}

  private async call<T>(keys: GatewayKeys, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base ?? BASES[keys.environment]}${path}`, {
        method,
        headers: {
          "x-client-id": keys.keyId,
          "x-client-secret": keys.keySecret,
          "x-api-version": API_VERSION,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new GatewayError("GATEWAY_UNREACHABLE", `Cashfree could not be reached: ${(e as Error).message}`, (e as Error).message);
    }
    const text = await res.text();
    const json = parseJson(text);
    if (res.status === 401 || res.status === 403) throw new GatewayError("GATEWAY_AUTH_FAILED", "Cashfree refused the app id or secret key", String(res.status));
    if (!res.ok) {
      const reason = String(obj(json).message ?? text ?? res.status).slice(0, 300);
      throw new GatewayError(res.status >= 500 ? "GATEWAY_UNREACHABLE" : "GATEWAY_REFUSED", `Cashfree answered ${res.status}: ${reason}`, reason);
    }
    return json as T;
  }

  async createLink(keys: GatewayKeys, link: NewLink) {
    const mobile = phone(link.customer.mobile);
    // Cashfree needs the customer's phone on every link.
    if (!mobile) throw new GatewayError("GATEWAY_REFUSED", "Cashfree needs the customer's mobile number", "customer_phone");
    const made = await this.call<Record<string, unknown>>(keys, "POST", "/links", {
      link_id: link.referenceId,
      link_amount: Number(link.amount),
      link_currency: "INR",
      link_purpose: link.description.slice(0, 500),
      customer_details: { customer_phone: mobile, customer_name: link.customer.name.slice(0, 100), ...(link.customer.email ? { customer_email: link.customer.email } : {}) },
      link_partial_payments: false,
      link_expiry_time: istIso(link.expiresAt),
      link_notify: { send_sms: false, send_email: false },
      link_auto_reminders: false,
      link_notes: link.notes,
      ...(link.upiOnly ? { link_meta: { payment_methods: "upi" } } : {}),
    });
    const url = str(made.link_url);
    if (!url) throw new GatewayError("GATEWAY_REFUSED", "Cashfree made no link", "no link_url");
    return { providerLinkId: str(made.link_id) ?? link.referenceId, url };
  }

  async fetchLink(keys: GatewayKeys, providerLinkId: string): Promise<LinkState> {
    const id = encodeURIComponent(providerLinkId);
    const link = await this.call<Record<string, unknown>>(keys, "GET", `/links/${id}`);
    const status = STATUS[String(link.link_status)] ?? "created";
    const payments: ReceivedPayment[] = [];
    if (Number(link.link_amount_paid ?? 0) > 0 || status === "paid" || status === "partly_paid") {
      const orders = await this.call<unknown[]>(keys, "GET", `/links/${id}/orders`).catch(() => []);
      for (const o of Array.isArray(orders) ? orders : []) {
        const order = obj(o);
        const orderId = str(order.order_id);
        if (!orderId || String(order.order_status ?? "") !== "PAID") continue;
        const list = await this.call<unknown[]>(keys, "GET", `/orders/${encodeURIComponent(orderId)}/payments`).catch(() => []);
        for (const p of Array.isArray(list) ? list : []) {
          const paid = paymentOf(obj(p));
          if (paid) payments.push(paid);
        }
      }
    }
    return { status, amountPaid: rupees(link.link_amount_paid), payments };
  }

  async cancelLink(keys: GatewayKeys, providerLinkId: string): Promise<void> {
    await this.call(keys, "POST", `/links/${encodeURIComponent(providerLinkId)}/cancel`);
  }

  /** Asks for a link that cannot exist: "not found" means the keys were accepted. */
  async check(keys: GatewayKeys): Promise<void> {
    try {
      await this.call(keys, "GET", `/links/digitalbahi-check-${Date.now()}`);
    } catch (e) {
      if (e instanceof GatewayError && e.code === "GATEWAY_REFUSED") return;
      throw e;
    }
  }
}
