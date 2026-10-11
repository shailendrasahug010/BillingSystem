/**
 * End-to-end check of trade schemes. Schemes → New scheme: "Lifebuoy 10+1"
 * (free goods on one product); the brand's 2% / 3% slab added through the
 * API. A bill for 9 soaps says how many more earn what; at 25 the bill gives
 * 2 soaps free (their own line) and the 3% slab on the line; the slab left
 * off and given again; saved, the server has both. The claims tab adds up
 * what to claim from the company; the screen fits a phone.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/schemes-flow.mjs
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
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
const check = (ok, message) => ok || errors.push(message);
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
/** Waits for the page to say `text`; on failure shows what it says instead. */
const says = (text, within = page) =>
  within
    .getByText(text)
    .first()
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      await page.screenshot({ path: `${OUT}/schemes-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 2500));
      throw e;
    });

try {
  // 1. Sign up; a brand, its two soaps, a shampoo and a customer.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Mohan Agarwal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Agarwal Distributors");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Mohan/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const today = (await api("GET", "/me", token)).today;
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const brand = (await api("POST", "/brands", token, { name: "Lifebuoy" })).id;
  const product = (name, price, cost, brandId) => api("POST", "/products", token, { name, taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "200", openingStockCost: cost, ...(brandId ? { brandId } : {}) });
  await product("Lifebuoy 100g", "35", "28", brand);
  await product("Lifebuoy Lemon", "40", "30", brand);
  await product("Clinic Plus 180ml", "120", "90");
  await api("POST", "/customers", token, { name: "Gupta Stores", stateCode: "23" });
  await page.reload();
  log("signed up; Lifebuoy soaps, a shampoo, Gupta Stores");

  // 2. Schemes → New scheme: 10+1 on Lifebuoy 100g.
  await nav("Schemes");
  await says("No schemes here");
  await page.getByRole("button", { name: "New scheme" }).click();
  await page.fill("#scheme-name", "Lifebuoy 10+1");
  await page.locator("#scheme-products").fill("lifebuoy 100");
  await page.getByRole("option", { name: /Lifebuoy 100g/ }).click();
  await page.fill("#scheme-from-0", "10");
  await page.fill("#scheme-free-0", "1");
  await page.screenshot({ path: `${OUT}/schemes-1-editor.png` });
  await page.getByRole("button", { name: "Save scheme" }).click();
  await toast("Scheme saved");
  await says("From 10: 1 free (repeats)");
  // The brand's slab, as the company sent it.
  await api("POST", "/schemes", token, { name: "Lifebuoy slab", kind: "discount", brandIds: [brand], slabs: [{ from: "12", discountPercent: "2" }, { from: "24", discountPercent: "3" }], validFrom: today, reference: "HUL/SC/2610" });
  await page.reload();
  await says("From 12: 2% off · From 24: 3% off");
  await page.screenshot({ path: `${OUT}/schemes-2-list.png` });
  log("schemes: Lifebuoy 10+1 (on the screen), Lifebuoy slab 2% / 3% (through the API)");

  // 3. A bill: 9 soaps says how many more earn what; 25 gives 2 free and 3% off.
  await nav("New Invoice");
  await page.getByRole("combobox", { name: /Search customer/ }).fill("gupta");
  await page.getByRole("option", { name: /Gupta Stores/ }).click();
  await page.getByPlaceholder("Search product, code or scan barcode").fill("lifebuoy 100");
  await page.getByRole("option", { name: /Lifebuoy 100g/ }).click();
  await page.getByLabel("Qty Lifebuoy 100g").fill("9");
  await says("1 PCS more: 1 free (Lifebuoy 10+1)");
  await says("3 PCS more: 2% off (Lifebuoy slab)");
  await page.getByLabel("Qty Lifebuoy 100g").fill("25");
  const free = page.locator("tr[data-free-line]");
  await free.waitFor({ timeout: 15000 });
  await says("Free · Lifebuoy 10+1", free);
  await says("2 PCS", free);
  await says("Lifebuoy slab: ₹26.25 off");
  await says("Scheme benefits");
  await page.screenshot({ path: `${OUT}/schemes-3-bill.png` });
  // Left off, and given again.
  await page.getByRole("button", { name: "Leave Lifebuoy slab off this bill" }).click();
  await says("Left off this bill:");
  check((await page.locator("[data-scheme-discount]").count()) === 0, "the slab is still on the line");
  await page.getByRole("button", { name: "Give Lifebuoy slab on this bill" }).click();
  await says("Lifebuoy slab: ₹26.25 off");
  log("bill: 9 says what more earns; 25 gives 2 free and 3% off; the slab left off and given again");

  // 4. Saved: the server has the free line and the discount, with their schemes.
  await page.keyboard.press("Control+Enter");
  const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
  await popup.waitFor({ timeout: 20000 });
  await popup.getByRole("button", { name: "New invoice" }).click();
  const [listed] = (await api("GET", "/invoices", token)).data;
  const inv = await api("GET", `/invoices/${listed.id}`, token);
  check(inv.grandTotal === "1002.00", `grand total ${inv.grandTotal}`);
  check(inv.items.length === 2 && inv.items[0].schemeName === "Lifebuoy slab" && inv.items[0].schemeDiscount === "26.25", `the soap line: ${JSON.stringify(inv.items[0])}`);
  check(inv.items[1]?.schemeFree === true && inv.items[1].qty === "2.000" && inv.items[1].schemeName === "Lifebuoy 10+1" && inv.items[1].lineTotal === "0.00", `the free line: ${JSON.stringify(inv.items[1])}`);
  log("saved", inv.invoiceNumber, "for", inv.grandTotal, "with 2 soaps free and ₹26.25 off");

  // 5. Claims: 2 soaps at ₹28 cost + ₹26.25 = ₹82.25 to claim.
  await nav("Schemes");
  await page.getByRole("tab", { name: "Claims" }).click();
  const totals = page.locator("[data-claim-totals]");
  await totals.waitFor({ timeout: 15000 });
  await says("₹82.25", totals);
  await says("₹56.00", totals);
  await says("Bill by bill");
  await page.screenshot({ path: `${OUT}/schemes-4-claims.png`, fullPage: true });
  log("claims: ₹56 of goods free at cost and ₹26.25 off: ₹82.25 to claim");

  // 6. A phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Schemes" }).click();
  await says("Lifebuoy 10+1");
  await page.screenshot({ path: `${OUT}/schemes-5-phone.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/schemes-failed.png` }).catch(() => {});
}

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
