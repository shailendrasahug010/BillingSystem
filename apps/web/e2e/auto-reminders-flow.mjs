/**
 * End-to-end check of the automatic payment reminders and the orders-waiting
 * rule (Phase 5.2): sign up -> customers with overdue bills (one who gets
 * messages in Hindi, one without a mobile) -> Settings: WhatsApp Business
 * (with the Hindi template language) and the SMS gateway -> Notifications →
 * Reminder rules: payment reminders are off with a note; once on, the card
 * lists who is due one today and who cannot be reached -> "Send now" (asked
 * first) -> Messages lists them marked Automatic, the Hindi customer's in
 * Hindi -> on a customer's page "No payment reminders" is ticked: a badge
 * says so and the manual reminders leave them out -> a customer replies STOP
 * on WhatsApp: stopped, the staff are told -> the cards in Hindi and at
 * phone width.
 *
 * The API must run with MESSAGING_DRIVER=log (the default outside
 * production): messages are recorded, not sent. Run against a database with
 * the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/auto-reminders-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createHmac } from "node:crypto";
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
const openCustomer = async (name) => {
  await nav("Customers");
  await page.getByRole("cell", { name: new RegExp(name) }).first().click({ timeout: 15000 });
  await page.getByRole("heading", { name: new RegExp(name) }).waitFor({ timeout: 15000 });
};
const rules = async () => {
  await nav("Notifications");
  await page.getByRole("heading", { name: "Notifications" }).waitFor({ timeout: 15000 });
  await page.getByRole("tab", { name: "Reminder rules" }).click();
};
/** The page is no wider than the screen (no sideways scrolling). */
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // 1. Sign up; customers with bills past their credit days.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Kailash Joshi");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Joshi Distributors");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Kailash/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "500", openingStockCost: "28" });
  const customer = (body) => api("POST", "/customers", token, { stateCode: "23", creditDays: 7, ...body });
  const sharma = await customer({ name: "Sharma Kirana", mobile: "9826012345" });
  const gupta = await customer({ name: "Gupta Stores", mobile: "9826054321", messageLocale: "hi" });
  const verma = await customer({ name: "Verma General" });
  const billed = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  for (const [c, qty] of [[sharma, "24"], [gupta, "12"], [verma, "6"]]) await api("POST", "/invoices", token, { customerId: c.id, invoiceDate: billed, lines: [{ productId: soap.id, qty }] });
  // Its hour later than now, so the scheduler does not send them before "Send now" does.
  await api("PATCH", "/reminder-rules/customer_reminders", token, { config: { hour: 23 } });
  log("three customers with bills of", billed, "(8 days overdue); Gupta Stores gets messages in Hindi, Verma General has no mobile");

  // 2. Settings: WhatsApp Business (with the Hindi template language) and the SMS gateway.
  await page.reload();
  await nav("Settings");
  const card = page.getByRole("heading", { name: "WhatsApp, SMS & email" }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  await card.waitFor({ timeout: 15000 });
  await page.getByLabel("WhatsApp provider").selectOption("meta");
  await page.getByLabel("Your WhatsApp Business number").fill("+91 98260 00000");
  await page.getByLabel("Phone number ID (from Meta)").fill("109876543210");
  await page.getByLabel("Access token").fill("EAAG-e2e-secret-token");
  await page.getByLabel("Template for payment reminders").fill("payment_reminder");
  await page.getByLabel("Language code of the same templates in Hindi").fill("hi");
  await page.locator("#msg-sms-provider").selectOption("webhook");
  await page.getByLabel("Provider's address (URL)").fill("https://sms.example.in/send");
  await page.getByLabel("Signing secret").fill("sms-e2e-signing-secret");
  await page.getByLabel("Sender id (DLT header)").fill("joshid");
  await page.getByLabel("DLT template id: reminder in English").fill("1207161234567890123");
  await page.getByLabel("DLT template id: reminder in Hindi").fill("1207161234567890456");
  await card.getByRole("button", { name: "Save" }).click();
  await toast("Settings saved");
  await page.getByLabel("Meta app secret").fill("e2e-meta-app-secret");
  await card.getByRole("button", { name: "Save" }).click();
  await toast("Settings saved");
  const settings = await api("GET", "/messaging/settings", token);
  if (settings.whatsapp.templateLanguageHi !== "hi") errors.push(`Hindi template language: ${settings.whatsapp.templateLanguageHi}`);
  if (settings.sms.senderId !== "JOSHID" || !settings.sms.hasSecret || settings.sms.reminderTemplateHi !== "1207161234567890456") errors.push(`sms settings: ${JSON.stringify(settings.sms)}`);
  if ((await page.content()).includes("sms-e2e-signing-secret")) errors.push("SMS secret visible in the page");
  const callbackUrl = await page.getByLabel("Callback URL").inputValue();
  await card.screenshot({ path: `${OUT}/auto-reminders-1-settings.png` });
  log("WhatsApp Business (templates also in Hindi) and the SMS gateway set up; the SMS secret is not shown");

  // 3. Reminder rules: payment reminders are off until turned on; orders waiting is looked at every hour.
  await rules();
  const reminders = page.locator('[data-rule="customer_reminders"]');
  await reminders.getByText("Off until you turn it on: it writes to your customers.", { exact: false }).waitFor({ timeout: 15000 });
  const waiting = page.locator('[data-rule="orders_waiting"]');
  await waiting.getByText("Every hour from then").waitFor();
  if ((await waiting.getByLabel("Orders waiting too long: After").inputValue()) !== "4") errors.push("orders waiting: not 4 hours by default");
  await reminders.getByRole("checkbox", { name: "On" }).check();
  await toast("Reminder rule saved");
  await reminders.getByLabel("Payment reminders to customers: First reminder").selectOption("3");
  await toast("Reminder rule saved");
  const due = reminders.getByRole("region", { name: "Due a reminder today" });
  await due.getByText("Sharma Kirana").waitFor({ timeout: 15000 });
  await due.getByText("Gupta Stores").waitFor();
  const vermaRow = due.locator("li").filter({ hasText: "Verma General" });
  await vermaRow.getByText("No WhatsApp, SMS or email").waitFor();
  if (!(await due.locator("li").filter({ hasText: "Sharma Kirana" }).innerText()).includes("overdue for 8 days · 0 sent so far")) errors.push(`due line: ${await due.locator("li").first().innerText()}`);
  await reminders.screenshot({ path: `${OUT}/auto-reminders-2-rule.png` });
  log("turned on (first reminder 3 days after the bill fell due): Sharma and Gupta are due one today; Verma cannot be reached");

  // 4. Send now, asked first.
  await reminders.getByRole("button", { name: "Send now" }).click();
  const confirm = page.getByRole("dialog", { name: "Send now" });
  await confirm.getByText("Today's scheduled run then sends nothing more.", { exact: false }).waitFor();
  await confirm.getByRole("button", { name: "Send now" }).click();
  await toast(/Payment reminders sent to 2 customers/);
  await toast("Due but not reached: 1");
  // Sent today: not due again today; Verma still is, and still cannot be reached.
  await due.getByText("Sharma Kirana").waitFor({ state: "detached", timeout: 15000 });
  if (await due.getByText("Gupta Stores").count()) errors.push("Gupta Stores still listed as due after the reminder went");
  await vermaRow.getByText("No WhatsApp, SMS or email").waitFor();
  log("sent now: 2 reminders, 1 customer could not be reached (still listed, as due but unreachable)");

  // 5. Messages: marked Automatic; Gupta's in Hindi with the Hindi template.
  let sent = [];
  for (let i = 0; i < 30; i++) {
    sent = (await api("GET", "/messages?kind=reminder", token)).data;
    if (sent.length === 2 && sent.every((m) => m.status === "sent")) break;
    await page.waitForTimeout(300);
  }
  const byName = Object.fromEntries(sent.map((m) => [m.partyName, m]));
  if (!byName["Sharma Kirana"]?.automatic || byName["Sharma Kirana"].channel !== "whatsapp" || !byName["Sharma Kirana"].body.includes("Reply STOP")) errors.push(`Sharma's reminder: ${JSON.stringify(byName["Sharma Kirana"])}`);
  if (!byName["Gupta Stores"]?.automatic || !byName["Gupta Stores"].body.startsWith("नमस्ते Gupta Stores") || !byName["Gupta Stores"].body.includes("STOP लिखकर भेजें")) errors.push(`Gupta's reminder: ${JSON.stringify(byName["Gupta Stores"])}`);
  await nav("Messages");
  const sharmaRow = page.getByRole("button", { name: /Sharma Kirana · Payment reminder/ });
  await sharmaRow.waitFor({ timeout: 15000 });
  if (!(await sharmaRow.innerText()).includes("Automatic")) errors.push("not marked Automatic in Messages");
  // Nothing went by SMS: the channel filter has it, and lists none.
  await page.getByLabel("Send by").first().selectOption("sms");
  await page.getByText("Nothing sent yet.").waitFor({ timeout: 15000 });
  await page.getByLabel("Send by").first().selectOption("");
  await page.getByRole("button", { name: /Gupta Stores · Payment reminder/ }).click();
  await page.screenshot({ path: `${OUT}/auto-reminders-3-messages.png` });
  log("in Messages, marked Automatic; Gupta's went in Hindi");

  // 6. A customer's page: no payment reminders.
  await openCustomer("Gupta Stores");
  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit customer" });
  if ((await edit.getByLabel("Messages in").inputValue()) !== "hi") errors.push("the customer's language is not shown as Hindi");
  await edit.getByRole("checkbox", { name: "No payment reminders" }).check();
  await edit.getByRole("button", { name: "Save" }).click();
  await toast("Customer updated");
  await page.getByText("Payment reminders stopped").waitFor({ timeout: 15000 });
  await page.getByText(/^Stopped on \d{2}\/\d{2}\/\d{4}$/).waitFor();
  const guptaNow = await api("GET", `/customers/${gupta.id}`, token);
  if (!guptaNow.remindersOptOut || guptaNow.remindersOptOutBy !== "staff") errors.push(`opt-out: ${JSON.stringify({ o: guptaNow.remindersOptOut, by: guptaNow.remindersOptOutBy })}`);
  await page.screenshot({ path: `${OUT}/auto-reminders-4-customer.png` });
  // The reminders sent by hand leave them out too.
  await nav("Messages");
  await page.getByRole("tab", { name: "Payment reminders" }).click();
  const guptaReminder = page.getByRole("row", { name: /Gupta Stores/ });
  await guptaReminder.getByText("No reminders").waitFor({ timeout: 15000 });
  if (!(await guptaReminder.getByRole("checkbox").isDisabled())) errors.push("an opted-out customer can still be picked for reminders");
  log("Gupta Stores: no payment reminders (badge on the page, left out of the reminders sent by hand)");

  // 7. Sharma replies STOP on WhatsApp: stopped, and the staff are told.
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "109876543210" }, messages: [{ from: "919826012345", id: `wamid.stop${run}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Band karo" } }] } }] }],
  });
  const res = await fetch(callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "e2e-meta-app-secret").update(body).digest("hex")}` }, body });
  if (res.status !== 200) errors.push(`STOP reply callback ${res.status}`);
  await page.getByRole("banner").getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("dialog", { name: "Notifications" }).getByText("Sharma Kirana asked to stop payment reminders (replied STOP on WhatsApp)").click({ timeout: 15000 });
  await page.getByRole("heading", { name: /Sharma Kirana/ }).waitFor({ timeout: 15000 });
  await page.getByText(/^They replied STOP on WhatsApp on \d{2}\/\d{2}\/\d{4}$/).waitFor({ timeout: 15000 });
  log("Sharma replied 'Band karo': reminders stopped, the bell said so and led to the customer");

  // 8. In Hindi, and at phone width.
  await rules();
  await page.getByRole("radio", { name: "हिं" }).first().click();
  await page.locator('[data-rule="customer_reminders"]').getByText("ग्राहकों को भुगतान रिमाइंडर").waitFor();
  await page.locator('[data-rule="orders_waiting"]').getByText("उसके बाद हर घंटे").waitFor();
  await page.screenshot({ path: `${OUT}/auto-reminders-5-hindi.png` });
  await page.getByRole("radio", { name: "EN" }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-rule="customer_reminders"]').getByText("Payment reminders to customers").waitFor();
  for (let i = 0; i < 20 && !(await fits()); i++) await page.waitForTimeout(100);
  if (!(await fits())) errors.push("the reminder rules are wider than a phone screen");
  await page.locator('[data-rule="customer_reminders"]').screenshot({ path: `${OUT}/auto-reminders-6-phone.png` });
  log("the cards read in Hindi and fit a phone screen");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/auto-reminders-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

if (errors.length) {
  console.error("FAILED:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("automatic reminders flow passed");
