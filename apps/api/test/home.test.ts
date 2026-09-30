import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("home screen by role", () => {
  let t: TestApp;
  let owner: Session;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const login = async (roleId: string, name: string) => {
    const mobile = nextMobile();
    await post("/members", { name, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Home Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    for (const key of ["sales", "warehouse", "hr", "accountant"]) tokens[key] = await login(roles[key], `${key} person`);
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "60" })).body.id;
    ids.shop = (await post("/customers", { name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", stateCode: "23" })).body.id;
    await post("/invoices", { customerId: ids.shop, invoiceDate: "2026-09-10", lines: [{ productId: soap, qty: "10" }] }); // 1,180 overdue
    await call(t.app, "POST", "/collections/notes", { token: tokens.sales!, body: { customerId: ids.shop, kind: "promise", promisedOn: "2026-09-24", promisedAmount: "500" } });
    const order = (await post("/sales-orders", { customerId: ids.shop, lines: [{ productId: soap, qty: "5" }] })).body.id;
    await post(`/sales-orders/${order}/status`, { status: "confirmed" });
    await post("/sales-orders", { customerId: ids.shop, lines: [{ productId: soap, qty: "2" }] }); // pending
    const ramesh = (await post("/employees", { name: "Ramesh Yadav", mobile: "9876500001", joiningDate: "2025-04-01", designation: "Packer" })).body.id;
    await post("/employees", { name: "Sita Verma", mobile: "9876500002", joiningDate: "2025-04-01", designation: "Billing" });
    await call(t.app, "PUT", "/attendance", { token: owner.token, body: { date: "2026-09-24", entries: [{ employeeId: ramesh, status: "present" }] } });
    const leaveType = (await get("/leave-types")).body.data.find((l: { code: string }) => l.code === "CL").id;
    await post("/leave/requests", { employeeId: ramesh, leaveTypeId: leaveType, fromDate: "2026-09-28", toDate: "2026-09-29", reason: "Wedding" });
    const cat = (await get("/expense-categories")).body.data[0].id;
    await post("/expenses", { categoryId: cat, amount: "240", paidTo: "Tea stall", paymentMethod: "cash" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("gives each role only its own parts", async () => {
    const all = (await get("/home")).body;
    expect(Object.keys(all).sort()).toEqual(["asOf", "collections", "expenses", "leave", "orders", "payroll", "people"]);
    expect(all.orders).toMatchObject({ pending: 2, toPack: 1, toDispatch: 0 });
    expect(all.orders.packNext).toHaveLength(1);
    expect(all.orders.packNext[0]).toMatchObject({ customer: "Gupta Kirana", city: "Dewas", status: "confirmed" });
    expect(all.people).toEqual({ employees: 2, present: 1, absent: 0, halfDay: 0, onLeave: 0, off: 0, notMarked: 1 });
    expect(all.leave).toMatchObject({ pending: 1, onLeaveToday: 0 });
    expect(all.leave.requests[0]).toMatchObject({ employee: "Ramesh Yadav", from: "2026-09-28", to: "2026-09-29", days: "2" });
    expect(all.payroll).toEqual({ month: "2026-09-01", run: null });
    expect(all.collections).toMatchObject({ outstanding: "1180.00", overdue: "1180.00", customers: 1, promisesDue: 1 });
    expect(all.collections.promises[0]).toMatchObject({ name: "Gupta Kirana", date: "2026-09-24", amount: "500.00" });
    expect(all.expenses).toMatchObject({ month: "2026-09-01", total: "240.00", count: 1 });

    const warehouse = (await get("/home", tokens.warehouse)).body;
    expect(Object.keys(warehouse).sort()).toEqual(["asOf", "orders"]);
    expect(warehouse.orders).toMatchObject({ pending: 2, toPack: 1, toDispatch: 0, packNext: [expect.objectContaining({ customer: "Gupta Kirana" })], dispatchNext: [] });

    const hr = (await get("/home", tokens.hr)).body;
    expect(Object.keys(hr).sort()).toEqual(["asOf", "expenses", "leave", "payroll", "people"]);

    const sales = (await get("/home", tokens.sales)).body;
    expect(Object.keys(sales).sort()).toEqual(["asOf", "collections", "orders"]);
    expect(sales.orders.packNext).toBeUndefined();

    const accountant = (await get("/home", tokens.accountant)).body;
    expect(Object.keys(accountant).sort()).toEqual(["asOf", "collections", "expenses"]);

    // The sales dashboard stays with dashboard.view.
    expect((await get("/dashboard", tokens.warehouse)).status).toBe(403);
    expect((await get("/dashboard", tokens.hr)).status).toBe(403);
  });

  it("drops a promise from the day's list once the customer pays", async () => {
    await post("/payments", { direction: "in", customerId: ids.shop, amount: "500", method: "cash" });
    const sales = (await get("/home", tokens.sales)).body;
    expect(sales.collections).toMatchObject({ outstanding: "680.00", promisesDue: 0, promises: [] });
  });
});
