/**
 * Three phones on a weak network (Phase 5.3): the owner and two salespeople,
 * each on a phone-sized browser with its own device series, work offline —
 * bills, a payment, a bill cancelled before it was ever sent, a discount on
 * a kept bill — then all come back at once on a slow, lossy connection (high
 * latency, little bandwidth, one phone's line dropping in the middle of
 * sending). Everything reaches the server once: no duplicate, each device's
 * numbers unbroken, the cancelled bill cancelled, the discount against its
 * bill, stock as the documents say, nothing left waiting, and the work went
 * in few requests (POST /sync/push carries many at once).
 *
 * Build the app and serve it with the API behind /api:
 *   pnpm --filter @digitalbahi/web build && (cd apps/web && npx vite preview --port 4173)
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:4173 node apps/web/e2e/weak-network-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const ownerMobile = `98766${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), "x-client": "native" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const errors = [];

/**
 * The popup a saved bill opens ("Invoice added successfully"): its number, then on to a new bill,
 * or to the bill itself with view.
 */
async function savedBill(page, { view = false } = {}) {
  const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
  await popup.waitFor({ timeout: 20000 });
  const number = (await popup.innerText()).match(/[A-Z][A-Z0-9]*\/\d\d-\d\d\/\d+/)?.[0] ?? "";
  await popup.getByRole("button", { name: view ? "View invoice" : "New invoice" }).click();
  await popup.waitFor({ state: "detached" });
  return number;
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** A phone: its own browser profile, phone-sized, with its own network. */
async function phone(name) {
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const p = { name, context, page, offline: false, signedIn: false, pushes: 0, cdp: await context.newCDPSession(page) };
  await p.cdp.send("Network.enable");
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`${name}: ${m.text()}`));
  page.on("request", (r) => r.url().endsWith("/api/v1/sync/push") && p.pushes++);
  page.on("response", (r) => {
    if (!p.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${name}: ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return p;
}
const setOffline = async (p, value) => {
  p.offline = value;
  await p.context.setOffline(value);
};
/** A weak mobile connection: 600 ms each way, 40 KB/s down, 20 KB/s up. */
const weak = (p) => p.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 600, downloadThroughput: 40 * 1024, uploadThroughput: 20 * 1024 });
const toast = (p, text) => p.page.getByText(text).first().waitFor({ timeout: 20000 });
/** Waits until the phone has its device series and its copy of the business. */
const keptOnDevice = (p) =>
  p.page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("digital-bahi");
        req.onsuccess = () => {
          const all = req.result.transaction("kv").objectStore("kv").getAllKeys();
          all.onsuccess = () => resolve(["device:", "snapshot:", "docs:"].every((prefix) => all.result.some((k) => String(k).startsWith(prefix))));
        };
        req.onerror = () => resolve(false);
      }),
    null,
    { timeout: 30000 },
  );

/** A bill on the phone's bill screen; returns the number the device gave it. */
let current = null;
async function bill(p, customer, qty, { view = false } = {}) {
  const page = p.page;
  current = page;
  await page.goto(`${WEB}/#invoice`);
  const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
  await customerBox.waitFor({ timeout: 20000 });
  await customerBox.fill(customer);
  await page.keyboard.press("Enter");
  await page.getByPlaceholder(/Search product/).fill("lifebuoy");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  // On a phone the quantity has − and + buttons.
  for (let i = 1; i < qty; i++) {
    const plus = page.getByRole("button", { name: "+1" }).first();
    // Above the bill's total bar, as a thumb would scroll it.
    await plus.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await plus.click();
  }
  // On a phone: on to the review step, then save.
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Save invoice" }).click();
  return savedBill(page, { view });
}

try {
  // 1. The owner signs up on the first phone; the master data and two salespeople.
  const a = await phone("owner");
  await a.page.goto(WEB);
  await a.page.evaluate(() => navigator.serviceWorker.ready);
  await a.page.getByRole("button", { name: "Create account" }).click();
  await a.page.fill("#su-name", "Prakash Jain");
  await a.page.fill("#su-mobile", ownerMobile);
  await a.page.fill("#su-password", password);
  await a.page.fill("#su-business", "Jain Distributors");
  await a.page.getByRole("button", { name: "Send OTP" }).click();
  const hint = a.page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await a.page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await a.page.getByRole("button", { name: "Verify and create account" }).click();
  await a.page.getByRole("heading", { name: /Prakash/ }).waitFor({ timeout: 20000 });
  a.signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: ownerMobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soap = await api("POST", "/products", token, { name: "Lifebuoy Soap 100g", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", openingStock: "300", openingStockCost: "30" });
  for (const [name, mobile] of [["Sharma Kirana", "9826011111"], ["Gupta Stores", "9826022222"], ["Verma General", "9826033333"]]) await api("POST", "/customers", token, { name, mobile, stateCode: "23" });
  const verma = (await api("GET", "/customers?q=Verma", token)).data[0];
  const kept = await api("POST", "/invoices", token, { customerId: verma.id, lines: [{ productId: soap.id, qty: "10" }] });
  const roles = Object.fromEntries((await api("GET", "/roles", token)).data.map((r) => [r.key, r.id]));
  const staff = [];
  for (const [n, who] of [["1", "Ravi"], ["2", "Sunil"]]) {
    const username = `${who.toLowerCase()}${run}`;
    await api("POST", "/members", token, { name: `${who} Salesman`, mobile: `9876${n}${run}0`.slice(0, 10), roleId: roles.sales, username, password: `${who}-pass-2026` });
    staff.push({ name: who, username, password: `${who}-pass-2026` });
  }
  log("owner signed up; 300 soaps, three customers, a bill kept on the server (", kept.invoiceNumber, "), two salespeople");

  // 2. The salespeople sign in on their phones; each phone keeps its copy and gets its own series.
  const b = await phone(staff[0].name);
  const c = await phone(staff[1].name);
  for (const [p, s] of [[b, staff[0]], [c, staff[1]]]) {
    await p.page.goto(WEB);
    await p.page.evaluate(() => navigator.serviceWorker.ready);
    await p.page.fill("#auth-id", s.username);
    await p.page.fill("#auth-password", s.password);
    await p.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await p.page.getByRole("heading", { name: new RegExp(s.name) }).waitFor({ timeout: 20000 });
    p.signedIn = true;
  }
  await a.page.reload();
  await a.page.getByRole("heading", { name: /Prakash/ }).waitFor({ timeout: 20000 });
  await Promise.all([a, b, c].map(keptOnDevice));
  const series = (await api("GET", "/devices", token)).data.map((d) => d.seriesCode).sort();
  if (series.length !== 3 || new Set(series).size !== 3) errors.push(`device series: ${series.join(", ")}`);
  log("three phones, each with its own series:", series.join(", "));

  // 3. A day without a connection.
  for (const p of [a, b, c]) await setOffline(p, true);
  const made = { owner: [], [staff[0].name]: [], [staff[1].name]: [] };
  made.owner.push(await bill(a, "Sharma", 3));
  // The owner opens the second bill from its popup and cancels it before it was ever sent.
  made.owner.push(await bill(a, "Gupta", 2, { view: true }));
  await a.page.getByRole("heading", { name: made.owner[1] }).waitFor({ timeout: 20000 });
  await a.page.getByRole("button", { name: "Cancel bill" }).click();
  await a.page.getByLabel("Reason").fill("Customer did not take it");
  await a.page.getByRole("button", { name: "Cancel the bill" }).click();
  await toast(a, "Saved on this device");
  await a.page.getByText("Cancelled on this device, waiting to send").waitFor({ timeout: 20000 });
  // A 5% discount on Verma's kept bill, from the copy on the phone.
  await a.page.goto(`${WEB}/#customers`);
  await a.page.getByRole("button", { name: /Verma General/ }).first().click();
  await a.page.getByRole("tab", { name: "Invoices" }).click();
  await a.page.getByRole("cell", { name: kept.invoiceNumber }).click();
  await a.page.getByText("Copy on this device").first().waitFor({ timeout: 20000 });
  await a.page.getByRole("button", { name: "Discount / rate difference" }).click();
  await a.page.locator("#pn-value").fill("5");
  await a.page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
  await toast(a, "Saved on this device");
  log("owner, offline:", made.owner.join(", "), "(the second cancelled), and a 5% discount on", kept.invoiceNumber);

  made[staff[0].name].push(await bill(b, "Sharma", 1), await bill(b, "Gupta", 4), await bill(b, "Verma", 2));
  made[staff[1].name].push(await bill(c, "Gupta", 1), await bill(c, "Verma", 3), await bill(c, "Sharma", 2));
  // Ravi collects ₹100 from Sharma.
  await b.page.goto(`${WEB}/#customers`);
  await b.page.getByRole("button", { name: /Sharma Kirana/ }).first().click();
  await b.page.getByRole("button", { name: "Receive Payment" }).click();
  await b.page.getByText(/the payment is saved on this device/).waitFor({ timeout: 20000 });
  await b.page.fill("#pay-amount", "100");
  await b.page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
  await toast(b, "Saved on this device");
  log(`${staff[0].name}, offline:`, made[staff[0].name].join(", "), "and ₹100 from Sharma;", `${staff[1].name}:`, made[staff[1].name].join(", "));
  await a.page.screenshot({ path: `${OUT}/weak-network-1-owner.png` });

  // 4. Back at once on a weak connection; Ravi's line drops while he sends.
  for (const p of [a, b, c]) await weak(p);
  const started = Date.now();
  await Promise.all([a, b, c].map((p) => setOffline(p, false)));
  await b.page.waitForTimeout(700);
  await setOffline(b, true);
  await b.page.waitForTimeout(2500);
  await setOffline(b, false);
  const expected = { invoices: 1 + 2 + 3 + 3, payments: 1, notes: 1 };
  let counts = {};
  for (let i = 0; i < 120; i++) {
    const invoices = (await api("GET", "/invoices?limit=100", token)).data;
    const payments = (await api("GET", "/payments?limit=100", token)).data;
    const notes = (await api("GET", "/notes?limit=100", token)).data;
    counts = { invoices: invoices.length, payments: payments.length, notes: notes.length, cancelled: invoices.filter((x) => x.status === "cancelled").length };
    if (counts.invoices >= expected.invoices && counts.payments >= 1 && counts.notes >= 1 && counts.cancelled >= 1) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`on the weak line everything arrived in ${((Date.now() - started) / 1000).toFixed(0)} s:`, JSON.stringify(counts));

  // 5. Once each, numbers kept, stock and the discount right.
  const invoices = (await api("GET", "/invoices?limit=100", token)).data;
  if (invoices.length !== expected.invoices) errors.push(`${invoices.length} invoices on the server, not ${expected.invoices}`);
  const numbers = invoices.map((x) => x.invoiceNumber);
  if (new Set(numbers).size !== numbers.length) errors.push(`duplicate numbers: ${numbers.join(", ")}`);
  for (const list of Object.values(made)) for (const n of list) if (!numbers.includes(n)) errors.push(`${n} missing on the server`);
  // Each device's numbers run without a gap.
  for (const [who, list] of Object.entries(made)) {
    const seq = list.map((n) => Number(n.slice(-4)));
    if (seq.some((n, i) => n !== i + 1)) errors.push(`${who}'s numbers ${list.join(", ")} are not 1, 2, 3…`);
  }
  const cancelled = invoices.find((x) => x.invoiceNumber === made.owner[1]);
  if (cancelled?.status !== "cancelled") errors.push(`${made.owner[1]} is ${cancelled?.status}, not cancelled`);
  const notes = (await api("GET", "/notes?limit=100", token)).data;
  if (notes.length !== 1 || notes[0].reason !== "discount") errors.push(`notes: ${JSON.stringify(notes.map((n) => [n.reason, n.grandTotal]))}`);
  const payments = (await api("GET", "/payments?limit=100", token)).data;
  if (payments.length !== 1 || payments[0].amount !== "100.00") errors.push(`payments: ${JSON.stringify(payments.map((x) => x.amount))}`);
  const stock = (await api("GET", "/catalog", token)).products.find((x) => x.id === soap.id).stock;
  // 300 − 10 kept − 5 (owner, 2 of them back) − 7 (Ravi) − 6 (Sunil) + 2 cancelled.
  if (Number(stock) !== 274) errors.push(`stock ${stock}, not 274`);
  // Nothing left waiting on any phone, and the work went in few requests.
  for (let i = 0; i < 30; i++) {
    const devices = (await api("GET", "/devices", token)).data;
    if (devices.every((d) => d.queueWaiting === 0 && d.queueRefused === 0)) break;
    if (i === 29) errors.push(`still waiting on devices: ${JSON.stringify(devices.map((d) => [d.seriesCode, d.queueWaiting, d.queueRefused]))}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const entries = { owner: 4, [staff[0].name]: 4, [staff[1].name]: 3 };
  for (const p of [a, b, c]) {
    if (p.pushes === 0) errors.push(`${p.name} sent nothing through /sync/push`);
    if (p.pushes > entries[p.name]) errors.push(`${p.name} needed ${p.pushes} requests for ${entries[p.name]} entries`);
  }
  log("requests to /sync/push:", [a, b, c].map((p) => `${p.name} ${p.pushes} for ${entries[p.name]} entries`).join(", "));
  await b.page.screenshot({ path: `${OUT}/weak-network-2-synced.png` });
  log("once each, every series unbroken, the cancellation and the discount in, stock 274, nothing waiting");
} catch (e) {
  errors.push(String(e?.stack ?? e).split("\n").filter((l) => !l.includes("[2m")).slice(0, 6).join("\n"));
  await current?.screenshot({ path: `${OUT}/weak-network-error.png`, fullPage: false }).catch(() => {});
} finally {
  await browser.close();
}

// The line drops and the slow network make some requests fail by design; only real errors count.
const real = errors.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|ERR_NETWORK_CHANGED/.test(e));
if (real.length) {
  console.error("FAILED:\n" + real.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("weak network flow passed");
