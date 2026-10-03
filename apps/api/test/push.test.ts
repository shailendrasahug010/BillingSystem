import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nightlyForBusiness } from "../src/services/nightly-analytics.js";
import { processOutbox } from "../src/services/outbox-worker.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.2, push messages to phones: the Android app registers its FCM
 * token; a new notification goes to the phones of the people it is for (as
 * the inbox shows it), in each phone's language, at most once; tokens FCM
 * says are gone are deleted; signing out, or moving the sign-in to another
 * business, stops them.
 */
describe.skipIf(!hasDatabase)("push messages to phones", () => {
  let t: TestApp;
  let owner: Session;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const deps = () => t.app.deps;
  const phone = (who: string) => `fcm-token-${who}-${"x".repeat(40)}`;
  /** Runs the outbox worker and returns the pushes it sent. */
  const pushed = async () => {
    const before = t.push.sent.length;
    await processOutbox(deps());
    return t.push.sent.slice(before);
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Agarwal Traders", stateCode: "23" });
    tokens.owner = owner.token;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    for (const key of ["sales", "warehouse"]) {
      const mobile = nextMobile();
      expect((await post("/members", { name: `${key} person`, mobile, roleId: roles[key] })).status).toBe(201);
      await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
      tokens[key] = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
    }
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.oil = (await post("/products", { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "8", minStock: "40" })).body.id;
    ids.customer = (await post("/customers", { name: "Verma Kirana", stateCode: "23" })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("writes no push work while the business has no phones", async () => {
    expect((await post("/reminder-rules/low_stock/check", {})).body).toMatchObject({ result: "raised" });
    expect(await q(`select 1 from outbox_events where event_type = 'notification.created'`)).toHaveLength(0);
  });

  it("registers phones: one row per business and token, moving to whoever signs in on it; a device must be the person's own", async () => {
    const reg = await post("/push/tokens", { token: phone("owner"), platform: "android", locale: "hi" });
    expect(reg.status).toBe(200);
    expect(reg.body).toEqual({ id: expect.any(String), push: true });
    // Registered again at the next start: the same row.
    expect((await post("/push/tokens", { token: phone("owner"), platform: "android", locale: "hi" })).body.id).toBe(reg.body.id);
    expect((await post("/push/tokens", { token: phone("sales"), platform: "android" }, tokens.sales)).status).toBe(200);
    expect((await post("/push/tokens", { token: phone("warehouse"), platform: "android" }, tokens.warehouse)).status).toBe(200);
    const rows = await q<{ token: string; locale: string }>(`select token, locale from push_tokens order by created_at`);
    expect(rows.map((r) => [r.token.slice(0, 20), r.locale])).toEqual([
      [phone("owner").slice(0, 20), "hi"],
      [phone("sales").slice(0, 20), "en"],
      [phone("warehouse").slice(0, 20), "en"],
    ]);
    const unknownDevice = await post("/push/tokens", { token: phone("owner"), platform: "android", deviceId: "01a0f000-0000-7000-8000-000000000999" });
    expect(unknownDevice.status).toBe(400);
    expect(unknownDevice.body.error).toMatchObject({ code: "DEVICE_NOT_FOUND", field: "deviceId" });
    expect((await post("/push/tokens", { token: "short", platform: "android" })).status).toBe(400);
  });

  it("pushes a new notification to the phones of those it is for, in each phone's language, once", async () => {
    t.setToday("2026-09-25");
    try {
      expect((await post("/reminder-rules/low_stock/check", {})).body).toMatchObject({ result: "raised" });
    } finally {
      t.setToday(null);
    }
    const sent = await pushed();
    // Low stock is for those who buy (purchase.create): the owner, not the salesperson or the warehouse.
    expect(sent.map((m) => m.token)).toEqual([phone("owner")]);
    const toOwner = sent[0]!;
    // The owner's phone is in Hindi.
    expect(toOwner.title).toMatch(/[ऀ-ॿ]/);
    expect(toOwner).toMatchObject({ tag: "low_stock", data: { type: "low_stock", businessId: owner.businessId } });
    expect(toOwner.data.notificationId).toEqual(expect.any(String));
    const [n] = await q<{ delivered_channels: string[] }>(`select delivered_channels from notifications where id = $1`, [toOwner.data.notificationId]);
    expect(n!.delivered_channels).toEqual(["in_app", "push"]);
    // At most once: nothing more on the next run.
    expect(await pushed()).toHaveLength(0);
  });

  it("follows the order through its steps: who confirms, then who packs", async () => {
    const order = (await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.oil, qty: "2" }] })).body;
    // One run: the order's event raises the notification, and its push goes in the same run.
    const waiting = await pushed();
    expect(waiting.map((m) => [m.token, m.data.type])).toEqual([[phone("owner"), "order_waiting"]]);
    expect(waiting[0]).toMatchObject({ tag: `order_waiting:${order.id}`, urgent: false, data: { entityType: "sales_order", entityId: order.id } });
    expect(waiting[0]!.title).toContain(order.orderNumber);
    expect((await post(`/sales-orders/${order.id}/status`, { status: "confirmed" })).status).toBe(200);
    // Confirmed: for those who pack (the warehouse; the owner sees everything).
    expect((await pushed()).map((m) => [m.token, m.data.type]).sort()).toEqual([
      [phone("owner"), "order_to_pack"],
      [phone("warehouse"), "order_to_pack"],
    ]);
  });

  it("deletes a token FCM says is gone, and stops at signing out", async () => {
    // An overdue bill: the payment reminder is for those who see ledgers, the salesperson among them, whose app was uninstalled.
    expect((await post("/invoices", { customerId: ids.customer, invoiceDate: "2026-09-01", lines: [{ productId: ids.oil, qty: "1" }] })).status).toBe(201);
    await pushed();
    t.push.unregistered.add(phone("sales"));
    expect((await post("/reminder-rules/customer_payment_due/check", {})).body).toMatchObject({ result: "raised" });
    expect((await pushed()).map((m) => m.token)).toEqual([phone("owner")]);
    expect(await q(`select 1 from push_tokens where token = $1`, [phone("sales")])).toHaveLength(0);

    // The owner signs out on the phone: no more pushes there.
    expect((await call(t.app, "POST", "/auth/logout", { token: tokens.owner, body: {} })).status).toBe(204);
    await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.oil, qty: "1" }] }, tokens.sales);
    expect(await q(`select 1 from notifications where type = 'order_waiting'`)).toHaveLength(1);
    expect(await pushed()).toEqual([]);
    expect(await q(`select 1 from notifications where type = 'order_waiting'`)).toHaveLength(2);
    // The nightly job clears the ended sign-in's token.
    const details = await nightlyForBusiness(deps(), owner.businessId, TEST_TODAY);
    expect(details.pushTokensDeleted).toBeGreaterThanOrEqual(1);
    expect(await q(`select 1 from push_tokens where token = $1`, [phone("owner")])).toHaveLength(0);
  });

  it("removes a phone on request, and sends a test push to one's own phones", async () => {
    // Signed in again (a new sign-in; the old one's access token would not do: its sign-in has ended).
    const again = await call(t.app, "POST", "/auth/login", { body: { identifier: owner.mobile, password: owner.password } });
    tokens.owner = again.body.accessToken;
    await post("/push/tokens", { token: phone("owner"), platform: "android", locale: "en" }, tokens.owner);
    const test = await post("/push/test", {}, tokens.owner);
    expect(test.body).toEqual({ phones: 1, sent: 1, failed: 0, removed: 0 });
    expect(t.push.sent.at(-1)).toMatchObject({ token: phone("owner"), title: "Test notification from Digital Bahi", body: "Notifications from Agarwal Traders will show on this phone." });
    expect((await call(t.app, "DELETE", "/push/tokens", { token: tokens.owner, body: { token: phone("owner") } })).status).toBe(204);
    expect((await post("/push/test", {}, tokens.owner)).body).toEqual({ phones: 0, sent: 0, failed: 0, removed: 0 });
    // Removing one that is not there is fine.
    expect((await call(t.app, "DELETE", "/push/tokens", { token: tokens.owner, body: { token: phone("owner") } })).status).toBe(204);
  });
});
