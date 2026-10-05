/**
 * End-to-end check of purchases, expenses and returns without a connection,
 * on the production build: sign up, a sale made online -> the device keeps
 * its recent bills (encrypted) -> the connection goes and the app opens from
 * the device with the password -> a supplier's purchase bill is entered (stock
 * comes in on the device), an expense is entered, and the customer's bill is
 * opened from the device copy and goods are returned against it -> the list
 * screens say what is waiting -> the connection comes back -> the purchase,
 * the expense and the credit note reach the server once each, and stock ends
 * where it should.
 *
 * Build the app and serve it with the API behind /api:
 *   pnpm --filter @digitalbahi/web build && (cd apps/web && npx vite preview --port 4173)
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:4173 node apps/web/e2e/offline-work-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98761${String(Date.now()).slice(-5)}`;
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
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
let signedIn = false;
let offline = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  // The live notifications stream is cut by design when the page reloads or the network goes.
  // A request cut off by a reload or the switch to offline is not a failure of the app.
  if (!offline && r.url().includes("/api/") && !r.url().includes("/notifications/stream") && r.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`);
});
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const goOffline = async (value) => {
  offline = value;
  await context.setOffline(value);
};
const idbKeys = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("digital-bahi");
        req.onsuccess = () => {
          const all = req.result.transaction("kv").objectStore("kv").getAllKeys();
          all.onsuccess = () => resolve(all.result.map(String));
        };
        req.onerror = () => resolve([]);
      }),
  );

// 1. Sign up; a product, a customer, a supplier and a sale made online.
await page.goto(WEB);
await page.evaluate(() => navigator.serviceWorker.ready);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kamla Devi");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Kamla Stores");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Kamla/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Lifebuoy Soap 100g", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", purchasePrice: "30", openingStock: "50", openingStockCost: "30" });
const sharma = await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23", city: "Indore" });
await api("POST", "/suppliers", token, { name: "Soap Depot", stateCode: "23", gstRegistration: "unregistered" });
const sale = await api("POST", "/invoices", token, { customerId: sharma.id, lines: [{ productId: soap.id, qty: "5" }] });
log("signed up; 50 soaps, a customer, a supplier; sold 5 online:", sale.invoiceNumber);

// 2. Loaded once online: the business and its recent bills are kept on the device.
await page.reload();
await page.getByRole("heading", { name: /, Kamla/ }).waitFor({ timeout: 15000 });
for (let i = 0; i < 40; i++) {
  const keys = await idbKeys();
  if (keys.some((k) => k.startsWith("snapshot:")) && keys.some((k) => k.startsWith("docs:"))) break;
  await page.waitForTimeout(300);
}
const keys = await idbKeys();
if (!keys.some((k) => k.startsWith("docs:"))) errors.push(`no recent bills kept: ${keys.join(", ")}`);
const stored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("digital-bahi");
      req.onsuccess = () => {
        const all = req.result.transaction("kv").objectStore("kv").getAll();
        all.onsuccess = () => resolve(JSON.stringify(all.result, (_k, v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? "[bytes]" : v)));
      };
    }),
);
if (stored.includes(sale.invoiceNumber) || stored.includes("Sharma Kirana")) errors.push("the kept bill is readable in the device storage");
log("recent bills kept on the device, encrypted");

// 3. No connection: open with the password.
await goOffline(true);
await page.reload();
await page.getByRole("heading", { name: "Open Kamla Stores without internet" }).waitFor({ timeout: 15000 });
await page.fill("#unlock-password", password);
await page.getByRole("button", { name: "Open", exact: true }).click();
await page.getByText("No connection. Bills, payments, orders, purchases, expenses, returns and customer changes are saved on this device").waitFor({ timeout: 15000 });
log("opened offline");

// 4. A supplier's bill: 20 soaps in.
await nav("Purchases");
await page.getByText("No connection: purchase bills from the last 30 days kept on this device").waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "New purchase bill" }).first().click();
await page.fill("#pu-supplier", "soap dep");
await page.getByRole("option", { name: /Soap Depot/ }).click();
await page.fill("#pu-bill", "SD/101");
await page.getByPlaceholder("Search product, code or scan barcode").fill("lifebuoy");
await page.getByRole("option", { name: /Lifebuoy Soap/ }).click();
await page.getByLabel("Qty").first().fill("20");
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Saved on this device");
await page.getByText("1 entry here is waiting on this device to be sent").waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/offline-work-1-purchase.png` });
log("purchase bill SD/101 kept offline; the Purchases screen says it is waiting");

// 5. An expense.
await nav("Expenses");
await page.getByRole("button", { name: "New expense" }).click();
await dialog().getByLabel("Category").selectOption({ label: "Rent" });
await dialog().getByLabel("Amount before GST").fill("1500");
await dialog().getByLabel("Paid to").fill("Landlord");
await dialog().getByRole("button", { name: /^Save/ }).click();
await toast("Saved on this device");
await page.getByText("1 entry here is waiting on this device to be sent").waitFor({ timeout: 15000 });
log("expense of 1,500 kept offline");

// 6. Sharma brings back 2 soaps: the bill opens from the device copy.
await nav("Customers");
await page.getByText("Sharma Kirana").first().click();
await page.getByRole("tab", { name: "Invoices" }).click();
await page.getByRole("cell", { name: sale.invoiceNumber }).click();
await page.getByText("Copy on this device").first().waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Record return" }).click();
await dialog().getByLabel(/^Return Lifebuoy/).fill("2");
await dialog().getByRole("button", { name: /^Save/ }).click();
await toast("Saved on this device");
// The kept bill now shows the 2 as returned: only 3 more can come back.
await page.getByRole("button", { name: "Record return" }).click();
const left = (await dialog().locator("tbody tr").first().locator("td").nth(2).innerText()).trim();
await page.screenshot({ path: `${OUT}/offline-work-2-return.png` });
await page.keyboard.press("Escape");
if (left !== "3") errors.push(`the kept bill lets ${left} come back, not 3`);
log("return of 2 kept offline against", sale.invoiceNumber);

// 7. Everything waiting is listed.
await page.getByRole("button", { name: /^Offline/ }).first().click();
const waitingList = await dialog().innerText();
for (const s of ["Purchase bill", "Expense", "Return", "Soap Depot · SD/101", "Rent · Landlord", "Sharma Kirana"]) if (!waitingList.includes(s)) errors.push(`waiting list lacks ${s}`);
await page.screenshot({ path: `${OUT}/offline-work-3-waiting.png` });
await page.keyboard.press("Escape");
log("waiting: a purchase bill, an expense and a return");

// 8. Back online: each reaches the server once.
await goOffline(false);
let purchases = [];
let expenses = [];
let saleNow = null;
for (let i = 0; i < 60; i++) {
  purchases = (await api("GET", "/purchases", token)).data;
  expenses = (await api("GET", "/expenses", token)).data;
  saleNow = await api("GET", `/invoices/${sale.id}`, token);
  if (purchases.length && expenses.length && saleNow.returns.length) break;
  await page.waitForTimeout(500);
}
if (purchases.length !== 1 || purchases[0].supplierInvoiceNumber !== "SD/101") errors.push(`purchases: ${JSON.stringify(purchases)}`);
if (expenses.length !== 1 || expenses[0].totalAmount !== "1500.00") errors.push(`expenses: ${JSON.stringify(expenses)}`);
if (saleNow.returns.length !== 1 || saleNow.items[0].returnedQty !== "2.000") errors.push(`return: ${JSON.stringify(saleNow.returns)}`);
const stock = (await api("GET", `/products/${soap.id}`, token)).stock.total;
if (Number(stock) !== 67) errors.push(`stock ${stock}, expected 50 - 5 + 20 + 2 = 67`);
log("synced: purchase", purchases[0]?.purchaseNumber, "· expense", expenses[0]?.expenseNumber, "· credit note", saleNow.returns[0]?.noteNumber, "· stock", stock);

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
