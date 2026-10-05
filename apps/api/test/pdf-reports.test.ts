import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readSheet } from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfCell } from "../src/services/pdf-report.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

/** Text of each page, as pdf.js reads it back from the file. */
async function pdfText(bytes: Buffer): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((x) => ("str" in x ? x.str : "")).join(" ").replace(/\s+/g, " "));
  }
  return pages;
}

describe("PDF cells", () => {
  it("formats amounts the Indian way, trims quantities and spells dates", () => {
    expect(pdfCell("135684.50").text).toBe("1,35,684.50");
    expect(pdfCell("-1234567.00").text).toBe("-12,34,567.00");
    expect(pdfCell("8.000")).toEqual({ text: "8", numeric: true });
    expect(pdfCell("12.500").text).toBe("12.5");
    expect(pdfCell("30.0").text).toBe("30.0");
    expect(pdfCell(42).text).toBe("42");
    expect(pdfCell("2026-09-05")).toEqual({ text: "05/09/2026", numeric: false });
    expect(pdfCell("Parle-G")).toEqual({ text: "Parle-G", numeric: false });
    expect(pdfCell(null).text).toBe("");
  });
});

describe.skipIf(!hasDatabase)("reports as PDF and Excel", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const pdf = (url: string, token = owner.token) => t.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  const RANGE = "from=2026-09-01&to=2026-09-30";

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { addressLine1: "12 Siyaganj Main Road", city: "Indore", pincode: "452007", phone: "9826012345", email: "accounts@laxmitraders.in" } });
    // A real 1x1 PNG as the firm's logo.
    await call(t.app, "PUT", "/business/logo", { token: owner.token, body: { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;

    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const product = async (name: string, nameLocal: string, price: string) =>
      (await post("/products", { name, nameLocal, taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "1000", openingStockCost: "50" })).body.id as string;
    const soap = await product("Bath Soap", "नहाने का साबुन", "100");
    const powder = await product("Washing Powder", "कपड़े धोने का पाउडर", "120000");
    const shop = (await post("/customers", { name: "Sharma Kirana Store", stateCode: "23" })).body.id;
    await post("/invoices", { customerId: shop, invoiceDate: "2026-09-10", lines: [{ productId: soap, qty: "10" }, { productId: powder, qty: "1" }] });
    // Enough customers to need a second page.
    for (let i = 1; i <= 45; i++) {
      const c = (await post("/customers", { name: `Kirana Shop ${String(i).padStart(2, "0")}`, stateCode: "23" })).body.id;
      await post("/invoices", { customerId: c, invoiceDate: "2026-09-12", lines: [{ productId: soap, qty: String(i) }] });
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  it("prints a report with the firm's letterhead, the period, the rows and the totals", async () => {
    const res = await pdf(`/reports/sales?${RANGE}&groupBy=product&format=pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="sales-2026-09-01-2026-09-30.pdf"');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const [page] = await pdfText(res.rawPayload);
    for (const text of ["Laxmi Traders", "12 Siyaganj Main Road", "Indore 452007", "9826012345 · accounts@laxmitraders.in", "Sales by product", "01/09/2026 – 30/09/2026", "Washing Powder", "1,20,000.00", "Total", "Page 1 of 1", "Made with", "Digital", "Bahi"]) {
      expect(page).toContain(text);
    }
    // 10 soaps + 1 powder + 1..45 soaps: taxable 1,000 + 1,20,000 + 1,03,500.
    expect(page).toContain("2,24,500.00");
  });

  it("carries on over pages with the column headings repeated", async () => {
    const res = await pdf(`/reports/sales?${RANGE}&groupBy=customer&format=pdf`);
    const pages = await pdfText(res.rawPayload);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)).toContain(`Page ${pages.length} of ${pages.length}`);
    for (const p of pages) expect(p).toContain("Taxable");
    expect(pages.join(" ")).toContain("Kirana Shop 45");
  });

  it("works for every exported report and needs the export right", async () => {
    for (const url of [
      `/reports/collections?${RANGE}&format=pdf`,
      `/reports/purchases?${RANGE}&format=pdf`,
      `/reports/outstanding?party=customer&format=pdf`,
      `/reports/profit?${RANGE}&groupBy=product&format=pdf`,
      `/reports/products?${RANGE}&format=pdf`,
      `/reports/expenses?${RANGE}&format=pdf`,
    ]) {
      const res = await pdf(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toBe("application/pdf");
    }
    const outstanding = (await pdfText((await pdf("/reports/outstanding?party=customer&format=pdf")).rawPayload))[0]!;
    expect(outstanding).toContain("Customer outstanding");
    expect(outstanding).toMatch(/As of \d{2}\/\d{2}\/\d{4}/);
    expect((await pdf(`/reports/sales?${RANGE}&format=pdf`, salesToken)).statusCode).toBe(403);
  });

  it("downloads an Excel workbook with numbers, dates and totals Excel can add up", async () => {
    const res = await pdf(`/reports/sales?${RANGE}&groupBy=product&format=xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="sales-2026-09-01-2026-09-30.xlsx"');
    const rows = await readSheet(res.rawPayload);
    expect(rows[0]![0]).toBe("Sales by product");
    expect(rows[1]![0]).toBe("Laxmi Traders · 01/09/2026 – 30/09/2026");
    const header = rows[3]!;
    expect(header).toContain("Taxable");
    const powder = rows.find((r) => r[0] === "Washing Powder" || r.includes("Washing Powder"))!;
    const taxable = header.indexOf("Taxable");
    expect(powder[taxable]).toBe(120000);
    const total = rows.at(-1)!;
    expect(total[0]).toBe("Total");
    expect(total[taxable]).toBe(224500);
    // Dates are dates.
    const byDay = await readSheet((await pdf(`/reports/sales?${RANGE}&groupBy=day&format=xlsx`)).rawPayload);
    expect(byDay.slice(4).some((r) => r.some((c) => c instanceof Date))).toBe(true);
    expect((await pdf(`/reports/sales?${RANGE}&format=xlsx`, salesToken)).statusCode).toBe(403);
    for (const url of [`/reports/outstanding?party=customer&format=xlsx`, `/reports/profit?${RANGE}&groupBy=product&format=xlsx`, `/reports/expenses?${RANGE}&format=xlsx`, `/reports/products?${RANGE}&format=xlsx`]) {
      expect((await pdf(url)).statusCode, url).toBe(200);
    }
  });
});
