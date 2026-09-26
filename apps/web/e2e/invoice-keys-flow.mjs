/**
 * End-to-end check of billing from the keyboard and of adding a customer
 * while billing: Ctrl+I opens a new invoice -> a shop that is not a customer
 * yet is typed in the customer search -> arrow down to "Add … as a new
 * customer", Enter -> the form opens with the name filled in -> saved, the
 * bill has the new customer -> product search, Enter, F2 back to search,
 * Ctrl+Enter saves. Then at tablet width (900 px): the full invoice screen
 * with the same keys (F3, F2, Ctrl+Enter). Then on a phone: "Add customer"
 * from the search by tap.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/invoice-keys-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98775${String(Date.now()).slice(-5)}`;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id ?? "");
const expectFocus = async (label, step) => {
  await page.waitForTimeout(150);
  const got = await focused();
  if (!got.startsWith(label)) errors.push(`${step}: focus on "${got}", expected "${label}"`);
};
const bills = async () => (await api("GET", "/invoices", token)).data;

// 1. Sign up; one product.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kishan Lal");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Kishan Agencies");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Kishan/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
await api("POST", "/products", token, { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "100" });
await page.reload();
await page.getByRole("heading", { name: /Kishan/ }).waitFor({ timeout: 15000 });
log("signed up; one product");

// 2. Ctrl+I, a new shop added from the customer search with the keyboard.
await page.keyboard.press("Control+i");
await page.getByRole("heading", { name: "New Invoice" }).waitFor();
await expectFocus("Search customer", "new invoice");
await page.keyboard.type("Sharma General Store");
await page.getByRole("option", { name: "Add “Sharma General Store” as a new customer" }).waitFor();
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
const dialog = page.getByRole("dialog");
await dialog.getByRole("heading", { name: "Add customer" }).waitFor();
if ((await page.locator("#c-business").inputValue()) !== "Sharma General Store") errors.push("name not carried into the form");
await dialog.getByRole("radio", { name: /Consumer|B2C/ }).click();
await page.fill("#c-mobile", "9826054321");
await page.screenshot({ path: `${OUT}/keys-1-add-customer.png` });
await dialog.getByRole("button", { name: "Save", exact: true }).click();
await toast("Customer saved");
await page.getByText("Sharma General Store").first().waitFor();
await expectFocus("Search product", "after adding the customer");
log("new customer added from the invoice and put on the bill");

// 3. Product by keyboard, F2 back to search, Ctrl+Enter saves.
await page.keyboard.type("fortune");
await page.getByRole("option", { name: /Fortune Oil 1L/ }).waitFor();
await page.keyboard.press("Enter");
await expectFocus("Qty", "after adding the product");
await page.keyboard.press("F2");
await expectFocus("Search product", "F2");
await page.keyboard.press("Control+Enter");
await toast(/Invoice INV\/.* saved/);
let list = await bills();
if (list.length !== 1 || !list[0].partyName?.includes("Sharma")) errors.push(`bills: ${JSON.stringify(list.map((b) => [b.invoiceNumber, b.partyName]))}`);
log("saved with Ctrl+Enter:", list.map((b) => `${b.invoiceNumber} ${b.partyName} ${b.grandTotal}`).join(", "));

// 4. Tablet / small laptop width: the full screen and the same keys.
await page.setViewportSize({ width: 900, height: 800 });
await page.keyboard.press("Control+i");
await page.getByRole("heading", { name: "New Invoice" }).waitFor();
await page.keyboard.press("F2");
await page.keyboard.press("F3");
await expectFocus("Search customer", "F3 at 900 px");
await page.keyboard.type("sharma");
await page.getByRole("option", { name: /Sharma General Store/ }).waitFor();
await page.keyboard.press("Enter");
await expectFocus("Search product", "after picking at 900 px");
await page.keyboard.type("fortune");
await page.getByRole("option", { name: /Fortune Oil 1L/ }).waitFor();
await page.keyboard.press("Enter");
await page.keyboard.press("Control+Enter");
await toast(/Invoice INV\/.*00002 saved/);
await page.screenshot({ path: `${OUT}/keys-2-tablet.png` });
log("900 px wide: F3, F2 and Ctrl+Enter work on the full invoice screen");

// 5. Phone: tap "Add customer" in the search.
await page.setViewportSize({ width: 390, height: 844 });
await page.reload();
await page.getByRole("heading", { name: "Quick Invoice" }).waitFor({ timeout: 15000 }).catch(async () => errors.push(`phone heading: ${await page.locator("h1").first().textContent()}`));
await page.getByRole("combobox", { name: /Search customer/ }).fill("9826011111");
await page.getByRole("option", { name: /as a new customer/ }).click();
await dialog.getByRole("heading", { name: "Add customer" }).waitFor();
if ((await page.locator("#c-mobile").inputValue()) !== "9826011111") errors.push("mobile not carried into the form");
await page.screenshot({ path: `${OUT}/keys-3-phone.png` });
await dialog.getByRole("button", { name: "Close" }).first().click();
log("phone: Add customer opens with the typed mobile number");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
