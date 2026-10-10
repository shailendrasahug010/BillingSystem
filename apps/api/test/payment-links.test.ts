import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_BAD_SECRET, type FakeGateways } from "../src/services/gateways/index.js";
import { runPaymentLinkChecks } from "../src/services/payment-links.js";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

/**
 * Online payments: the business's Razorpay or Cashfree account (the stand-in
 * gateway here), links for a bill or a balance, and each payment on them
 * recorded once as a receipt, whether the gateway's webhook or a check
 * brings it.
 */
describe.skipIf(!hasDatabase)("online payments", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token: string = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token: string = owner.token) => call(t.app, "GET", url, { token });
  const put = (url: string, body: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const fake = () => t.app.deps.gateways as FakeGateways;
  const providerLinkId = async (id: string) => (await t.owner.query("select provider_link_id from payment_links where id = $1", [id])).rows[0].provider_link_id as string;
  const receiptsOf = async (customerId: string) => (await get(`/payments?customerId=${customerId}`)).body.data as Array<{ id: string; amount: string; method: string; referenceNumber: string | null }>;
  const webhook = (key: string, raw: string, headers: Record<string, string>) =>
    t.app.inject({ method: "POST", url: `/api/v1/webhooks/payments/${key}`, headers: { "content-type": "application/json", ...headers }, payload: raw });
  const razorpaySecret = "whsec-razorpay-test";

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Mehta Distributors", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "70" })).body.id;
    ids.shop = (await post("/customers", { name: "Gupta Kirana", mobile: "9826012345", stateCode: "23" })).body.id;
    ids.noMobile = (await post("/customers", { name: "Walk-in Stores", stateCode: "23" })).body.id;
    // Two bills of 1,180 each: the older one first.
    const first = await post("/invoices", { customerId: ids.shop, invoiceDate: "2026-09-10", lines: [{ productId: ids.soap, qty: "10" }] });
    const second = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "10" }] });
    expect([first.status, second.status]).toEqual([201, 201]);
    ids.first = first.body.id;
    ids.second = second.body.id;
    ids.secondNumber = second.body.invoiceNumber;
    await post("/invoices", { customerId: ids.noMobile, lines: [{ productId: ids.soap, qty: "1" }] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is off until a gateway is set up, refuses wrong keys and never shows a secret", async () => {
    expect((await get("/payment-gateway")).body).toMatchObject({ driver: "fake", provider: "none", ready: false, webhookKey: null });
    expect((await post("/payment-links", { customerId: ids.shop })).body.error.code).toBe("PAYMENT_GATEWAY_NOT_SET_UP");
    expect((await put("/payment-gateway", { provider: "razorpay" })).body.error.code).toBe("GATEWAY_KEYS_REQUIRED");
    const refused = await put("/payment-gateway", { provider: "razorpay", keyId: "rzp_test_ABCDEF123456", keySecret: FAKE_BAD_SECRET });
    expect(refused.status).toBe(502);
    expect(refused.body.error.code).toBe("GATEWAY_AUTH_FAILED");

    const saved = await put("/payment-gateway", { provider: "razorpay", environment: "test", keyId: "rzp_test_ABCDEF123456", keySecret: "razorpay-key-secret", webhookSecret: razorpaySecret, upiOnly: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: "razorpay", environment: "test", keyId: "rzp_test_ABCDEF123456", hasKeySecret: true, hasWebhookSecret: true, upiOnly: true, linkExpiryDays: 15, ready: true });
    expect(saved.body.webhookKey).toMatch(/^[A-Za-z0-9_-]{24}$/);
    ids.webhookKey = saved.body.webhookKey;
    expect(JSON.stringify((await get("/payment-gateway")).body)).not.toMatch(/razorpay-key-secret|whsec-razorpay/);
    const stored = (await t.owner.query("select key_secret, webhook_secret from payment_gateway_settings")).rows[0];
    expect(stored.key_secret).not.toContain("razorpay-key-secret");
    expect(stored.webhook_secret).not.toContain("whsec");
    expect((await post("/payment-gateway/test")).body).toEqual({ ok: true, provider: "razorpay", environment: "test" });
    // Leaving the secret out keeps it; the webhook address stays the same.
    const again = await put("/payment-gateway", { provider: "razorpay", environment: "test", linkExpiryDays: 10 });
    expect(again.body).toMatchObject({ hasKeySecret: true, linkExpiryDays: 10, webhookKey: ids.webhookKey });
    expect((await get("/payment-links/setup")).body).toEqual({ ready: true, provider: "razorpay", environment: "test" });
  });

  it("makes a link for a bill's balance, and gives the same open link again", async () => {
    const made = await post("/payment-links", { customerId: ids.shop, invoiceId: ids.second });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ provider: "razorpay", environment: "test", customerName: "Gupta Kirana", invoiceNumber: ids.secondNumber, amount: "1180.00", amountPaid: "0.00", status: "created", source: "staff", payments: [] });
    expect(made.body.url).toMatch(/^https:\/\/pay\.example\.test\/razorpay\/plink_test/);
    ids.link = made.body.id;
    const same = await post("/payment-links", { customerId: ids.shop, invoiceId: ids.second });
    expect(same.status).toBe(200);
    expect(same.body.id).toBe(ids.link);
    expect((await post("/payment-links", { customerId: ids.shop, invoiceId: ids.second, amount: "5000" })).body.error).toMatchObject({ code: "PAYMENT_LINK_EXCEEDS_DUE", params: { due: "1180.00" } });
    expect((await post("/payment-links", { customerId: ids.shop, invoiceId: ids.second, amount: "0.50" })).body.error.code).toBe("PAYMENT_LINK_TOO_SMALL");
    const audit = (await get("/audit-logs?entityType=customer")).body.data.find((a: { action: string }) => a.action === "payment_link.created");
    expect(audit.changes).toMatchObject({ amount: "1180.00", bill: ids.secondNumber, gateway: "razorpay" });
  });

  it("records a paid link as a receipt for its own bill, once, and tells staff", async () => {
    fake().pay("razorpay", await providerLinkId(ids.link!), { method: "upi", reference: "426512345678" });
    const paid = await post(`/payment-links/${ids.link}/refresh`);
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "paid", amountPaid: "1180.00" });
    expect(paid.body.payments).toEqual([expect.objectContaining({ amount: "1180.00", method: "upi", reference: "426512345678" })]);
    expect(paid.body.payments[0].paymentNumber).toBeTruthy();
    // The link's bill is paid, not the older one.
    expect((await get(`/invoices/${ids.second}`)).body).toMatchObject({ balanceDue: "0.00", paymentStatus: "paid" });
    expect((await get(`/invoices/${ids.first}`)).body.balanceDue).toBe("1180.00");
    const receipts = await receiptsOf(ids.shop!);
    expect(receipts).toEqual([expect.objectContaining({ amount: "1180.00", method: "upi", referenceNumber: "426512345678" })]);
    // Asked again (and again past the few seconds the screen waits): still one receipt.
    t.advance(10_000);
    await post(`/payment-links/${ids.link}/refresh`);
    expect(await receiptsOf(ids.shop!)).toHaveLength(1);
    const notes = (await get("/notifications")).body.data.filter((n: { type: string }) => n.type === "payment_received_online");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ entityType: "customer", entityId: ids.shop, params: { customer: "Gupta Kirana", amount: "1180.00" } });
    expect((await post(`/payment-links/${ids.link}/cancel`)).body.error.code).toBe("PAYMENT_LINK_CLOSED");
  });

  it("takes the gateway's signed webhook and ignores unsigned or wrongly signed ones", async () => {
    // What the customer owes now: the older bill.
    const made = await post("/payment-links", { customerId: ids.shop });
    expect(made.body).toMatchObject({ amount: "1180.00", invoiceId: null, status: "created" });
    const plink = await providerLinkId(made.body.id);
    const raw = JSON.stringify({
      entity: "event",
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: plink, reference_id: made.body.id, status: "paid", amount: 118000, amount_paid: 118000 } },
        payment: { entity: { id: "pay_TestWebhook001", amount: 118000, method: "netbanking", status: "captured", created_at: Math.floor(Date.now() / 1000), acquirer_data: { bank_transaction_id: "HDFC0001234" } } },
      },
    });
    const sign = (secret: string) => createHmac("sha256", secret).update(raw).digest("hex");
    expect((await webhook(ids.webhookKey!, raw, {})).statusCode).toBe(403);
    expect((await webhook(ids.webhookKey!, raw, { "x-razorpay-signature": sign("not-the-secret") })).statusCode).toBe(403);
    expect((await webhook("unknown-key-0123456789abcdef", raw, { "x-razorpay-signature": sign(razorpaySecret) })).statusCode).toBe(403);
    expect((await get(`/payment-links/${made.body.id}`)).body.status).toBe("created");

    expect((await webhook(ids.webhookKey!, raw, { "x-razorpay-signature": sign(razorpaySecret) })).statusCode).toBe(200);
    const link = (await get(`/payment-links/${made.body.id}`)).body;
    expect(link).toMatchObject({ status: "paid", amountPaid: "1180.00" });
    expect(link.payments).toEqual([expect.objectContaining({ method: "bank_transfer", reference: "HDFC0001234" })]);
    // A balance link pays the oldest bill first.
    expect((await get(`/invoices/${ids.first}`)).body.balanceDue).toBe("0.00");
    // Sent again: nothing more is recorded.
    expect((await webhook(ids.webhookKey!, raw, { "x-razorpay-signature": sign(razorpaySecret) })).statusCode).toBe(200);
    expect(await receiptsOf(ids.shop!)).toHaveLength(2);
    expect((await get("/payment-gateway")).body.lastWebhookAt).toBeTruthy();
  });

  it("finds payments by asking the gateway when no webhook comes, and closes links that ran out", async () => {
    const bill = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "5" }] });
    const paidLater = await post("/payment-links", { customerId: ids.shop, invoiceId: bill.body.id });
    expect(paidLater.body.amount).toBe("590.00");
    const another = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "1" }] });
    const runsOut = await post("/payment-links", { customerId: ids.shop, invoiceId: another.body.id });
    fake().pay("razorpay", await providerLinkId(paidLater.body.id), { method: "card" });
    fake().expire("razorpay", await providerLinkId(runsOut.body.id));
    // Too new to be asked about yet.
    expect((await runPaymentLinkChecks(t.app.deps)).checked).toBe(0);
    t.advance(15 * 60_000);
    const done = await runPaymentLinkChecks(t.app.deps);
    expect(done).toMatchObject({ businesses: 1, checked: 2, recorded: 1, failed: 0 });
    expect((await get(`/payment-links/${paidLater.body.id}`)).body).toMatchObject({ status: "paid" });
    expect((await get(`/payment-links/${runsOut.body.id}`)).body).toMatchObject({ status: "expired" });
    expect((await get(`/invoices/${bill.body.id}`)).body.balanceDue).toBe("0.00");
    // Nothing open is left to ask about.
    t.advance(15 * 60_000);
    expect((await runPaymentLinkChecks(t.app.deps)).checked).toBe(0);
    const open = (await get("/payment-links?status=open")).body.data;
    expect(open).toEqual([]);
    const paidList = (await get(`/payment-links?status=paid&customerId=${ids.shop}`)).body.data;
    expect(paidList).toHaveLength(3);
  });

  it("cancels a link at the gateway", async () => {
    const bill = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "2" }] });
    const made = await post("/payment-links", { customerId: ids.shop, invoiceId: bill.body.id, amount: "100" });
    expect(made.body.amount).toBe("100.00");
    const cancelled = await post(`/payment-links/${made.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    // A new link for the same bill is a new one, not the cancelled one.
    const fresh = await post("/payment-links", { customerId: ids.shop, invoiceId: bill.body.id, amount: "100" });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(made.body.id);
    ids.lastBill = bill.body.id;
  });

  it("puts a pay link in payment reminders whose words are not a template's", async () => {
    const res = await post("/messages/reminders", { channel: "whatsapp", customerIds: [ids.shop] });
    expect(res.body.queued).toBe(1);
    let reminder: { status: string; body: string } | undefined;
    for (let i = 0; i < 60; i++) {
      reminder = (await get("/messages?kind=reminder")).body.data[0];
      if (reminder?.status === "sent") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(reminder?.status).toBe("sent");
    expect(reminder!.body).toMatch(/Pay online: https:\/\/pay\.example\.test\/razorpay\/plink_test\w+$/);
    const link = (await get(`/payment-links?customerId=${ids.shop}&status=open`)).body.data.find((l: { source: string }) => l.source === "reminder");
    expect(link).toMatchObject({ invoiceId: null, amount: (await get(`/customers/${ids.shop}`)).body.balance });
    expect(reminder!.body.endsWith(link.url)).toBe(true);
  });

  it("lets a shop pay online from its order link", async () => {
    const key = (await post(`/customers/${ids.shop}/order-link`)).body.key as string;
    const page = (await call(t.app, "GET", `/shop/${key}`, {})).body;
    expect(page.account.online).toBe(true);
    // Everything owed: the reminder's link, still open for the same amount.
    const whole = await call(t.app, "POST", `/shop/${key}/pay`, { body: {} });
    expect(whole.status).toBe(200);
    const reminderLink = (await get(`/payment-links?customerId=${ids.shop}&status=open`)).body.data.find((l: { source: string }) => l.source === "reminder");
    expect(whole.body).toMatchObject({ url: reminderLink.url, amount: "354.00" });
    const bill = await call(t.app, "POST", `/shop/${key}/pay`, { body: { invoiceId: ids.lastBill } });
    expect(bill.body.amount).toBe("236.00");
    expect(bill.body.url).toMatch(/^https:\/\/pay\.example\.test\/razorpay\//);
    // A bill already paid has nothing to pay.
    expect((await call(t.app, "POST", `/shop/${key}/pay`, { body: { invoiceId: ids.first } })).body.error.code).toBe("PAYMENT_LINK_NOTHING_DUE");
    const links = (await get(`/payment-links?customerId=${ids.shop}`)).body.data.filter((l: { source: string }) => l.source === "shop");
    expect(links).toEqual([expect.objectContaining({ invoiceId: ids.lastBill, amount: "236.00" })]);
  });

  it("works with Cashfree, which signs with the secret key and needs the customer's mobile", async () => {
    const saved = await put("/payment-gateway", { provider: "cashfree", environment: "test", keyId: "TEST1234567890abcdef", keySecret: "cashfree-secret-key" });
    expect(saved.body).toMatchObject({ provider: "cashfree", ready: true, webhookKey: ids.webhookKey });
    expect((await post("/payment-links", { customerId: ids.noMobile })).body.error.code).toBe("PAYMENT_LINK_NEEDS_MOBILE");
    const bill = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "3" }] });
    const made = await post("/payment-links", { customerId: ids.shop, invoiceId: bill.body.id });
    expect(made.body).toMatchObject({ provider: "cashfree", amount: "354.00" });
    expect(made.body.url).toBe(`https://pay.example.test/cashfree/${made.body.id}`);
    const raw = JSON.stringify({
      type: "PAYMENT_LINK_EVENT",
      data: { link_id: made.body.id, link_status: "PAID", link_amount: 354, link_amount_paid: 354, order: { order_id: "CF_ORDER_1", transaction_id: 1122334455, transaction_status: "SUCCESS", order_amount: 354 } },
    });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", "cashfree-secret-key").update(timestamp + raw).digest("base64");
    expect((await webhook(ids.webhookKey!, raw, { "x-webhook-timestamp": timestamp, "x-webhook-signature": "bad" })).statusCode).toBe(403);
    expect((await webhook(ids.webhookKey!, raw, { "x-webhook-timestamp": timestamp, "x-webhook-signature": signature })).statusCode).toBe(200);
    expect((await get(`/payment-links/${made.body.id}`)).body).toMatchObject({ status: "paid", amountPaid: "354.00" });
    expect((await get(`/invoices/${bill.body.id}`)).body.balanceDue).toBe("0.00");
    // The links made with Razorpay keys are no longer asked about at Cashfree.
    t.advance(24 * 3600_000);
    expect((await runPaymentLinkChecks(t.app.deps)).failed).toBe(0);
  });

  it("keeps each business's links to itself", async () => {
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    expect((await get(`/payment-links/${ids.link}`, other.token)).status).toBe(404);
    expect((await get("/payment-links", other.token)).body.data).toEqual([]);
    expect((await get("/payment-gateway", other.token)).body).toMatchObject({ provider: "none", webhookKey: null });
  });
});
