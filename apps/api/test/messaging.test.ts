import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("WhatsApp and email to customers", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const put = (url: string, body: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const member = async (roleKey: string) => {
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: `${roleKey} person`, mobile, roleId: roles[roleKey] });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { email: "accounts@laxmitraders.in" } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.sharma = (await post("/customers", { name: "Sharma Kirana", mobile: "9826011111", stateCode: "23", creditDays: 7 })).body.id;
    ids.gupta = (await post("/customers", { name: "Gupta Stores", stateCode: "23" })).body.id;
    ids.verma = (await post("/customers", { name: "Verma General", mobile: "9826033333", email: "verma@example.in", stateCode: "23" })).body.id;
    // Sharma's bill is 10 days old: past its 7 credit days.
    const old = await post("/invoices", { customerId: ids.sharma, invoiceDate: "2026-09-14", lines: [{ productId: ids.soap, qty: "10" }] });
    ids.invoice = old.body.id;
    ids.invoiceNumber = old.body.invoiceNumber;
    await post("/invoices", { customerId: ids.gupta, lines: [{ productId: ids.soap, qty: "1" }] });
    ids.receipt = (await post("/payments", { direction: "in", customerId: ids.sharma, amount: "180", method: "upi" })).body.id;
    tokens.sales = await member("sales");
    tokens.warehouse = await member("warehouse");
  });
  afterAll(async () => {
    await t?.close();
  });

  it("keeps secrets encrypted and never shows them", async () => {
    const saved = await put("/messaging/settings", {
      whatsappProvider: "meta",
      whatsappNumber: "+91 98260 00000",
      whatsappPhoneNumberId: "109876543210",
      whatsappSecret: "EAAG-very-secret-token",
      whatsappDocumentTemplate: "bill_with_pdf",
      whatsappReminderTemplate: "payment_reminder",
      whatsappTemplateLanguage: "en",
      emailMode: "smtp",
      smtpHost: "smtp.example.in",
      smtpPort: 587,
      smtpUser: "bills@laxmitraders.in",
      smtpPassword: "mail-password",
      emailFromAddress: "bills@laxmitraders.in",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.whatsapp).toMatchObject({ provider: "meta", hasSecret: true, documentTemplate: "bill_with_pdf", ready: true });
    expect(saved.body.email).toMatchObject({ mode: "smtp", hasPassword: true, ready: true });
    const all = JSON.stringify((await get("/messaging/settings")).body);
    expect(all).not.toContain("very-secret");
    expect(all).not.toContain("mail-password");
    const stored = (await t.owner.query("select whatsapp_secret, smtp_password from messaging_settings")).rows[0];
    expect(stored.whatsapp_secret).toMatch(/^v1\./);
    expect(stored.smtp_password).not.toContain("mail-password");
    const auditRow = (await get("/audit-logs?entityType=setting")).body.data.find((a: { action: string }) => a.action === "messaging.updated");
    expect(JSON.stringify(auditRow.changes)).not.toContain("secret-token");
    // Leaving a secret out keeps it.
    expect((await put("/messaging/settings", { whatsappTemplateLanguage: "hi" })).body.whatsapp.hasSecret).toBe(true);
    await put("/messaging/settings", { whatsappTemplateLanguage: "en" });
  });

  it("sends the invoice PDF on WhatsApp, in the approved template", async () => {
    const res = await post("/messages/send", { channel: "whatsapp", documentType: "invoice", documentId: ids.invoice });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "sent", recipient: "919826011111", kind: "invoice", documentNumber: ids.invoiceNumber, provider: "log" });
    const sent = t.messenger.sent.at(-1)!;
    expect(sent.attachment!.filename).toBe(`${ids.invoiceNumber!.replace(/\//g, "-")}.pdf`);
    expect(sent.attachment!.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(sent.text).toContain(ids.invoiceNumber);
    expect(sent.template).toEqual({ name: "bill_with_pdf", language: "en", params: ["Sharma Kirana", ids.invoiceNumber, "₹1,180.00", "Laxmi Traders"] });
  });

  it("needs an address for email, and takes one typed in", async () => {
    const none = await post("/messages/send", { channel: "email", documentType: "receipt", documentId: ids.receipt });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("MESSAGE_NO_RECIPIENT");
    expect((await post("/messages/send", { channel: "email", documentType: "receipt", documentId: ids.receipt, to: "not-an-email" })).body.error.code).toBe("MESSAGE_RECIPIENT_INVALID");
    const ok = await post("/messages/send", { channel: "email", documentType: "receipt", documentId: ids.receipt, to: "sharma@example.in", locale: "hi" });
    expect(ok.body).toMatchObject({ status: "sent", recipient: "sharma@example.in", subject: expect.stringContaining("रसीद") });
    expect(t.messenger.sent.at(-1)!.attachment!.filename).toMatch(/^RCT-/);
  });

  it("records a failed send with the reason", async () => {
    t.messenger.failNext("(#131026) Message undeliverable");
    const res = await post("/messages/send", { channel: "whatsapp", documentType: "invoice", documentId: ids.invoice });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: "MESSAGE_SEND_FAILED", params: { reason: "(#131026) Message undeliverable" } });
    const log = (await get(`/messages?documentId=${ids.invoice}`)).body.data;
    expect(log.map((m: { status: string }) => m.status)).toEqual(["failed", "sent"]);
    expect(log[0]).toMatchObject({ error: "(#131026) Message undeliverable", sentBy: expect.any(String) });
  });

  it("sends payment reminders in the background to customers with a balance", async () => {
    const candidates = (await get("/messages/reminders")).body.data;
    const sharma = candidates.find((c: { id: string }) => c.id === ids.sharma);
    // 1,180 billed, 180 paid; the bill was due on 21 Sep.
    expect(sharma).toMatchObject({ balance: "1000.00", overdue: "1000.00", oldestDue: "2026-09-21" });
    expect(candidates.some((c: { id: string }) => c.id === ids.verma)).toBe(false);
    const res = await post("/messages/reminders", { channel: "whatsapp", customerIds: [ids.sharma, ids.gupta, ids.verma] });
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(1);
    expect(res.body.skipped.map((s: { reason: string }) => s.reason).sort()).toEqual(["no_balance", "no_contact"]);
    let reminders: Array<{ status: string; body: string; recipient: string }> = [];
    for (let i = 0; i < 40; i++) {
      reminders = (await get("/messages?kind=reminder")).body.data;
      if (reminders[0]?.status === "sent") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(reminders[0]).toMatchObject({ status: "sent", recipient: "919826011111" });
    expect(reminders[0]!.body).toContain("₹1,000.00 is due, of which ₹1,000.00 is overdue since 21/09/2026");
    expect(t.messenger.sent.at(-1)!.template).toEqual({ name: "payment_reminder", language: "en", params: ["Sharma Kirana", "₹1,000.00", "₹1,000.00", "Laxmi Traders"] });
  });

  it("lets sales staff send but not read the log; warehouse staff neither", async () => {
    expect((await post("/messages/send", { channel: "whatsapp", documentType: "invoice", documentId: ids.invoice }, tokens.sales)).status).toBe(200);
    expect((await get("/messages", tokens.sales)).status).toBe(403);
    expect((await get("/messaging/settings", tokens.sales)).status).toBe(403);
    expect((await get("/messaging/channels", tokens.sales)).body).toMatchObject({ driver: "log", whatsapp: { ready: true }, email: { ready: true } });
    expect((await post("/messages/send", { channel: "whatsapp", documentType: "invoice", documentId: ids.invoice }, tokens.warehouse)).status).toBe(403);
    expect((await post("/messaging/test", { channel: "email", to: "owner@example.in" }, tokens.sales)).status).toBe(403);
    expect((await post("/messaging/test", { channel: "email", to: "owner@example.in" })).body).toMatchObject({ status: "sent", kind: "test" });
  });

  it("keeps each business's messages to itself", async () => {
    const other = await signup(t, { legalName: "Other Firm", stateCode: "27" });
    expect((await call(t.app, "GET", "/messages", { token: other.token })).body.data).toEqual([]);
    expect((await call(t.app, "GET", "/messaging/settings", { token: other.token })).body.whatsapp.provider).toBe("none");
    const res = await call(t.app, "POST", "/messages/send", { token: other.token, body: { channel: "whatsapp", documentType: "invoice", documentId: ids.invoice } });
    expect(res.status).toBe(404);
  });
});
