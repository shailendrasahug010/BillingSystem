/**
 * End-to-end check of the app's own confirm box and of Tally's F-keys.
 * A device is registered -> Settings, Remove device -> the app's dialog asks
 * (no browser confirm) -> Cancel keeps it -> Remove device removes it.
 * Then F8 opens a sales bill, F9 a purchase, F6 a receipt, F5 a payment and
 * F7 an expense, also from inside a text field. In the shortcuts list (?) the
 * Tally keys are switched off: F8 does nothing, and stays off after a reload.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/confirm-keys-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98774${String(Date.now()).slice(-5)}`;
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
// The browser's own confirm() must never show.
page.on("dialog", (d) => {
  errors.push(`browser ${d.type()} shown: ${d.message()}`);
  void d.dismiss();
});
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const hash = () => page.evaluate(() => location.hash);

// 1. Sign up; a phone that bills offline is registered.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kavita Rao");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Kavita Agencies");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
await api("POST", "/devices", token, { name: "Old phone", platform: "android" });
log("signed up; a device registered");

// 2. Removing it asks in the app's own dialog.
await page.goto(`${WEB}/#settings`);
await page.reload();
const removeButton = page
  .locator(":is(li,tr,div):visible", { hasText: "Old phone" })
  .filter({ has: page.getByRole("button", { name: "Remove device" }) })
  .last()
  .getByRole("button", { name: "Remove device" });
await removeButton.waitFor({ timeout: 15000 });
await removeButton.click();
const ask = page.getByRole("dialog", { name: "Remove this device?" });
await ask.waitFor();
check((await ask.innerText()).includes("Old phone"), "the dialog does not name the device");
await page.screenshot({ path: `${OUT}/confirm-1-remove-device.png` });
await ask.getByRole("button", { name: "Cancel" }).click();
await ask.waitFor({ state: "detached" });
check(!(await api("GET", "/devices", token)).data.find((d) => d.name === "Old phone").revokedAt, "Cancel removed the device");
log("Cancel: the device stays");
await removeButton.click();
await ask.getByRole("button", { name: "Remove device" }).click();
await toast("Device removed");
check(!!(await api("GET", "/devices", token)).data.find((d) => d.name === "Old phone").revokedAt, "the device was not removed");
log("Remove device: removed, no browser confirm");

// 3. Tally keys, from the dashboard and from a text field.
await page.goto(`${WEB}/#dashboard`);
await page.reload();
await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
await page.keyboard.press("F8");
const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
await customerBox.waitFor({ timeout: 15000 });
log("F8:", await hash());
await customerBox.click();
await page.keyboard.press("F9");
await page.waitForFunction(() => location.hash.startsWith("#purchase-new"), null, { timeout: 15000 });
log("F9 (typing in the customer box):", await hash());
await page.keyboard.press("F6");
await page.getByRole("dialog").first().waitFor({ timeout: 15000 });
log("F6:", await hash(), "·", (await page.getByRole("dialog").first().innerText()).split("\n")[0]);
check((await hash()).includes("collect"), `F6 opened ${await hash()}`);
await page.keyboard.press("Escape");
await page.keyboard.press("F5");
await page.waitForFunction(() => location.hash.includes("pay") && !location.hash.includes("collect"), null, { timeout: 15000 });
await page.getByRole("dialog").first().waitFor({ timeout: 15000 });
log("F5 (no reload):", await hash(), "·", (await page.getByRole("dialog").first().innerText()).split("\n")[0]);
await page.keyboard.press("Escape");
await page.keyboard.press("F7");
await page.getByRole("dialog").first().waitFor({ timeout: 15000 });
log("F7:", await hash(), "·", (await page.getByRole("dialog").first().innerText()).split("\n")[0]);
check((await hash()).startsWith("#expenses"), `F7 opened ${await hash()}`);
await page.keyboard.press("Escape");

// 4. Switched off in the shortcuts list, and still off after a reload.
await page.goto(`${WEB}/#dashboard`);
await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
await page.keyboard.press("Shift+?");
const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
await help.waitFor();
await help.getByText("Tally keys (F5 to F9)").click();
await page.screenshot({ path: `${OUT}/confirm-2-tally-off.png` });
await page.keyboard.press("Escape");
await page.reload();
await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
await page.keyboard.press("F8");
await page.waitForTimeout(800);
check((await hash()) === "#dashboard", `F8 still works when switched off: ${await hash()}`);
log("Tally keys off: F8 does nothing after a reload");

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
