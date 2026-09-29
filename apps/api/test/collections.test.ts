import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readSheet } from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

async function pdfText(bytes: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((x) => ("str" in x ? x.str : "")).join(" ");
  }
  return text.replace(/\s+/g, " ");
}

describe.skipIf(!hasDatabase)("outstanding to collect", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  let warehouseToken: string;
  const ids: Record<string, string> = {};

  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const file = (url: string, token = owner.token) => t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  const login = async (roleId: string, name: string) => {
    const mobile = nextMobile();
    await post("/members", { name, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Collect Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    salesToken = await login(roles.sales, "Sales Sam");
    warehouseToken = await login(roles.warehouse, "Wasim Warehouse");
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "60" })).body.id;
    ids.route = (await post("/routes", { name: "Dewas Road" })).body.id;

    // Dewas: one bill overdue (1,180 less a 200 receipt) and one not yet due (590).
    ids.gupta = (await post("/customers", { name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", stateCode: "23", creditDays: 10, routeId: ids.route })).body.id;
    await post("/invoices", { customerId: ids.gupta, invoiceDate: "2026-08-20", lines: [{ productId: soap, qty: "10" }] });
    await post("/invoices", { customerId: ids.gupta, lines: [{ productId: soap, qty: "5" }] });
    await post("/payments", { direction: "in", customerId: ids.gupta, amount: "200", method: "cash" });
    // Dewas written another way; owes only an opening balance.
    ids.sharma = (await post("/customers", { name: "Sharma Stores", city: "DEWAS", stateCode: "23", openingBalance: "500" })).body.id;
    // Dewas, paid in full: not on the list.
    ids.paid = (await post("/customers", { name: "Paid Up Mart", city: "Dewas", stateCode: "23" })).body.id;
    await post("/invoices", { customerId: ids.paid, lines: [{ productId: soap, qty: "1" }], payment: { amount: "118", method: "upi" } });
    // Ujjain, overdue since 10 Sep.
    ids.verma = (await post("/customers", { name: "Verma Traders", city: "Ujjain", stateCode: "23" })).body.id;
    await post("/invoices", { customerId: ids.verma, invoiceDate: "2026-09-10", lines: [{ productId: soap, qty: "20" }] });
    // No city; billed today, due today.
    ids.nocity = (await post("/customers", { name: "Corner Shop", stateCode: "23" })).body.id;
    await post("/invoices", { customerId: ids.nocity, lines: [{ productId: soap, qty: "1" }] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("lists everyone who owes, largest first, with overdue, bills and the places", async () => {
    const res = await get("/collections/outstanding");
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { name: string; outstanding: string }) => [r.name, r.outstanding])).toEqual([
      ["Verma Traders", "2360.00"],
      ["Gupta Kirana", "1570.00"],
      ["Sharma Stores", "500.00"],
      ["Corner Shop", "118.00"],
    ]);
    expect(res.body.totals).toEqual({ customers: 4, outstanding: "4548.00", overdue: "3340.00" });
    const gupta = res.body.rows.find((r: { name: string }) => r.name === "Gupta Kirana");
    expect(gupta).toMatchObject({
      mobile: "9826022222",
      city: "Dewas",
      route: "Dewas Road",
      overdue: "980.00",
      openBills: 2,
      oldestDueDate: "2026-08-30",
      daysOverdue: 25,
      lastPaymentDate: "2026-09-24",
      lastPaymentAmount: "200.00",
    });
    expect(res.body.rows.find((r: { name: string }) => r.name === "Corner Shop")).toMatchObject({ city: null, overdue: "0.00", daysOverdue: 0 });
    // Dewas and DEWAS are one place.
    const cities = res.body.cities.map((c: { city: string | null; customers: number; total: string }) => [c.city?.toLowerCase() ?? null, c.customers, c.total]);
    expect(cities).toEqual([
      ["ujjain", 1, "2360.00"],
      ["dewas", 2, "2070.00"],
      [null, 1, "118.00"],
    ]);
  });

  it("filters by city, route, search and overdue, and sorts", async () => {
    const names = async (qs: string) => (await get(`/collections/outstanding?${qs}`)).body.rows.map((r: { name: string }) => r.name);
    expect(await names("city=dewas")).toEqual(["Gupta Kirana", "Sharma Stores"]);
    expect(await names("city=-")).toEqual(["Corner Shop"]);
    expect(await names(`routeId=${ids.route}`)).toEqual(["Gupta Kirana"]);
    expect(await names("q=verma")).toEqual(["Verma Traders"]);
    expect(await names("q=98260")).toEqual(["Gupta Kirana"]);
    expect(await names("overdue=true")).toEqual(["Verma Traders", "Gupta Kirana"]);
    expect(await names("sort=name")).toEqual(["Corner Shop", "Gupta Kirana", "Sharma Stores", "Verma Traders"]);
    expect(await names("sort=oldest")).toEqual(["Gupta Kirana", "Verma Traders", "Corner Shop", "Sharma Stores"]);
    const dewas = (await get("/collections/outstanding?city=Dewas")).body;
    expect(dewas.totals).toEqual({ customers: 2, outstanding: "2070.00", overdue: "980.00" });
    // The city picker still shows every place.
    expect(dewas.cities).toHaveLength(3);
  });

  it("opens one customer with open bills, their age and recent payments", async () => {
    const res = await get(`/collections/outstanding/${ids.gupta}`);
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.customer).toMatchObject({ name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", route: "Dewas Road", creditDays: 10 });
    expect(d).toMatchObject({ outstanding: "1570.00", overdue: "980.00", notDue: "590.00", other: "0.00" });
    expect(d.aging[0]).toMatchObject({ label: "0-30", amount: "980.00", count: 1 });
    expect(d.bills.map((b: { date: string; dueDate: string; total: string; paid: string; balance: string; daysOverdue: number }) => [b.date, b.dueDate, b.total, b.paid, b.balance, b.daysOverdue])).toEqual([
      ["2026-08-20", "2026-08-30", "1180.00", "200.00", "980.00", 25],
      ["2026-09-24", "2026-10-04", "590.00", "0.00", "590.00", 0],
    ]);
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ date: "2026-09-24", amount: "200.00", method: "cash" });

    const sharma = (await get(`/collections/outstanding/${ids.sharma}`)).body;
    expect(sharma).toMatchObject({ outstanding: "500.00", overdue: "0.00", other: "500.00", bills: [] });
    expect((await get("/collections/outstanding/0190d3c8-0000-7000-8000-000000000000")).status).toBe(404);
  });

  it("downloads and prints for the sales team, notes each download, and stays shut to others", async () => {
    const xlsx = await file("/collections/outstanding?city=Dewas&format=xlsx", salesToken);
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-disposition"]).toBe('attachment; filename="outstanding-dewas-2026-09-24.xlsx"');
    const sheet = (await readSheet(xlsx.rawPayload)).map((r) => r.map((c) => (c == null ? null : String(c))));
    const header = sheet.findIndex((r) => r[0] === "Customer");
    expect(sheet[header]).toEqual(["Customer", "Mobile", "City / route", "Bills", "Oldest due", "Overdue", "Outstanding"]);
    expect(sheet[header + 1]?.slice(0, 3)).toEqual(["Gupta Kirana", "9826022222", "Dewas · Dewas Road"]);

    const pdf = await file("/collections/outstanding?city=Dewas&format=pdf", salesToken);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const text = await pdfText(pdf.rawPayload);
    for (const s of ["Outstanding · Dewas", "Collected", "Gupta Kirana", "Sharma Stores", "1,570.00", "2,070.00"]) expect(text).toContain(s);
    expect(text).not.toContain("Verma Traders");

    const csv = await file("/collections/outstanding?format=csv", salesToken);
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\r\n")[0]).toBe("\uFEFFCustomer,Mobile,City / route,Bills,Oldest due,Overdue,Outstanding");

    const audit = (await get("/audit-logs?action=outstanding.exported")).body.data;
    expect(audit).toHaveLength(3);
    expect(audit.map((a: { changes: { format: string } }) => a.changes.format).sort()).toEqual(["csv", "pdf", "xlsx"]);

    expect((await get("/collections/outstanding", salesToken)).status).toBe(200);
    expect((await get("/collections/outstanding", warehouseToken)).status).toBe(403);
    expect((await get(`/collections/outstanding/${ids.gupta}`, warehouseToken)).status).toBe(403);
    expect((await file("/collections/outstanding?format=pdf", warehouseToken)).statusCode).toBe(403);
  });
});
