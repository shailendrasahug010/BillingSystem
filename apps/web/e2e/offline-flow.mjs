/**
 * End-to-end check of offline billing on the production build (the service
 * worker serves the app without a network): sign up -> the device gets its
 * own series -> the connection goes -> the app still opens from the copy on
 * the device, which is encrypted and opens with the owner's password (a
 * wrong one is refused) -> two bills are made and printed with the device's numbers
 * (A1/26-27/0001, 0002) -> still offline: a new customer is added and
 * billed, a payment is received, an order is booked for the new customer and
 * a customer's city is changed -> sign-out is refused while offline -> the
 * connection comes back -> everything reaches the server in order (the new
 * customer first, under the id it was billed with), the bills keep their
 * numbers and the stock and balances move -> a bill made when the network
 * drops in the middle of work is sent by itself when it returns.
 *
 * Build the app and serve it with the API behind /api:
 *   pnpm --filter @vyapaar/web build && (cd apps/web && npx vite preview --port 4173)
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:4173 node apps/web/e2e/offline-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98767${String(Date.now()).slice(-5)}`;
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
  // Without a network the app's requests fail by design.
  if (!offline && r.url().includes("/api/")) errors.push(`failed ${r.method()} ${r.url()}`);
});

const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const goOffline = async (value) => {
  offline = value;
  await context.setOffline(value);
};

async function bill(customer, product, qty) {
  const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
  await customerBox.waitFor({ timeout: 15000 });
  await customerBox.fill(customer);
  await page.keyboard.press("Enter");
  const productBox = page.getByPlaceholder(/Search product/);
  await productBox.fill(product);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  if (qty !== 1) {
    await page.getByLabel(/^Qty /).first().fill(String(qty));
    await page.keyboard.press("Tab");
  }
  await page.getByRole("button", { name: "Save invoice" }).click();
}

// 1. Sign up and the master data.
await page.goto(WEB);
await page.evaluate(() => navigator.serviceWorker.ready);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Mohan Lal");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Mohan Traders");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Mohan/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Lifebuoy Soap 100g", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", openingStock: "50", openingStockCost: "30" });
const sharma = await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23", city: "Indore" });
log("signed up; product (50 in stock) and customer added");

// 2. Loaded once online: the business is kept on the device and the device gets its series.
await page.reload();
await page.getByRole("heading", { name: /Mohan/ }).waitFor({ timeout: 15000 });
await page.waitForFunction(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("digital-bahi");
      req.onsuccess = () => {
        const all = req.result.transaction("kv").objectStore("kv").getAllKeys();
        all.onsuccess = () => resolve(all.result.some((k) => String(k).startsWith("device:")) && all.result.some((k) => String(k).startsWith("snapshot:")));
      };
      req.onerror = () => resolve(false);
    }),
  null,
  { timeout: 15000 },
);
const devices = (await api("GET", "/devices", token)).data;
log("device registered:", devices.map((d) => `${d.seriesCode} ${d.name}`).join(", "));

// 3. No connection: the app still opens, from the copy on the device.
await goOffline(true);
await page.reload();
// The copy on the device is locked: it opens with the password, not without it.
await page.getByRole("heading", { name: "Open Mohan Traders without internet" }).waitFor({ timeout: 15000 });
await page.fill("#unlock-password", "not-the-password");
await page.getByRole("button", { name: "Open", exact: true }).click();
await page.getByText("This password does not open the copy on this device.", { exact: false }).waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/offline-0-locked.png` });
await page.fill("#unlock-password", password);
await page.getByRole("button", { name: "Open", exact: true }).click();
await page.getByText("No connection. Bills, payments, orders, purchases, expenses, returns and customer changes are saved on this device").waitFor({ timeout: 15000 });
await page.getByRole("heading", { name: /Mohan/ }).waitFor();
await page.screenshot({ path: `${OUT}/offline-1-start.png` });
log("opened offline from the saved copy");

// 4. Two bills offline, numbered by the device.
await page.goto(`${WEB}/#invoice`);
await page.getByText("A1/26-27/0001").first().waitFor({ timeout: 15000 });
await bill("Sharma", "lifebuoy", 3);
await toast("Invoice A1/26-27/0001 saved");
await page.getByText("Saved offline · will sync when online").first().waitFor();
await page.getByRole("button", { name: "Details" }).first().click();
await page.getByRole("heading", { name: "A1/26-27/0001" }).waitFor({ timeout: 15000 });
await page.getByText("Not synced yet").waitFor();
await page.screenshot({ path: `${OUT}/offline-2-bill.png`, fullPage: true });
log("bill A1/26-27/0001 saved and printed offline");
await page.goto(`${WEB}/#invoice`);
await bill("Sharma", "lifebuoy", 1);
await toast("Invoice A1/26-27/0002 saved");
log("second bill queued");

// 4b. More work offline: a new customer (billed at once), a payment, an order and a changed city.
const openCustomer = async (name) => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("cell", { name: new RegExp(name) }).first().click({ timeout: 15000 });
  await page.getByRole("heading", { name: new RegExp(name) }).waitFor({ timeout: 15000 });
};
await page.goto(`${WEB}/#customers`);
await page.getByRole("button", { name: "Add customer" }).first().click();
await page.getByText("No connection: saved on this device and sent when the internet is back.").waitFor();
await page.getByRole("radio", { name: "B2C" }).click();
await page.fill("#c-business", "Naya Kirana Stores");
await page.fill("#c-mobile", "9826055555");
await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
await toast("Saved on this device");
await page.goto(`${WEB}/#invoice`);
await bill("Naya", "lifebuoy", 2);
await toast("Invoice A1/26-27/0003 saved");
log("new customer added offline and billed A1/26-27/0003");

await openCustomer("Sharma Kirana");
await page.getByRole("button", { name: "Receive Payment" }).click();
await page.getByText(/the payment is saved on this device/).waitFor({ timeout: 15000 });
await page.fill("#pay-amount", "50");
await page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
await toast("Saved on this device");
log("payment of 50 kept offline");

await openCustomer("Naya Kirana Stores");
await page.getByRole("button", { name: "New order" }).click();
await page.getByText(/the order is saved on this device/).waitFor({ timeout: 15000 });
await page.getByRole("dialog").getByPlaceholder(/Search product/).fill("lifebuoy");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.getByRole("dialog").getByLabel("Qty Lifebuoy Soap 100g").fill("5");
await page.getByRole("dialog").getByRole("button", { name: /^Save order/ }).click();
await toast("Saved on this device");
log("order for the new customer kept offline");

await openCustomer("Sharma Kirana");
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.fill("#c-city", "Ujjain");
await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
await toast("Saved on this device");
log("Sharma's city changed offline");

await page.getByRole("button", { name: /Offline.*7 changes waiting to sync/ }).click();
const waiting = page.getByRole("dialog");
await waiting.getByText("A1/26-27/0003").waitFor();
for (const what of ["New customer", "Payment received", "Order", "Customer details"]) await waiting.getByText(what, { exact: true }).first().waitFor();
await page.screenshot({ path: `${OUT}/offline-3-waiting.png` });
await waiting.getByRole("button", { name: "Close" }).click();
log("7 changes waiting: 3 bills, a new customer, a payment, an order and a customer change");

// Nothing readable on the device: customers, products and bills are stored encrypted.
const stored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("digital-bahi");
      req.onsuccess = () => {
        const tx = req.result.transaction(["kv", "outbox"]);
        const texts = [];
        let pending = 2;
        for (const name of ["kv", "outbox"]) {
          const all = tx.objectStore(name).getAll();
          all.onsuccess = () => {
            texts.push(JSON.stringify(all.result));
            if (--pending === 0) resolve(texts.join("\n"));
          };
        }
      };
    }),
);
for (const secret of ["Sharma Kirana", "Naya Kirana", "Lifebuoy", "9826012345", "Ujjain"]) if (stored.includes(secret)) errors.push(`"${secret}" readable in the device's storage`);
log("device storage checked:", stored.length, "characters, no customer, product or bill readable");

// Signing out needs the server.
await page.getByRole("button", { name: "Sign out" }).first().click({ timeout: 5000 }).catch(async () => {
  await page.getByRole("button", { name: /menu/i }).first().click();
  await page.getByRole("button", { name: "Sign out" }).first().click();
});
await toast("Connect to the internet to sign out.");
log("sign-out refused while offline");

// 5. Back online: the bills go to the server with their numbers.
await goOffline(false);
await page.getByRole("button", { name: /^Online$/ }).waitFor({ timeout: 60000 });
const synced = (await api("GET", "/invoices?q=A1/", token)).data;
log("server now has:", synced.map((i) => `${i.invoiceNumber} ${i.grandTotal}`).join(" | "));
if (synced.length !== 3) errors.push(`expected 3 synced bills, got ${synced.length}`);
const stockAfter = (await api("GET", "/catalog", token)).products.find((p) => p.id === soap.id).stock;
if (Number(stockAfter) !== 44) errors.push(`stock after sync ${stockAfter}, expected 44 (orders do not move stock)`);
const naya = (await api("GET", "/customers?q=Naya", token)).data;
if (naya.length !== 1) errors.push(`new customer on the server: ${naya.length}`);
const nayaBill = synced.find((i) => i.invoiceNumber === "A1/26-27/0003");
if (!naya[0] || nayaBill?.customerId !== naya[0].id) errors.push(`A1/26-27/0003 not billed to the new customer: ${JSON.stringify(nayaBill)}`);
const payments = (await api("GET", `/payments?direction=in`, token)).data.filter((p) => p.partyName === "Sharma Kirana" || p.customerId === sharma.id);
if (!payments.some((p) => Number(p.amount) === 50)) errors.push(`payment not synced: ${JSON.stringify(payments)}`);
const orders = (await api("GET", "/sales-orders", token)).data;
if (!orders.some((o) => o.customerId === naya[0]?.id || o.customerName === "Naya Kirana Stores")) errors.push(`order not synced: ${JSON.stringify(orders)}`);
const sharmaNow = await api("GET", `/customers/${sharma.id}`, token);
if (sharmaNow.city !== "Ujjain") errors.push(`Sharma's city ${sharmaNow.city}`);
log("server has the new customer", naya[0]?.code, "with its bill, the payment, the order; Sharma in", sharmaNow.city, "owing", sharmaNow.balance);
await page.getByRole("button", { name: /^Online$/ }).click();
await page.getByRole("dialog").getByText("Recently synced").waitFor();
await page.screenshot({ path: `${OUT}/offline-4-synced.png` });
await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
log("synced; stock now", stockAfter);

// 6. The network drops in the middle of work: the bill is kept, then sent by itself.
await page.goto(`${WEB}/#invoice`);
await page.getByPlaceholder("Search customer by name, mobile, GSTIN or code").waitFor({ timeout: 15000 });
await goOffline(true);
await bill("Sharma", "lifebuoy", 2);
await toast("Invoice A1/26-27/0004 saved");
await goOffline(false);
for (let i = 0; i < 30; i++) {
  const found = (await api("GET", "/invoices?q=A1/26-27/0004", token)).data;
  if (found.length === 1) break;
  await page.waitForTimeout(500);
}
const third = (await api("GET", "/invoices?q=A1/26-27/0004", token)).data;
if (third.length !== 1) errors.push("third bill not synced after the network returned");
log("bill made during a drop synced:", third.map((i) => i.invoiceNumber).join(", "));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
