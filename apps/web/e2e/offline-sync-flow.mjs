/**
 * End-to-end check of Phase 5.3 on the production build: a second start loads
 * only what changed (the pull feed, no catalogue download) -> the connection
 * goes -> a bill for Gupta Stores and a new city for Sharma Kirana are made
 * on the device -> meanwhile, at the office, Gupta Stores is made inactive,
 * Sharma's mobile number is changed and the soap's price goes up -> back
 * online: the bill is taken but held for review, Sharma keeps both changes
 * (merged field by field), the device has the new price and no longer lists
 * Gupta Stores, all without loading everything again -> the owner sees the
 * held bill on the home screen and in the bell, opens it, reads why and marks
 * it reviewed -> Settings → Devices says everything on the device was sent.
 *
 * Build the app and serve it with the API behind /api:
 *   pnpm --filter @digitalbahi/web build && (cd apps/web && npx vite preview --port 4173)
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:4173 node apps/web/e2e/offline-sync-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98767${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

async function api(method, path, token, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), "x-client": "native", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
let signedIn = false;
let offline = false;
/** What the app asked the server for. */
const asked = [];
page.on("request", (r) => r.url().includes("/api/v1/") && asked.push(new URL(r.url()).pathname + new URL(r.url()).search));
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  // Without a network the app's requests fail by design; the live notifications stream is cut on reload.
  // (A request cut by the test's own navigation is aborted, and the app sends it again.)
  if (!offline && r.url().includes("/api/") && !r.url().includes("/notifications/stream") && r.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`);
});
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });

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
const goOffline = async (value) => {
  offline = value;
  await context.setOffline(value);
};
const openCustomer = async (name) => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("cell", { name: new RegExp(name) }).first().click({ timeout: 15000 });
  await page.getByRole("heading", { name: new RegExp(name) }).waitFor({ timeout: 15000 });
};

try {
  // 1. Sign up; the master data.
  await page.goto(WEB);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Mohan Lal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Mohan Traders");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Mohan/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soap = await api("POST", "/products", token, { name: "Lifebuoy Soap 100g", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", openingStock: "50" });
  const sharma = await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23", city: "Indore" });
  const gupta = await api("POST", "/customers", token, { name: "Gupta Stores", mobile: "9826054321", stateCode: "23", city: "Dewas" });

  // 2. Loaded online and kept on the device; the next start loads only what changed.
  await page.reload();
  await page.getByRole("heading", { name: /, Mohan/ }).waitFor({ timeout: 15000 });
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
  await page.waitForTimeout(1000);
  asked.length = 0;
  await page.reload();
  await page.getByRole("heading", { name: /, Mohan/ }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  if (asked.some((u) => u.startsWith("/api/v1/catalog"))) errors.push(`second start downloaded the catalogue: ${asked.filter((u) => u.includes("catalog")).join(", ")}`);
  if (!asked.some((u) => u.startsWith("/api/v1/sync/pull?cursor="))) errors.push(`second start did not pull: ${asked.join(", ")}`);
  log("second start: only what changed (pull feed), no catalogue download:", asked.filter((u) => u.includes("/sync/pull")).length, "pull");

  // 3. Offline: a bill for Gupta Stores, and Sharma moves to Ujjain.
  await goOffline(true);
  await page.goto(`${WEB}/#invoice`);
  await page.getByText("A1/26-27/0001").first().waitFor({ timeout: 15000 }).catch(() => undefined);
  const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
  if (!(await customerBox.isVisible().catch(() => false))) {
    // The reload above was online; a page opened without network asks for the password.
    await page.fill("#unlock-password", password);
    await page.getByRole("button", { name: "Open", exact: true }).click();
  }
  await customerBox.waitFor({ timeout: 15000 });
  await customerBox.fill("Gupta");
  await page.keyboard.press("Enter");
  await page.getByPlaceholder(/Search product/).fill("lifebuoy");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.getByLabel(/^Qty /).first().fill("2");
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "Save invoice" }).click();
  if ((await savedBill(page)) !== "A1/26-27/0001") errors.push("the offline bill is not A1/26-27/0001");
  await openCustomer("Sharma Kirana");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.fill("#c-city", "Ujjain");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await toast("Saved on this device");
  log("offline: bill A1/26-27/0001 for Gupta Stores; Sharma's city changed to Ujjain");

  // Meanwhile at the office.
  await api("PATCH", `/customers/${gupta.id}`, token, { isActive: false });
  const sharmaV = (await api("GET", `/customers/${sharma.id}`, token)).version;
  await api("PATCH", `/customers/${sharma.id}`, token, { mobile: "9826099999" }, { "if-match": String(sharmaV) });
  await api("PATCH", `/products/${soap.id}`, token, { sellingPrice: "45" });
  log("meanwhile: Gupta Stores made inactive, Sharma's mobile changed, soap now ₹45");

  // 4. Back online.
  asked.length = 0;
  await goOffline(false);
  await page.getByRole("button", { name: /^Online$/ }).waitFor({ timeout: 60000 });
  let held = [];
  for (let i = 0; i < 30 && !held.length; i++) {
    held = (await api("GET", "/invoices?review=needs_review", token)).data;
    if (!held.length) await page.waitForTimeout(500);
  }
  if (held.map((x) => x.invoiceNumber).join() !== "A1/26-27/0001") errors.push(`held for review: ${JSON.stringify(held)}`);
  const bill = await api("GET", `/invoices/${held[0]?.id}`, token);
  if (bill.reviewReasons?.[0]?.code !== "customer_inactive") errors.push(`reasons ${JSON.stringify(bill.reviewReasons)}`);
  const sharmaNow = await api("GET", `/customers/${sharma.id}`, token);
  if (sharmaNow.city !== "Ujjain" || sharmaNow.mobile !== "9826099999") errors.push(`Sharma not merged: ${sharmaNow.city} ${sharmaNow.mobile}`);
  log(`synced: A1/26-27/0001 held for review (${bill.reviewReasons?.map((r) => r.code).join(", ")}); Sharma: city ${sharmaNow.city}, mobile ${sharmaNow.mobile}`);
  await page.getByRole("button", { name: /^Online$/ }).click();
  await page.getByRole("dialog").getByText("Held for review: the server took it, and a manager will check it").waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/sync-1-held.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  // The device brought itself up to date without loading everything: the new price, no Gupta Stores.
  await page.waitForTimeout(1500);
  if (asked.some((u) => u.startsWith("/api/v1/catalog"))) errors.push("the sync downloaded the whole catalogue");
  await page.goto(`${WEB}/#invoice`);
  const box = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
  await box.waitFor({ timeout: 15000 });
  await box.fill("Gupta");
  await page.waitForTimeout(500);
  if (await page.getByRole("option", { name: /Gupta Stores/ }).count()) errors.push("Gupta Stores is still offered on the device");
  await box.fill("Sharma");
  await page.keyboard.press("Enter");
  await page.getByPlaceholder(/Search product/).fill("lifebuoy");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  const rate = await page.getByLabel(/^Rate /).first().inputValue().catch(() => "");
  if (Number(rate) !== 45) errors.push(`rate on the device ${rate}, expected 45`);
  log("the device has the new price (₹45) and no longer offers Gupta Stores, without a catalogue download");

  // 5. The owner sees the held bill, opens it from the home screen and marks it reviewed.
  await page.goto(`${WEB}/#dashboard`);
  await page.getByText("Offline bills to review").waitFor({ timeout: 15000 });
  await page.getByText("Gupta Stores had been made inactive.").first().waitFor();
  await page.getByText("Offline bills to review").scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/sync-2-home.png` });
  await page.getByRole("button", { name: /A1\/26-27\/0001 · Gupta Stores/ }).click();
  await page.getByRole("heading", { name: "A1/26-27/0001" }).waitFor({ timeout: 15000 });
  const card = page.getByRole("region", { name: "Made offline, held for review" });
  await card.getByText("Gupta Stores had been made inactive.").waitFor();
  await card.getByLabel("What was done (optional)").fill("Shop reopened; bill stands");
  await page.screenshot({ path: `${OUT}/sync-3-review.png`, fullPage: true });
  await card.getByRole("button", { name: "Mark reviewed" }).click();
  await toast("Marked reviewed");
  await page.getByText("Made offline, reviewed").waitFor({ timeout: 15000 });
  await page.getByText(/Reviewed by Mohan Lal, .* · Shop reopened; bill stands/).waitFor();
  const reviewed = await api("GET", `/invoices/${held[0].id}`, token);
  if (reviewed.reviewStatus !== "reviewed") errors.push(`after review: ${reviewed.reviewStatus}`);
  log("the owner opened it from the home screen and marked it reviewed");

  // The bell had it too.
  const notes = (await api("GET", "/notifications", token)).data;
  if (!notes.some((n) => n.type === "offline_review" && n.entityId === held[0].id)) errors.push("no notification for the held bill");

  // 6. Settings → Devices: nothing left on the device.
  await page.goto(`${WEB}/#settings`);
  const row = page.getByRole("row").filter({ hasText: "A1" });
  await row.getByText("All sent").waitFor({ timeout: 15000 });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const device = (await api("GET", "/devices", token)).data[0];
  if (device.queueWaiting !== 0 || !device.queueReportedAt) errors.push(`device queue ${JSON.stringify(device)}`);
  await page.screenshot({ path: `${OUT}/sync-4-devices.png` });
  log("Settings → Devices: everything on the device was sent");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/sync-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
process.exit(errors.length ? 1 : 0);
