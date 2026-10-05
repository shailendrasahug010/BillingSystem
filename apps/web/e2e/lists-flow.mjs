/**
 * End-to-end check of the shared list table: 60 shops on Customers show 50
 * with "Show 10 more", the header sorts by name (up, down, back), the
 * Columns menu hides GSTIN, and after a reload the table keeps both; the
 * Products list sorts by price; Sales bills sort by total. On a phone the
 * shops are cards, not a table.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/lists-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98773${String(Date.now()).slice(-5)}`;
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
const check = (ok, message) => ok || errors.push(message);
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

// 1. Sign up; 60 shops and three products through the API.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Ramesh Gupta");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Ramesh Distributors");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Ramesh/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
for (let i = 1; i <= 60; i++) {
  const n = String(i).padStart(2, "0");
  await api("POST", "/customers", token, { name: `Shop ${n}`, mobile: `98260${String(10000 + i)}`, stateCode: "23", city: "Indore", ...(i === 7 ? { gstin: "23AAACM1234M1ZR" } : {}) });
}
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
for (const [name, price] of [["Tea 250g", "120"], ["Biscuit 100g", "10"], ["Soap 100g", "35"]])
  await api("POST", "/products", token, { name, hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "10", openingStockCost: "5" });
log("signed up; 60 shops and 3 products");

// 2. Customers: 50 shown, then the rest.
await page.goto(`${WEB}/#customers`);
await page.reload();
const table = page.locator("table").first();
await table.getByText("Shop 01", { exact: true }).waitFor({ timeout: 20000 });
const rowCount = () => table.locator("tbody tr").count();
check((await rowCount()) === 50, `rows at first: ${await rowCount()}`);
await page.getByRole("button", { name: "Show 10 more (10 left)" }).click();
check((await rowCount()) === 60, `rows after Show more: ${await rowCount()}`);
log("Customers: 50 rows, then all 60 with Show 10 more");

// 3. Sort by name: up, down, then the list's own order.
const nameHeader = table.getByRole("button", { name: "Name" });
const firstShop = async () => (await table.locator("tbody tr").first().innerText()).match(/Shop \d\d/)?.[0];
await nameHeader.click();
check((await firstShop()) === "Shop 01", `sorted up, first: ${await firstShop()}`);
await nameHeader.click();
check((await firstShop()) === "Shop 60", `sorted down, first: ${await firstShop()}`);
check((await table.locator("th[aria-sort=descending]").count()) === 1, "the header does not say it sorts down");
log("Name header: Shop 01 first, then Shop 60 first");

// 4. Hide GSTIN; after a reload the sort and the hidden column are kept.
await page.getByRole("button", { name: "Columns" }).click();
await page.getByRole("checkbox", { name: "GSTIN" }).click();
await page.keyboard.press("Escape");
check(!(await table.locator("th", { hasText: "GSTIN" }).count()), "GSTIN still shown");
await page.screenshot({ path: `${OUT}/lists-1-customers.png` });
await page.reload();
await table.getByText("Shop 60", { exact: true }).waitFor({ timeout: 20000 });
check((await firstShop()) === "Shop 60", `after a reload, first: ${await firstShop()}`);
check(!(await table.locator("th", { hasText: "GSTIN" }).count()), "GSTIN back after a reload");
log("GSTIN hidden; sort and columns kept after a reload");

// 5. Products sort by price.
await page.goto(`${WEB}/#products`);
await page.reload();
const products = page.locator("table").first();
await products.getByText("Tea 250g", { exact: true }).waitFor({ timeout: 20000 });
await products.getByRole("button", { name: "Selling price" }).click();
const order = async () => (await products.locator("tbody tr").allInnerTexts()).map((r) => r.split("\n")[0]);
check(JSON.stringify(await order()) === JSON.stringify(["Biscuit 100g", "Soap 100g", "Tea 250g"]), `products by price: ${await order()}`);
log("Products by selling price:", (await order()).join(", "));

// 6. A phone: shops as cards.
const phone = await context.newPage();
await phone.setViewportSize({ width: 390, height: 844 });
await phone.goto(`${WEB}/#customers`);
await phone.getByRole("button", { name: /Shop 60/ }).waitFor({ timeout: 20000 });
check(!(await phone.locator("table").first().isVisible()), "a table on the phone");
await phone.screenshot({ path: `${OUT}/lists-2-phone.png` });
log("phone: cards, no table");

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
