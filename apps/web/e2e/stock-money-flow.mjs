/**
 * Stock and money screens, start to end: expired batches written off from
 * Inventory -> a stock count typed in and saved -> stock shown in boxes and
 * pieces -> a purchase bill that costs more offers new selling rates -> the
 * bill as a PDF -> the bill corrected (entered again, payment moved) -> the
 * supplier's statement as a PDF -> the cash book -> on a phone: list cards,
 * folded filters, date chips, and the purchase bill's own Save bar in place
 * of the tab bar.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/stock-money-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH) and a Chromium (CHROMIUM_PATH optional).
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
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const check = (ok, what) => {
  if (!ok) errors.push(what);
};
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
const shot = (name) => page.screenshot({ path: `${OUT}/stock-money-${name}.png` });
const download = async (click) => {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), click()]);
  return file.suggestedFilename();
};

// 1. Sign up; a biscuit sold in boxes of 24, an ORS with batches and expiry, a supplier, a customer.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kavita Rao");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Rao Medical Agencies");
await page.locator("#su-state").selectOption("23");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Kavita/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const parle = (
  await api("POST", "/products", token, { name: "Parle-G 100g", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", mrp: "10", units: [{ unitId: units.BOX, conversionFactor: "24", isDefaultPurchase: true }] })
).id;
const ors = (await api("POST", "/products", token, { name: "ORS Sachet", hsnCode: "3004", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "20", trackBatches: true, trackExpiry: true })).id;
const supplier = (await api("POST", "/suppliers", token, { name: "Shree Stockist", stateCode: "23", gstRegistration: "unregistered", mobile: "9876500011", creditDays: 15 })).id;
// The business's own today (India time), which near midnight is not the UTC date.
const today = (await api("GET", "/stock/batches", token)).today;
const days = (n) => new Date(Date.parse(today) + n * 86_400_000).toISOString().slice(0, 10);
await api("POST", "/purchases", token, {
  supplierId: supplier,
  supplierInvoiceNumber: "SS-100",
  supplierInvoiceDate: today,
  lines: [
    { productId: parle, unitId: units.BOX, qty: "8", rate: "192" },
    { productId: ors, qty: "10", rate: "12", batchNumber: "OLD1", expiryDate: days(-20) },
    { productId: ors, qty: "15", rate: "12", batchNumber: "NEAR1", expiryDate: days(10) },
    { productId: ors, qty: "30", rate: "12", batchNumber: "FAR1", expiryDate: days(300) },
  ],
  payment: { amount: "500", method: "cash" },
});
await page.reload();
log("signed up; 8 boxes of Parle-G and three ORS batches bought (one expired, one expiring)");

// 2. Inventory: the stock in boxes and pieces; expiring and expired batches; write off the expired one.
await nav("Inventory");
await page.getByText("8 BOX").first().waitFor({ timeout: 15000 });
check((await page.getByText("= 192 PCS").count()) > 0, "stock in boxes shows no piece total");
await page.getByRole("tab", { name: "Expiring" }).click();
await page.getByText("NEAR1", { exact: true }).waitFor({ timeout: 15000 });
check((await page.getByText("OLD1", { exact: true }).count()) > 0, "the expired batch is not in the expiring list");
check((await page.getByText("FAR1", { exact: true }).count()) === 0, "a batch far from expiry is listed");
await shot("1-expiring");
await page.getByRole("radio", { name: "Expired" }).click();
await page.getByRole("button", { name: "Write off 1 expired batch" }).click();
await dialog().getByRole("button", { name: "Write off" }).click();
await toast("1 expired batch written off");
await page.getByText("No expired stock").waitFor({ timeout: 15000 });
const orsStock = (await api("GET", `/products/${ors}`, token)).stock;
check(Number(orsStock.total) === 45, `ORS stock after write-off ${orsStock.total}`);
log("expired batch written off");

// 3. Stock count: every product listed; Parle-G counted short, ORS left blank; saved as one count.
await page.getByRole("tab", { name: "Stock" }).click();
await page.getByRole("button", { name: "Count stock" }).click();
await dialog().getByText("Parle-G 100g").waitFor({ timeout: 15000 });
await dialog().getByLabel("Counted · Parle-G 100g").fill("180");
await dialog().getByText("→ -12").waitFor();
await shot("2-count");
await dialog().getByRole("button", { name: "Save count (1 change)" }).click();
await toast("Count saved: 1 product adjusted");
const counted = (await api("GET", "/stock?q=Parle", token)).data[0];
check(Number(counted.qty) === 180, `Parle-G after the count: ${counted.qty}`);
log("stock count saved: Parle-G 192 -> 180");

// 4. Products: the stock value is the same as on Inventory (average cost), in boxes and pieces.
await nav("Products");
await page.getByText("7 BOX 12 PCS").first().waitFor({ timeout: 15000 });
log("products show 7 BOX 12 PCS");

// 5. A purchase bill dearer than before: offered new selling rate and MRP, which are saved.
await page.goto(`${WEB}/#purchase-new/${supplier}`);
await page.reload();
await page.locator("#pu-bill").waitFor({ timeout: 15000 });
await page.fill("#pu-bill", "SS-101");
await page.getByPlaceholder("Search product, code or scan barcode").fill("parle");
await page.getByRole("option", { name: /Parle-G 100g/ }).click();
await page.getByLabel("Qty").first().fill("5");
await page.getByLabel("Rate").first().fill("216");
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
await dialog().getByText("Cost went up").waitFor({ timeout: 15000 });
const newRate = await dialog().getByLabel("New selling rate · Parle-G 100g").inputValue();
check(newRate === "11.30", `suggested selling rate ${newRate}`);
await dialog().getByLabel("MRP · Parle-G 100g").fill("12");
await shot("3-price-rise");
await dialog().getByRole("button", { name: "Update 1 rate" }).click();
await toast("Selling rate updated for 1 item");
const updated = await api("GET", `/products/${parle}`, token);
check(Number(updated.sellingPrice) === 11.3 && Number(updated.mrp) === 12, `rates after the rise: ${updated.sellingPrice} / ${updated.mrp}`);
log("price rise: selling rate 10 -> 11.30, MRP 12");

// 6. The bill as a PDF; then corrected: entered again with the right quantity, the payment moved.
await page.getByRole("button", { name: "Download PDF" }).waitFor({ timeout: 15000 });
const pdfName = await download(() => page.getByRole("button", { name: "Download PDF" }).click());
check(pdfName.endsWith(".pdf") && pdfName.includes("SS-101"), `purchase PDF name ${pdfName}`);
const first = (await api("GET", "/purchases", token)).data.find((p) => p.supplierInvoiceNumber === "SS-100");
await page.goto(`${WEB}/#purchase/${first.id}`);
await page.reload();
await page.getByRole("button", { name: "Correct bill" }).click();
await page.getByRole("heading", { name: "Correct bill SS-100" }).waitFor({ timeout: 15000 });
check((await page.getByLabel("Qty").count()) === 4, "the corrected bill did not start with its 4 lines");
await page.getByLabel("Qty").first().fill("9");
await shot("4-correct");
await page.getByRole("button", { name: "Save corrected bill" }).click();
await toast("Bill corrected");
await page.getByRole("button", { name: "Correct bill" }).waitFor({ timeout: 15000 });
const old = await api("GET", `/purchases/${first.id}`, token);
check(old.status === "cancelled", `the wrong bill is ${old.status}`);
const fixed = (await api("GET", "/purchases", token)).data.find((p) => p.supplierInvoiceNumber === "SS-100" && p.status === "posted");
check(fixed && Number(fixed.grandTotal) - Number(fixed.balanceDue) === 500, `the payment did not move: ${JSON.stringify(fixed)}`);
log("bill corrected; old one cancelled, ₹500 paid moved to the new one");

// 7. The supplier's statement as a PDF.
await page.goto(`${WEB}/#supplier/${supplier}`);
await page.reload();
await page.getByRole("tab", { name: "Ledger" }).click();
const statement = await download(() => page.getByRole("tabpanel").getByRole("button", { name: "Download PDF" }).click());
check(statement.startsWith("statement-") && statement.endsWith(".pdf"), `statement PDF name ${statement}`);
log("statement PDF", statement);

// 8. The cash book: the ₹500 paid in cash is money out of the drawer.
await nav("Payments");
await page.getByRole("tab", { name: "Cash book" }).click();
await page.getByText("Closing").first().waitFor({ timeout: 15000 });
await page.getByRole("combobox", { name: "Period" }).selectOption("last7");
await page.getByText("₹500.00").first().waitFor({ timeout: 10000 }).catch(() => undefined);
check((await page.getByText("₹500.00").count()) > 0, "the cash book does not show the ₹500 paid out");
await shot("5-cash-book");
log("cash book shows the cash paid out");

// 9. On a phone: purchases as cards, filters folded, date chips; the bill screen's own Save bar.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${WEB}/#purchases`);
await page.reload();
await page.getByText("SS-101").filter({ visible: true }).first().waitFor({ timeout: 15000 });
const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check(!wide, "the purchases list scrolls sideways on a phone");
await page.getByRole("button", { name: "Filters" }).click();
await page.getByRole("button", { name: "Today", exact: true }).click();
await page.getByText("SS-101").filter({ visible: true }).first().waitFor();
await shot("6-phone-purchases");
await page.goto(`${WEB}/#purchase-new`);
await page.reload();
await page.locator("#pu-bill").waitFor({ timeout: 15000 });
check(!(await page.getByRole("navigation", { name: "Primary" }).isVisible().catch(() => false)), "the tab bar shows on the phone purchase bill");
check(await page.getByRole("button", { name: "Save", exact: true }).isVisible(), "no Save bar on the phone purchase bill");
await shot("7-phone-purchase-bill");
log("phone: cards, filters, chips and the purchase bill Save bar");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
if (errors.length) process.exit(1);
