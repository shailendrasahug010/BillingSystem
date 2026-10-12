/**
 * End-to-end check of buying: what to order, the order, goods received
 * before the bill, and the bills. Soap sells (40 of 50 gone) and comes in
 * cartons of 12; oil has none left and a minimum of 5. Purchases → Orders →
 * What to order suggests 2 cartons of soap and 5 oil; they become an order.
 * One carton and the oil come before the bill (a goods receipt): stock comes
 * in, the order is partly received. The receipt's bill comes at a higher
 * rate (stock does not come in twice; the cost follows the bill). The last
 * carton comes with a bill made from the order, which completes it.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/purchase-orders-flow.mjs
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
      await page.screenshot({ path: `${OUT}/buying-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 2000));
      throw e;
    });
/** After a bill is saved: a cost rise is offered as a new selling rate; the old rates are kept. */
const keepRates = async () => {
  const keep = page.getByRole("button", { name: "Keep old rates" });
  if (await keep.isVisible({ timeout: 3000 }).catch(() => false)) await keep.click();
};

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
  log("signed up");

  // 2. A supplier; soap that sells and comes in cartons of 12, oil that must not run out; 40 soaps sold.
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const hul = await api("POST", "/suppliers", token, { name: "HUL Distributor", stateCode: "23", gstin: "23AAACM1234M1ZR" });
  const soap = await api("POST", "/products", token, {
    name: "Lifebuoy 100g",
    taxCategoryId: taxes["GST 18%"],
    baseUnitId: units.PCS,
    sellingPrice: "40",
    purchasePrice: "28",
    openingStock: "50",
    openingStockCost: "28",
    preferredSupplierId: hul.id,
    units: [{ unitId: units.CTN, conversionFactor: "12", isDefaultPurchase: true }],
  });
  const oil = await api("POST", "/products", token, { name: "Fortune Oil 1L", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", purchasePrice: "100", minStock: "5", preferredSupplierId: hul.id });
  const gupta = await api("POST", "/customers", token, { name: "Gupta Stores", stateCode: "23" });
  await api("POST", "/invoices", token, { customerId: gupta.id, lines: [{ productId: soap.id, qty: "40" }] });
  const stockOf = async (id) => (await api("GET", `/products/${id}`, token)).stock.total;
  /** Stock that came in for the product, by movement (opening, purchase …). */
  const cameIn = async (id) => (await api("GET", `/stock/ledger?productId=${id}`, token)).entries.filter((e) => Number(e.qtyIn) > 0);

  // 3. Purchases → Orders → What to order: 2 cartons of soap (it runs out), 5 oil (none left).
  await page.goto(`${WEB}/#purchase-orders`);
  await page.reload();
  await page.getByRole("button", { name: "What to order" }).click();
  const group = page.locator('[data-reorder-group="HUL Distributor"]');
  await group.waitFor({ timeout: 15000 });
  const soapRow = group.locator('tr[data-reorder="Lifebuoy 100g"]');
  const oilRow = group.locator('tr[data-reorder="Fortune Oil 1L"]');
  await says("Runs out", soapRow);
  await says("None left", oilRow);
  check((await soapRow.getByRole("textbox").inputValue()) === "2", "soap: not 2 cartons");
  check((await oilRow.getByRole("textbox").inputValue()) === "5", "oil: not 5");
  await page.screenshot({ path: `${OUT}/buying-1-what-to-order.png`, fullPage: true });
  log("what to order: 2 cartons of soap, 5 oil");

  // 4. They become an order at the last purchase rates.
  await group.getByRole("button", { name: "Make order with 2 items" }).click();
  await page.getByRole("heading", { name: "New purchase order" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Save order" }).click();
  await toast("Order saved");
  await page.getByRole("button", { name: "Receive goods" }).waitFor({ timeout: 15000 });
  const orders = (await api("GET", "/purchase-orders?status=pending", token)).data;
  check(orders.length === 1 && orders[0].lines === 2 && orders[0].pendingLines === 2, `the order: ${JSON.stringify(orders)}`);
  const orderId = orders[0]?.id;
  const order = await api("GET", `/purchase-orders/${orderId}`, token);
  check(order.items[0].unitId === units.CTN && order.items[0].qty === "2.000" && order.items[0].rate === "336.0000", `the soap line: ${JSON.stringify(order.items[0])}`);
  log("order saved:", order.orderNumber, order.grandTotal);

  // 5. One carton and the oil come before the bill: received against the order.
  await page.getByRole("button", { name: "Receive goods" }).click();
  await page.getByText(`Against order ${order.orderNumber}`).waitFor({ timeout: 15000 });
  await page.getByRole("textbox", { name: "Qty Lifebuoy 100g" }).fill("1");
  await page.locator("#gr-challan").fill("DC-881");
  await page.getByRole("button", { name: "Save receipt" }).click();
  await toast("Goods received");
  await says("Waiting for the bill");
  const receipts = (await api("GET", "/goods-receipts", token)).data;
  check(receipts.length === 1 && receipts[0].status === "received" && receipts[0].challanNumber === "DC-881", `the receipt: ${JSON.stringify(receipts)}`);
  check((await stockOf(soap.id)) === "22.000" && (await stockOf(oil.id)) === "5.000", "the goods received are not in stock");
  log("received:", receipts[0]?.receiptNumber, "(soap 10 + 12, oil 5 in stock)");
  const partly = await api("GET", `/purchase-orders/${orderId}`, token);
  check(partly.status === "partly_received", `the order is ${partly.status}`);
  check(partly.items.map((i) => i.receivedBase).join() === "12.000,5.000", `received on the order: ${partly.items.map((i) => i.receivedBase)}`);
  await page.screenshot({ path: `${OUT}/buying-2-received.png`, fullPage: true });

  // 6. The receipt's bill comes at 372 a carton: made from the receipt, the goods do not come in twice.
  await page.getByRole("button", { name: "Make the bill" }).click();
  await page.locator("#pu-bill").waitFor({ timeout: 15000 });
  await says(`Received on ${receipts[0].receiptNumber}`);
  await page.locator("#pu-bill").fill("HUL-5501");
  await page.locator("tr", { hasText: "Lifebuoy 100g" }).getByRole("textbox", { name: "Rate", exact: true }).fill("372");
  await page.getByRole("button", { name: "Save purchase" }).click();
  await toast("Purchase saved");
  await keepRates();
  const billed = await api("GET", `/goods-receipts/${receipts[0].id}`, token);
  check(billed.status === "billed" && billed.purchase?.supplierInvoiceNumber === "HUL-5501", `the receipt after its bill: ${billed.status}`);
  check((await stockOf(soap.id)) === "22.000", "the soap came in twice");
  check((await cameIn(soap.id)).filter((e) => e.type === "purchase").length === 1, "the bill brought the received soap in again");
  log("bill HUL-5501 made from the receipt: stock as received");

  // 7. The last carton comes with a bill made from the order, which completes it.
  await page.goto(`${WEB}/#purchase-order/${orderId}`);
  await page.reload();
  await says("Partly received");
  await page.getByRole("button", { name: "Make the bill" }).click();
  await page.locator("#pu-bill").waitFor({ timeout: 15000 });
  await says(`Order ${order.orderNumber}`);
  check((await page.locator("tbody tr", { hasText: "Fortune Oil 1L" }).count()) === 0, "the oil (all received) is on the bill again");
  await page.locator("#pu-bill").fill("HUL-5502");
  await page.getByRole("button", { name: "Save purchase" }).click();
  await toast("Purchase saved");
  await keepRates();
  const done = await api("GET", `/purchase-orders/${orderId}`, token);
  check(done.status === "received" && done.bills.length === 1 && done.receipts.length === 1, `the order at the end: ${done.status}, ${done.bills.length} bills, ${done.receipts.length} receipts`);
  check((await stockOf(soap.id)) === "34.000", "the last carton is not in stock");
  await page.goto(`${WEB}/#purchase-order/${orderId}`);
  await page.reload();
  await says("HUL-5502");
  await says("Received", page.getByRole("heading").first());
  await page.screenshot({ path: `${OUT}/buying-3-order-done.png`, fullPage: true });
  log("order received in full: one receipt, one bill brought the rest");

  // 8. Nothing left to come; the order is in the list as received.
  await page.goto(`${WEB}/#purchase-orders`);
  await page.reload();
  await says("No purchase orders yet");
  await page.getByRole("radio", { name: "All", exact: true }).click();
  await says(order.orderNumber);

  // 9. A phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${WEB}/#purchase-order/${orderId}`);
  await page.reload();
  await says(order.orderNumber);
  await page.screenshot({ path: `${OUT}/buying-4-phone.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the order scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/buying-failed.png` }).catch(() => {});
}

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
