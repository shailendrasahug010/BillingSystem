import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("offline bills from devices", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token, headers?: Record<string, string>) => call(t.app, "POST", url, { token, body, ...(headers ? { headers } : {}) });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const put = (url: string, body: unknown, token = owner.token) => call(t.app, "PUT", url, { token, body });
  const bill = (number: string, qty: string, key: string, token = owner.token, deviceId = ids.device) =>
    post("/invoices", { customerId: ids.shop, invoiceDate: "2026-09-20", lines: [{ productId: ids.soap, qty }], offline: { deviceId, invoiceNumber: number, savedAt: "2026-09-20T10:15:00+05:30" } }, token, { "idempotency-key": key });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Offline Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "5", openingStockCost: "70" })).body.id;
    ids.shop = (await post("/customers", { name: "Kirana One", stateCode: "23" })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("registers each device once, with its own invoice series", async () => {
    const first = await post("/devices", { name: "Counter PC", platform: "windows" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ seriesCode: "A1", pattern: "{DEVICE}/{FYS}/{SEQ:4}", series: { financialYear: "2026-27", nextNumber: 1 } });
    ids.device = first.body.id;
    const again = await post("/devices", { name: "Counter PC", platform: "windows", deviceId: ids.device });
    expect(again.body).toMatchObject({ id: ids.device, seriesCode: "A1" });
    const phone = await post("/devices", { name: "Sam's phone", platform: "android" }, salesToken);
    expect(phone.body.seriesCode).toBe("A2");
    ids.phone = phone.body.id;
    // Someone else's device id is not taken over: a new device is registered instead.
    expect((await post("/devices", { name: "x", platform: "web", deviceId: ids.phone })).body.seriesCode).toBe("A3");
  });

  it("keeps the number the device gave the bill, and replays safely", async () => {
    const key = "0199a0d6-0000-7000-8000-000000000001";
    const res = await bill("A1/26-27/0001", "1", key);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ invoiceNumber: "A1/26-27/0001", deviceId: ids.device, grandTotal: "118.00" });
    const replay = await bill("A1/26-27/0001", "1", key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(res.body.id);
    expect((await post("/devices", { name: "Counter PC", platform: "windows", deviceId: ids.device })).body.series.nextNumber).toBe(2);
    // Online bills still use the main series.
    expect((await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "1" }] })).body.invoiceNumber).toMatch(/^INV\//);
  });

  it("refuses numbers from another series or used twice", async () => {
    expect((await bill("A2/26-27/0002", "1", "0199a0d6-0000-7000-8000-000000000002")).body.error.code).toBe("OFFLINE_NUMBER_INVALID");
    expect((await bill("A1/2026/0002", "1", "0199a0d6-0000-7000-8000-000000000003")).body.error.code).toBe("OFFLINE_NUMBER_INVALID");
    expect((await bill("A1/26-27/0001", "1", "0199a0d6-0000-7000-8000-000000000004")).body.error.code).toBe("DUPLICATE_NUMBER");
  });

  it("accepts an offline bill that a block rule would stop online, with the warning", async () => {
    await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "block" } });
    const online = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "50" }] });
    expect(online.status).toBe(409);
    const offline = await bill("A2/26-27/0001", "50", "0199a0d6-0000-7000-8000-000000000005", salesToken, ids.phone);
    expect(offline.status).toBe(201);
    expect(offline.body.warnings.map((w: { code: string }) => w.code)).toContain("insufficient_stock");
    // Held for a manager, with what it broke.
    expect(offline.body).toMatchObject({ reviewStatus: "needs_review", reviewReasons: [{ code: "stock_short", params: { product: "Bath Soap", requested: "50" } }] });
    const audit = (await get("/audit-logs?entityType=invoice")).body.data.find((a: { entityLabel: string }) => a.entityLabel === "A2/26-27/0001");
    expect(audit.changes).toMatchObject({ savedOffline: "2026-09-20T10:15:00+05:30", warnings: ["insufficient_stock"], heldForReview: ["stock_short"] });
    await call(t.app, "PUT", "/settings/stock.negative_policy", { token: owner.token, body: { value: "warn" } });
  });

  it("lets a bill keep the day it was made offline; one that took over a week to arrive is held", async () => {
    const sam = (d: string, key: string, n: string, savedOn = d) =>
      post("/invoices", { customerId: ids.shop, invoiceDate: d, lines: [{ productId: ids.soap, qty: "1" }], offline: { deviceId: ids.phone, invoiceNumber: n, savedAt: `${savedOn}T18:00:00+05:30` } }, salesToken, { "idempotency-key": key });
    const recent = await sam("2026-09-18", "0199a0d6-0000-7000-8000-000000000008", "A2/26-27/0002");
    expect(recent.status).toBe(201);
    expect(recent.body.reviewStatus).toBeNull();
    const late = await sam("2026-09-10", "0199a0d6-0000-7000-8000-000000000007", "A2/26-27/0003");
    expect(late.status).toBe(201);
    expect(late.body).toMatchObject({ invoiceDate: "2026-09-10", reviewStatus: "needs_review", reviewReasons: [{ code: "late_sync", params: { days: 14 } }] });
    // Dated before the day it was made: that is back-dating, and needs the permission.
    expect((await sam("2026-09-15", "0199a0d6-0000-7000-8000-000000000009", "A2/26-27/0004", "2026-09-16")).status).toBe(403);
  });

  it("refuses bills from a removed device and lists devices for the owner", async () => {
    expect((await post(`/devices/${ids.phone}/revoke`, {}, salesToken)).status).toBe(403);
    expect((await post(`/devices/${ids.phone}/revoke`, {})).status).toBe(200);
    expect((await bill("A2/26-27/0005", "1", "0199a0d6-0000-7000-8000-000000000006", salesToken, ids.phone)).body.error.code).toBe("DEVICE_REVOKED");
    const list = (await get("/devices")).body.data;
    expect(list.map((d: { seriesCode: string; offlineBills: number; revokedAt: string | null }) => [d.seriesCode, d.offlineBills, Boolean(d.revokedAt)])).toEqual([
      ["A1", 1, false],
      ["A2", 3, true],
      ["A3", 0, false],
    ]);
  });

  it("registers every device that keeps a copy, and tells a removed one to wipe itself, signed in or not", async () => {
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Wasim Warehouse", mobile, roleId: roles.warehouse });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    const warehouseToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
    // Someone who does not bill: registered (so it can be removed), without a code or series.
    const tablet = await post("/devices", { name: "Godown tablet", platform: "android" }, warehouseToken);
    expect(tablet.status).toBe(200);
    expect(tablet.headers["cache-control"]).toBe("no-store");
    expect(tablet.body).toMatchObject({ seriesCode: null, series: null, wipeAfterDays: 30 });
    expect(tablet.body.checkSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const check = (deviceId: string, secret: string) => call(t.app, "POST", "/devices/check", { body: { deviceId, secret } });
    expect((await check(tablet.body.id, tablet.body.checkSecret)).body).toEqual({ status: "active" });
    expect((await check(tablet.body.id, "x".repeat(43))).body).toEqual({ status: "unknown" });
    expect((await check("0199a0d6-0000-7000-8000-00000000ffff", tablet.body.checkSecret)).body).toEqual({ status: "unknown" });
    // Each registration renews the secret; the old one no longer answers.
    await put("/settings/offline.wipe_after_days", { value: 7 });
    const renewed = await post("/devices", { name: "Godown tablet", platform: "android", deviceId: tablet.body.id }, warehouseToken);
    expect(renewed.body).toMatchObject({ id: tablet.body.id, wipeAfterDays: 7 });
    expect((await check(tablet.body.id, tablet.body.checkSecret)).body.status).toBe("unknown");
    expect((await check(tablet.body.id, renewed.body.checkSecret)).body.status).toBe("active");
    // The owner removes it: the next check tells it to wipe, and the list shows when.
    const signIn = `select count(*) filter (where rt.revoked_at is null)::int as live from devices d join refresh_tokens rt on rt.family_id = d.session_id where d.id = $1`;
    expect((await t.owner.query(signIn, [tablet.body.id])).rows[0].live).toBeGreaterThan(0);
    await post(`/devices/${tablet.body.id}/revoke`, {});
    // Its sign-in ends with it.
    expect((await t.owner.query(signIn, [tablet.body.id])).rows[0].live).toBe(0);
    expect((await get("/devices")).body.data.find((d: { id: string }) => d.id === tablet.body.id).wipedAt).toBeNull();
    expect((await check(tablet.body.id, renewed.body.checkSecret)).body.status).toBe("removed");
    expect((await get("/devices")).body.data.find((d: { id: string }) => d.id === tablet.body.id).wipedAt).not.toBeNull();
  });

  it("adds a customer made offline under the device's id, once, and takes its bill, payment and order", async () => {
    const id = "0199a0d6-0000-7000-8000-0000000000c1";
    const body = { name: "Naya Kirana", businessName: "Naya Kirana Stores", mobile: "9826099001", stateCode: "23" };
    const first = await post("/customers", body, salesToken, { "idempotency-key": id });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id, businessName: "Naya Kirana Stores", version: 1 });
    // Sent again (the answer was lost on the way): the same customer, not a second.
    const again = await post("/customers", body, salesToken, { "idempotency-key": id });
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.body.code).toBe(first.body.code);
    const list = (await get("/customers?q=Naya")).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, version: 1 });
    // What was queued after it on the device goes through with the same id.
    const paid = await post("/payments", { direction: "in", customerId: id, amount: "150", method: "cash" }, salesToken, { "idempotency-key": "0199a0d6-0000-7000-8000-0000000000c2" });
    expect(paid.status).toBe(201);
    const order = await post("/sales-orders", { customerId: id, lines: [{ productId: ids.soap, qty: "2" }] }, salesToken, { "idempotency-key": "0199a0d6-0000-7000-8000-0000000000c3" });
    expect(order.status).toBe(201);
    const orderAgain = await post("/sales-orders", { customerId: id, lines: [{ productId: ids.soap, qty: "2" }] }, salesToken, { "idempotency-key": "0199a0d6-0000-7000-8000-0000000000c3" });
    expect(orderAgain.status).toBe(200);
    expect(orderAgain.body.orderNumber).toBe(order.body.orderNumber);

    // Another business cannot take (or probe) that id.
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    const taken = await post("/customers", { name: "Copy", stateCode: "23" }, other.token, { "idempotency-key": id });
    expect(taken.status).toBe(400);
    expect(taken.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect((await post("/customers", { name: "Bad key", stateCode: "23" }, owner.token, { "idempotency-key": "not-a-uuid" })).status).toBe(400);
  });

  it("refuses an offline customer edit made on an old version", async () => {
    const shop = (await get(`/customers/${ids.shop}`)).body;
    const edit = (patch: object, version: number) => call(t.app, "PATCH", `/customers/${ids.shop}`, { token: owner.token, body: patch, headers: { "if-match": String(version) } });
    expect((await edit({ city: "Indore" }, shop.version)).status).toBe(200);
    const stale = await edit({ mobile: "9826099002" }, shop.version);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", params: { current: shop.version + 1 } });
  });

  describe("held for review", () => {
    const made = { savedAt: "2026-09-24T11:00:00+05:30" };
    let tablet: { id: string; code: string };
    let seq = 0;
    /** A bill from Sam's tablet, made today offline. */
    const fromTablet = (body: Record<string, unknown>) => {
      seq += 1;
      const n = `${tablet.code}/26-27/${String(seq).padStart(4, "0")}`;
      return post("/invoices", { ...body, offline: { deviceId: tablet.id, invoiceNumber: n, ...made } }, salesToken, { "idempotency-key": `0199a0d6-0000-7000-8000-0000000001${String(seq).padStart(2, "0")}` });
    };
    const notes = async (token: string) => (await get("/notifications", token)).body.data as Array<{ type: string; entityId: string; titleKey: string; bodyKey: string | null; params: Record<string, unknown> }>;

    beforeAll(async () => {
      const r = (await post("/devices", { name: "Sam's tablet", platform: "android" }, salesToken)).body;
      tablet = { id: r.id, code: r.seriesCode };
      const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
      const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
      ids.tea = (await post("/products", { name: "Tea 250g", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100" })).body.id;
      ids.old = (await post("/customers", { name: "Old Shop", stateCode: "23" })).body.id;
    });

    it("takes a bill made offline that broke a rule meanwhile, and holds it for a manager", async () => {
      // The rate list changed while the tablet was offline: the bill keeps the rate it was made at.
      expect((await call(t.app, "PATCH", `/products/${ids.tea}`, { token: owner.token, body: { sellingPrice: "120" } })).status).toBe(200);
      const priced = await fromTablet({ customerId: ids.shop, lines: [{ productId: ids.tea, qty: "1", rate: "100.0000" }] });
      expect(priced.status).toBe(201);
      expect(priced.body).toMatchObject({ grandTotal: "105.00", reviewStatus: "needs_review", reviewReasons: [{ code: "price_changed", params: { product: "Tea 250g", billed: "100.00", list: "120.00" } }] });
      ids.priced = priced.body.id;
      // Online the same is still refused.
      expect((await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.tea, qty: "1", rate: "100.0000" }] }, salesToken)).status).toBe(403);

      // A customer made inactive meanwhile.
      expect((await call(t.app, "PATCH", `/customers/${ids.old}`, { token: owner.token, body: { isActive: false } })).status).toBe(200);
      const inactive = await fromTablet({ customerId: ids.old, lines: [{ productId: ids.tea, qty: "1", rate: "120.0000" }] });
      expect(inactive.body).toMatchObject({ reviewStatus: "needs_review", reviewReasons: [{ code: "customer_inactive", params: { customer: "Old Shop" } }] });
      ids.inactive = inactive.body.id;
      expect((await post("/invoices", { customerId: ids.old, lines: [{ productId: ids.tea, qty: "1" }] })).body.error.code).toBe("CUSTOMER_INACTIVE");

      // Its GST month locked meanwhile; a new bill there online is refused.
      await t.owner.query(`insert into gst_return_periods (business_id, return_type, period, status) values ($1, 'GSTR1', '2026-09', 'locked')`, [owner.businessId]);
      try {
        const locked = await fromTablet({ customerId: ids.shop, lines: [{ productId: ids.tea, qty: "2", rate: "120.0000" }] });
        expect(locked.body).toMatchObject({ reviewStatus: "needs_review", reviewReasons: [{ code: "period_locked", params: { month: "2026-09" } }] });
        ids.locked = locked.body.id;
        expect((await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.tea, qty: "1" }] })).body.error.code).toBe("GST_PERIOD_LOCKED");
      } finally {
        await t.owner.query(`delete from gst_return_periods where business_id = $1`, [owner.businessId]);
      }

      // A bill that broke nothing is not held.
      expect((await fromTablet({ customerId: ids.shop, lines: [{ productId: ids.tea, qty: "1", rate: "120.0000" }] })).body.reviewStatus).toBeNull();

      // Listed and counted for the Invoices screen.
      const held = (await get("/invoices?review=needs_review&limit=50")).body.data.map((x: { id: string }) => x.id);
      expect(held).toEqual(expect.arrayContaining([ids.priced, ids.inactive, ids.locked]));
      expect((await get("/invoices/review-count")).body.count).toBe(held.length);
      // On the home screen of whoever may review them, oldest first, with what each broke.
      const home = (await get("/home")).body;
      expect(home.review.count).toBe(held.length);
      expect(home.review.bills[0]).toMatchObject({ number: "A2/26-27/0001", reasons: [{ code: "stock_short" }] });
      expect((await get("/home", salesToken)).body.review).toBeUndefined();

      // Whoever may review is told, with the first reason; the salesperson is not asked to.
      const told = (await notes(owner.token)).filter((n) => n.type === "offline_review");
      expect(told.find((n) => n.entityId === ids.priced)).toMatchObject({
        titleKey: "notifications.events.offline_review",
        bodyKey: "notifications.review.price_changed",
        params: { product: "Tea 250g", customer: "Kirana One", total: "105.00", reasons: 1 },
      });
      expect((await notes(salesToken)).some((n) => n.type === "offline_review")).toBe(false);
    });

    it("is marked reviewed by a manager, or settled by cancelling it; whoever made it is told", async () => {
      expect((await post(`/invoices/${ids.priced}/review`, {}, salesToken)).status).toBe(403);
      const done = await post(`/invoices/${ids.priced}/review`, { note: "Old rate agreed with the shop" });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ reviewStatus: "reviewed", reviewedBy: owner.userId, reviewNote: "Old rate agreed with the shop" });
      expect((await post(`/invoices/${ids.priced}/review`, {})).body.error.code).toBe("NOT_HELD_FOR_REVIEW");
      const audit = (await get(`/audit-logs?entityType=invoice&entityId=${ids.priced}`)).body.data.find((a: { action: string }) => a.action === "invoice.reviewed");
      expect(audit.changes).toMatchObject({ reasons: ["price_changed"], note: "Old rate agreed with the shop" });
      expect((await notes(salesToken)).find((n) => n.type === "offline_reviewed")).toMatchObject({ entityId: ids.priced, params: { reviewer: "Owner" } });

      const cancelled = await post(`/invoices/${ids.inactive}/cancel`, { reason: "Shop closed, goods returned" });
      expect(cancelled.body).toMatchObject({ status: "cancelled", reviewStatus: "reviewed", reviewNote: "Shop closed, goods returned" });
      expect((await get("/invoices?review=needs_review&limit=50")).body.data.map((x: { id: string }) => x.id)).not.toContain(ids.inactive);
    });
  });

  it("merges a customer change made offline with one made meanwhile, field by field; the later change stands", async () => {
    const shop = (await get(`/customers/${ids.shop}`)).body;
    const v = shop.version;
    const seen = { mobile: shop.mobile, city: shop.city };
    const edit = (token: string, body: object, version: number) => call(t.app, "PATCH", `/customers/${ids.shop}`, { token, body, headers: { "if-match": String(version) } });
    // Sam changes the mobile and the city offline; a minute later the owner changes the city online.
    const samMadeAt = new Date(Date.now() - 60_000).toISOString();
    expect((await edit(owner.token, { city: "Dewas" }, v)).status).toBe(200);
    const merged = await edit(salesToken, { mobile: "9826099011", city: "Ujjain", offline: { base: seen, madeAt: samMadeAt } }, v);
    expect(merged.status).toBe(200);
    // The mobile nobody else touched is applied; the owner's later city stands.
    expect(merged.body).toMatchObject({ mobile: "9826099011", city: "Dewas", version: v + 2, merge: { kept: ["city"], overwritten: [] } });
    const logged = (await get(`/audit-logs?entityType=customer&entityId=${ids.shop}`)).body.data[0];
    expect(logged.changes).toMatchObject({ mobile: [seen.mobile ?? null, "9826099011"], madeOffline: samMadeAt, notApplied: { city: "Ujjain" } });

    // A change made offline after the owner's wins over it, and the owner is told.
    const later = await edit(salesToken, { city: "Ujjain", offline: { base: { city: seen.city }, madeAt: new Date(Date.now() + 60_000).toISOString() } }, v);
    expect(later.body).toMatchObject({ city: "Ujjain", merge: { kept: [], overwritten: ["city"] } });
    const told = (await get("/notifications")).body.data.find((n: { type: string }) => n.type === "customer_edit_replaced");
    expect(told).toMatchObject({ entityType: "customer", entityId: ids.shop, params: { customer: "Kirana One", fields: "city", editor: "Sales Sam" } });

    // Sent again (its answer lost): already so, nothing changes.
    const again = await edit(salesToken, { city: "Ujjain", offline: { base: { city: seen.city }, madeAt: new Date().toISOString() } }, v);
    expect(again.body).toMatchObject({ city: "Ujjain", merge: { kept: [], overwritten: [] } });
    // Online, an old version is still refused.
    expect((await edit(owner.token, { city: "Indore" }, v)).body.error.code).toBe("VERSION_CONFLICT");
  });

  it("keeps what waits on each device, and reminds when one holds work that has not reached the server", async () => {
    const spare = (await post("/devices", { name: "Sam's spare phone", platform: "android" }, salesToken)).body;
    const report = (body: object, token = salesToken) => call(t.app, "PUT", `/devices/${spare.id}/queue`, { token, body });
    expect((await report({ waiting: 3, bills: 2, refused: 0, oldestAt: "2026-09-23T17:00:00+05:30" })).status).toBe(204);
    // Only the device's own person reports for it.
    expect((await report({ waiting: 0, bills: 0, refused: 0 }, owner.token)).status).toBe(404);
    expect((await get("/devices")).body.data.find((d: { id: string }) => d.id === spare.id)).toMatchObject({ queueWaiting: 3, queueBills: 2, queueRefused: 0 });

    const check = () => post("/reminder-rules/devices_unsynced/check", {});
    // It reported just now: nothing to remind about yet.
    expect((await check()).body.result).toBe("nothing");
    t.advance(25 * 3_600_000);
    try {
      expect((await check()).body.result).toBe("raised");
      const n = (await get("/notifications")).body.data.find((x: { type: string }) => x.type === "devices_unsynced");
      expect(n).toMatchObject({ titleKey: "notifications.devices_unsynced.title", bodyKey: "notifications.devices_unsynced.body", params: { count: 1, device: "Sam's spare phone", person: "Sales Sam", waiting: 3, date: "2026-09-23" } });
      // The salesperson's role does not look after devices.
      expect((await get("/notifications", salesToken)).body.data.some((x: { type: string }) => x.type === "devices_unsynced")).toBe(false);
    } finally {
      t.advance(-25 * 3_600_000);
    }
    // Work the server refused waits on the device for someone: reminded the next day without waiting the hours.
    expect((await report({ waiting: 1, bills: 1, refused: 1, oldestAt: "2026-09-24T10:00:00+05:30" })).status).toBe(204);
    t.setToday("2026-09-25");
    try {
      expect((await check()).body.result).toBe("raised");
      const n = (await get("/notifications")).body.data.find((x: { type: string; params: { refused: number } }) => x.type === "devices_unsynced" && x.params.refused === 1);
      expect(n.bodyKey).toBe("notifications.devices_unsynced.refused");
    } finally {
      t.setToday(null);
    }
    // Sent and cleared: nothing.
    expect((await report({ waiting: 0, bills: 0, refused: 0, oldestAt: null })).status).toBe(204);
    t.setToday("2026-09-26");
    try {
      expect((await check()).body.result).toBe("nothing");
    } finally {
      t.setToday(null);
    }
  });

  it("keeps device series out of the editable number series", async () => {
    const series = (await get("/document-series")).body.data;
    expect(series.some((s: { pattern: string }) => s.pattern.includes("{DEVICE}"))).toBe(false);
    const deviceSeries = await t.owner.query<{ id: string }>(`select id from document_series where device_id = $1`, [ids.device]);
    const res = await call(t.app, "PATCH", `/document-series/${deviceSeries.rows[0]!.id}`, { token: owner.token, body: { pattern: "X/{SEQ:3}" } });
    expect(res.status).toBe(404);
  });
});
