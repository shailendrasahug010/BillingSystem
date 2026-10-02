import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pumpMessages } from "../src/services/messaging/queue.js";
import { runDueReminders } from "../src/services/reminders.js";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.2, what was left: payment reminders sent to customers by a rule
 * (WhatsApp, SMS or email, in their language, on a schedule, never to those
 * who said no or replied STOP) and a reminder for orders waiting too long at
 * one step, looked at every hour.
 */
describe.skipIf(!hasDatabase)("automatic reminders", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const patch = (url: string, body: unknown) => call(t.app, "PATCH", url, { token: owner.token, body });
  const put = (url: string, body: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const deps = () => t.app.deps;
  /** Lets the message queue send what the rule queued. */
  const sent = async () => {
    await pumpMessages(deps(), { businessId: owner.businessId, userId: "" });
    return t.messenger.sent;
  };
  const at = async <T>(day: string, fn: () => Promise<T>) => {
    t.setToday(day);
    try {
      return await fn();
    } finally {
      t.setToday(null);
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    const customer = async (body: Record<string, unknown>) => (await post("/customers", { stateCode: "23", creditDays: 7, ...body })).body.id as string;
    ids.sharma = await customer({ name: "Sharma Kirana", mobile: "9826011111" });
    ids.gupta = await customer({ name: "Gupta Stores", mobile: "9826022222", messageLocale: "hi" });
    ids.verma = await customer({ name: "Verma General" });
    ids.small = await customer({ name: "Small Shop", mobile: "9826044444" });
    // Bills of 10 September: due on the 17th, a week overdue on TEST_TODAY (24 September).
    for (const [who, qty] of [["sharma", "10"], ["gupta", "5"], ["verma", "2"]] as const) {
      expect((await post("/invoices", { customerId: ids[who], invoiceDate: "2026-09-10", lines: [{ productId: ids.soap, qty }] })).status).toBe(201);
    }
    // Small Shop owes ₹59, under the rule's ₹100.
    await post("/invoices", { customerId: ids.small, invoiceDate: "2026-09-10", lines: [{ productId: ids.soap, qty: "0.5" }] });
    await put("/messaging/settings", {
      whatsappProvider: "meta",
      whatsappPhoneNumberId: "109876543210",
      whatsappSecret: "EAAG-very-secret-token",
      whatsappAppSecret: "meta-app-secret-123",
      whatsappReminderTemplate: "payment_reminder",
      whatsappTemplateLanguage: "en",
      whatsappTemplateLanguageHi: "hi",
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("payment reminders to customers", () => {
    it("are off until the business turns them on", async () => {
      const rule = (await get("/reminder-rules")).body.data.find((r: { type: string }) => r.type === "customer_reminders");
      expect(rule).toMatchObject({ isActive: false, permission: "message.send", config: { hour: 10, firstAfterDays: 1, repeatDays: 7, maxCount: 3, minAmount: 100, channel: "whatsapp_or_sms" } });
      expect((await post("/reminder-rules/customer_reminders/check", {})).body.error).toMatchObject({ code: "REMINDER_RULE_OFF" });
      expect(await runDueReminders(deps())).toMatchObject({ failed: 0 });
      expect(await sent()).toHaveLength(0);
    });

    it("once on, show who is due one today and who cannot be reached", async () => {
      const on = await patch("/reminder-rules/customer_reminders", { isActive: true, config: { hour: 0, firstAfterDays: 3, repeatDays: 7, maxCount: 2 } });
      expect(on.status).toBe(200);
      const due = (await get("/reminder-rules/customer_reminders/due")).body.data as Array<Record<string, unknown>>;
      expect(due.map((d) => [d.name, d.channel, d.locale, d.overdue, d.daysOverdue, d.sentSinceDue, d.skip])).toEqual([
        ["Sharma Kirana", "whatsapp", "en", "1180.00", 7, 0, null],
        ["Gupta Stores", "whatsapp", "hi", "590.00", 7, 0, null],
        // No mobile or email on file; Small Shop owes too little to be listed.
        ["Verma General", null, "en", "236.00", 7, 0, "no_contact"],
      ]);
      expect(due[0]).not.toHaveProperty("to");
    });

    it("send each in their language with the approved template, and tell the staff", async () => {
      const run = await runDueReminders(deps());
      expect(run).toMatchObject({ failed: 0 });
      const out = await sent();
      expect(out.map((m) => [m.channel, m.to])).toEqual([
        ["whatsapp", "919826011111"],
        ["whatsapp", "919826022222"],
      ]);
      expect(out[0]!.text).toContain("Namaste Sharma Kirana, a reminder from Laxmi Traders: ₹1,180.00 is due");
      expect(out[0]!.text).toContain("Reply STOP to stop these reminders.");
      expect(out[0]!.template).toEqual({ name: "payment_reminder", language: "en", params: ["Sharma Kirana", "₹1,180.00", "₹1,180.00", "Laxmi Traders"] });
      // Gupta gets it in Hindi, in the Hindi translation of the same template.
      expect(out[1]!.text).toContain("STOP");
      expect(out[1]!.template).toMatchObject({ name: "payment_reminder", language: "hi" });
      const rows = await q<{ party_name: string; automatic: boolean; reminder_on: string; status: string }>(`select party_name, automatic, reminder_on::text, status::text from messages order by party_name`);
      expect(rows).toEqual([
        { party_name: "Gupta Stores", automatic: true, reminder_on: TEST_TODAY, status: "sent" },
        { party_name: "Sharma Kirana", automatic: true, reminder_on: TEST_TODAY, status: "sent" },
      ]);
      const [n] = await q<{ permission: string; title_key: string; body_key: string; params: Record<string, unknown> }>(`select permission, title_key, body_key, params from notifications where type = 'customer_reminders'`);
      expect(n).toMatchObject({ permission: "message.send", title_key: "notifications.customer_reminders.title", body_key: "notifications.customer_reminders.unreachable", params: { count: 2, amount: "1770.00", unreachable: 1 } });
      expect((await get("/messages?kind=reminder")).body.data.every((m: { automatic: boolean }) => m.automatic)).toBe(true);
    });

    it("repeat only after the set days, up to the most allowed, and never twice a day", async () => {
      // The rule ran today already.
      expect(await runDueReminders(deps())).toMatchObject({ notifications: 0 });
      // Four days on: too soon.
      await at("2026-09-28", () => runDueReminders(deps()));
      expect(await sent()).toHaveLength(2);
      // A week on: the second and last.
      await at("2026-10-01", () => runDueReminders(deps()));
      expect((await sent()).slice(2).map((m) => m.to)).toEqual(["919826011111", "919826022222"]);
      await at("2026-10-08", () => runDueReminders(deps()));
      expect(await sent()).toHaveLength(4);
      expect((await at("2026-10-08", () => get("/reminder-rules/customer_reminders/due"))).body.data.filter((d: { channel: string | null }) => d.channel)).toEqual([]);
    });

    it("start again when the overdue bills are paid and new ones fall overdue", async () => {
      await post("/payments", { direction: "in", customerId: ids.sharma, amount: "1180", method: "cash" });
      await at("2026-10-10", () => post("/invoices", { customerId: ids.sharma, lines: [{ productId: ids.soap, qty: "1" }] }));
      // Due on 17 October; three days later the first reminder of this round.
      const due = (await at("2026-10-20", () => get("/reminder-rules/customer_reminders/due"))).body.data;
      expect(due.find((d: { name: string }) => d.name === "Sharma Kirana")).toMatchObject({ oldestDue: "2026-10-17", sentSinceDue: 0, overdue: "118.00" });
    });

    it("leave out a customer who asked not to get them, here and when sent by hand", async () => {
      const off = await patch(`/customers/${ids.sharma}`, { remindersOptOut: true });
      expect(off.body).toMatchObject({ remindersOptOut: true, remindersOptOutBy: "staff", remindersOptOutAt: expect.any(String) });
      const due = (await at("2026-10-20", () => get("/reminder-rules/customer_reminders/due"))).body.data;
      expect(due.find((d: { name: string }) => d.name === "Sharma Kirana")).toBeUndefined();
      const byHand = await at("2026-10-20", () => post("/messages/reminders", { channel: "whatsapp", customerIds: [ids.sharma, ids.gupta] }));
      expect(byHand.status).toBe(202);
      expect(byHand.body).toMatchObject({ queued: 1, skipped: [{ customerId: ids.sharma, reason: "opted_out" }] });
      await sent();
      expect((await patch(`/customers/${ids.sharma}`, { remindersOptOut: false })).body).toMatchObject({ remindersOptOut: false, remindersOptOutBy: null, remindersOptOutAt: null });
    });

    it("stop when the customer replies STOP on WhatsApp, and start again on START", async () => {
      const key = (await get("/messaging/settings")).body.whatsapp.statusKey as string;
      const reply = (text: string) => {
        const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { metadata: { phone_number_id: "109876543210" }, messages: [{ from: "919826022222", id: "wamid.in1", timestamp: "1790500000", type: "text", text: { body: text } }] } }] }] });
        return t.app.inject({
          method: "POST",
          url: `/api/v1/webhooks/whatsapp/${key}`,
          headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "meta-app-secret-123").update(body).digest("hex")}` },
          payload: body,
        });
      };
      expect((await reply("Stop")).statusCode).toBe(200);
      expect((await get(`/customers/${ids.gupta}`)).body).toMatchObject({ remindersOptOut: true, remindersOptOutBy: "reply" });
      const [n] = await q<{ permission: string; title_key: string; params: Record<string, unknown> }>(`select permission, title_key, params from notifications where type = 'reminders_stopped'`);
      expect(n).toMatchObject({ permission: "message.send", title_key: "notifications.events.reminders_stopped", params: { customer: "Gupta Stores" } });
      // Hindi works too, and other messages change nothing.
      expect((await reply("namaste")).statusCode).toBe(200);
      expect((await get(`/customers/${ids.gupta}`)).body.remindersOptOut).toBe(true);
      expect((await reply("START")).statusCode).toBe(200);
      expect((await get(`/customers/${ids.gupta}`)).body).toMatchObject({ remindersOptOut: false, remindersOptOutBy: null });
      expect((await reply("बंद")).statusCode).toBe(200);
      expect((await get(`/customers/${ids.gupta}`)).body.remindersOptOut).toBe(true);
      // START does not undo a stop the business set itself.
      await patch(`/customers/${ids.sharma}`, { remindersOptOut: true });
      await q(`update customers set mobile = '9826022222' where id = $1`, [ids.verma]);
      expect((await reply("START")).statusCode).toBe(200);
      expect((await get(`/customers/${ids.sharma}`)).body.remindersOptOut).toBe(true);
      await q(`update customers set mobile = null where id = $1`, [ids.verma]);
    });

    it("go by SMS with the registered DLT template, and keep the SMS secret to the server", async () => {
      const saved = await put("/messaging/settings", { smsProvider: "webhook", smsWebhookUrl: "https://sms.example.in/send", smsSecret: "sms-signing-secret", smsSenderId: "LAXMIT", smsReminderTemplate: "1207161234567890123", smsReminderTemplateHi: "1207161234567890456" });
      expect(saved.body.sms).toEqual({ provider: "webhook", webhookUrl: "https://sms.example.in/send", hasSecret: true, senderId: "LAXMIT", reminderTemplate: "1207161234567890123", reminderTemplateHi: "1207161234567890456", ready: true });
      expect(JSON.stringify((await get("/messaging/settings")).body)).not.toContain("sms-signing-secret");
      expect((await put("/messaging/settings", { smsSenderId: "laxmi traders" })).status).toBe(400);
      await patch(`/customers/${ids.gupta}`, { remindersOptOut: false });
      await patch(`/customers/${ids.sharma}`, { remindersOptOut: false });
      // Gupta has had two already: allow more.
      await patch("/reminder-rules/customer_reminders", { config: { channel: "sms", firstAfterDays: 0, maxCount: 5 } });
      const before = (await sent()).length;
      // Verma General has no mobile for an SMS.
      expect((await at("2026-10-21", () => post("/reminder-rules/customer_reminders/check", {}))).body).toMatchObject({ result: "raised", sent: { count: 2, unreachable: 1 } });
      const sms = (await sent()).slice(before);
      // Each in their language's registered template.
      expect(sms.map((m) => [m.channel, m.to, m.template?.name])).toEqual([
        ["sms", "919826022222", "1207161234567890456"],
        ["sms", "919826011111", "1207161234567890123"],
      ]);
      // No STOP line by SMS (the replies do not come here).
      expect(sms.every((m) => !m.text.includes("STOP"))).toBe(true);
      // Sent by hand, the day's run sends nothing more.
      await at("2026-10-21", () => runDueReminders(deps()));
      expect((await sent()).length).toBe(before + 2);
    });
  });

  describe("orders waiting too long", () => {
    it("tell the staff once, in the hour an order crosses the limit", async () => {
      const customer = ids.gupta;
      const order = await post("/sales-orders", { customerId: customer, lines: [{ productId: ids.soap, qty: "2" }] });
      expect(order.status).toBe(201);
      const rule = (await get("/reminder-rules")).body.data.find((r: { type: string }) => r.type === "orders_waiting");
      expect(rule).toMatchObject({ isActive: true, hourly: true, permission: "order.confirm", config: { hour: 9, afterHours: 4 } });
      await patch("/reminder-rules/orders_waiting", { config: { hour: 0, afterHours: 4 } });
      const now = deps().clock.now();
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
      // Placed five hours ago and still waiting to be confirmed.
      const placedAt = async (id: string, iso: string) => {
        await q(`update sales_orders set created_at = $2 where id = $1`, [id, iso]);
        await q(`update status_history set created_at = $2 where entity_id = $1`, [id, iso]);
      };
      await placedAt(order.body.id, hoursAgo(5));
      await q(`update reminder_rules set last_run_at = null where type = 'orders_waiting'`);
      expect(await runDueReminders(deps())).toMatchObject({ failed: 0 });
      const first = await q<{ title_key: string; body_key: string; params: Record<string, unknown>; permission: string }>(`select title_key, body_key, params, permission from notifications where type = 'orders_waiting'`);
      expect(first).toEqual([
        { permission: "order.confirm", title_key: "notifications.orders_waiting.title", body_key: "notifications.orders_waiting.confirm", params: { count: 1, hours: 4, order: order.body.orderNumber, customer: "Gupta Stores", waited: 5 } },
      ]);
      // Within the hour: not looked at again.
      expect((await runDueReminders(deps())).checked).toBe(0);
      // An hour on: the same order is not told again.
      t.advance(3_600_000);
      expect(await runDueReminders(deps())).toMatchObject({ failed: 0 });
      expect(await q(`select 1 from notifications where type = 'orders_waiting'`)).toHaveLength(1);
      // Another order crossing the limit in that hour is.
      const second = await post("/sales-orders", { customerId: customer, lines: [{ productId: ids.soap, qty: "1" }] });
      const later = deps().clock.now();
      // Placed 3½ hours before the last run: it crosses the 4 hours before the next.
      await placedAt(second.body.id, new Date(later.getTime() - 3.5 * 3_600_000).toISOString());
      t.advance(3_600_000);
      await runDueReminders(deps());
      const all = await q<{ params: Record<string, unknown> }>(`select params from notifications where type = 'orders_waiting' order by created_at`);
      expect(all).toHaveLength(2);
      expect(all[1]!.params).toMatchObject({ count: 1, order: second.body.orderNumber });
      // Confirmed orders waiting to be packed say so.
      expect((await post(`/sales-orders/${second.body.id}/status`, { status: "confirmed" })).status).toBe(200);
      // A check by hand in the hour of a run is that run's; in the next hour it looks again.
      expect((await post("/reminder-rules/orders_waiting/check", {})).body).toMatchObject({ result: "already" });
      t.advance(3_600_000);
      await q(`update status_history set created_at = $2 where entity_id = $1 and to_status = 'confirmed'`, [second.body.id, new Date(deps().clock.now().getTime() - 4.2 * 3_600_000).toISOString()]);
      const check = await post("/reminder-rules/orders_waiting/check", {});
      expect(check.body).toMatchObject({ result: "raised" });
      const [last] = await q<{ body_key: string }>(`select body_key from notifications where type = 'orders_waiting' order by created_at desc limit 1`);
      expect(last!.body_key).toMatch(/notifications\.orders_waiting\.(confirm|pack)/);
    });
  });
});
