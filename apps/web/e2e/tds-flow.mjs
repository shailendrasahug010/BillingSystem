/**
 * End-to-end check of TDS both ways. A supermarket chain pays a ₹11,800
 * bill with ₹11,790 and deducts ₹10 TDS: the receipt says so, the bill is
 * paid, and GST → TDS lists it until its certificate comes. Then TDS on
 * purchases is turned on in Settings; a supplier's bill that takes the
 * year's purchases past the threshold shows the TDS kept back and what is
 * payable, and GST → TDS records the month's challan.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/tds-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98774${String(Date.now()).slice(-5)}`;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
      await page.screenshot({ path: `${OUT}/tds-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 2000));
      throw e;
    });

try {
  // 1. Sign up.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Vikas Mehta");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Mehta Distributors");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Vikas/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const today = (await api("GET", "/me", token)).today;
  const month = today.slice(0, 7);
  log("signed up");

  // 2. A chain store's ₹11,800 bill; a supplier already sold ₹80,000 to us this year.
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const soap = await api("POST", "/products", token, { name: "Lifebuoy 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "500", openingStockCost: "70" });
  const oil = await api("POST", "/products", token, { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", purchasePrice: "100" });
  const chain = await api("POST", "/customers", token, { name: "Avenue Supermarts", stateCode: "23", pan: "AACCA8432H" });
  const hul = await api("POST", "/suppliers", token, { name: "HUL Distributor", stateCode: "23", gstin: "23AAACM1234M1ZR" });
  const invoice = await api("POST", "/invoices", token, { customerId: chain.id, lines: [{ productId: soap.id, qty: "100" }] });
  check(invoice.grandTotal === "11800.00", `the bill is ${invoice.grandTotal}`);
  await api("POST", "/purchases", token, { supplierId: hul.id, supplierInvoiceNumber: "HUL-1", supplierInvoiceDate: today, lines: [{ productId: oil.id, qty: "800", rate: "100" }] });

  // 3. The chain pays ₹11,790 and deducts ₹10 TDS: the bill is paid.
  await page.goto(`${WEB}/#payments`);
  await page.reload();
  await page.getByRole("button", { name: "Receive payment" }).first().click();
  await page.locator("#pay-party").fill("Avenue");
  await page.getByRole("option", { name: /Avenue Supermarts/ }).click();
  await page.locator("#pay-amount").fill("11790");
  await page.locator("#pay-method").selectOption("bank_transfer");
  await page.getByText("The customer deducted TDS").click();
  await page.locator("#pay-tds").fill("10");
  await says("Settles ₹11,800.00 of their bills");
  await page.screenshot({ path: `${OUT}/tds-1-receipt.png` });
  await page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
  await toast("Payment saved");
  const paid = await api("GET", `/invoices/${invoice.id}`, token);
  check(paid.paymentStatus === "paid", `the bill is ${paid.paymentStatus}`);
  const receipt = (await api("GET", `/payments?customerId=${chain.id}`, token)).data[0];
  check(receipt?.amount === "11790.00" && receipt?.tdsAmount === "10.00", `the receipt: ${JSON.stringify(receipt)}`);
  log("receipt with ₹10 TDS; the bill is paid");

  // 4. TDS on purchases turned on in Settings (a lower threshold for the test).
  await nav("Settings");
  await page.getByRole("radiogroup", { name: "TDS on purchases (393(1), old 194Q)" }).getByRole("radio", { name: "Deduct", exact: true }).click();
  await toast("Settings saved");
  await api("PUT", "/settings/tds.purchases", token, { value: { enabled: true, threshold: 100000, rate: 0.1, noPanRate: 5 } });
  log("TDS on purchases on");

  // 5. A ₹40,000 bill takes the year past ₹1 lakh: ₹20,000 over, ₹20 kept back.
  await page.goto(`${WEB}/#purchase-new/${hul.id}`);
  await page.reload();
  await page.locator("#pu-bill").fill("HUL-2");
  await page.getByPlaceholder(/Search product/).fill("Fortune");
  await page.getByRole("option", { name: /Fortune Oil 1L/ }).first().click();
  const line = page.locator("tbody tr", { hasText: "Fortune Oil 1L" });
  await line.getByRole("textbox", { name: "Qty", exact: true }).fill("400");
  await line.getByRole("textbox", { name: "Rate", exact: true }).fill("100");
  await says("TDS 0.1% of ₹20,000.00");
  await says("Payable to the supplier");
  await page.screenshot({ path: `${OUT}/tds-2-bill.png`, fullPage: true });
  await page.getByRole("button", { name: "Save purchase" }).click();
  await toast("Purchase saved");
  const keep = page.getByRole("button", { name: "Keep old rates" });
  if (await keep.isVisible({ timeout: 3000 }).catch(() => false)) await keep.click();
  const bills = (await api("GET", `/purchases?supplierId=${hul.id}`, token)).data;
  const second = bills.find((b) => b.supplierInvoiceNumber === "HUL-2");
  const detail = await api("GET", `/purchases/${second.id}`, token);
  check(detail.tdsAmount === "20.00" && detail.balanceDue === "41980.00", `the bill: TDS ${detail.tdsAmount}, owed ${detail.balanceDue}`);
  log("bill HUL-2: ₹20 TDS kept back, ₹41,980 owed");

  // 6. GST → TDS: the month's TDS and its challan; the chain's TDS with its certificate.
  await page.goto(`${WEB}/#gst`);
  await page.reload();
  await page.getByLabel("Period").fill(month);
  await page.getByRole("tab", { name: "TDS", exact: true }).click();
  const kept = page.locator("[data-tds-kept]");
  await says("HUL-2", kept);
  await says("Not paid yet", kept);
  await kept.getByRole("button", { name: "Record the challan" }).click();
  await page.locator("#tds-bsr").fill("0510308");
  await page.locator("#tds-serial").fill("00042");
  await kept.getByRole("button", { name: "Save challan" }).click();
  await toast("Challan saved");
  await says("0510308/00042", kept);
  check((await api("GET", `/tds/deducted?month=${month}`, token)).pending === "0.00", "the month's TDS is not all paid");
  const received = page.locator("[data-tds-received]");
  await says("Avenue Supermarts", received);
  await received.getByRole("button", { name: "Add", exact: true }).click();
  await received.getByRole("textbox").fill("KXAB12345");
  await received.getByRole("button", { name: "Save", exact: true }).click();
  await toast("Certificate saved");
  await says("KXAB12345", received);
  await page.screenshot({ path: `${OUT}/tds-3-gst.png`, fullPage: true });
  log("challan recorded; the chain's certificate noted");

  // 7. A phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${OUT}/tds-4-phone.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the TDS tab scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/tds-failed.png` }).catch(() => {});
}

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
