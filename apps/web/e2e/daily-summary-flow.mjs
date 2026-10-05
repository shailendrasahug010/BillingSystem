/**
 * End-to-end check of the daily summary on WhatsApp. Notifications →
 * Reminder rules: the daily summary is off until turned on, goes in the
 * evening, and to the business's phone unless numbers are given; two numbers
 * typed, one wrong refused; Send now writes the day's sales, collections,
 * expenses and what customers owe to both numbers by WhatsApp; again the same
 * day sends nothing more; the message is listed in Messages as a daily
 * summary; the rule on a phone.
 *
 * The API must run with MESSAGING_DRIVER=log (the default outside
 * production): messages are recorded, not sent. Run against a database with
 * the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/daily-summary-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98769${run}`;
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
const rules = async () => {
  await nav("Notifications");
  await page.getByRole("heading", { name: "Notifications" }).waitFor({ timeout: 15000 });
  await page.getByRole("tab", { name: "Reminder rules" }).click();
};
/** The page is no wider than the screen (no sideways scrolling). */
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);


try {
  // 1. Sign up; WhatsApp Business set up; a day's work.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Meena Agarwal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Agarwal Traders");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  await api("PUT", "/messaging/settings", token, { whatsappProvider: "meta", whatsappPhoneNumberId: "109876543210", whatsappSecret: "EAAG-e2e-secret-token", whatsappAppSecret: "e2e-meta-app-secret", whatsappTemplateLanguage: "en" });
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "50", openingStock: "100", openingStockCost: "40" });
  const shop = await api("POST", "/customers", token, { name: "Sharma Kirana", stateCode: "23", creditDays: 7 });
  await api("POST", "/invoices", token, { customerId: shop.id, lines: [{ productId: soap.id, qty: "20" }] });
  await api("POST", "/payments", token, { direction: "in", customerId: shop.id, amount: "300", method: "upi" });
  log("signed up; WhatsApp Business set up; a bill of ₹1,180 and ₹300 collected today");

  // 2. The rule: off, in the evening; turned on with two numbers.
  await rules();
  const rule = page.locator('[data-rule="daily_summary"]');
  await rule.getByText("Daily summary on WhatsApp").waitFor({ timeout: 15000 });
  if (await rule.getByRole("checkbox", { name: "On" }).isChecked()) errors.push("the daily summary is on before it is turned on");
  if ((await rule.getByLabel("Daily summary on WhatsApp: Send after").inputValue()) !== "20") errors.push("not in the evening by default");
  await rule.getByRole("checkbox", { name: "On" }).check();
  await toast("Reminder rule saved");
  const numbers = rule.getByLabel("Daily summary on WhatsApp: Send to");
  await numbers.fill("98260 11111, 12345");
  await numbers.blur();
  await page.getByText("Check the details and try again", { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => undefined);
  let saved = (await api("GET", "/reminder-rules", token)).data.find((r) => r.type === "daily_summary");
  if (saved.config.recipients.length) errors.push(`a wrong number was saved: ${saved.config.recipients}`);
  errors.splice(0, errors.length, ...errors.filter((e) => !e.startsWith("400 PATCH")));
  await numbers.fill("98260 11111, +91 98260 22222");
  await numbers.blur();
  await toast("Reminder rule saved");
  saved = (await api("GET", "/reminder-rules", token)).data.find((r) => r.type === "daily_summary");
  if (saved.config.recipients.join() !== "9826011111,9826022222") errors.push(`numbers saved: ${saved.config.recipients}`);
  await rule.screenshot({ path: `${OUT}/daily-summary-1-rule.png` });
  log("off until turned on, at 8 pm; a wrong number refused; two numbers saved");

  // 3. Check now: the day's figures to both numbers; again: nothing more.
  await rule.getByRole("button", { name: "Send now" }).click();
  let sent = [];
  for (let i = 0; i < 30; i++) {
    sent = (await api("GET", "/messages?kind=summary", token)).data;
    if (sent.length === 2 && sent.every((m) => m.status === "sent")) break;
    await page.waitForTimeout(300);
  }
  if (sent.length !== 2 || !sent.every((m) => m.channel === "whatsapp" && m.automatic)) errors.push(`summaries: ${JSON.stringify(sent)}`);
  const text = sent[0]?.body ?? "";
  for (const part of ["Agarwal Traders", "sales ₹1,180 (1 bill)", "collected ₹300", "Customers owe ₹880"]) if (!text.includes(part)) errors.push(`the summary lacks "${part}": ${text}`);
  await rule.getByRole("button", { name: "Send now" }).click();
  await page.waitForTimeout(1500);
  if ((await api("GET", "/messages?kind=summary", token)).data.length !== 2) errors.push("sent twice the same day");
  log("sent:", text);

  // 4. Messages: listed as a daily summary.
  await nav("Messages");
  await page.getByRole("button", { name: /Daily summary/ }).first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/daily-summary-2-messages.png` });
  log("listed in Messages as a daily summary");

  // 5. A phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${WEB}/#notifications`);
  await page.reload();
  await page.getByRole("tab", { name: "Reminder rules" }).click({ timeout: 15000 });
  await rule.scrollIntoViewIfNeeded();
  await rule.screenshot({ path: `${OUT}/daily-summary-3-phone.png` });
  if (!(await fits())) errors.push("the page scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/daily-summary-failed.png` }).catch(() => undefined);
}
await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
