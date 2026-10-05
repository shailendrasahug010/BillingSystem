/**
 * End-to-end check of the first-time setup guide, the UPI QR code on bills
 * and repeat bills. A new business sees "Get your business ready" on the
 * dashboard; the bank and UPI step opens Settings at "Where customers pay";
 * the UPI ID saved there ticks the step and puts a QR code for the amount
 * owed on the A4 bill; the first product, customer and bill tick their steps.
 * From the bill, "Repeat bill" sets it to repeat every week; Invoices → Repeat
 * bills lists it, pauses it, starts it again and stops it (after asking).
 * The guide can be hidden; on a phone it fits.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/setup-repeat-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98768${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), "x-client": "native" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const errors = [];
let signedIn = false;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const guide = page.locator("[data-setup-guide]");
const step = (key) => guide.locator(`[data-step="${key}"]`);
const done = async (key) => (await step(key).getAttribute("data-done")) === "true";
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const home = async () => {
  await nav("Dashboard");
  await guide.waitFor({ timeout: 15000 });
};

try {
  // 1. A new business: the guide, with nothing done but what sign-up gave.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Kavita Joshi");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Joshi Suppliers");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  await guide.waitFor({ timeout: 15000 });
  await guide.getByText("Get your business ready").waitFor();
  for (const key of ["payment", "product", "customer", "bill"]) if (await done(key)) errors.push(`a new business has "${key}" done`);
  await guide.screenshot({ path: `${OUT}/setup-1-guide.png` });
  log("new business: the setup guide, with", await guide.getByText(/of 7 done/).textContent());

  // 2. The bank and UPI step opens Settings at "Where customers pay"; saving the UPI ID ticks it.
  await step("payment").click();
  const pay = page.locator("#settings-payment");
  await pay.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const r = document.getElementById("settings-payment")?.getBoundingClientRect();
    return r && r.top >= 0 && r.top < window.innerHeight;
  }, null, { timeout: 5000 });
  await page.fill("#pay-upiId", "joshisuppliers@okhdfcbank");
  await pay.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(800);
  await home();
  if (!(await done("payment"))) errors.push("the UPI step is not ticked after saving the UPI ID");
  log("bank and UPI step: opens Settings there; ticked once the UPI ID is saved");

  // 3. First product, customer and bill (made through the API): their steps tick.
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const oil = await api("POST", "/products", token, { name: "Sunflower Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "200", openingStockCost: "120" });
  const hotel = await api("POST", "/customers", token, { name: "Hotel Rajhans", stateCode: "23", mobile: "9826033333" });
  const bill = await api("POST", "/invoices", token, { customerId: hotel.id, lines: [{ productId: oil.id, qty: "20" }] });
  await page.reload();
  await guide.waitFor({ timeout: 15000 });
  for (const key of ["product", "customer", "bill"]) if (!(await done(key))) errors.push(`"${key}" not ticked after it was made`);
  log("first product, customer and bill: ticked");

  // 4. The A4 bill: a QR code to pay what is owed by UPI.
  await page.goto(`${WEB}/#invoice/${bill.id}`);
  const qr = page.locator("[data-upi-qr]").first();
  await qr.waitFor({ timeout: 15000 });
  const owed = Number(bill.balanceDue).toLocaleString("en-IN", { minimumFractionDigits: 2 });
  if (!(await qr.textContent()).includes(`Scan to pay ₹${owed} by UPI`)) errors.push(`QR caption: ${await qr.textContent()}`);
  if ((await qr.locator("svg path").count()) !== 1) errors.push("no QR code drawn");
  await qr.screenshot({ path: `${OUT}/setup-2-upi-qr.png` });
  log("A4 bill: QR code for", `₹${owed}`);

  // 5. Repeat the bill every week.
  await page.getByRole("button", { name: "Repeat bill" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Every week" }).click().catch(async () => dialog.getByRole("button", { name: "Every week" }).click());
  await dialog.screenshot({ path: `${OUT}/setup-3-repeat-dialog.png` });
  await dialog.getByRole("button", { name: "Start repeating" }).click();
  await toast(`${bill.invoiceNumber} will repeat`);
  const repeats = (await api("GET", "/repeat-bills", token)).data;
  if (repeats.length !== 1 || repeats[0].frequency !== "weekly" || repeats[0].customerName !== "Hotel Rajhans") errors.push(`repeat: ${JSON.stringify(repeats)}`);
  log("repeat set:", repeats[0]?.frequency, "next", repeats[0]?.nextDate);

  // 6. Invoices → Repeat bills: pause, start again, stop (after asking).
  await nav("Invoices");
  await page.getByRole("button", { name: "Repeat bills" }).click();
  const list = page.getByRole("dialog");
  const row = list.locator("[data-repeat]").first();
  await row.waitFor({ timeout: 15000 });
  await row.getByText("On", { exact: true }).waitFor();
  await row.getByRole("button", { name: "Pause" }).click();
  await row.getByText("Paused", { exact: true }).waitFor({ timeout: 15000 });
  await row.getByRole("button", { name: "Start again" }).click();
  await row.getByText("On", { exact: true }).waitFor({ timeout: 15000 });
  await list.screenshot({ path: `${OUT}/setup-4-repeat-list.png` });
  await row.getByRole("button", { name: "Stop repeating for Hotel Rajhans" }).click();
  await page.getByRole("button", { name: "Stop repeating", exact: true }).click();
  await list.getByText("No repeat bills yet").waitFor({ timeout: 15000 });
  if ((await api("GET", "/repeat-bills", token)).data.length !== 0) errors.push("the repeat bill was not removed");
  await page.keyboard.press("Escape");
  log("repeat bills: paused, started again, stopped");

  // 7. A phone: the guide fits; hidden, it stays hidden.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${WEB}/#dashboard`);
  await page.reload();
  await guide.waitFor({ timeout: 15000 });
  await guide.screenshot({ path: `${OUT}/setup-5-phone.png` });
  if (!(await fits())) errors.push("the dashboard scrolls sideways on a phone");
  await guide.getByRole("button", { name: "Hide this checklist" }).click();
  await page.reload();
  await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);
  if (await guide.count()) errors.push("the guide came back after it was hidden");
  log("phone: fits; hidden stays hidden");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/setup-failed.png` }).catch(() => undefined);
}
await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
