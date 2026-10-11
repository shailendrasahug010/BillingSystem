/**
 * End-to-end check of goods returned without their bill, debit notes, and
 * billing from another godown. A shop is billed 10 soaps; 2 come back
 * without the bill (Bills → Goods returned): the credit note takes them back
 * at the rate they were billed, with GST, and pays that bill. A rate
 * difference raises the bill by a debit note. With a second godown, the
 * bill screen offers it, shows its stock, and the bill goes out from it.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/sales-returns-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98773${String(Date.now()).slice(-5)}`;
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
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
/** Waits for the page to say `text`; on failure shows what it says instead. */
const says = (text, within = page) =>
  within
    .getByText(text)
    .first()
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      await page.screenshot({ path: `${OUT}/returns-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 2500));
      throw e;
    });

try {
  // 1. Sign up.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Arun Bansal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Bansal Agencies");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Arun/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  log("signed up");

  // 2. A shop billed 10 soaps (10 × 35 + 18% = 413); a back godown holding 20 of them.
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const soap = await api("POST", "/products", token, { name: "Lifebuoy 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "100", openingStockCost: "28" });
  const gupta = await api("POST", "/customers", token, { name: "Gupta Stores", mobile: "9826011111", stateCode: "23" });
  const bill = await api("POST", "/invoices", token, { customerId: gupta.id, lines: [{ productId: soap.id, qty: "10" }] });
  check(bill.grandTotal === "413.00", `the bill is ${bill.grandTotal}`);
  const main = (await api("GET", "/warehouses", token)).data.find((w) => w.isDefault);
  const back = await api("POST", "/warehouses", token, { name: "Back godown", code: "BACK" });
  await api("POST", "/stock/transfers", token, { fromWarehouseId: main.id, toWarehouseId: back.id, lines: [{ productId: soap.id, qty: "20" }] });
  log("billed", bill.invoiceNumber, "for", bill.grandTotal, "; 20 soaps moved to the back godown");

  // 3. Bills → Goods returned: 2 soaps without their bill, at the rate billed, paying that bill.
  await page.goto(`${WEB}/#invoices`);
  await page.reload();
  await page.getByRole("button", { name: "Goods returned" }).click();
  const dialog = page.getByRole("dialog", { name: "Goods returned without a bill" });
  await dialog.locator("#lr-customer").fill("gupta");
  await page.getByRole("option", { name: /Gupta Stores/ }).click();
  await dialog.locator("#lr-product").fill("lifebuoy");
  await page.getByRole("option", { name: /Lifebuoy 100g/ }).click();
  await dialog.getByLabel("Qty Lifebuoy 100g").fill("2");
  await says(`Last billed on ${bill.invoiceNumber}`, dialog);
  // 2 × 35 = 70, + 12.60 GST, rounded: 83.
  const totals = dialog.locator("[data-loose-totals]");
  await says("₹83.00", totals);
  await page.screenshot({ path: `${OUT}/returns-1-dialog.png` });
  await dialog.locator("[data-loose-save]").click();
  await toast("Credit note saved");
  await says(`CN/26-27/00001 · ₹83.00 · Paid bills: ${bill.invoiceNumber}`);
  const afterReturn = await api("GET", `/invoices/${bill.id}`, token);
  check(afterReturn.balanceDue === "330.00", `the bill owes ${afterReturn.balanceDue}`);
  check(afterReturn.noteCredits?.[0]?.amount === "83.00", `the bill's note credits: ${JSON.stringify(afterReturn.noteCredits)}`);
  const notes = (await api("GET", `/notes?customerId=${gupta.id}&withoutBill=true`, token)).data;
  check(notes.length === 1 && notes[0].grandTotal === "83.00" && notes[0].amountSettled === "83.00", `the note: ${JSON.stringify(notes)}`);
  log("returned without a bill: CN/26-27/00001 for ₹83 paid", bill.invoiceNumber, "down to ₹330");

  // 4. The bill: a debit note for a rate difference of ₹50 (₹59 with GST).
  await page.goto(`${WEB}/#invoice/${bill.id}`);
  await page.getByRole("button", { name: "Debit note" }).click();
  const debit = page.getByRole("dialog", { name: "Debit note: charge more on this bill" });
  await debit.locator("#pn-value").fill("50");
  await debit.getByRole("button", { name: "Save", exact: true }).click();
  await toast("Debit note saved");
  await says("DN/26-27/00001 · ₹59.00");
  const afterDebit = await api("GET", `/invoices/${bill.id}`, token);
  check(afterDebit.debited === "59.00" && afterDebit.balanceDue === "389.00" && afterDebit.paymentStatus === "partial", `after the debit note: ${afterDebit.debited} / ${afterDebit.balanceDue} / ${afterDebit.paymentStatus}`);
  await says("+ ₹59.00");
  await says("Add: debit notes");
  await page.screenshot({ path: `${OUT}/returns-2-bill.png`, fullPage: true });
  log("debit note DN/26-27/00001 for ₹59: the bill owes ₹389");

  // 5. A bill from the back godown: its stock is what the screen goes by.
  await page.goto(`${WEB}/#invoice/new/${gupta.id}`);
  await page.locator("#bill-godown").selectOption({ label: "Back godown" });
  await page.getByPlaceholder("Search product, code or scan barcode").fill("lifebuoy");
  const option = page.getByRole("option", { name: /Lifebuoy 100g/ });
  await says("20 in stock", option);
  await option.click();
  await page.getByLabel("Qty Lifebuoy 100g").fill("25");
  await says("Only 20 PCS in stock");
  await page.getByLabel("Qty Lifebuoy 100g").fill("5");
  await page.screenshot({ path: `${OUT}/returns-3-godown.png` });
  await page.keyboard.press("Control+Enter");
  const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
  await popup.waitFor({ timeout: 20000 });
  await popup.getByRole("button", { name: "New invoice" }).click();
  const [latest] = (await api("GET", "/invoices", token)).data;
  const fromBack = await api("GET", `/invoices/${latest.id}`, token);
  check(fromBack.warehouseId === back.id, `the bill went out from ${fromBack.warehouseId}, not the back godown`);
  const backStock = (await api("GET", `/warehouses/${back.id}/stock`, token)).data;
  check(backStock.length === 1 && backStock[0].qty === "15.000", `the back godown has ${JSON.stringify(backStock)}`);
  log("billed 5 from the back godown: 15 left there");

  // 6. A phone: the return without a bill fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${WEB}/#customer/${gupta.id}`);
  await page.getByRole("button", { name: "Goods returned" }).click();
  await page.getByRole("dialog", { name: "Goods returned without a bill" }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/returns-4-phone.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/returns-failed.png` }).catch(() => {});
}

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
