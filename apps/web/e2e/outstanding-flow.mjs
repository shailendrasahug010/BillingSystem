/**
 * End-to-end check of Outstanding (money to collect): an owner with customers
 * in Dewas, Ujjain and one without a city -> a salesman collecting on his
 * phone opens Outstanding from the menu -> a chip per city with its total ->
 * Dewas narrows the list (Dewas and DEWAS are one place) -> search and "only
 * overdue" -> a customer opens with the open bills, days late, the last
 * payments, Call and WhatsApp -> he takes a payment there and the dues drop
 * -> the Dewas list downloads as PDF and Excel and prints with a "Collected"
 * column -> without a connection the list still shows from the phone ->
 * the owner sees the table on the desktop and opens the customer -> a
 * warehouse worker has no Outstanding.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/outstanding-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98767${run}`;
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

const errors = [];
function watch(page, state) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && !m.text().includes("ERR_INTERNET_DISCONNECTED") && errors.push(m.text()));
  page.on("response", (r) => {
    if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}
async function signIn(page, state, id, pass) {
  await page.goto(WEB);
  await page.fill("#auth-id", id);
  await page.fill("#auth-password", pass);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading").first().waitFor({ timeout: 15000 });
  state.signedIn = true;
}

// 1. The owner, a salesman who collects, and customers who owe money.
const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
await api("POST", "/auth/signup", null, { name: "Ramesh Agrawal", mobile, password, otp: otp.devCode, preferredLocale: "en", business: { legalName: "Agrawal Distributors", stateCode: "23", city: "Indore" } });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "70" });
const route = await api("POST", "/routes", token, { name: "Dewas Road" });
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(today) - n * 86400_000).toISOString().slice(0, 10);
const gupta = await api("POST", "/customers", token, { name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", stateCode: "23", creditDays: 15, routeId: route.id });
await api("POST", "/invoices", token, { customerId: gupta.id, invoiceDate: daysAgo(40), lines: [{ productId: soap.id, qty: "10" }] }); // 1,180, due 25 days ago
await api("POST", "/invoices", token, { customerId: gupta.id, lines: [{ productId: soap.id, qty: "5" }] }); // 590, not due
await api("POST", "/payments", token, { direction: "in", customerId: gupta.id, amount: "200", method: "cash" });
const sharma = await api("POST", "/customers", token, { name: "Sharma Stores", mobile: "9826033333", city: "DEWAS", stateCode: "23", openingBalance: "750" });
const verma = await api("POST", "/customers", token, { name: "Verma Traders", mobile: "9826044444", city: "Ujjain", stateCode: "23" });
await api("POST", "/invoices", token, { customerId: verma.id, invoiceDate: daysAgo(10), lines: [{ productId: soap.id, qty: "20" }] }); // 2,360, overdue
const corner = await api("POST", "/customers", token, { name: "Corner Shop", stateCode: "23" });
await api("POST", "/invoices", token, { customerId: corner.id, lines: [{ productId: soap.id, qty: "1" }] }); // 118
const roles = Object.fromEntries((await api("GET", "/roles", token)).data.map((r) => [r.key, r.id]));
await api("POST", "/members", token, { name: "Sonu Sales", mobile: `98766${run}`, roleId: roles.sales, username: `sonu${run}`, password: "Sonu-pass-2026" });
await api("POST", "/members", token, { name: "Pappu Packer", mobile: `98765${run}`, roleId: roles.warehouse, username: `pappu${run}`, password: "Pappu-pass-2026" });
log("owner, salesman, warehouse worker; 4 customers owe 1,570 + 750 + 2,360 + 118");

// 2. The salesman on his phone: Outstanding from the menu, a chip per city.
const phone = await (await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})).newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
const browser = phone.browser();
const page = await phone.newPage();
const salesState = { signedIn: false };
watch(page, salesState);
await signIn(page, salesState, `sonu${run}`, "Sonu-pass-2026");
await page.getByRole("button", { name: "More", exact: true }).first().click();
await page.getByRole("dialog").getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Outstanding", exact: true }).click();
await page.getByRole("heading", { name: "Outstanding", exact: true }).waitFor({ timeout: 15000 });
const places = page.getByRole("group", { name: "City" });
await places.getByRole("button", { name: /All places\s*4/ }).waitFor({ timeout: 15000 });
const chips = (await places.getByRole("button").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
const expectChips = ["All places 4 ₹4,798", "Ujjain 1 ₹2,360", "Dewas 2 ₹2,320", "No city 1 ₹118"];
if (JSON.stringify(chips) !== JSON.stringify(expectChips)) errors.push(`chips: ${JSON.stringify(chips)}`);
await page.screenshot({ path: `${OUT}/outstanding-1-phone.png` });
log("phone: chips", chips.join(" | "));

// 3. Dewas only; then search and "only overdue".
const cards = () => page.locator("ul li button:visible").filter({ has: page.locator("p.truncate.font-medium") });
const names = async () => (await cards().locator("p.truncate.font-medium").allInnerTexts()).map((s) => s.trim());
await places.getByRole("button", { name: /^Dewas/ }).click();
await page.waitForTimeout(300);
if (JSON.stringify(await names()) !== JSON.stringify(["Gupta Kirana", "Sharma Stores"])) errors.push(`Dewas list: ${await names()}`);
await page.getByLabel("To collect").getByText("₹2,320").first().waitFor();
await page.getByRole("button", { name: "Only overdue" }).click();
if (JSON.stringify(await names()) !== JSON.stringify(["Gupta Kirana"])) errors.push(`Dewas overdue: ${await names()}`);
await page.getByRole("button", { name: "Only overdue" }).click();
await places.getByRole("button", { name: /^All places/ }).click();
await page.getByLabel("Search name, mobile or code").fill("44444");
if (JSON.stringify(await names()) !== JSON.stringify(["Verma Traders"])) errors.push(`search by mobile: ${await names()}`);
await page.getByLabel("Search name, mobile or code").fill("");
await places.getByRole("button", { name: /^Dewas/ }).click();
await page.screenshot({ path: `${OUT}/outstanding-2-dewas.png` });
log("Dewas narrows to its 2 customers (Dewas and DEWAS); overdue and search filter");

// 4. One customer: bills, days late, payments, and a payment taken there.
await cards().filter({ hasText: "Gupta Kirana" }).click();
const sheet = page.getByRole("dialog");
await sheet.getByRole("heading", { name: "Gupta Kirana" }).waitFor();
await sheet.getByText("25 days late").waitFor({ timeout: 15000 });
for (const s of ["Open bills", "Recent payments", "15 days credit", "₹1,570.00", "₹980.00", "₹590.00"]) {
  if ((await sheet.getByText(s, { exact: false }).count()) === 0) errors.push(`sheet lacks ${s}`);
}
if (!(await sheet.getByRole("button", { name: "Call" }).isEnabled()) || !(await sheet.getByRole("button", { name: "WhatsApp reminder" }).isEnabled())) errors.push("call / WhatsApp");
await page.screenshot({ path: `${OUT}/outstanding-3-sheet.png` });
await sheet.getByRole("button", { name: "Receive payment" }).click();
await page.fill("#pay-amount", "1000");
await page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
await page.getByText("Payment saved").first().waitFor({ timeout: 15000 });
await page.getByRole("dialog").getByRole("heading", { name: "Gupta Kirana" }).waitFor();
await page.getByRole("dialog").getByText("₹570.00").first().waitFor({ timeout: 15000 });
if ((await page.getByRole("dialog").getByText("days late").count()) !== 0) errors.push("still overdue after paying the old bill");
await page.keyboard.press("Escape");
await page.getByLabel("To collect").getByText("₹1,320").first().waitFor({ timeout: 15000 });
log("sheet: bills, 25 days late, last payments; ₹1,000 taken there, Dewas now ₹1,320");

// 5. Downloads (the sales role may export this list) and print.
let download = page.waitForEvent("download");
await page.getByRole("button", { name: "PDF", exact: true }).click();
let file = await download;
if (file.suggestedFilename() !== `outstanding-dewas-${today}.pdf`) errors.push(`pdf name ${file.suggestedFilename()}`);
if (readFileSync(await file.path()).subarray(0, 5).toString() !== "%PDF-") errors.push("not a PDF");
download = page.waitForEvent("download");
await page.getByRole("button", { name: "Excel", exact: true }).click();
file = await download;
if (file.suggestedFilename() !== `outstanding-dewas-${today}.xlsx`) errors.push(`xlsx name ${file.suggestedFilename()}`);
const printed = await page.locator(".print-root").textContent();
for (const s of ["Outstanding · Dewas", "Collected", "Collector's signature", "Gupta Kirana", "Sharma Stores", "Total · 2 customers"]) if (!printed.includes(s)) errors.push(`print lacks ${s}`);
if (printed.includes("Verma")) errors.push("print has another city");
await page.emulateMedia({ media: "print" });
await page.screenshot({ path: `${OUT}/outstanding-4-print.png`, fullPage: true });
await page.emulateMedia({ media: "screen" });
const audit = (await api("GET", "/audit-logs?action=outstanding.exported", token)).data;
if (audit.length !== 2) errors.push(`audit: ${audit.length} downloads noted`);
log("Dewas list downloaded as PDF and Excel (noted in the audit log); prints with a Collected column");

// 6. No connection: the list still shows, from the phone.
await phone.setOffline(true);
await page.getByText("No connection: amounts from the copy on this device").waitFor({ timeout: 15000 });
// Gupta now owes less than Sharma: the phone's copy has the payment.
if (JSON.stringify(await names()) !== JSON.stringify(["Sharma Stores", "Gupta Kirana"])) errors.push(`offline Dewas list: ${await names()}`);
download = page.waitForEvent("download");
await page.getByRole("button", { name: "CSV", exact: true }).click();
file = await download;
const csv = readFileSync(await file.path(), "utf8");
if (!csv.includes("Gupta Kirana") || !csv.includes("Sharma Stores") || csv.includes("Verma")) errors.push(`offline CSV: ${csv}`);
await page.screenshot({ path: `${OUT}/outstanding-5-offline.png` });
await phone.setOffline(false);
log("offline: Dewas list from the phone, CSV download");

// 7. The owner at the desk: the table, a row opens, then the customer.
const desk = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const ownerState = { signedIn: false };
watch(desk, ownerState);
await signIn(desk, ownerState, mobile, password);
await desk.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Outstanding", exact: true }).click();
const table = desk.locator("table:visible");
await table.getByRole("row", { name: /Verma Traders/ }).waitFor({ timeout: 15000 });
const rows = await table.locator("tbody tr").allInnerTexts();
if (rows.length !== 4 || !rows[0].includes("Verma Traders") || !rows[0].includes("10 days late")) errors.push(`desk rows: ${JSON.stringify(rows)}`);
const foot = await table.locator("tfoot").innerText();
if (!foot.includes("4 customers") || !foot.includes("₹3,798")) errors.push(`desk total: ${foot}`);
await desk.screenshot({ path: `${OUT}/outstanding-6-desk.png`, fullPage: true });
await table.getByRole("row", { name: /Sharma Stores/ }).click();
const dlg = desk.getByRole("dialog");
await dlg.getByText("Opening balance / other").waitFor({ timeout: 15000 });
await desk.screenshot({ path: `${OUT}/outstanding-7-desk-detail.png` });
await dlg.getByRole("button", { name: "Open customer" }).click();
await desk.getByRole("heading", { name: "Sharma Stores" }).waitFor({ timeout: 15000 });
log("desk: table of 4 (₹3,798), Sharma's opening balance, opens the customer");

// 8. A warehouse worker has no Outstanding.
const packer = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const packerState = { signedIn: false };
watch(packer, packerState);
await signIn(packer, packerState, `pappu${run}`, "Pappu-pass-2026");
const menu = await packer.getByRole("navigation", { name: "Main" }).getByRole("button").allTextContents();
if (menu.some((m) => m.includes("Outstanding"))) errors.push(`warehouse menu: ${menu.join(", ")}`);
await packer.goto(`${WEB}/#outstanding`);
await packer.getByText("Not part of your role").waitFor({ timeout: 15000 });
log("warehouse: no Outstanding in the menu; the link says not part of the role");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
