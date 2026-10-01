import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTranslator, LOCALES, type TranslationKey } from "@digitalbahi/i18n";
import { processOutbox } from "../src/services/outbox-worker.js";
import { runDueReminders } from "../src/services/reminders.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.2, notifications: reminder rules and their daily checks (once per
 * condition), notifications raised by events (orders, leave), the inbox each
 * person reads on their own, and the live stream.
 */
describe.skipIf(!hasDatabase)("notifications", () => {
  let t: TestApp;
  let owner: Session;
  const tokens: Record<string, string> = {};
  const mobiles: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const patch = (url: string, body: unknown, token = owner.token) => call(t.app, "PATCH", url, { token, body });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
  const deps = () => t.app.deps;
  const typesFor = async (token: string) => ((await get("/notifications", token)).body.data as Array<{ type: string }>).map((n) => n.type).sort();
  const unread = async (token: string) => (await get("/notifications/unread-count", token)).body.unread as number;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Sharma Distributors", stateCode: "23" });
    tokens.owner = owner.token;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    for (const key of ["sales", "warehouse", "hr"]) {
      mobiles[key] = nextMobile();
      expect((await post("/members", { name: `${key} person`, mobile: mobiles[key], roleId: roles[key] })).status).toBe(201);
      await call(t.app, "POST", "/auth/otp", { body: { mobile: mobiles[key], purpose: "login" } });
      tokens[key] = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile: mobiles[key], otp: t.otp.last(mobiles[key]!) } })).body.accessToken;
    }
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.salt = (await post("/products", { name: "Tata Salt 1kg", hsnCode: "2501", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "28", openingStock: "100" })).body.id;
    ids.oil = (await post("/products", { name: "Fortune Oil 1L", hsnCode: "1512", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "10", minStock: "50" })).body.id;
    ids.customer = (await post("/customers", { name: "Verma Kirana", stateCode: "23", creditDays: 7 })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Shree Ganesh Agencies", stateCode: "23", gstin: "23AAACM1234M1ZR", creditDays: 7 })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("reminder rules", () => {
    it("are listed with their settings; the owner changes them, others may not", async () => {
      const list = await get("/reminder-rules");
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(9);
      expect(list.body.data.find((r: { type: string }) => r.type === "customer_payment_due")).toMatchObject({ isActive: true, permission: "customer.view_ledger", config: { hour: 9, daysBefore: 3 }, lastRunOn: null });

      const changed = await patch("/reminder-rules/customer_payment_due", { config: { daysBefore: 5 } });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ isActive: true, config: { hour: 9, daysBefore: 5 } });
      // A setting that does not apply to the type is ignored.
      expect((await patch("/reminder-rules/low_stock", { config: { daysBefore: 4 } })).body.config).toEqual({ hour: 9 });
      expect((await patch("/reminder-rules/low_stock", { config: { hour: 24 } })).status).toBe(400);
      expect((await patch("/reminder-rules/nonsense", { isActive: false })).status).toBe(404);
      expect((await patch("/reminder-rules/low_stock", { isActive: false }, tokens.sales)).status).toBe(403);
      const [logged] = await q(`select action, entity_label from audit_logs where action = 'reminder_rule.updated' order by id limit 1`);
      expect(logged).toMatchObject({ entity_label: "customer_payment_due" });

      // From here on every check is due whenever it runs.
      for (const r of list.body.data as Array<{ type: string }>) expect((await patch(`/reminder-rules/${r.type}`, { config: { hour: 0 } })).status).toBe(200);
    });
  });

  describe("daily checks", () => {
    it("leave one notification per rule when there is something to act on, once a day", async () => {
      // An overdue bill, one more due in 3 days, an overdue supplier bill, low stock, an order waiting, staff without last month's salary.
      expect((await post("/invoices", { customerId: ids.customer, invoiceDate: "2026-09-01", lines: [{ productId: ids.salt, qty: "10" }] })).status).toBe(201);
      expect((await post("/invoices", { customerId: ids.customer, invoiceDate: "2026-09-20", lines: [{ productId: ids.salt, qty: "5" }] })).status).toBe(201);
      expect((await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "SG/1", supplierInvoiceDate: "2026-09-01", lines: [{ productId: ids.salt, qty: "50", rate: "20" }] })).status).toBe(201);
      expect((await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.salt, qty: "2" }] })).status).toBe(201);
      ids.employee = (await post("/employees", { name: "HR Person", mobile: mobiles.hr, joiningDate: "2025-04-01" })).body.id;

      const first = await runDueReminders(deps());
      expect(first).toMatchObject({ businesses: 1, checked: 9, failed: 0 });
      const rows = await q<{ type: string; permission: string; dedupe_key: string; severity: string; title_key: string; params: Record<string, unknown> }>(
        `select type, permission, dedupe_key, severity::text, title_key, params from notifications order by type`,
      );
      expect(rows.map((r) => r.type)).toEqual(["customer_payment_due", "low_stock", "pending_orders", "salary_due", "supplier_payment_due"]);
      expect(rows.find((r) => r.type === "customer_payment_due")).toMatchObject({
        permission: "customer.view_ledger",
        severity: "warning",
        dedupe_key: `customer_payment_due:${TEST_TODAY}`,
        title_key: "notifications.customer_payment_due.overdue",
        params: { count: 1, customers: 1, dueCount: 1, days: 5 },
      });
      expect(rows.find((r) => r.type === "low_stock")).toMatchObject({ permission: "purchase.create", params: { count: 1, outOfStock: 0, product: "Fortune Oil 1L" } });
      expect(rows.find((r) => r.type === "salary_due")).toMatchObject({ dedupe_key: "salary_due:2026-08", title_key: "notifications.salary_due.title", params: { month: "2026-08", count: 1 } });
      expect(first.notifications).toBe(5);

      // Once a day: the rules are claimed for today, and the keys would stop a repeat anyway.
      expect(await runDueReminders(deps())).toMatchObject({ checked: 0, notifications: 0 });
      await q(`update reminder_rules set last_run_on = null`);
      expect(await runDueReminders(deps())).toMatchObject({ checked: 9, notifications: 0 });

      // The next day: today's again, salary only once a month, nothing for a rule switched off.
      expect((await patch("/reminder-rules/low_stock", { isActive: false })).status).toBe(200);
      t.setToday("2026-09-25");
      try {
        expect(await runDueReminders(deps())).toMatchObject({ checked: 8, notifications: 3 });
      } finally {
        t.setToday(null);
      }
      const next = await q<{ type: string }>(`select type from notifications where dedupe_key like '%:2026-09-25' order by type`);
      expect(next.map((r) => r.type)).toEqual(["customer_payment_due", "pending_orders", "supplier_payment_due"]);
      expect((await patch("/reminder-rules/low_stock", { isActive: true })).status).toBe(200);
    });

    it("run on request ('Check now'), leaving the day's one notification", async () => {
      t.setToday("2026-09-26");
      try {
        const check = (type: string, token = owner.token) => post(`/reminder-rules/${type}/check`, {}, token);
        expect((await check("low_stock")).body).toMatchObject({ result: "raised" });
        expect((await check("low_stock")).body).toEqual({ result: "already", notificationId: null });
        expect((await check("leave_request")).body).toEqual({ result: "nothing", notificationId: null });
        expect((await check("low_stock", tokens.sales)).status).toBe(403);
        expect((await check("nonsense")).status).toBe(404);
        expect((await patch("/reminder-rules/to_pack", { isActive: false })).status).toBe(200);
        expect((await check("to_pack")).body.error).toMatchObject({ code: "REMINDER_RULE_OFF" });
        expect((await patch("/reminder-rules/to_pack", { isActive: true })).status).toBe(200);
        // The scheduled checks that day leave no second low-stock notification.
        expect(await runDueReminders(deps())).toMatchObject({ checked: 9, notifications: 3 });
        expect(await q(`select 1 from notifications where dedupe_key = 'low_stock:2026-09-26'`)).toHaveLength(1);
      } finally {
        t.setToday(null);
      }
    });
  });

  describe("the inbox", () => {
    it("shows each person what their role is for, and each reads it on their own", async () => {
      expect(await typesFor(tokens.owner!)).toEqual(expect.arrayContaining(["customer_payment_due", "low_stock", "pending_orders", "salary_due", "supplier_payment_due"]));
      const sales = await typesFor(tokens.sales!);
      expect(sales).toContain("customer_payment_due");
      expect(sales).not.toContain("salary_due");
      expect(sales).not.toContain("supplier_payment_due");
      expect(await typesFor(tokens.hr!)).toEqual(["salary_due"]);
      expect(await typesFor(tokens.warehouse!)).toEqual([]);

      const list = await get("/notifications?limit=2");
      expect(list.body.data).toHaveLength(2);
      const rest = await get(`/notifications?limit=50&cursor=${list.body.nextCursor}`);
      expect(rest.body.data.map((n: { id: string }) => n.id)).not.toContain(list.body.data[0].id);
      const all = list.body.data.length + rest.body.data.length;
      expect(list.body.unread).toBe(all);

      // The owner reads the customer reminder; the salesperson still has it unread.
      const reminder = rest.body.data.concat(list.body.data).find((n: { type: string }) => n.type === "customer_payment_due");
      const salesBefore = await unread(tokens.sales!);
      expect((await post(`/notifications/${reminder.id}/read`, {})).status).toBe(204);
      expect(await unread(tokens.owner!)).toBe(all - 1);
      expect(await unread(tokens.sales!)).toBe(salesBefore);
      expect((await get("/notifications?status=unread")).body.data.map((n: { id: string }) => n.id)).not.toContain(reminder.id);

      // Not for the warehouse: as if it did not exist.
      expect((await post(`/notifications/${reminder.id}/read`, {}, tokens.warehouse)).status).toBe(404);

      // Dismissed: gone from the salesperson's list only.
      expect((await post(`/notifications/${reminder.id}/dismiss`, {}, tokens.sales)).status).toBe(204);
      expect((await typesFor(tokens.sales!)).filter((x) => x === "customer_payment_due").length).toBe(sales.filter((x) => x === "customer_payment_due").length - 1);
      expect((await get("/notifications")).body.data.map((n: { id: string }) => n.id)).toContain(reminder.id);

      expect((await post("/notifications/read-all", {})).body).toEqual({ marked: all - 1 });
      expect(await unread(tokens.owner!)).toBe(0);
      expect(await unread(tokens.sales!)).toBeGreaterThan(0);
    });
  });

  describe("events", () => {
    it("tell who should act as orders move on and leave is asked for and decided", async () => {
      const order = (await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.salt, qty: "3" }] })).body;
      await processOutbox(deps());
      const waiting = (await get("/notifications")).body.data.find((n: { entityId: string; type: string }) => n.entityId === order.id);
      expect(waiting).toMatchObject({ type: "order_waiting", titleKey: "notifications.events.order_waiting", entityType: "sales_order", params: { number: order.orderNumber, customer: "Verma Kirana" } });
      expect((await typesFor(tokens.warehouse!))).not.toContain("order_waiting");

      expect((await post(`/sales-orders/${order.id}/status`, { status: "confirmed" })).status).toBe(200);
      await processOutbox(deps());
      expect(await typesFor(tokens.warehouse!)).toContain("order_to_pack");

      // A leave request goes to HR; the decision goes to the employee's own account (found by mobile).
      const types = (await get("/leave-types", tokens.hr)).body.data as Array<{ code: string; id: string }>;
      const leave = await post("/leave/requests", { employeeId: ids.employee, leaveTypeId: types.find((x) => x.code === "CL")!.id, fromDate: "2026-10-05", toDate: "2026-10-06" }, tokens.hr);
      expect(leave.status).toBe(201);
      await processOutbox(deps());
      expect(await typesFor(tokens.hr!)).toContain("leave_requested");
      expect((await post(`/leave/requests/${leave.body.id}/decide`, { decision: "approve" })).status).toBe(200);
      await processOutbox(deps());
      const mine = (await get("/notifications", tokens.hr)).body.data.find((n: { type: string }) => n.type === "leave_approved");
      expect(mine).toMatchObject({ severity: "success", params: { from: "2026-10-05", to: "2026-10-06", count: 2, type: "CL" } });
      // Addressed to that person alone.
      expect(await typesFor(tokens.owner!)).not.toContain("leave_approved");

      // Switched off: no more order notifications.
      expect((await patch("/reminder-rules/pending_orders", { isActive: false })).status).toBe(200);
      const quiet = (await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.salt, qty: "1" }] })).body;
      await processOutbox(deps());
      expect((await get("/notifications")).body.data.find((n: { entityId: string }) => n.entityId === quiet.id)).toBeUndefined();
      expect((await patch("/reminder-rules/pending_orders", { isActive: true })).status).toBe(200);
    });
  });

  describe("the live stream", () => {
    it("tells an open app about a new notification for that person at once, and nobody else", async () => {
      const address = await t.app.listen({ port: 0, host: "127.0.0.1" });
      const open = async (token: string) => {
        const controller = new AbortController();
        const res = await fetch(`${address}/api/v1/notifications/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body!.getReader();
        let text = "";
        const decoder = new TextDecoder();
        /** Reads until `pattern` shows up, or gives up after `ms`. */
        const waitFor = async (pattern: RegExp, ms: number): Promise<RegExpMatchArray | null> => {
          const deadline = Date.now() + ms;
          while (!pattern.test(text)) {
            const left = deadline - Date.now();
            if (left <= 0) return null;
            const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
            if (!chunk || chunk.done) return pattern.exec(text);
            text += decoder.decode(chunk.value);
          }
          return pattern.exec(text);
        };
        expect(await waitFor(/event: ready/, 3000)).not.toBeNull();
        return { waitFor, close: () => controller.abort() };
      };
      const ownerStream = await open(tokens.owner!);
      const warehouseStream = await open(tokens.warehouse!);
      try {
        const order = (await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.salt, qty: "4" }] })).body;
        await processOutbox(deps());
        const [n] = await q<{ id: string }>(`select id from notifications where entity_id = $1`, [order.id]);
        const seen = await ownerStream.waitFor(/event: notification\ndata: (\{[^\n]*\})/, 5000);
        expect(seen && JSON.parse(seen[1]!)).toEqual({ id: n!.id });
        // The warehouse may not confirm orders: nothing for it.
        expect(await warehouseStream.waitFor(/event: notification/, 500)).toBeNull();
      } finally {
        ownerStream.close();
        warehouseStream.close();
      }
    });
  });

  describe("texts", () => {
    /** Every title and body the checks and events can raise. */
    const KEYS = [
      ...["customer_payment_due", "supplier_payment_due"].flatMap((k) => [`notifications.${k}.overdue`, `notifications.${k}.alsoDue`, `notifications.${k}.soon`]),
      ...["title", "body", "withOut"].map((k) => `notifications.low_stock.${k}`),
      ...["title", "body", "withExpired"].map((k) => `notifications.expiring_stock.${k}`),
      ...["pending_orders", "to_pack", "to_dispatch", "leave_request"].map((k) => `notifications.${k}.title`),
      ...["title", "noRun", "draft", "finalized"].map((k) => `notifications.salary_due.${k}`),
      ...["order_waiting", "order_to_pack", "order_to_dispatch", "leave_requested", "leave_approved", "leave_rejected", "offline_review", "offline_reviewed"].map((k) => `notifications.events.${k}`),
      // Why a bill made offline is held (the body of offline_review).
      ...["price_changed", "customer_inactive", "product_inactive", "period_locked", "late_sync", "stock_short", "credit_limit", "credit_overdue"].map((k) => `notifications.review.${k}`),
    ];

    it("exist in every language the app has", () => {
      for (const { code } of LOCALES) {
        const tr = createTranslator(code);
        expect(KEYS.filter((k) => !tr.has(k)), code).toEqual([]);
      }
    });

    it("read in full: every placeholder in the notifications raised here has its value", async () => {
      const rows = await q<{ title_key: string; body_key: string | null; params: Record<string, string | number | null> }>(`select distinct title_key, body_key, params from notifications`);
      expect(rows.length).toBeGreaterThan(5);
      for (const r of rows) {
        expect(KEYS).toContain(r.title_key);
        if (r.body_key) expect(KEYS).toContain(r.body_key);
        // A missing value shows as a dash in the app, as here.
        const params = Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, v ?? "—"]));
        for (const { code } of LOCALES) {
          const tr = createTranslator(code);
          for (const key of [r.title_key, r.body_key]) {
            if (key) expect(tr.t(key as TranslationKey, params), `${code} ${key}`).not.toMatch(/\{\{/);
          }
        }
      }
    });
  });

  describe("backups", () => {
    it("leave notifications out, so a business whose people read them restores", async () => {
      const file = await t.app.inject({ method: "POST", url: "/api/v1/backups/download", headers: { authorization: `Bearer ${owner.token}` }, payload: {} });
      expect(file.statusCode).toBe(200);
      const restored = await t.app.inject({
        method: "POST",
        url: "/api/v1/backups/restore",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/octet-stream", "x-account-password": Buffer.from(owner.password).toString("base64") },
        payload: file.rawPayload,
      });
      expect(restored.statusCode).toBe(201);
    });
  });
});
