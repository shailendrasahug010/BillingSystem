/**
 * End-to-end check of Backup & Restore: sign up -> a customer, a product and
 * a bill -> Backup & Restore: download a backup, then one protected with a
 * password -> both listed -> automatic backups turned on (weekly, emailed
 * with a password) -> Restore: the protected file is checked (firm,
 * date, what is in it), then (with the owner's own password typed again)
 * restored as a NEW business the app switches to,
 * with the bill in it; the original business is still there.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/backup-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98771${String(Date.now()).slice(-5)}`;
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
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const errors = [];
let signedIn = false;
// The first check of the protected file is refused on purpose (no password yet).
let passwordRefusal = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (passwordRefusal && r.status() === 400 && r.url().includes("/backups/restore?dryRun=true")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 20000 });

// 1. Sign up and a bill.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kamla Devi");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Devi Provision Stores");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Kamla/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const product = await api("POST", "/products", token, { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "60", openingStockCost: "130" });
const shop = await api("POST", "/customers", token, { name: "Gupta Kirana", stateCode: "23" });
const inv = await api("POST", "/invoices", token, { customerId: shop.id, lines: [{ productId: product.id, qty: "6" }] });
log("bill", inv.invoiceNumber, inv.grandTotal);

// 2. Backups: plain and with a password.
await page.reload();
await nav("Backup & Restore");
await page.getByRole("heading", { name: "Download a backup" }).waitFor({ timeout: 15000 });
let download = page.waitForEvent("download");
await page.getByRole("button", { name: "Download backup" }).click();
let file = await download;
const plainPath = join(OUT, `plain-${file.suggestedFilename()}`);
await file.saveAs(plainPath);
if (!/^digital-bahi-devi-provision-stores-\d{4}-\d{2}-\d{2}\.dbbackup$/.test(file.suggestedFilename())) errors.push(`backup name ${file.suggestedFilename()}`);
if (readFileSync(plainPath).subarray(0, 4).toString() !== "DBBK") errors.push("not a backup file");
await toast("Backup downloaded");
await page.getByLabel("Password for the file", { exact: true }).first().fill("devi-stores-2026");
download = page.waitForEvent("download");
await page.getByRole("button", { name: "Download backup" }).click();
file = await download;
const lockedPath = join(OUT, `locked-${file.suggestedFilename()}`);
await file.saveAs(lockedPath);
if (readFileSync(lockedPath)[5] !== 1) errors.push("password backup not encrypted");
await page.getByRole("row", { name: /Downloaded\s*Password/ }).waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/backup-1-download.png`, fullPage: true });
log("two backups downloaded (one with a password) and listed");

// 3. Automatic backups: every Sunday at 9 pm, emailed with a password.
await page.getByRole("heading", { name: "Automatic backups" }).waitFor();
await page.getByRole("radio", { name: "Every week" }).click();
await page.selectOption("#auto-day", { label: "Sunday" });
if ((await page.locator("#auto-hour").inputValue()) !== "21") errors.push("default time is not 9 pm");
await page.fill("#auto-to", "backups@devi.example");
if (!(await page.getByRole("button", { name: "Save schedule" }).isDisabled())) errors.push("schedule saved without a password");
await page.fill("#auto-password", "devi-auto-2026");
await page.getByRole("button", { name: "Save schedule" }).click();
await toast("Automatic backups are on");
await page.getByText(/^Next backup: /).first().waitFor();
const auto = await api("GET", "/backups/schedule", token);
if (auto.frequency !== "weekly" || auto.weekday !== 0 || auto.hour !== 21 || auto.to !== "backups@devi.example" || !auto.hasPassword || new Date(auto.nextRunAt).getUTCDay() !== 0) errors.push(`schedule: ${JSON.stringify(auto)}`);
await page.screenshot({ path: `${OUT}/backup-auto.png`, fullPage: true });
log("automatic backups on:", auto.frequency, "next", auto.nextRunAt);

// 4. Restore the protected file as a new business.
await page.getByLabel("Backup file (.dbbackup)").setInputFiles(lockedPath);
passwordRefusal = true;
await page.getByRole("button", { name: "Check the file" }).click();
await page.getByText("This backup is protected with a password. Type the password.").waitFor({ timeout: 15000 });
passwordRefusal = false;
await page.getByLabel("The file's password (if it has one)").fill("devi-stores-2026");
await page.getByRole("button", { name: "Check the file" }).click();
await page.getByText(/backup of/).waitFor({ timeout: 15000 });
const summary = await page.getByText(/backup of/).locator("xpath=ancestor::section[1]").innerText();
if (!summary.includes("Devi Provision Stores") || !/Invoices\s*1/.test(summary)) errors.push(`summary: ${summary}`);
await page.getByText(/I understand this creates a new business/).click();
// Restoring needs the person's own password again, even with the session open.
if (!(await page.getByRole("button", { name: "Restore as a new business" }).isDisabled())) errors.push("restore allowed without the account password");
await page.getByLabel("Your Digital Bahi password", { exact: true }).fill(password);
await page.screenshot({ path: `${OUT}/backup-2-restore-check.png`, fullPage: true });
await page.getByRole("button", { name: "Restore as a new business" }).click();
await toast("Restored: Devi Provision Stores (restored)");
await page.getByText("Devi Provision Stores (restored)").first().waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/backup-3-restored.png` });
const businesses = (await api("POST", "/auth/login", null, { identifier: mobile, password })).businesses;
if (businesses.length !== 2) errors.push(`businesses: ${businesses.length}`);
const restored = businesses.find((b) => b.tradeName === "Devi Provision Stores (restored)");
const switched = await api("POST", "/auth/switch-business", token, { businessId: restored.id });
const bills = (await api("GET", "/invoices", switched.accessToken)).data;
if (bills.length !== 1 || bills[0].invoiceNumber !== inv.invoiceNumber || bills[0].grandTotal !== inv.grandTotal) errors.push(`restored bills: ${JSON.stringify(bills)}`);
log("restored as a new business with the bill:", bills.map((b) => `${b.invoiceNumber} ${b.grandTotal}`).join(", "));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
