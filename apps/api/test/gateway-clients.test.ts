import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fromPaise,
  GatewayError,
  LiveGateways,
  methodOf,
  parseCashfreeWebhook,
  parseRazorpayWebhook,
  rupees,
  toPaise,
  verifyCashfreeWebhook,
  verifyRazorpayWebhook,
  type GatewayKeys,
} from "../src/services/gateways/index.js";

/** What the stand-in gateway was asked. */
interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

/** A stand-in for a gateway's API: answers by method and path, and keeps what it was asked. */
function standIn(routes: Record<string, (req: Seen) => { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const table = new Map(Object.entries(routes));
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      const asked: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
      seen.push(asked);
      const route = table.get(`${req.method} ${path}`);
      const answer = route ? route(asked) : { status: 404, body: { message: "not found" } };
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  return {
    seen,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("payment gateway helpers", () => {
  it("turns rupees into paise and back without floating point", () => {
    expect(toPaise("1180.00")).toBe(118000);
    expect(toPaise("0.5")).toBe(50);
    expect(toPaise("12")).toBe(1200);
    expect(fromPaise(118000)).toBe("1180.00");
    expect(fromPaise(5)).toBe("0.05");
    expect(rupees(590)).toBe("590.00");
    expect(rupees("354.5")).toBe("354.50");
    expect(rupees(undefined)).toBe("0.00");
  });

  it("reads the gateways' payment methods as ours", () => {
    expect(methodOf("upi")).toBe("upi");
    expect(methodOf("credit_card")).toBe("card");
    expect(methodOf("card")).toBe("card");
    expect(methodOf("netbanking")).toBe("bank_transfer");
    expect(methodOf("net_banking")).toBe("bank_transfer");
    expect(methodOf("wallet")).toBe("other");
    expect(methodOf(undefined)).toBe("other");
  });

  it("checks Razorpay's webhook signature and reads payment link events", () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: "payment_link.paid",
        payload: {
          payment_link: { entity: { id: "plink_ABC", reference_id: "0192a3b4-0000-7000-8000-000000000001", status: "paid", amount_paid: 59000 } },
          payment: { entity: { id: "pay_XYZ", amount: 59000, method: "upi", status: "captured", created_at: 1760086800, acquirer_data: { rrn: "428912345678" } } },
        },
      }),
    );
    const signature = createHmac("sha256", "whsec").update(raw).digest("hex");
    expect(verifyRazorpayWebhook(raw, signature, "whsec")).toBe(true);
    expect(verifyRazorpayWebhook(raw, signature, "other")).toBe(false);
    expect(verifyRazorpayWebhook(Buffer.concat([raw, Buffer.from(" ")]), signature, "whsec")).toBe(false);
    expect(parseRazorpayWebhook(JSON.parse(raw.toString()))).toEqual({
      providerLinkId: "plink_ABC",
      referenceId: "0192a3b4-0000-7000-8000-000000000001",
      state: { status: "paid", amountPaid: "590.00", payments: [{ providerPaymentId: "pay_XYZ", amount: "590.00", method: "upi", reference: "428912345678", paidAt: "2025-10-10T09:00:00.000Z" }] },
    });
    expect(parseRazorpayWebhook({ event: "payment.captured", payload: {} })).toBeNull();
    // A payment that failed is not a payment.
    const failed = parseRazorpayWebhook({ event: "payment_link.partially_paid", payload: { payment_link: { entity: { id: "plink_ABC", status: "partially_paid", amount_paid: 0 } }, payment: { entity: { id: "pay_F", amount: 100, status: "failed" } } } });
    expect(failed?.state?.payments).toEqual([]);
  });

  it("checks Cashfree's webhook signature and reads its link and payment events", () => {
    const raw = Buffer.from(JSON.stringify({ type: "PAYMENT_LINK_EVENT", data: { link_id: "L1", link_status: "PAID", link_amount_paid: 354, order: { transaction_id: 55, transaction_status: "SUCCESS", order_amount: 354 } } }));
    const signature = createHmac("sha256", "cf-secret").update(`1760086800000${raw.toString()}`).digest("base64");
    expect(verifyCashfreeWebhook(raw, "1760086800000", signature, "cf-secret")).toBe(true);
    expect(verifyCashfreeWebhook(raw, "1760086800001", signature, "cf-secret")).toBe(false);
    const notice = parseCashfreeWebhook(JSON.parse(raw.toString()));
    expect(notice).toMatchObject({ providerLinkId: "L1", referenceId: "L1", state: { status: "paid", amountPaid: "354.00", payments: [{ providerPaymentId: "55", amount: "354.00" }] } });
    const success = parseCashfreeWebhook({
      type: "PAYMENT_SUCCESS_WEBHOOK",
      data: { order: { order_id: "o1", order_tags: { link_id: "L2" } }, payment: { cf_payment_id: 77, payment_amount: 100, payment_group: "upi", bank_reference: "UTR77" } },
    });
    expect(success).toMatchObject({ providerLinkId: "L2", state: { payments: [{ providerPaymentId: "77", method: "upi", reference: "UTR77", amount: "100.00" }] } });
    expect(parseCashfreeWebhook({ type: "REFUND_STATUS_WEBHOOK", data: {} })).toBeNull();
  });
});

describe("Razorpay payment links", () => {
  const keys: GatewayKeys = { provider: "razorpay", environment: "test", keyId: "rzp_test_KEY", keySecret: "secret", webhookSecret: null };
  const server = standIn({
    "POST /v1/payment_links": (req) =>
      req.headers.authorization === `Basic ${Buffer.from("rzp_test_KEY:secret").toString("base64")}`
        ? { body: { id: "plink_NEW", short_url: "https://rzp.io/rzp/abc", status: "created" } }
        : { status: 401, body: { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } } },
    "GET /v1/payment_links/plink_NEW": () => ({ body: { id: "plink_NEW", status: "paid", amount_paid: 118000, payments: [{ payment_id: "pay_1", amount: 118000, method: "upi", status: "captured", created_at: 1760086800 }] } }),
    "GET /v1/payments/pay_1": () => ({ body: { id: "pay_1", amount: 118000, method: "upi", status: "captured", created_at: 1760086800, acquirer_data: { rrn: "428900001111" } } }),
    "POST /v1/payment_links/plink_NEW/cancel": () => ({ body: { id: "plink_NEW", status: "cancelled" } }),
    "GET /v1/payment_links": () => ({ body: { payment_links: [] } }),
  });
  let gateways: LiveGateways;
  beforeAll(async () => {
    gateways = new LiveGateways({ razorpay: await server.start() });
  });
  afterAll(() => server.close());

  it("makes a link in paise, for the business to send itself", async () => {
    const expiresAt = new Date("2026-10-25T12:00:00Z");
    const made = await gateways.client("razorpay").createLink(keys, {
      referenceId: "0192a3b4-0000-7000-8000-000000000001",
      amount: "1180.00",
      description: "Bill INV-7 from Mehta Distributors",
      customer: { name: "Gupta Kirana", mobile: "98260 12345", email: null },
      expiresAt,
      upiOnly: true,
      notes: { bill: "INV-7" },
    });
    expect(made).toEqual({ providerLinkId: "plink_NEW", url: "https://rzp.io/rzp/abc" });
    expect(server.seen.at(-1)!.body).toMatchObject({
      amount: 118000,
      currency: "INR",
      accept_partial: false,
      expire_by: Math.floor(expiresAt.getTime() / 1000),
      reference_id: "0192a3b4-0000-7000-8000-000000000001",
      customer: { name: "Gupta Kirana", contact: "+919826012345" },
      notify: { sms: false, email: false },
      reminder_enable: false,
      upi_link: true,
      notes: { bill: "INV-7" },
    });
  });

  it("reads a paid link with each payment's UTR, cancels and checks keys", async () => {
    const state = await gateways.client("razorpay").fetchLink(keys, "plink_NEW");
    expect(state).toEqual({ status: "paid", amountPaid: "1180.00", payments: [{ providerPaymentId: "pay_1", amount: "1180.00", method: "upi", reference: "428900001111", paidAt: "2025-10-10T09:00:00.000Z" }] });
    await gateways.client("razorpay").cancelLink(keys, "plink_NEW");
    expect(server.seen.at(-1)!.path).toBe("/v1/payment_links/plink_NEW/cancel");
    await gateways.client("razorpay").check(keys);
    const refused = await gateways
      .client("razorpay")
      .createLink({ ...keys, keySecret: "wrong" }, { referenceId: "x", amount: "1.00", description: "x", customer: { name: "x", mobile: null, email: null }, expiresAt: new Date(), upiOnly: false, notes: {} })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(GatewayError);
    expect((refused as GatewayError).code).toBe("GATEWAY_AUTH_FAILED");
  });
});

describe("Cashfree payment links", () => {
  const keys: GatewayKeys = { provider: "cashfree", environment: "test", keyId: "TESTAPP", keySecret: "cf-secret", webhookSecret: null };
  const server = standIn({
    "POST /links": (req) => ({ body: { link_id: (req.body as { link_id: string }).link_id, link_url: "https://payments-test.cashfree.com/links/abc", link_status: "ACTIVE" } }),
    "GET /links/L9": () => ({ body: { link_id: "L9", link_status: "PAID", link_amount_paid: 590 } }),
    "GET /links/L9/orders": () => ({ body: [{ order_id: "order_1", order_status: "PAID" }] }),
    "GET /orders/order_1/payments": () => ({ body: [{ cf_payment_id: 9876, payment_status: "SUCCESS", payment_amount: 590, payment_group: "upi", bank_reference: "UTR9876", payment_time: "2026-10-10T12:00:00+05:30" }] }),
    "POST /links/L9/cancel": () => ({ body: { link_status: "CANCELLED" } }),
  });
  let gateways: LiveGateways;
  beforeAll(async () => {
    gateways = new LiveGateways({ cashfree: await server.start() });
  });
  afterAll(() => server.close());

  it("makes a link in rupees with the customer's phone, expiring in India's time", async () => {
    const made = await gateways.client("cashfree").createLink(keys, {
      referenceId: "L9",
      amount: "590.00",
      description: "Payment to Mehta Distributors",
      customer: { name: "Gupta Kirana", mobile: "+91 98260 12345", email: "gupta@example.in" },
      expiresAt: new Date("2026-10-25T06:30:00Z"),
      upiOnly: true,
      notes: { link: "L9" },
    });
    expect(made).toEqual({ providerLinkId: "L9", url: "https://payments-test.cashfree.com/links/abc" });
    const asked = server.seen.at(-1)!;
    expect(asked.headers).toMatchObject({ "x-client-id": "TESTAPP", "x-client-secret": "cf-secret", "x-api-version": "2023-08-01" });
    expect(asked.body).toMatchObject({
      link_id: "L9",
      link_amount: 590,
      link_currency: "INR",
      customer_details: { customer_phone: "9826012345", customer_name: "Gupta Kirana", customer_email: "gupta@example.in" },
      link_partial_payments: false,
      link_expiry_time: "2026-10-25T12:00:00+05:30",
      link_notify: { send_sms: false, send_email: false },
      link_meta: { payment_methods: "upi" },
    });
    const noPhone = await gateways
      .client("cashfree")
      .createLink(keys, { referenceId: "L10", amount: "1.00", description: "x", customer: { name: "x", mobile: null, email: null }, expiresAt: new Date(), upiOnly: false, notes: {} })
      .catch((e: unknown) => e);
    expect(noPhone).toMatchObject({ code: "GATEWAY_REFUSED", reason: "customer_phone" });
  });

  it("reads a paid link's payments through its orders, cancels, and takes keys a missing link answers", async () => {
    expect(await gateways.client("cashfree").fetchLink(keys, "L9")).toEqual({
      status: "paid",
      amountPaid: "590.00",
      payments: [{ providerPaymentId: "9876", amount: "590.00", method: "upi", reference: "UTR9876", paidAt: "2026-10-10T06:30:00.000Z" }],
    });
    await gateways.client("cashfree").cancelLink(keys, "L9");
    // No such link (404): the keys were accepted.
    await expect(gateways.client("cashfree").check(keys)).resolves.toBeUndefined();
  });
});
