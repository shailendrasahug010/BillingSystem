/**
 * End-to-end check of TCS on sales of specified goods. A scrap dealer turns
 * TCS on in Settings and marks scrap as TCS goods on the product. A bill of
 * 1,000 kg to a steel works (PAN in its GSTIN) shows TCS 2% on the value
 * with GST before it is saved, and the server agrees to the rupee; one to a
 * kabadi with no PAN takes 5%. The bill prints the TCS; GST → TDS & TCS
 * lists the month's TCS with its due date and records its challan.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/tcs-flow.mjs
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
      await page.screenshot({ path: `${OUT}/tcs-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 2000));
      throw e;
    });

try {
  // 1. Sign up.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Suresh Sharma");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Sharma Metals");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Suresh/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const today = (await api("GET", "/me", token)).today;
  const month = today.slice(0, 7);
  log("signed up");

  // 2. Scrap in stock; a steel works (its GSTIN carries its PAN) and a kabadi with no PAN.
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const scrap = await api("POST", "/products", token, { name: "MS Scrap", hsnCode: "7204", taxCategoryId: taxes["GST 18%"], baseUnitId: units.KG ?? units.PCS, sellingPrice: "30", openingStock: "5000", openingStockCost: "25" });
  await api("POST", "/customers", token, { name: "Malwa Steel Works", customerType: "b2b", stateCode: "23", gstin: "23AAACM1234M1ZR" });
  const raju = await api("POST", "/customers", token, { name: "Raju Kabadi", stateCode: "23" });

  // 3. TCS turned on in Settings; scrap marked as TCS goods on the product.
  await page.reload();
  await nav("Settings");
  await page.getByRole("radiogroup", { name: "TCS on sales (394(1), old 206C(1))" }).getByRole("radio", { name: "Collect", exact: true }).click();
  await toast("Settings saved");
  await nav("Products");
  await page.getByRole("cell", { name: /MS Scrap/ }).click();
  await page.locator("#p-rate").waitFor();
  const more = page.getByRole("button", { name: /More details/ });
  if (!(await page.locator("#p-tcs").isVisible()) && (await more.isVisible())) await more.click();
  await page.selectOption("#p-tcs", "scrap");
  await page.screenshot({ path: `${OUT}/tcs-1-product.png` });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await toast("Product saved");
  check((await api("GET", `/products/${scrap.id}`, token)).tcsGoods === "scrap", "scrap is not marked as TCS goods");
  log("TCS on; scrap marked");

  // 4. 1,000 kg to the steel works: ₹30,000 + ₹5,400 GST = ₹35,400, TCS 2% ₹708, the bill ₹36,108.
  await nav("New Invoice");
  await page.getByRole("combobox", { name: /Search customer/ }).fill("malwa");
  await page.getByRole("option", { name: /Malwa Steel Works/ }).click();
  await page.getByPlaceholder("Search product, code or scan barcode").fill("scrap");
  await page.getByRole("option", { name: /MS Scrap/ }).click();
  await page.getByLabel("Qty MS Scrap").fill("1000");
  await says("TCS 206C(1) @ 2%");
  await says("₹708.00");
  await says("₹36,108.00");
  await page.screenshot({ path: `${OUT}/tcs-2-bill.png` });
  await page.keyboard.press("Control+Enter");
  const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
  await popup.waitFor({ timeout: 20000 });
  await popup.getByRole("button", { name: "New invoice" }).click();
  const [steelRow] = (await api("GET", "/invoices", token)).data;
  const steel = await api("GET", `/invoices/${steelRow.id}`, token);
  check(steel.grandTotal === "36108.00" && steel.tcsAmount === "708.00", `the steel works' bill: ${steel.grandTotal}, TCS ${steel.tcsAmount}`);
  log("bill", steel.invoiceNumber, "for", steel.grandTotal, "with ₹708 TCS");

  // 5. 100 kg to the kabadi, who has no PAN: 5% of ₹3,540 = ₹177.
  await page.getByRole("combobox", { name: /Search customer/ }).fill("raju");
  await page.getByRole("option", { name: /Raju Kabadi/ }).click();
  await page.getByPlaceholder("Search product, code or scan barcode").fill("scrap");
  await page.getByRole("option", { name: /MS Scrap/ }).click();
  await page.getByLabel("Qty MS Scrap").fill("100");
  await says("TCS 206C(1) @ 5%");
  await says("₹177.00");
  await page.keyboard.press("Control+Enter");
  await page.getByRole("dialog", { name: "Invoice added successfully" }).waitFor({ timeout: 20000 });
  const rajuBill = (await api("GET", `/invoices?customerId=${raju.id}`, token)).data[0];
  check(rajuBill && (await api("GET", `/invoices/${rajuBill.id}`, token)).tcsAmount === "177.00", "the kabadi's bill has not 5% TCS");
  log("bill to the kabadi with 5% TCS");

  // 6. The bill prints its TCS.
  await page.goto(`${WEB}/#invoice/${steel.id}`);
  await page.reload();
  await says("TCS 206C(1) @ 2%");
  await page.screenshot({ path: `${OUT}/tcs-3-invoice.png`, fullPage: true });
  log("the bill shows its TCS");

  // 7. GST → TDS & TCS: the month's TCS and its challan.
  await page.goto(`${WEB}/#gst`);
  await page.reload();
  await page.getByLabel("Period").fill(month);
  await page.getByRole("tab", { name: "TDS & TCS", exact: true }).click();
  const collected = page.locator("[data-tcs-collected]");
  await says("Malwa Steel Works", collected);
  await says("Not paid yet", collected);
  await says("₹885.00", collected);
  await collected.getByRole("button", { name: "Record the challan" }).click();
  await page.locator("#tcs-bsr").fill("0510308");
  await page.locator("#tcs-serial").fill("00077");
  await collected.getByRole("button", { name: "Save challan" }).click();
  await toast("Challan saved");
  await says("0510308/00077", collected);
  check((await api("GET", `/tcs/collected?month=${month}`, token)).pending === "0.00", "the month's TCS is not all paid");
  await page.screenshot({ path: `${OUT}/tcs-4-gst.png`, fullPage: true });
  log("the month's ₹885 TCS on a challan");

  // 8. A phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${OUT}/tcs-5-phone.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the TDS & TCS tab scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/tcs-failed.png` }).catch(() => {});
}

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
