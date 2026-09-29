/**
 * End-to-end check of selling price lists (Price A / B / C): a new business
 * starts with Price A (default, the selling price), Price B and Price C ->
 * Settings → Price lists: add one, rename one -> Customers → Add customer on
 * Price B -> a bill for them is priced from Price B, and the invoice's
 * customer card says so -> the customer moved to Price C on their page ->
 * the next bill is priced from Price C.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/price-lists-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98779${String(Date.now()).slice(-5)}`;
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
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");

// 1. Sign up: the business starts with Price A, B and C. One product with a price on each.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Suresh Gupta");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Gupta Distributors");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Suresh/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const levels = Object.fromEntries((await api("GET", "/price-levels", token)).data.map((l) => [l.name, l]));
if (!levels["Price A"]?.isDefault || !levels["Price B"] || !levels["Price C"]) errors.push(`price lists: ${Object.keys(levels).join(", ")}`);
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
await api("POST", "/products", token, {
  name: "Parle-G 100g",
  taxCategoryId: taxes["GST 5%"],
  baseUnitId: units.PCS,
  sellingPrice: "10",
  openingStock: "500",
  prices: [
    { priceLevelId: levels["Price B"].id, unitId: units.PCS, price: "9.5" },
    { priceLevelId: levels["Price C"].id, unitId: units.PCS, price: "9" },
  ],
});
log("new business has", Object.keys(levels).join(", "), "; Parle-G at 10 / 9.50 / 9");

// 2. Settings → Price lists: add one and rename one.
await page.reload();
await nav("Settings");
await page.getByRole("heading", { name: "Price lists" }).waitFor({ timeout: 15000 });
await page.fill("#pl-name", "Price D");
await page.getByRole("button", { name: "Add list" }).click();
await toast("Price D added");
await page.getByLabel("Name of Price D").fill("Special");
await page.getByLabel("Name of Price D").press("Enter");
await toast("Renamed to Special");
await page.getByRole("heading", { name: "Price lists" }).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/price-lists-1-settings.png` });
const now = (await api("GET", "/price-levels", token)).data.map((l) => l.name);
if (JSON.stringify(now) !== JSON.stringify(["Price A", "Price B", "Price C", "Special"])) errors.push(`lists after edit: ${now.join(", ")}`);
log("Settings: Price D added and renamed to Special");

// 3. A customer on Price B.
await nav("Customers");
await page.getByRole("button", { name: "Add customer" }).first().click();
await dialog().getByRole("radio", { name: /Consumer|B2C/ }).click();
await page.fill("#c-business", "Jain Kirana");
await page.fill("#c-mobile", "9826033333");
await page.locator("#c-price-list").selectOption({ label: "Price B" });
await page.screenshot({ path: `${OUT}/price-lists-2-customer.png` });
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await toast("Customer saved");
const customer = (await api("GET", "/customers", token)).data.find((c) => c.name === "Jain Kirana");
if (customer?.priceLevelId !== levels["Price B"].id) errors.push(`customer price list ${customer?.priceLevelId}`);
log("Jain Kirana added on Price B");

// 4. Their bill is priced from Price B, and the card says so.
const bill = async (expectedRate, list, number) => {
  await nav("New Invoice");
  await page.getByRole("combobox", { name: /Search customer/ }).fill("jain");
  await page.getByRole("option", { name: /Jain Kirana/ }).click();
  await page.getByText(list, { exact: true }).first().waitFor();
  await page.getByPlaceholder("Search product, code or scan barcode").fill("parle");
  await page.getByRole("option", { name: /Parle-G 100g/ }).click();
  const rate = await page.getByLabel("Rate Parle-G 100g").inputValue();
  if (rate !== expectedRate) errors.push(`${list}: rate ${rate}, expected ${expectedRate}`);
  await page.getByLabel("Qty Parle-G 100g").fill("100");
  await page.screenshot({ path: `${OUT}/price-lists-bill-${number}.png` });
  await page.keyboard.press("Control+Enter");
  await page.getByText(`Invoice INV/26-27/0000${number} saved`).first().waitFor({ timeout: 15000 });
};
await bill("9.5", "Price B", 1);
await page.screenshot({ path: `${OUT}/price-lists-3-invoice.png` });
log("bill for Jain Kirana at 9.50 (Price B)");

// 5. Moved to Price C on their page: the next bill is at 9.
await nav("Customers");
await page.getByRole("cell", { name: /Jain Kirana/ }).first().click();
await page.getByLabel("Selling price list").selectOption({ label: "Price C" });
await toast("Now bills at Price C");
await page.screenshot({ path: `${OUT}/price-lists-4-profile.png` });
await bill("9", "Price C", 2);
const invoices = (await api("GET", "/invoices", token)).data.map((i) => i.grandTotal).sort();
// 100 x 9.50 + 5% = 997.50, rounded off to 998; 100 x 9 + 5% = 945.
if (JSON.stringify(invoices) !== JSON.stringify(["945.00", "998.00"])) errors.push(`invoice totals ${invoices.join(", ")}`);
log("moved to Price C on the customer's page; next bill at 9 — totals", invoices.join(", "));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
