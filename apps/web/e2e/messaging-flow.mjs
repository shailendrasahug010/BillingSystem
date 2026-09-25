/**
 * End-to-end check of WhatsApp and email: sign up -> Settings: set up the
 * firm's WhatsApp Business number (Meta Cloud API, token saved and hidden)
 * -> an invoice -> Send: WhatsApp Business to the customer's mobile, with the
 * PDF -> Messages: the send is listed with its text -> Payment reminders:
 * the customer with an overdue bill is reminded -> listed as sent.
 *
 * The API must run with MESSAGING_DRIVER=log (the default outside
 * production): messages are recorded, not sent. Run against a database with
 * the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/messaging-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98769${String(Date.now()).slice(-5)}`;
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

// 1. Sign up; a customer with a bill that is past its credit days.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Suresh Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Jain Agencies");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Suresh/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "200", openingStockCost: "28" });
const shop = await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23", creditDays: 7 });
const today = new Date();
const old = new Date(today.getTime() - 12 * 86400000).toISOString().slice(0, 10);
const inv = await api("POST", "/invoices", token, { customerId: shop.id, invoiceDate: old, lines: [{ productId: soap.id, qty: "24" }] });
log("customer with an overdue bill:", inv.invoiceNumber, inv.grandTotal);

// 2. Settings: the firm's WhatsApp Business number.
await page.reload();
await nav("Settings");
await page.getByRole("heading", { name: "WhatsApp & email" }).waitFor({ timeout: 15000 });
await page.getByLabel("WhatsApp provider").selectOption("meta");
await page.getByLabel("Your WhatsApp Business number").fill("+91 98260 00000");
await page.getByLabel("Phone number ID (from Meta)").fill("109876543210");
await page.getByLabel("Access token").fill("EAAG-e2e-secret-token");
await page.getByLabel("Template for bills (with a document header)").fill("bill_with_pdf");
await page.getByLabel("Template for payment reminders").fill("payment_reminder");
const card = page.getByRole("heading", { name: "WhatsApp & email" }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
await card.getByRole("button", { name: "Save" }).click();
await toast("Settings saved");
await page.getByText("Saved. Leave empty to keep it.").waitFor();
if ((await page.getByLabel("Access token").inputValue()) !== "") errors.push("token shown after saving");
if ((await page.content()).includes("EAAG-e2e-secret-token")) errors.push("token visible in the page");
await card.screenshot({ path: `${OUT}/messaging-1-settings.png` });
log("WhatsApp Business set up; token saved and hidden");

// 3. Send the invoice on WhatsApp.
await page.keyboard.press("Control+k");
await page.keyboard.type(inv.invoiceNumber);
await page.getByText(inv.invoiceNumber).first().waitFor({ timeout: 10000 });
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
await page.getByRole("heading", { name: inv.invoiceNumber }).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Send", exact: true }).click();
await dialog().getByText(`The PDF ${inv.invoiceNumber.replace(/\//g, "-")}.pdf goes with the message.`).waitFor();
if ((await dialog().getByLabel("To").inputValue()) !== "9826012345") errors.push("customer's mobile not filled in");
await page.screenshot({ path: `${OUT}/messaging-2-send.png` });
await dialog().getByRole("button", { name: "Send now" }).click();
await toast("Sent to +91 98260 12345");
log("invoice sent on WhatsApp Business");

// 4. Messages: the send is listed.
await nav("Messages");
await page.getByRole("heading", { name: "WhatsApp & email" }).first().waitFor({ timeout: 15000 });
const row = page.getByRole("button", { name: new RegExp(`Sharma Kirana · Invoice ${inv.invoiceNumber.replace(/\//g, "\\/")}`) });
await row.click();
await page.getByText(`📎 ${inv.invoiceNumber.replace(/\//g, "-")}.pdf`).waitFor();
await page.getByText(/Balance due/).first().waitFor();
log("listed as sent, with the message and the PDF");

// 5. Payment reminders.
await page.getByRole("tab", { name: "Payment reminders" }).click();
const reminderRow = page.getByRole("row", { name: /Sharma Kirana/ });
await reminderRow.waitFor({ timeout: 15000 });
await reminderRow.getByRole("checkbox").click();
await page.screenshot({ path: `${OUT}/messaging-3-reminders.png` });
await page.getByRole("button", { name: "Send 1 reminder" }).click();
await toast("1 reminder on its way");
await page.getByRole("tab", { name: "Sent" }).click();
await page.getByRole("button", { name: /Sharma Kirana · Payment reminder/ }).waitFor({ timeout: 15000 });
for (let i = 0; i < 20; i++) {
  const reminders = (await api("GET", "/messages?kind=reminder", token)).data;
  if (reminders[0]?.status === "sent") break;
  await page.waitForTimeout(300);
}
const reminders = (await api("GET", "/messages?kind=reminder", token)).data;
if (reminders[0]?.status !== "sent" || !reminders[0].body.includes("overdue since")) errors.push(`reminder: ${JSON.stringify(reminders[0])}`);
await page.reload();
await nav("Messages");
await page.getByRole("button", { name: /Sharma Kirana · Payment reminder/ }).click();
await page.screenshot({ path: `${OUT}/messaging-4-sent.png` });
log("reminder sent:", reminders[0]?.body);

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
