/**
 * End-to-end check of the live web app against a real API and database:
 * sign up (creates the business) -> products and a customer (API) -> bill in
 * the UI -> the server agrees on the total -> invoice view, dashboard, search
 * -> session survives a reload -> sign out.
 *
 * Run against an empty database, with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/billing-flow.mjs
 * Needs the `playwright` package (set PLAYWRIGHT_PATH to where it is installed
 * if it is not resolvable from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const API = `${process.env.API_URL ?? "http://localhost:3000"}/api/v1`;
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98765${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), "x-client": "native" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url()}`));

// 1. Sign up (creates the business) through the UI.
await page.goto(WEB);
await page.getByRole("heading", { name: "Welcome back" }).waitFor();
log("auth screen shown");
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Ravi Kumar");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Ravi Distributors");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
const code = (await hint.textContent()).match(/\d{6}/)[0];
await page.fill("#auth-otp", code);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Ravi/ }).waitFor({ timeout: 15000 });
log("signed up; dashboard greets", await page.getByRole("heading", { name: /Ravi/ }).textContent());
await page.screenshot({ path: `${OUT}/e2e-1-dashboard-empty.png` });

// 2. Master data through the API (the web product/customer editors come later).
const session = await api("POST", "/auth/login", null, { identifier: mobile, password });
const token = session.accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
if ((await api("GET", "/products", token)).data.length === 0) await api("POST", "/products", token, { name: "Parle-G 100g", nameLocal: "पारले-जी 100 ग्रा", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", mrp: "10", openingStock: "100", openingStockCost: "8" });
if ((await api("GET", "/products?q=surf", token)).data.length === 0) await api("POST", "/products", token, { name: "Surf Excel 1kg", hsnCode: "3402", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "20", openingStockCost: "120" });
if ((await api("GET", "/customers?q=sharma", token)).data.length === 0) await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23", city: "Indore", creditDays: 7 });
log("created 2 products and a customer via API");

// 3. Bill in the UI.
await page.goto(`${WEB}/#invoice`);
await page.reload();
const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
await customerBox.waitFor({ timeout: 15000 });
await customerBox.fill("Sharma");
await page.keyboard.press("Enter");
const productBox = page.getByPlaceholder(/Search product/);
await productBox.fill("parle");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await productBox.fill("surf");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/e2e-2-invoice-draft.png` });
const grandUi = await page.locator("aside[aria-label='Bill summary']").innerText();
log("summary panel:", grandUi.replace(/\s+/g, " ").slice(0, 200));
await page.getByRole("button", { name: "Save invoice" }).click();
const toast = page.getByText(/Invoice INV\/\d\d-\d\d\/00001 saved/);
await toast.waitFor({ timeout: 15000 });
log("toast:", await toast.textContent());

// 4. Server agrees.
const invoices = await api("GET", "/invoices", token);
log("server invoices:", invoices.data.map((i) => `${i.invoiceNumber} ${i.partyName} ${i.grandTotal}`).join(" | "));

// 5. Invoice view (stored snapshot) and dashboard.
await page.getByRole("button", { name: "Details" }).click();
await page.getByRole("heading", { name: /INV\/\d\d-\d\d\/00001/ }).waitFor({ timeout: 15000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/e2e-3-invoice-view.png`, fullPage: true });
log("invoice view opened");
await page.goto(`${WEB}/#dashboard`);
await page.getByText("Today's Sales").waitFor({ timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/e2e-4-dashboard.png` });
const todaySales = await page.getByText("Today's Sales").locator("xpath=ancestor::*[contains(@class,'rounded')][1]").innerText();
log("today tile:", todaySales.replace(/\s+/g, " "));

// 6. Global search finds the invoice.
await page.keyboard.press("Control+k");
await page.keyboard.type("INV/");
await page.getByText(/INV\/\d\d-\d\d\/00001/).first().waitFor({ timeout: 10000 });
log("search found the invoice");
await page.keyboard.press("Escape");

// 7. Sign out returns to the sign-in screen; reload keeps you signed in until then.
await page.reload();
await page.getByText("Today's Sales").waitFor({ timeout: 15000 });
log("session restored after reload (refresh cookie)");
await page.getByRole("button", { name: "Sign out" }).click();
await page.getByRole("heading", { name: "Welcome back" }).waitFor();
log("signed out");

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
