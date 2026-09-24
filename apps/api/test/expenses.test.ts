import { gstinCheckChar } from "@vyapaar/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("expenses", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const cat: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token, headers?: Record<string, string>) => call(t.app, "POST", url, { token, body, ...(headers ? { headers } : {}) });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Kharcha Traders", stateCode: "23", gstin: gstin("23", "AAPFK1234K") });
    for (const c of (await get("/expense-categories")).body.data) cat[c.name] = c.id;
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("starts every business with the usual categories and lets it add its own", async () => {
    expect(Object.keys(cat)).toEqual(expect.arrayContaining(["Rent", "Electricity", "Fuel", "Salary", "Transport"]));
    const added = await post("/expense-categories", { name: "Tea & Snacks", nameHi: "चाय नाश्ता" });
    expect(added.status).toBe(201);
    cat["Tea & Snacks"] = added.body.id;
    expect((await post("/expense-categories", { name: "Tea & Snacks" })).body.error).toMatchObject({ code: "DUPLICATE_NAME", field: "name" });
  });

  it("records a plain cash expense with a number and no GST", async () => {
    const res = await post("/expenses", { categoryId: cat["Tea & Snacks"], amount: "240", paidTo: "Sharma Tea Stall", paymentMethod: "cash" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ expenseNumber: "EXP/26-27/00001", expenseDate: "2026-09-24", amount: "240.00", totalAmount: "240.00", gstRate: "0.000", cgstAmount: "0.00", itcEligibility: null, categoryName: "Tea & Snacks", status: "posted" });
  });

  it("puts GST on a vendor bill into the GST register as input tax credit (intra- and inter-state)", async () => {
    const vendor = gstin("23", "AAACM1234M");
    const local = await post("/expenses", { categoryId: cat.Electricity, amount: "1180", amountIncludesTax: true, gstRate: "18", vendorGstin: vendor, paidTo: "MP Power", referenceNumber: "EB-7781", paymentMethod: "upi" });
    expect(local.status).toBe(201);
    expect(local.body).toMatchObject({ amount: "1000.00", cgstAmount: "90.00", sgstAmount: "90.00", igstAmount: "0.00", totalAmount: "1180.00", vendorGstin: vendor, itcEligibility: "input_services" });
    const other = await post("/expenses", { categoryId: cat.Transport, amount: "500", gstRate: "5", vendorGstin: gstin("27", "AAACT1234T"), paidTo: "VRL Logistics", paymentMethod: "bank_transfer" });
    expect(other.body).toMatchObject({ amount: "500.00", igstAmount: "25.00", cgstAmount: "0.00", totalAmount: "525.00" });

    const gst = (await get("/reports/gst?period=2026-09")).body;
    expect(gst.inward).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itcEligibility: "input_services", gstRate: "18.000", taxable: "1000.00", cgst: "90.00", sgst: "90.00" }),
        expect.objectContaining({ itcEligibility: "input_services", gstRate: "5.000", taxable: "500.00", igst: "25.00" }),
      ]),
    );
    expect(gst.estimate.eligibleItc).toMatchObject({ cgst: "90.00", sgst: "90.00", igst: "25.00" });
  });

  it("needs a valid vendor GSTIN to claim GST, and refuses future dates", async () => {
    expect((await post("/expenses", { categoryId: cat.Rent, amount: "100", gstRate: "18", paymentMethod: "cash" })).body.error).toMatchObject({ code: "EXPENSE_GSTIN_REQUIRED", field: "vendorGstin" });
    expect((await post("/expenses", { categoryId: cat.Rent, amount: "100", gstRate: "18", vendorGstin: "23AAACM1234M1ZZ", paymentMethod: "cash" })).body.error).toMatchObject({ code: "INVALID_GSTIN", field: "vendorGstin" });
    expect((await post("/expenses", { categoryId: cat.Rent, amount: "100", expenseDate: "2026-09-25", paymentMethod: "cash" })).body.error.code).toBe("FUTURE_DATE_NOT_ALLOWED");
  });

  it("replays a retried save instead of recording it twice", async () => {
    const key = randomUUID();
    const body = { categoryId: cat.Fuel, amount: "900", paymentMethod: "cash", notes: "Van diesel" };
    const first = await post("/expenses", body, owner.token, { "idempotency-key": key });
    const again = await post("/expenses", body, owner.token, { "idempotency-key": key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it("lists with totals, reports by category and month, and exports CSV", async () => {
    const list = (await get("/expenses?from=2026-09-01&to=2026-09-30")).body;
    expect(list.data).toHaveLength(4);
    expect(list.totals).toEqual({ count: 4, amount: "2640.00", gst: "205.00", total: "2845.00" });
    expect((await get(`/expenses?categoryId=${cat.Fuel}`)).body.data).toEqual([expect.objectContaining({ amount: "900.00", categoryName: "Fuel" })]);
    expect((await get("/expenses?q=VRL")).body.data).toHaveLength(1);

    const byCategory = (await get("/reports/expenses?from=2026-09-01&to=2026-09-30")).body;
    expect(byCategory.rows[0]).toMatchObject({ label: "Electricity", count: 1, amount: "1000.00", gst: "180.00", itc: "180.00", total: "1180.00" });
    expect(byCategory.totals).toEqual({ count: 4, amount: "2640.00", gst: "205.00", total: "2845.00" });
    expect((await get("/reports/expenses?from=2026-04-01&to=2026-09-30&groupBy=month")).body.rows).toEqual([expect.objectContaining({ label: "2026-09", count: 4, total: "2845.00" })]);
    const csv = await t.app.inject({ method: "GET", url: "/api/v1/reports/expenses?from=2026-09-01&to=2026-09-30&format=csv", headers: { authorization: `Bearer ${owner.token}` } });
    expect(String(csv.headers["content-type"])).toContain("text/csv");
    expect(csv.body).toContain("Electricity,1,1000.00,180.00,180.00,1180.00");
  });

  it("cancels an expense (reason required) and takes its GST out of the register", async () => {
    const [electricity] = (await get(`/expenses?categoryId=${cat.Electricity}`)).body.data;
    expect((await post(`/expenses/${electricity.id}/cancel`, { reason: "" })).status).toBe(400);
    const cancelled = await post(`/expenses/${electricity.id}/cancel`, { reason: "Entered twice" });
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancelReason: "Entered twice" });
    expect((await post(`/expenses/${electricity.id}/cancel`, { reason: "Again" })).body.error.code).toBe("EXPENSE_NOT_POSTED");
    const gst = (await get("/reports/gst?period=2026-09")).body;
    expect(gst.estimate.eligibleItc).toMatchObject({ cgst: "0.00", sgst: "0.00", igst: "25.00" });
    expect((await get("/expenses?status=cancelled")).body.data).toEqual([expect.objectContaining({ id: electricity.id })]);
    const audit = (await get("/audit-logs?entityType=expense")).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["expense.posted", "expense.cancelled"]));
  });

  it("keeps expenses from roles without expense permissions", async () => {
    expect((await get("/expenses", salesToken)).status).toBe(403);
    expect((await post("/expenses", { categoryId: cat.Rent, amount: "10", paymentMethod: "cash" }, salesToken)).status).toBe(403);
  });
});
