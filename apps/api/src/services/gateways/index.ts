import { CashfreeClient } from "./cashfree.js";
import { RazorpayClient } from "./razorpay.js";
import { GatewayError, type GatewayClient, type GatewayKeys, type GatewayName, type Gateways, type LinkState, type NewLink } from "./types.js";

export * from "./types.js";
export { parseCashfreeWebhook, verifyCashfreeWebhook } from "./cashfree.js";
export { parseRazorpayWebhook, verifyRazorpayWebhook } from "./razorpay.js";

/** Keys the stand-in gateway refuses, to try the "wrong keys" path. */
export const FAKE_BAD_SECRET = "wrong-secret";

/**
 * A stand-in for both gateways, for development, demos and tests: links are
 * made in memory with an address that goes nowhere, nothing is charged. A
 * payment is reported to it the way a gateway reports one (a signed webhook,
 * which the webhook route hands to `remember`), or by `pay` in tests.
 */
export class FakeGateways implements Gateways {
  readonly driver = "fake" as const;
  private readonly links = new Map<string, LinkState & { amount: string }>();

  private key(provider: GatewayName, id: string) {
    return `${provider}:${id}`;
  }

  remember(provider: GatewayName, providerLinkId: string, state: LinkState) {
    const k = this.key(provider, providerLinkId);
    const before = this.links.get(k);
    const payments = new Map([...(before?.payments ?? []), ...state.payments].map((p) => [p.providerPaymentId, p]));
    this.links.set(k, { amount: before?.amount ?? state.amountPaid, ...state, payments: [...payments.values()] });
  }

  /** Tests: the customer pays (all of it unless an amount is given). */
  pay(provider: GatewayName, providerLinkId: string, p: { amount?: string; method?: "upi" | "card"; id?: string; reference?: string } = {}) {
    const link = this.links.get(this.key(provider, providerLinkId));
    if (!link) throw new Error(`no fake link ${providerLinkId}`);
    const amount = p.amount ?? link.amount;
    const paid = (Number(link.amountPaid) + Number(amount)).toFixed(2);
    link.payments.push({ providerPaymentId: p.id ?? `fakepay_${providerLinkId}_${link.payments.length + 1}`, amount, method: p.method ?? "upi", reference: p.reference ?? null, paidAt: new Date().toISOString() });
    link.amountPaid = paid;
    link.status = Number(paid) >= Number(link.amount) ? "paid" : "partly_paid";
  }

  /** Tests: the link ran out. */
  expire(provider: GatewayName, providerLinkId: string) {
    const link = this.links.get(this.key(provider, providerLinkId));
    if (link) link.status = "expired";
  }

  client(provider: GatewayName): GatewayClient {
    const links = this.links;
    const key = (id: string) => this.key(provider, id);
    const guard = (keys: GatewayKeys) => {
      if (keys.keySecret === FAKE_BAD_SECRET) throw new GatewayError("GATEWAY_AUTH_FAILED", "The test gateway refused the keys", "401");
    };
    return {
      createLink: async (keys: GatewayKeys, link: NewLink) => {
        guard(keys);
        if (provider === "cashfree" && !(link.customer.mobile ?? "").replace(/\D/g, "").match(/[6-9]\d{9}$/)) {
          throw new GatewayError("GATEWAY_REFUSED", "Cashfree needs the customer's mobile number", "customer_phone");
        }
        const providerLinkId = provider === "razorpay" ? `plink_test${link.referenceId.replace(/-/g, "").slice(-14)}` : link.referenceId;
        links.set(key(providerLinkId), { amount: link.amount, status: "created", amountPaid: "0.00", payments: [] });
        return { providerLinkId, url: `https://pay.example.test/${provider}/${providerLinkId}` };
      },
      fetchLink: async (keys: GatewayKeys, providerLinkId: string) => {
        guard(keys);
        const link = links.get(key(providerLinkId));
        if (!link) throw new GatewayError("GATEWAY_REFUSED", "No such link at the test gateway", "404");
        return { status: link.status, amountPaid: link.amountPaid, payments: [...link.payments] };
      },
      cancelLink: async (keys: GatewayKeys, providerLinkId: string) => {
        guard(keys);
        const link = links.get(key(providerLinkId));
        if (link && link.status !== "paid") link.status = "cancelled";
      },
      check: async (keys: GatewayKeys) => {
        guard(keys);
      },
    };
  }
}

/** The real gateways; `bases` replace their addresses (a stand-in server in tests). */
export class LiveGateways implements Gateways {
  readonly driver = "live" as const;
  private readonly razorpay: RazorpayClient;
  private readonly cashfree: CashfreeClient;
  constructor(bases: { razorpay?: string | undefined; cashfree?: string | undefined } = {}) {
    this.razorpay = new RazorpayClient(bases.razorpay ?? "https://api.razorpay.com");
    this.cashfree = new CashfreeClient(bases.cashfree ?? null);
  }
  client(provider: GatewayName): GatewayClient {
    return provider === "razorpay" ? this.razorpay : this.cashfree;
  }
}

export function createGateways(config: { driver: "live" | "fake"; razorpayBase?: string | undefined; cashfreeBase?: string | undefined }): Gateways {
  return config.driver === "live" ? new LiveGateways({ razorpay: config.razorpayBase, cashfree: config.cashfreeBase }) : new FakeGateways();
}
