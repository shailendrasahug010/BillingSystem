/**
 * End-to-end check of e-invoices and e-way bills without a GSP: sign up ->
 * the firm's GSTIN and address -> e-invoicing turned on in Settings (e-way
 * bills above ₹50,000) -> bills to a registered buyer, one to a buyer with no
 * PIN code, one above ₹50,000 -> GST Reports → E-invoice & e-way bill: the
 * bill without a PIN is held back with the reason, the ready ones download
 * as the IRP's bulk JSON -> the IRN, acknowledgement and signed QR code
 * entered -> the big bill's e-way bill JSON with the vehicle, its number
 * entered -> the invoice prints the IRN, QR code and e-way bill -> the tab
 * on a phone.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/einvoice-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98754${run}`;
const password = "Str0ng-pass!";
const IRN = "a5c12dca80e743321740b001fd70953e8738d109865d28ba4013750f2046f229";
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

/** A GSTIN with its check digit. */
function gstin(first14) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return first14 + chars[(36 - (sum % 36)) % 36];
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const state = { signedIn: false };
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => r.failure()?.errorText !== "net::ERR_ABORTED" && errors.push(`failed ${r.url()} ${r.failure()?.errorText}`));
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");
const download = async (click) => {
  const wait = page.waitForEvent("download");
  await click();
  const file = await wait;
  const path = `${OUT}/${file.suggestedFilename()}`;
  await file.saveAs(path);
  return JSON.parse(readFileSync(path, "utf8"));
};

// 1. Sign up; the firm's GSTIN and address, customers and bills through the API.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Ravi Kumar");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Ravi Distributors");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Ravi/ }).waitFor({ timeout: 15000 });
state.signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
await api("PATCH", "/business", token, { gstin: gstin(`23AAPFR${run.slice(0, 4)}K1Z`), addressLine1: "12 MG Road", city: "Indore", pincode: "452001" });
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const biscuit = (await api("POST", "/products", token, { name: "Parle-G 100g", hsnCode: "190531", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "20000", openingStockCost: "8" })).id;
const sharma = (await api("POST", "/customers", token, { name: "Sharma Kirana", customerType: "b2b", stateCode: "23", gstin: gstin(`23ABCDE${run.slice(0, 4)}F1Z`), addressLine1: "Shop 4, Rajwada", city: "Indore", pincode: "452002" })).id;
const verma = (await api("POST", "/customers", token, { name: "Verma Stores", customerType: "b2b", stateCode: "23", gstin: gstin(`23ABCDV${run.slice(0, 4)}F1Z`), addressLine1: "Palasia", city: "Indore" })).id;
const today = (await api("GET", "/me", token)).today;
const month = today.slice(0, 7);
const bill = async (customerId, qty) => (await api("POST", "/invoices", token, { customerId, lines: [{ productId: biscuit, qty, rate: "10" }] })).invoiceNumber;
const small = await bill(sharma, "100");
const noPin = await bill(verma, "10");
const big = await bill(sharma, "6000");
log("bills:", small, noPin, big);

// 2. E-invoicing turned on in Settings.
await nav("Settings");
await page.getByRole("radiogroup", { name: "E-invoicing" }).getByRole("radio", { name: "We e-invoice" }).click();
await toast("Settings saved");
check((await page.getByLabel("E-way bill above").inputValue()) === "50000", "e-way bill limit ₹50,000 by default");
log("e-invoicing on; e-way bills above ₹50,000");

// 3. The month's e-invoices: the one without a PIN held back, the ready ones downloaded.
await nav("GST Reports");
await page.getByLabel("Period").fill(month);
await page.getByRole("tab", { name: "E-invoice & e-way bill" }).click();
const einv = page.getByRole("heading", { name: "E-invoice (IRN)" }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
const nopinRow = einv.getByRole("row").filter({ hasText: noPin });
await nopinRow.getByText("The buyer's PIN code is missing").waitFor({ timeout: 15000 });
await nopinRow.getByText("Fix first").waitFor();
check(await nopinRow.getByRole("checkbox").isDisabled(), "a bill the portal would refuse cannot be picked");
await einv.getByRole("button", { name: "Pick all 2 ready" }).click();
const docs = await download(() => einv.getByRole("button", { name: "Download JSON (2)" }).click());
check(Array.isArray(docs) && docs.length === 2 && docs.map((d) => d.DocDtls.No).sort().join() === [small, big].sort().join(), `IRP bulk JSON: ${JSON.stringify(docs.map((d) => d.DocDtls))}`);
check(docs.find((d) => d.DocDtls.No === small).ValDtls.TotInvVal === 1050, "invoice value in the JSON");
await page.screenshot({ path: `${OUT}/einvoice-1-tab.png`, fullPage: true });
log("e-invoice JSON for", docs.length, "bills; the one without a PIN held back");

// 4. The IRN the portal returned.
await einv.getByRole("row").filter({ hasText: small }).getByRole("button", { name: "Enter IRN" }).click();
await page.fill("#irn-irn", IRN);
await page.fill("#irn-ack", "112010036556789");
await page.fill("#irn-date", `${today}T14:05`);
await page.fill("#irn-qr", "eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoie1wiU2VsbGVyR3N0aW5cIjpcIjIzQUFQRlJcIn0ifQ.c2lnbmF0dXJl");
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await toast("IRN saved");
await einv.getByRole("row").filter({ hasText: small }).getByText("IRN received").waitFor({ timeout: 15000 });
log("IRN entered");

// 5. The big bill's e-way bill with the vehicle; its number entered.
const ewb = page.getByRole("heading", { name: "E-way bill", exact: true }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
await ewb.getByRole("row").filter({ hasText: big }).waitFor();
check((await ewb.getByRole("row").filter({ hasText: small }).count()) === 0, "bills under ₹50,000 are not listed");
await page.fill("#ewb-vehicle", "mp09ab1234");
await ewb.getByRole("row").filter({ hasText: big }).getByRole("checkbox").check();
const ewbFile = await download(() => ewb.getByRole("button", { name: "Download JSON (1)" }).click());
check(ewbFile.version === "1.0.0621" && ewbFile.billLists[0].docNo === big && ewbFile.billLists[0].vehicleNo === "MP09AB1234" && ewbFile.billLists[0].totInvValue === 63000, `e-way bill JSON: ${JSON.stringify(ewbFile).slice(0, 300)}`);
await ewb.getByRole("row").filter({ hasText: big }).getByRole("button", { name: "Enter e-way bill no." }).click();
await page.fill("#ewb-number", "331001234567");
await page.fill("#ewb-date", `${today}T15:00`);
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await toast("E-way bill saved");
await ewb.getByText("331001234567").waitFor({ timeout: 15000 });
log("e-way bill JSON with the vehicle; number entered");

// 6. The invoice prints the IRN and its QR code.
await page.keyboard.press("Control+k");
await page.keyboard.type(small);
await dialog().getByRole("button", { name: new RegExp(small.replaceAll("/", "\\/")) }).first().click();
const doc = page.locator("article").first();
await doc.getByText(`IRN: ${IRN}`).waitFor({ timeout: 15000 });
await doc.getByText(`Ack. no. 112010036556789`).waitFor();
await doc.getByRole("img", { name: "E-invoice QR code" }).waitFor();
await page.getByRole("region", { name: "E-invoice and e-way bill" }).getByRole("button", { name: "Change IRN" }).waitFor();
await page.screenshot({ path: `${OUT}/einvoice-2-invoice.png`, fullPage: true });
log("invoice prints the IRN and QR code");

// 7. The tab on a phone.
await nav("GST Reports");
await page.getByRole("tab", { name: "E-invoice & e-way bill" }).click();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
await page.screenshot({ path: `${OUT}/einvoice-3-phone.png`, fullPage: true });

await browser.close();
if (errors.length) {
  console.error("errors:", errors);
  process.exit(1);
}
log("e-invoice and e-way bill flow passed");
