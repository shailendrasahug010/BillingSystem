/**
 * End-to-end check of exports and supplies to SEZ: sign up -> the LUT saved
 * in Settings -> a buyer abroad (Export) and an SEZ unit added in the
 * customer form -> an export billed under the LUT (no IGST) with its
 * shipping bill number -> the invoice shows the declaration and the LUT, and
 * the shipping bill date is added later; the invoice on a phone -> the SEZ unit billed with payment
 * of IGST -> GSTR-1 shows the EXP table and GSTR-3B row 3.1(b).
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/export-sez-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98757${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);
const check = (ok, what) => {
  if (!ok) throw new Error(`check failed: ${what}`);
};

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

/** A GSTIN's last character (its check digit). */
function gstinCheck(first14) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return chars[(36 - (sum % 36)) % 36];
}
const SEZ_GSTIN = `27AABCS${run.slice(0, 4)}B1Z`;
const sezGstin = SEZ_GSTIN + gstinCheck(SEZ_GSTIN);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const state = { signedIn: false };
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => r.failure()?.errorText !== "net::ERR_ABORTED" && errors.push(`failed ${r.url()} ${r.failure()?.errorText}`));
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });

// 1. Sign up; a product through the API.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Farhan Qureshi");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Qureshi Exports");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Farhan/ }).waitFor({ timeout: 15000 });
state.signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
await api("POST", "/products", token, { name: "Basmati Rice 5kg", hsnCode: "1006", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "70" });
log("signed up; a product added");

// 2. The LUT in Settings.
await nav("Settings");
const arn = `AD23032600${run}`;
await page.locator("#lut-arn").waitFor({ timeout: 15000 });
await page.fill("#lut-arn", arn);
check((await page.inputValue("#lut-until")).endsWith("-03-31"), "LUT valid until defaults to the financial year's end");
await page.locator("#lut-arn").locator("xpath=ancestor::div[contains(@class,'border-b')][1]").getByRole("button", { name: "Save", exact: true }).click();
await toast("Settings saved");
check((await api("GET", "/settings", token))["gst.lut"]?.arn === arn, "LUT stored");
log("LUT saved:", arn);

// 3. An export buyer and an SEZ unit from the customer form.
await nav("Customers");
await page.getByRole("button", { name: "Add customer" }).click();
let dialog = page.getByRole("dialog");
await dialog.getByRole("radio", { name: "Export" }).click();
await dialog.getByText(/A buyer outside India/).waitFor();
check((await dialog.locator("#c-state").count()) === 0 && (await dialog.locator("#c-pin").count()) === 0 && (await dialog.locator("#c-gstin").count()) === 0, "no state, PIN code or GSTIN for a buyer abroad");
await page.fill("#c-business", "Gulf Traders LLC");
await page.fill("#c-mobile", `98260${run}`);
await page.screenshot({ path: `${OUT}/export-1-customer-form.png` });
await dialog.getByRole("button", { name: "Save", exact: true }).click();
// Saved when the form closes (a "Customer saved" toast can still be the one before).
await dialog.waitFor({ state: "detached", timeout: 15000 });
await toast("Customer saved");
await page.getByRole("button", { name: "Add customer" }).click();
dialog = page.getByRole("dialog");
await dialog.getByRole("radio", { name: "SEZ" }).click();
await dialog.getByText(/Special Economic Zone/).waitFor();
await page.fill("#c-business", "Pune SEZ Unit");
await page.fill("#c-mobile", `98261${run}`);
await page.fill("#c-gstin", sezGstin);
check((await page.inputValue("#c-state")) === "27", "state filled from the SEZ unit's GSTIN");
await dialog.getByRole("button", { name: "Save", exact: true }).click();
await dialog.waitFor({ state: "detached", timeout: 15000 });
const customers = (await api("GET", "/customers?q=", token)).data;
const gulf = customers.find((c) => c.name === "Gulf Traders LLC");
const sez = customers.find((c) => c.name === "Pune SEZ Unit");
check(gulf?.gstRegistration === "overseas" && gulf.stateCode === "96", `export buyer stored as overseas in 96: ${JSON.stringify(gulf)}`);
check(sez?.gstRegistration === "sez" && sez.gstin === sezGstin, `SEZ unit stored: ${JSON.stringify(sez)}`);
log("customers:", gulf.name, gulf.gstRegistration, gulf.stateCode, "·", sez.name, sez.gstRegistration, sez.gstin);

// 4. An export under the LUT, with the shipping bill number and port.
async function startBill(customer) {
  await page.goto(`${WEB}/#invoice`);
  await page.reload();
  const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
  await customerBox.waitFor({ timeout: 15000 });
  await customerBox.fill(customer);
  await page.keyboard.press("Enter");
  const productBox = page.getByPlaceholder(/Search product/);
  await productBox.fill("basmati");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  return page.locator("aside[aria-label='Bill summary']");
}
let summary = await startBill("Gulf");
await summary.getByText("Export · Inter-state supply · IGST").waitFor({ timeout: 15000 });
check(await summary.getByRole("radio", { name: "Under LUT / bond, no IGST" }).isChecked(), "under LUT by default while the LUT is valid");
await summary.getByText(`LUT ${arn}, valid till`).waitFor();
await summary.getByText("Foreign Country").waitFor();
await page.fill("#sb-number", "7894561");
await page.fill("#sb-port", "innsa1");
check((await page.inputValue("#sb-port")) === "INNSA1", "port code in capitals");
let text = (await summary.innerText()).replace(/\s+/g, " ");
check(/IGST ₹0\.00/.test(text) && /Grand total ₹100\.00/i.test(text), `no IGST under the LUT: ${text.slice(0, 400)}`);
// Paying IGST instead puts it on the bill, and back.
await summary.getByRole("radio", { name: "With payment of IGST" }).click();
await summary.getByText("₹118.00").first().waitFor();
await summary.getByRole("radio", { name: "Under LUT / bond, no IGST" }).click();
await summary.getByText("₹100.00").first().waitFor();
await page.screenshot({ path: `${OUT}/export-2-invoice-draft.png` });
await page.getByRole("button", { name: "Save invoice" }).click();
await toast(/Invoice INV\/\d\d-\d\d\/00001 saved/);
const exp = (await api("GET", "/invoices", token)).data.find((i) => i.partyName === "Gulf Traders LLC");
const expDetail = await api("GET", `/invoices/${exp.id}`, token);
check(expDetail.zeroRatedType === "EXPWOP" && expDetail.igstTotal === "0.00" && expDetail.lutArn === arn && expDetail.shippingBillNumber === "7894561" && expDetail.portCode === "INNSA1" && expDetail.placeOfSupply === "96", `export stored: ${JSON.stringify({ ...expDetail, items: undefined, seller: undefined })}`);
log("export saved:", expDetail.invoiceNumber, expDetail.zeroRatedType, "IGST", expDetail.igstTotal, "LUT", expDetail.lutArn);

// 5. The invoice: declaration, LUT, shipping bill; the date added later.
await page.getByRole("button", { name: "Details" }).click();
await page.getByRole("heading", { name: expDetail.invoiceNumber }).waitFor({ timeout: 15000 });
await page.getByText("Export · under LUT").first().waitFor();
const doc = page.locator("article").first();
await doc.getByText("SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX").waitFor();
await doc.getByText(`Under LUT, ARN ${arn}`).waitFor();
const card = page.getByRole("region", { name: "Shipping bill" });
await card.getByText("7894561 · INNSA1").waitFor();
await card.getByRole("button", { name: "Change shipping bill" }).click();
dialog = page.getByRole("dialog");
await page.fill("#sbd-date", "2020-01-01");
await dialog.getByRole("button", { name: "Save", exact: true }).click();
await dialog.getByText(/before the invoice/i).waitFor();
errors.splice(errors.findIndex((e) => e.startsWith("400 PATCH")), 1);
await page.fill("#sbd-date", expDetail.invoiceDate);
await dialog.getByRole("button", { name: "Save", exact: true }).click();
await toast("Shipping bill saved");
const [y, m, d] = expDetail.invoiceDate.split("-");
await doc.getByText(`Shipping bill 7894561 · ${d}/${m}/${y} · INNSA1`).waitFor();
await page.screenshot({ path: `${OUT}/export-3-invoice-view.png`, fullPage: true });
log("invoice shows the declaration, LUT and shipping bill; date added later");
// The same invoice on a phone.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
await page.screenshot({ path: `${OUT}/export-5-phone.png`, fullPage: true });
await page.setViewportSize({ width: 1360, height: 900 });
log("phone view fits");

// 6. The SEZ unit billed with payment of IGST.
summary = await startBill("Pune SEZ");
await summary.getByText("Supply to an SEZ unit · Inter-state supply · IGST").waitFor({ timeout: 15000 });
check((await page.locator("#sb-number").count()) === 0, "no shipping bill for an SEZ supply");
await summary.getByRole("radio", { name: "With payment of IGST" }).click();
await summary.getByText("₹118.00").first().waitFor();
await page.getByRole("button", { name: "Save invoice" }).click();
await toast(/Invoice INV\/\d\d-\d\d\/00002 saved/);
await page.getByRole("button", { name: "Details" }).click();
await page.getByText("SEZ · with IGST").first().waitFor({ timeout: 15000 });
await page.locator("article").first().getByText("SUPPLY TO SEZ UNIT / DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX").waitFor();
check((await page.getByRole("region", { name: "Shipping bill" }).count()) === 0, "no shipping bill card on an SEZ invoice");
log("SEZ invoice saved with IGST");

// 7. GSTR-1: EXP table and SEZ in B2B; GSTR-3B 3.1(b).
await nav("GST Reports");
await page.getByRole("tab", { name: "GSTR-1" }).click();
const panel = page.getByRole("tabpanel");
const expRow = panel.getByRole("row").filter({ hasText: "6A · Exports" });
await expRow.waitFor({ timeout: 15000 });
text = (await expRow.innerText()).replace(/\s+/g, " ");
check(/\b1\b/.test(text) && text.includes("100.00"), `EXP row: ${text}`);
const b2bRow = panel.getByRole("row").filter({ hasText: "4A, 6B" });
text = (await b2bRow.innerText()).replace(/\s+/g, " ");
check(text.includes("18.00"), `B2B row carries the SEZ invoice's IGST: ${text}`);
await panel.getByLabel("CSV table").selectOption("exp");
await page.screenshot({ path: `${OUT}/export-4-gstr1.png`, fullPage: true });
await page.getByRole("tab", { name: "GSTR-3B" }).click();
const zeroRow = page.getByRole("tabpanel").getByRole("row").filter({ hasText: "(b) Zero-rated" });
await zeroRow.waitFor({ timeout: 15000 });
text = (await zeroRow.innerText()).replace(/\s+/g, " ");
check(text.includes("200.00") && text.includes("18.00"), `3.1(b): ${text}`);
log("GSTR-1 EXP and B2B rows, GSTR-3B 3.1(b):", text);

await browser.close();
if (errors.length) {
  console.error("errors:", errors);
  process.exit(1);
}
log("export and SEZ flow passed");
