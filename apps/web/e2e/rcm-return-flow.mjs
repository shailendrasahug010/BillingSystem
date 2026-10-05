/**
 * End-to-end check of a return against a reverse-charge purchase: sign up ->
 * a supplier and a reverse-charge bill of 100 kg at ₹50 (through the API;
 * GST ₹125 + ₹125 paid by us, not the supplier) -> the purchase screen offers
 * a return and says how reverse charge is handled -> 20 kg returned from the
 * screen: ₹1,000 back from the supplier, no GST on it -> the debit note
 * shows its GST apart from the total -> GSTR-3B 3.1(d) and ITC 4A(3) drop to
 * ₹4,000 / ₹100 + ₹100 -> the purchase on a phone.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/rcm-return-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98755${run}`;
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
const dialog = () => page.getByRole("dialog");

// 1. Sign up; a reverse-charge purchase through the API.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Irfan Sheikh");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Sheikh Dry Fruits");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Irfan/ }).waitFor({ timeout: 15000 });
state.signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
await api("PATCH", "/business", token, { gstin: gstin(`23AAPFS${run.slice(0, 4)}K1Z`) });
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const cashew = (await api("POST", "/products", token, { name: "Cashew kernels", hsnCode: "0801", taxCategoryId: taxes["GST 5%"], baseUnitId: units.KG ?? units.PCS, sellingPrice: "60" })).id;
const supplier = (await api("POST", "/suppliers", token, { name: "Konkan Growers", stateCode: "23", gstin: gstin(`23AAFFK${run.slice(0, 4)}L1Z`) })).id;
const today = (await api("GET", "/me", token)).today;
const month = today.slice(0, 7);
const purchase = await api("POST", "/purchases", token, { supplierId: supplier, supplierInvoiceNumber: `KG-${run}`, supplierInvoiceDate: today, isReverseCharge: true, lines: [{ productId: cashew, qty: "100", rate: "50" }] });
check(purchase.grandTotal === "5000.00" && purchase.cgstTotal === "125.00", `reverse-charge purchase: ${purchase.grandTotal} ${purchase.cgstTotal}`);
log("reverse-charge purchase of ₹5,000 with GST ₹125 + ₹125 paid by us");

// 2. The purchase screen offers a return and explains reverse charge.
await nav("Purchases");
await page.getByRole("cell", { name: new RegExp(`KG-${run}`) }).first().click();
const returns = page.getByRole("heading", { name: "Returns" }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
await returns.getByText(/^Reverse-charge bill: a return or credit note takes back the goods' value/).waitFor({ timeout: 15000 });
await returns.getByRole("button", { name: "Return to supplier" }).click();
await dialog().getByLabel("Return Cashew kernels").fill("20");
const save = dialog().getByRole("button", { name: /^Save/ });
check((await save.innerText()).includes("₹1,000.00"), `estimate without GST: ${await save.innerText()}`);
await save.click();
await toast("Debit note saved");
await page.getByText(/DN\/.+ · /).first().waitFor({ timeout: 15000 });
log("20 kg returned from the purchase screen");

// 3. The debit note: GST shown apart from its ₹1,000 total.
await returns.getByRole("button", { name: /DN\// }).first().click();
const note = dialog().locator("article").first();
await note.getByText("GST under reverse charge is paid by the recipient and is not included in this total.").waitFor({ timeout: 15000 });
const noteText = (await note.innerText()).replace(/\s+/g, " ");
check(/Reverse charge Yes/i.test(noteText) && /Grand total ₹1,000\.00/i.test(noteText) && /CGST ₹25\.00/.test(noteText), `note: ${noteText.slice(0, 600)}`);
await page.screenshot({ path: `${OUT}/rcm-1-note.png` });
await page.keyboard.press("Escape");
check((await api("GET", `/suppliers/${supplier}`, token)).balance === "4000.00", "supplier owed ₹4,000 now");

// 4. GSTR-3B: reverse-charge tax and its credit both lower.
const r3b = await api("GET", `/gst/returns/gstr3b?period=${month}`, token);
check(r3b.outward.reverseChargeInward.taxable === "4000.00" && r3b.outward.reverseChargeInward.cgst === "100.00" && r3b.itc.reverseCharge.sgst === "100.00", `GSTR-3B: ${JSON.stringify(r3b.outward.reverseChargeInward)} ${JSON.stringify(r3b.itc.reverseCharge)}`);
log("GSTR-3B 3.1(d) ₹4,000 with ₹100 + ₹100; ITC 4A(3) the same");

// 5. The purchase on a phone.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
await page.screenshot({ path: `${OUT}/rcm-2-phone.png`, fullPage: true });

await browser.close();
if (errors.length) {
  console.error("errors:", errors);
  process.exit(1);
}
log("reverse-charge return flow passed");
