import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.3, work done offline sent in one request (POST /sync/push): each
 * item goes through its own route, in order, with its own Idempotency-Key;
 * later items can act on what earlier ones made and wait for them; a batch
 * sent again does nothing twice.
 */
describe.skipIf(!hasDatabase)("sending offline work in one request", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const push = (items: unknown[], token = owner.token) => call(t.app, "POST", "/sync/push", { token, body: { items }, headers: { "x-client": "native" } });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Joshi Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await call(t.app, "POST", "/products", { token: owner.token, body: { name: "Lux Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "100" } })).body.id;
    ids.sharma = (await call(t.app, "POST", "/customers", { token: owner.token, body: { name: "Sharma Kirana", stateCode: "23" } })).body.id;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await call(t.app, "POST", "/members", { token: owner.token, body: { name: "Salesperson", mobile, roleId: roles.sales } });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("sends a day's work in one go: a new customer, bills, a payment, a discount and a cancellation on bills made in the same batch", async () => {
    ids.customer = randomUUID();
    ids.bill1 = randomUUID();
    ids.bill2 = randomUUID();
    ids.payment = randomUUID();
    ids.discount = randomUUID();
    ids.cancel = randomUUID();
    const items = [
      { id: ids.customer, kind: "customer", body: { name: "Naya Kirana", stateCode: "23", mobile: "9826077777" } },
      { id: ids.bill1, kind: "invoice", after: ids.customer, body: { customerId: ids.customer, invoiceDate: TEST_TODAY, lines: [{ productId: ids.soap, qty: "10" }] } },
      { id: ids.bill2, kind: "invoice", body: { customerId: ids.sharma, invoiceDate: TEST_TODAY, lines: [{ productId: ids.soap, qty: "4" }] } },
      { id: ids.payment, kind: "payment", after: ids.customer, body: { direction: "in", customerId: ids.customer, amount: "100", method: "cash" } },
      { id: ids.discount, kind: "sale-price-note", target: ids.bill1, body: { reason: "discount", percent: "10" } },
      { id: ids.cancel, kind: "invoice-cancel", target: ids.bill2, body: { reason: "Wrong shop" } },
    ];
    const res = await push(items);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { id: string; status: number }) => [r.id, r.status])).toEqual([
      [ids.customer, 201],
      [ids.bill1, 201],
      [ids.bill2, 201],
      [ids.payment, 201],
      [ids.discount, 201],
      [ids.cancel, 200],
    ]);
    const [, bill1, bill2] = res.body.results.map((r: { body: Record<string, unknown> }) => r.body);
    expect(bill1).toMatchObject({ customerId: ids.customer, grandTotal: "413.00" });
    expect((await get(`/invoices/${bill2.id}`)).body.status).toBe("cancelled");
    // The new customer kept the device's id; the discount note is against the bill made in the batch.
    expect((await get(`/customers/${ids.customer}`)).body).toMatchObject({ name: "Naya Kirana" });
    expect(res.body.results[4].body).toMatchObject({ reason: "discount", original: { id: bill1.id } });

    // Sent again (the answer was lost on the way): answered again, nothing done twice.
    const again = await push(items);
    expect(again.body.results.map((r: { body: { id?: string } }) => r.body?.id)).toEqual(res.body.results.map((r: { body: { id?: string } }) => r.body?.id).map((id: string | undefined, i: number) => (i === 5 ? undefined : id)));
    expect(again.body.results[5]).toMatchObject({ status: 409, body: { error: { code: "INVOICE_NOT_POSTED", params: { status: "cancelled" } } } });
    expect(await q(`select count(*)::int as n from invoices`)).toEqual([{ n: 2 }]);
    expect(await q(`select count(*)::int as n from payments`)).toEqual([{ n: 1 }]);
  });

  it("refuses an item alone; what waits for it is not tried, the rest go", async () => {
    const customer = randomUUID();
    const res = await push([
      // No state: refused.
      { id: customer, kind: "customer", body: { name: "Bad Shop" } },
      { id: randomUUID(), kind: "invoice", after: customer, body: { customerId: customer, invoiceDate: TEST_TODAY, lines: [{ productId: ids.soap, qty: "1" }] } },
      { id: randomUUID(), kind: "invoice-cancel", body: { reason: "No bill given" } },
      { id: randomUUID(), kind: "payment", body: { direction: "in", customerId: ids.sharma, amount: "50", method: "cash" } },
    ]);
    expect(res.body.results.map((r: { status: number }) => r.status)).toEqual([400, 0, 400, 201]);
    expect(res.body.results[2].body.error).toMatchObject({ code: "VALIDATION_FAILED", field: "target" });
  });

  it("does each item as the person who sent it, with their permissions", async () => {
    const res = await push([{ id: randomUUID(), kind: "purchase", body: { supplierId: randomUUID(), supplierInvoiceNumber: "X/1", supplierInvoiceDate: TEST_TODAY, lines: [{ productId: ids.soap, qty: "1", rate: "20" }] } }], salesToken);
    expect(res.body.results[0]).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    const [created] = await q<{ user_id: string }>(`select created_by as user_id from invoices order by created_at limit 1`);
    expect(created!.user_id).toBe(owner.userId);
    // Not more than 50 at once, and only the kinds it knows.
    expect((await push(Array.from({ length: 51 }, () => ({ id: randomUUID(), kind: "payment", body: {} })))).status).toBe(400);
    expect((await push([{ id: randomUUID(), kind: "backup-restore", body: {} }])).status).toBe(400);
  });
});
