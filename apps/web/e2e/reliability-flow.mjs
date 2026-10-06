/**
 * Safer on a phone, on the production build:
 *  1. a bill whose save gets no answer (signal bars, nothing through) is kept
 *     on the device after a few seconds, not left spinning, and reaches the
 *     server once when it answers again;
 *  2. a purchase bill half typed in comes back after a reload;
 *  3. a PIN locks the app when it opens: a wrong PIN is refused, the right one opens it;
 *  4. pulling down at the top of a list refreshes it.
 *
 * Build the app and serve it with the API behind /api:
 *   pnpm --filter @digitalbahi/web build && (cd apps/web && npx vite preview --port 4173)
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:4173 node apps/web/e2e/reliability-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? ".";
const mobile = `98768${String(Date.now()).slice(-5)}`;
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
const check = (ok, message) => ok || errors.push(message);
let signedIn = false;
let holding = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  // The held save is given up on by design; a stream or request cut by a reload is not a failure.
  if (holding || r.failure()?.errorText === "net::ERR_ABORTED" || r.url().includes("/notifications/stream")) return;
  if (r.url().includes("/api/")) errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`);
});

try {
  // Sign up, a product, a customer and a supplier; loaded once so the business is kept on the device.
  await page.goto(WEB);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Ravi Jain");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Jain Agencies");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Ravi/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  await api("POST", "/products", token, { name: "Lifebuoy Soap 100g", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", purchasePrice: "30", openingStock: "50", openingStockCost: "30" });
  await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23", city: "Indore" });
  await api("POST", "/suppliers", token, { name: "HUL Depot", stateCode: "23", gstRegistration: "unregistered" });
  await page.reload();
  await page.getByRole("heading", { name: /, Ravi/ }).waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("digital-bahi");
        req.onsuccess = () => {
          const all = req.result.transaction("kv").objectStore("kv").getAllKeys();
          all.onsuccess = () => resolve(["device:", "snapshot:"].every((p) => all.result.some((k) => String(k).startsWith(p))));
        };
        req.onerror = () => resolve(false);
      }),
    null,
    { timeout: 20000 },
  );
  log("signed up on a phone; the business is kept on the device");

  // 1. The save gets no answer: kept on the device within seconds, then sent once.
  await page.route("**/api/v1/invoices", (route) => (route.request().method() === "POST" ? undefined : route.fallback()));
  holding = true;
  await page.goto(`${WEB}/#invoice`);
  await page.getByPlaceholder("Search name, mobile, GSTIN").fill("Sharma");
  await page.getByRole("option", { name: /Sharma Kirana/ }).first().click();
  await page.getByPlaceholder(/Search product/).fill("lifebuoy");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Next" }).click();
  const started = Date.now();
  await page.locator("[data-overlay=bottom]").filter({ hasText: "Grand total" }).getByRole("button", { name: "Save invoice" }).click();
  await page.getByText("Saved offline · will sync when online").first().waitFor({ timeout: 15000 });
  const waited = (Date.now() - started) / 1000;
  check(waited < 14, `the bill waited ${waited}s before it was kept on the device`);
  log(`no answer from the server: the bill was kept on the device after ${waited.toFixed(1)}s`);
  await page.screenshot({ path: `${OUT}/reliability-1-kept.png` });
  await page.unroute("**/api/v1/invoices");
  holding = false;
  await page.getByRole("dialog", { name: "Invoice added successfully" }).getByRole("button", { name: "New invoice" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  let bills = [];
  for (let i = 0; i < 30 && bills.length === 0; i++) {
    await page.waitForTimeout(1000);
    bills = (await api("GET", "/invoices", token)).data;
  }
  check(bills.length === 1, `expected 1 bill on the server, found ${bills.length}`);
  log("connection answers again: the bill reached the server once", bills.map((b) => b.invoiceNumber ?? b.number).join(", "));

  // 2. A purchase bill half typed in comes back after a reload.
  await page.goto(`${WEB}/#purchase-new`);
  const supplierBox = page.locator("#pu-supplier");
  await supplierBox.waitFor({ timeout: 15000 });
  await supplierBox.fill("HUL");
  await page.getByRole("option", { name: /HUL Depot/ }).first().click();
  await page.getByPlaceholder(/Search product/).fill("lifebuoy");
  await page.getByRole("option", { name: /Lifebuoy Soap 100g/ }).first().click();
  await page.getByText("Lifebuoy Soap 100g").first().waitFor();
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByText("Unfinished purchase bill brought back").first().waitFor({ timeout: 15000 });
  check((await page.getByText("Lifebuoy Soap 100g").count()) > 0, "the purchase line did not come back after the reload");
  check((await page.getByText(/HUL Depot/).count()) > 0, "the purchase supplier did not come back after the reload");
  await page.screenshot({ path: `${OUT}/reliability-2-purchase-kept.png`, fullPage: true });
  await page.getByRole("button", { name: "Start a new bill" }).click();
  log("a half-typed purchase bill came back after a reload");

  // 3. The PIN lock.
  await page.goto(`${WEB}/#profile`);
  await page.getByRole("button", { name: "Set a PIN" }).click();
  await page.getByRole("dialog", { name: "Choose a 4-digit PIN" }).waitFor();
  for (const d of "2580") await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("dialog", { name: "Type the same PIN again" }).waitFor();
  for (const d of "2580") await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Change PIN" }).waitFor({ timeout: 10000 });
  await page.reload();
  const lock = page.getByRole("dialog", { name: "Enter your PIN" });
  await lock.waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/reliability-3-pin.png` });
  for (const d of "1111") await lock.getByRole("button", { name: d, exact: true }).click();
  await lock.getByText("Wrong PIN. Try again.").waitFor();
  for (const d of "2580") await page.keyboard.press(d);
  await lock.waitFor({ state: "detached", timeout: 10000 });
  await page.getByRole("button", { name: "Change PIN" }).waitFor();
  log("the PIN lock: a wrong PIN refused, the right one opened the app");
  await page.getByRole("button", { name: "Remove PIN" }).click();

  // 4. Pull down at the top of the bills list.
  await page.goto(`${WEB}/#invoices`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  let asked = 0;
  page.on("request", (r) => r.url().includes("/api/v1/") && asked++);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 130 }] });
  for (let y = 150; y <= 430; y += 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y }] });
  await page.getByRole("status", { name: "Let go to refresh" }).waitFor({ timeout: 5000 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(1500);
  check(asked > 0, "pulling down did not refresh anything");
  log(`pulled down at the top of the bills: ${asked} requests refreshed the screen`);
} catch (e) {
  errors.push(`FAILED: ${e.message}`);
  await page.screenshot({ path: `${OUT}/reliability-failed.png`, fullPage: true }).catch(() => undefined);
}

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
if (errors.length) process.exit(1);
