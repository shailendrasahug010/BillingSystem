/**
 * End-to-end check that a device's saved copy does not outlive its welcome,
 * on the production build: sign up -> the phone keeps a copy -> offline, an
 * expense waits on it -> the owner removes the device (from elsewhere) -> the
 * phone connects: it is signed out, deletes the business's copy and the
 * waiting expense, and says so -> signed in again, the business allows 2 days
 * without connecting -> 3 days later (the copy's date moved back) the phone
 * starts offline: the copy is deleted instead of opened, and it says why.
 *
 * Build the app and serve it with the API behind /api:
 *   pnpm --filter @digitalbahi/web build && (cd apps/web && npx vite preview --port 4173)
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:4173 node apps/web/e2e/device-wipe-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98762${String(Date.now()).slice(-5)}`;
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
let expectAuthErrors = false;
let offline = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  // Signed out on purpose (the device was removed): the refresh is refused.
  if ((expectAuthErrors || !r.url().includes("/api/")) && r.status() === 401) return;
  if (r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  // A request cut off by a reload is not a failure of the app.
  if (!offline && r.url().includes("/api/") && r.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`);
});
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const goOffline = async (value) => {
  offline = value;
  await context.setOffline(value);
};
const idb = (fn, arg) =>
  page.evaluate(
    ([source, a]) =>
      new Promise((resolve) => {
        const req = indexedDB.open("digital-bahi");
        req.onsuccess = () => resolve(new Function("db", "arg", source)(req.result, a));
        req.onerror = () => resolve(null);
      }),
    [fn, arg],
  );
const kvKeys = () =>
  idb(`return new Promise((r) => { const q = db.transaction("kv").objectStore("kv").getAllKeys(); q.onsuccess = () => r(q.result.map(String)); });`);
const outboxCount = () => idb(`return new Promise((r) => { const q = db.transaction("outbox").objectStore("outbox").count(); q.onsuccess = () => r(q.result); });`);
const waitForKeys = async (prefixes) => {
  for (let i = 0; i < 40; i++) {
    const keys = await kvKeys();
    if (prefixes.every((p) => keys.some((k) => k.startsWith(p)))) return keys;
    await page.waitForTimeout(300);
  }
  return kvKeys();
};

// 1. Sign up: the phone keeps a copy of the business and registers itself.
await page.goto(WEB);
await page.evaluate(() => navigator.serviceWorker.ready);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Ravi Gupta");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Ravi Agencies");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Ravi/ }).waitFor({ timeout: 15000 });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
await page.reload();
await page.getByRole("heading", { name: /Ravi/ }).waitFor({ timeout: 15000 });
const before = await waitForKeys(["snapshot:", "device:", "vault:"]);
log("copy kept on the phone:", before.filter((k) => !k.startsWith("probe")).map((k) => k.split(":")[0]).join(", "));

// 2. Offline: an expense waits on the phone.
await goOffline(true);
await page.reload();
await page.fill("#unlock-password", password);
await page.getByRole("button", { name: "Open", exact: true }).click();
await page.getByRole("heading", { name: /Ravi/ }).waitFor({ timeout: 15000 });
await nav("Expenses");
await page.getByRole("button", { name: "New expense" }).click();
await dialog().getByLabel("Category").selectOption({ label: "Rent" });
await dialog().getByLabel("Amount before GST").fill("900");
await dialog().getByRole("button", { name: /^Save/ }).click();
await toast("Saved on this device");
if ((await outboxCount()) !== 1) errors.push("the expense is not waiting on the phone");
log("an expense of 900 waits on the phone");

// 3. The owner removes the phone (from another device).
const devices = (await api("GET", "/devices", token)).data;
if (devices.length !== 1 || devices[0].seriesCode !== "A1") errors.push(`devices: ${JSON.stringify(devices)}`);
await api("POST", `/devices/${devices[0].id}/revoke`, token, {});
log("the owner removed", devices[0].name);

// 4. The phone connects: signed out, copy and waiting work deleted, and it says so.
expectAuthErrors = true;
await goOffline(false);
await page.reload();
await page.getByText("The owner removed this device, so the copy of Ravi Agencies kept on it has been deleted. 1 entry that had not been sent was deleted with it.").waitFor({ timeout: 20000 });
await page.screenshot({ path: `${OUT}/device-wipe-1-removed.png` });
const after = await kvKeys();
for (const p of ["snapshot:", "docs:", "device:", "vault:", "synced:"]) if (after.some((k) => k.startsWith(p))) errors.push(`still on the phone after removal: ${p}`);
if ((await outboxCount()) !== 0) errors.push("waiting work still on the phone");
if ((await api("GET", "/expenses", token)).data.length !== 0) errors.push("the deleted expense reached the server");
const removed = (await api("GET", "/devices", token)).data.find((d) => d.id === devices[0].id);
if (!removed.wipedAt) errors.push("the device list does not show the copy was deleted");
log("phone signed out; copy, key and the waiting expense deleted; the owner's list says when");
expectAuthErrors = false;

// 5. Signed in again; the business allows 2 days without connecting.
await api("PUT", "/settings/offline.wipe_after_days", token, { value: 2 });
await page.fill("#auth-id", mobile);
await page.fill("#auth-password", password);
await page.getByRole("button", { name: "Sign in", exact: true }).click();
// Signed in again on the screen the link names (the one left before): the dashboard next.
await page.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 15000 });
await page.goto(`${WEB}/#dashboard`);
await page.getByRole("heading", { name: /Ravi/ }).waitFor({ timeout: 15000 });
await waitForKeys(["snapshot:", "device:"]);
if ((await api("GET", "/devices", token)).data.filter((d) => !d.revokedAt).length !== 1) errors.push("the phone did not register again");
// Three days pass without a connection (the copy's date is moved back).
const last = await idb(`return new Promise((r) => { const q = db.transaction("kv").objectStore("kv").get("snapshot:last"); q.onsuccess = () => r(q.result); });`);
if (last?.wipeAfterDays !== 2) errors.push(`the copy does not carry the 2-day rule: ${JSON.stringify(last)}`);
await idb(
  `return new Promise((r) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(arg, "snapshot:last"); tx.oncomplete = () => r(true); });`,
  { ...last, savedAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
);
await goOffline(true);
await page.reload();
await page.getByText("The copy of Ravi Agencies on this device was deleted: it went more than 2 days without connecting.").waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/device-wipe-2-expired.png` });
const expired = await kvKeys();
if (expired.some((k) => k.startsWith("snapshot:"))) errors.push("the expired copy is still on the phone");
if (!expired.some((k) => k.startsWith("device:"))) errors.push("the device record went with the expired copy");
log("after 3 days offline the copy was deleted instead of opened");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
