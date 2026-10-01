/**
 * End-to-end check of notifications (Phase 5.2): a new business with a
 * product below its minimum stock -> on Notifications → Reminder rules the
 * owner runs the low-stock check now ("Check now") -> the bell shows it
 * without a reload (the live stream) -> an order comes in through the API ->
 * within seconds the bell counts it, again without a reload -> opening it
 * from the bell goes to the order and marks it read -> in the inbox the
 * reminder is dismissed and the rest marked read -> in Hindi the texts read
 * in Hindi -> the low-stock rule's hour is changed and kept.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true and the
 * outbox worker on (OUTBOX_WORKER_SECONDS, default 5):
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/notifications-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98769${run}`;
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
let signedIn = false;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
/** The unread count on the bell (0 when it shows none). */
const badge = async () => {
  const b = page.getByTestId("unread-badge");
  return (await b.count()) ? Number(await b.textContent()) : 0;
};
const bell = () => page.getByRole("banner").getByRole("button", { name: /^Notifications/ });

try {
  // 1. A new business, signed up in the browser.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Meena Agarwal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Agarwal Traders");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const oil = await api("POST", "/products", token, { name: "Fortune Oil 1L", hsnCode: "1512", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "8", minStock: "40" });
  const shop = await api("POST", "/customers", token, { name: "Verma Kirana", stateCode: "23" });
  log("signed up; Fortune Oil has 8 in stock against a minimum of 40");

  // 2. Reminder rules: the low-stock check, run now.
  await bell().click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "See all" }).click();
  await page.getByRole("heading", { name: "Notifications" }).waitFor();
  await page.getByRole("tab", { name: "Reminder rules" }).click();
  const lowStock = page.locator('[data-rule="low_stock"]');
  await lowStock.getByText("Low stock").first().waitFor();
  await lowStock.getByRole("button", { name: "Check now" }).click();
  // "already" if the API's own daily check got there first.
  await page.getByText(/Checked: the notification is in the inbox|Already notified today/).first().waitFor();
  const start = Date.now();
  while ((await badge()) < 1) {
    if (Date.now() - start > 10000) throw new Error("the bell did not count the low-stock reminder");
    await page.waitForTimeout(200);
  }
  log(`'Check now' on Low stock: the bell shows ${await badge()} without a reload`);
  await page.screenshot({ path: `${OUT}/notifications-1-rules.png` });

  // 3. An order comes in: the bell counts it within seconds, without a reload.
  const before = await badge();
  const order = await api("POST", "/sales-orders", token, { customerId: shop.id, lines: [{ productId: oil.id, qty: "6" }] });
  const sent = Date.now();
  while ((await badge()) !== before + 1) {
    if (Date.now() - sent > 20000) throw new Error(`the bell did not count the new order (still ${await badge()})`);
    await page.waitForTimeout(200);
  }
  log(`order ${order.orderNumber} placed; the bell went from ${before} to ${await badge()} in ${((Date.now() - sent) / 1000).toFixed(1)} s`);

  // 4. From the bell: the order, which is then read.
  await bell().click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  const item = panel.getByRole("button", { name: new RegExp(`Order ${order.orderNumber.replace(/\//g, "\\/")} from Verma Kirana is waiting for confirmation`) });
  await item.waitFor();
  await panel.getByText("Fortune Oil 1L").or(panel.getByText(/1 product is at or below its minimum stock/)).first().waitFor();
  await page.screenshot({ path: `${OUT}/notifications-2-bell.png` });
  await item.click();
  await page.getByRole("heading", { name: new RegExp(order.orderNumber) }).waitFor();
  const read = Date.now();
  while ((await badge()) !== before) {
    if (Date.now() - read > 10000) throw new Error("opening the order did not mark it read");
    await page.waitForTimeout(200);
  }
  log("opened from the bell: the order's screen, and the notification is read");

  // 5. The inbox: the reminder dismissed, then everything marked read.
  await bell().click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "See all" }).click();
  await page.getByRole("heading", { name: "Notifications" }).waitFor();
  /** Switches the inbox filter and waits for that list (the previous one shows meanwhile). */
  const filter = async (name, status) => {
    const loaded = page.waitForResponse((r) => r.url().includes(`/notifications?status=${status}`) && r.ok());
    await page.getByRole("radio", { name }).click();
    await loaded;
  };
  await filter("Unread", "unread");
  const inbox = page.getByRole("list", { name: "Inbox" });
  const reminder = inbox.getByRole("listitem").filter({ hasText: "1 product is at or below its minimum stock" });
  await reminder.waitFor();
  if (await inbox.getByText(new RegExp(`Order ${order.orderNumber.replace(/\//g, "\\/")}`)).count()) errors.push("the order read from the bell is still under Unread");
  await reminder.getByRole("button", { name: "Dismiss" }).click();
  await reminder.waitFor({ state: "detached" });
  await filter("All", "all");
  await inbox.getByRole("listitem").first().waitFor();
  if (await inbox.getByText("1 product is at or below its minimum stock").count()) errors.push("a dismissed notification is still listed");
  const markAll = page.getByRole("button", { name: "Mark all as read" });
  if (await markAll.count()) await markAll.click();
  const counts = await api("GET", "/notifications/unread-count", token);
  if (counts.unread !== 0) errors.push(`unread after reading everything: ${counts.unread}`);
  log("in the inbox: the reminder dismissed, nothing left unread");

  // 6. In Hindi.
  await page.getByRole("radio", { name: "हिं" }).first().click();
  await page.getByRole("heading", { name: "सूचनाएँ" }).waitFor();
  await page.getByText(new RegExp(`Verma Kirana का ऑर्डर ${order.orderNumber.replace(/\//g, "\\/")} पुष्टि की प्रतीक्षा में है`)).waitFor();
  await page.screenshot({ path: `${OUT}/notifications-3-hindi.png` });
  await page.getByRole("radio", { name: "EN" }).first().click();
  log("in Hindi the notifications read in Hindi");

  // 7. A rule's hour, changed and kept.
  await page.getByRole("tab", { name: "Reminder rules" }).click();
  await page.getByLabel("Low stock: Check after").selectOption("8");
  await page.getByText("Reminder rule saved").first().waitFor();
  const rules = await api("GET", "/reminder-rules", token);
  const rule = rules.data.find((r) => r.type === "low_stock");
  if (rule.config.hour !== 8) errors.push(`low_stock hour ${JSON.stringify(rule.config)}`);
  log("Low stock now checks after 8 am");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/notifications-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

if (errors.length) {
  console.error("FAILED:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("notifications flow passed");
