/**
 * End-to-end check of the purchase-history service (Phase 5.1): a shop that
 * buys milk and bread every week, five weeks running -> the API's outbox
 * worker stores its figures by itself within seconds (the insight now comes
 * from the stored figures, the same as worked out live) -> the shop is on
 * "customers due to reorder" with milk and bread due -> on New Invoice the
 * suggestions say "Usually every 7 days · last bought 7 days ago"; milk is
 * added from them, bread from the product search -> the bill is saved -> the
 * feedback the screen sent counts what was offered and the one taken from
 * the suggestions -> the worker updates the figures for the new bill, and
 * the shop is no longer due.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true and the
 * worker on (OUTBOX_WORKER_SECONDS, default 5):
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/purchase-history-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98768${run}`;
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
/** Waits until `check` returns something truthy (the worker runs every few seconds). */
async function until(what, check, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
/** A date `days` before today in India, as the API counts days. */
const daysAgo = (days) => new Date(Date.now() + 5.5 * 3_600_000 - days * 86_400_000).toISOString().slice(0, 10);

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
let signedIn = false;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

try {
  // 1. A new business, signed up in the browser.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Ramesh Gupta");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Gupta Dairy Distributors");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Ramesh/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;

  // 2. Five weeks of milk and bread for one shop.
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const product = (name, price) => api("POST", "/products", token, { name, hsnCode: "0401", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: price, openingStock: "500" });
  const milk = await product("Toned Milk 500ml", "28");
  const bread = await product("Bread 400g", "40");
  const shop = await api("POST", "/customers", token, { name: "ABC General Store", stateCode: "23", creditDays: 7 });
  for (const ago of [35, 28, 21, 14, 7]) {
    await api("POST", "/invoices", token, { customerId: shop.id, invoiceDate: daysAgo(ago), lines: [{ productId: milk.id, qty: "24" }, { productId: bread.id, qty: "10" }] });
  }
  log("ABC General Store bought 24 milk and 10 bread every week for five weeks");

  // 3. The worker stores the figures by itself; the insight is then read from them.
  const stored = await until("the worker to store the figures", async () => {
    const ins = await api("GET", `/customers/${shop.id}/insight`, token);
    return ins.source === "stored" ? ins : null;
  });
  const milkStats = stored.stats.find((s) => s.productId === milk.id);
  if (milkStats?.orderCount !== 5 || milkStats.typicalIntervalDays !== 7 || milkStats.lastQty !== "24") errors.push(`milk stats ${JSON.stringify(milkStats)}`);
  const due = await api("GET", "/reorder/due", token);
  const abc = due.customers.find((c) => c.customerId === shop.id);
  if (!abc || abc.due !== 2) errors.push(`reorder due: ${JSON.stringify(due.customers)}`);
  log("the worker stored the figures within seconds (milk: 5 orders, every 7 days); ABC is due to reorder", abc?.products.map((p) => `${p.productName} ${p.status} (${p.suggestedQty})`).join(", "));

  // 4. A new bill: the suggestions explain themselves; milk is taken from them.
  await page.reload();
  await page.getByRole("heading", { name: /Ramesh/ }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Control+i");
  await page.getByRole("heading", { name: "New Invoice" }).waitFor();
  await page.keyboard.type("ABC");
  await page.getByRole("option", { name: /ABC General Store/ }).first().click();
  await page.getByText(/Usually every 7 days · last bought 7 days ago/).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${OUT}/history-1-suggestions.png` });
  await page.getByRole("button", { name: "Add 24 Toned Milk 500ml" }).click();
  await page.getByLabel("Qty Toned Milk 500ml").waitFor();
  // Bread the usual way, from the product search.
  await page.getByPlaceholder(/Search product/).first().fill("bread");
  await page.getByRole("option", { name: /Bread 400g/ }).waitFor();
  await page.keyboard.press("Enter");
  await page.getByLabel("Qty Bread 400g").fill("10");
  await page.keyboard.press("Control+Enter");
  await savedBill(page);
  log("milk added from the suggestions, bread from the search; bill saved");

  // 5. The screen sent what it offered and what was taken.
  const summary = await until("the feedback", async () => {
    const s = await api("GET", "/suggestions/feedback/summary?from=2000-01-01&to=2099-12-31", token);
    return s.sessions ? s : null;
  });
  const reorder = summary.byGroup.find((g) => g.group === "reorder");
  if (summary.savedBills !== 1 || summary.added !== 1 || summary.shown < 2 || reorder.added !== 1 || summary.linesFromSuggestions !== 1 || summary.invoiceLines !== 12) {
    errors.push(`feedback summary ${JSON.stringify(summary)}`);
  }
  log(`feedback: ${summary.shown} offered, ${summary.added} taken (${reorder.added} of ${reorder.shown} reorder), ${summary.linesFromSuggestions} of ${summary.invoiceLines} bill lines from suggestions`);

  // 6. The worker updates the figures for the new bill: ABC is no longer due.
  await until("the figures to include today's bill", async () => {
    const ins = await api("GET", `/customers/${shop.id}/insight`, token);
    return ins.source === "stored" && ins.summary.invoiceCount === 6 ? ins : null;
  });
  const after = await api("GET", "/reorder/due", token);
  if (after.customers.some((c) => c.customerId === shop.id)) errors.push("ABC still due after today's bill");
  log("after the bill the worker updated the figures (6 bills) and ABC is no longer due");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/history-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

if (errors.length) {
  console.error("FAILED:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("purchase-history flow passed");
