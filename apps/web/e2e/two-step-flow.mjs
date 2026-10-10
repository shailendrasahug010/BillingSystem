/**
 * Two-step sign-in, end to end: the owner turns it on from My profile (QR
 * code and key, the app's first code, recovery codes shown once); a second
 * device signs in with the app's code and shows up in the list of signed-in
 * devices, from where it is signed out at once; the owner signs in again with
 * a recovery code; the owner asks the Manager role for two-step sign-in, and
 * a manager who has not turned it on gets the screen that turns it on before
 * the business opens.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/two-step-flow.mjs
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = `98781${run}`;
const managerMobile = `98782${run}`;
const password = "Str0ng-pass!";
const managerPassword = "Manager-pass-1";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const log = (...a) => console.log("•", ...a);
const errors = [];
const check = (ok, what) => ok || errors.push(what);

/** What an authenticator app shows for a key (RFC 6238: SHA-1, 6 digits, 30 seconds). */
function totp(key, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const ch of key.toUpperCase().replace(/[\s=]/g, "")) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

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

const watch = (page) => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
};

/** Signs in with the password; with two-step sign-in on, the code step comes next. */
async function signInWithPassword(page, who, pass) {
  await page.goto(WEB);
  await page.locator("#auth-id").waitFor();
  await page.fill("#auth-id", who);
  await page.fill("#auth-password", pass);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Turns two-step sign-in on (the steps are the same on My profile and on the screen a business shows first). */
async function turnOn(scope, page, pass) {
  await scope.locator("#two-step-password").fill(pass);
  await scope.getByRole("button", { name: "Next" }).click();
  const keyText = scope.locator("[data-two-step-key]");
  await keyText.waitFor();
  const key = (await keyText.innerText()).replace(/\s/g, "");
  check(/^[A-Z2-7]{32}$/.test(key), `setup: the key looks wrong (${key})`);
  check((await scope.getByRole("img", { name: "QR code to add Digital Bahi to an authenticator app" }).count()) === 1, "setup: no QR code");
  await scope.locator("#two-step-code").focus();
  await page.keyboard.type(totp(key), { delay: 30 });
  const list = scope.locator("[data-recovery-codes]");
  await list.waitFor({ timeout: 15000 });
  const codes = (await list.innerText()).split(/\s+/).filter(Boolean);
  check(codes.length === 10, `recovery codes: ${codes.length}, not 10`);
  check(await scope.getByRole("button", { name: "Done" }).isDisabled(), "Done before the codes were kept");
  await scope.getByText("I have kept these codes safe").click();
  await scope.getByRole("button", { name: "Done" }).click();
  return { key, codes };
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // The owner (signed up here), and a manager who signs in with a password.
  const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
  const owner = await api("POST", "/auth/signup", null, { name: "Kavita Joshi", mobile, password, otp: otp.devCode, business: { legalName: "Joshi Traders", stateCode: "23" } });
  const manager = (await api("GET", "/roles", owner.accessToken)).data.find((r) => r.key === "manager");
  await api("POST", "/members", owner.accessToken, { name: "Vikram Rao", mobile: managerMobile, roleId: manager.id, password: managerPassword });

  // 1. The owner turns it on from My profile.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  watch(desk);
  await signInWithPassword(desk, mobile, password);
  await desk.getByRole("button", { name: "Your account" }).click();
  await desk.getByRole("dialog", { name: "Your account" }).getByRole("button", { name: "My profile" }).click();
  await desk.getByRole("heading", { name: "My profile" }).waitFor();
  await desk.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  const setup = desk.getByRole("dialog", { name: "Turn on two-step sign-in" });
  await setup.waitFor();
  // A wrong password says so at the box.
  await setup.locator("#two-step-password").fill("not-my-password");
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.locator("#two-step-password[aria-invalid=true]").waitFor();
  await setup.getByText("Mobile/email or password is incorrect.").waitFor();
  const { key, codes } = await turnOn(setup, desk, password);
  await desk.getByText("Two-step sign-in is on.").first().waitFor();
  await desk.getByText(/On since .* · 10 recovery codes left/).waitFor();
  await desk.screenshot({ path: `${OUT}/two-step-1-on.png`, fullPage: true });
  log("turned on: QR code and key, the app's code, 10 recovery codes kept");

  // 2. Another device: the password, then the app's code.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: PHONE_UA });
  const phone = await phoneContext.newPage();
  watch(phone);
  await signInWithPassword(phone, mobile, password);
  await phone.getByRole("heading", { name: "Two-step sign-in" }).waitFor();
  await phone.screenshot({ path: `${OUT}/two-step-2-code.png` });
  // The code of the next 30 seconds (the one shown now went into turning it on, and a code works once).
  await phone.locator("#auth-two-step").focus();
  await phone.keyboard.type(totp(key, Date.now() + 30_000), { delay: 30 });
  await phone.getByRole("button", { name: "Your account" }).waitFor({ timeout: 20000 });
  log("second device signed in with the app's code");

  // 3. The list of signed-in devices shows it; it is signed out from here at once.
  await desk.reload();
  await desk.getByRole("heading", { name: "My profile" }).waitFor();
  const other = desk.locator("[data-session=other]").filter({ hasText: "Chrome on Android" });
  await other.waitFor({ timeout: 15000 });
  check((await desk.locator("[data-session=current]").count()) === 1, "sessions: this device not marked");
  await desk.screenshot({ path: `${OUT}/two-step-3-sessions.png`, fullPage: true });
  await other.getByRole("button", { name: "Sign out" }).click();
  await desk.getByRole("dialog", { name: "Sign out this device?" }).getByRole("button", { name: "Sign out" }).click();
  await desk.getByText("Signed out", { exact: true }).waitFor();
  check((await desk.locator("[data-session=other]").filter({ hasText: "Chrome on Android" }).count()) === 0, "sessions: the phone is still listed");
  await phone.reload();
  await phone.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 20000 });
  log("the phone signed out from the list, at once");
  await phoneContext.close();

  // 4. Signing in again with a recovery code in place of the app.
  await desk.getByRole("button", { name: "Your account" }).click();
  await desk.getByRole("dialog", { name: "Your account" }).getByRole("button", { name: "Sign out" }).click();
  await desk.getByRole("dialog", { name: /Sign out of/ }).getByRole("button", { name: "Sign out" }).click();
  await desk.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 15000 });
  await desk.fill("#auth-password", password);
  await desk.getByRole("button", { name: "Sign in", exact: true }).click();
  await desk.getByRole("heading", { name: "Two-step sign-in" }).waitFor();
  await desk.getByRole("button", { name: "Lost your phone? Use a recovery code" }).click();
  await desk.fill("#auth-two-step", codes[0]);
  await desk.getByRole("button", { name: "Verify and sign in" }).click();
  await desk.getByRole("button", { name: "Your account" }).waitFor({ timeout: 20000 });
  log("signed in with a recovery code");

  // 5. The owner asks the Manager role for it.
  await desk.evaluate(() => {
    location.hash = "settings";
  });
  const roles = desk.locator("[data-two-step-roles]");
  await roles.waitFor({ timeout: 15000 });
  await roles.getByText("Manager", { exact: true }).click();
  await desk.getByText("Settings saved").first().waitFor();
  await roles.screenshot({ path: `${OUT}/two-step-4-roles.png` });
  log("Manager role asked for two-step sign-in");

  // 6. The manager, without it: the screen that turns it on comes before the business.
  const managerContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const managerPage = await managerContext.newPage();
  watch(managerPage);
  await signInWithPassword(managerPage, managerMobile, managerPassword);
  await managerPage.getByRole("heading", { name: "Joshi Traders asks for two-step sign-in" }).waitFor({ timeout: 20000 });
  check(!(await managerPage.getByRole("button", { name: "Your account" }).count()), "gate: the business opened before two-step sign-in was on");
  await managerPage.screenshot({ path: `${OUT}/two-step-5-asked.png`, fullPage: true });
  await turnOn(managerPage, managerPage, managerPassword);
  await managerPage.getByRole("button", { name: "Your account" }).waitFor({ timeout: 20000 });
  log("the manager turned it on and the business opened");
  await managerContext.close();
  await desk.close();
} catch (e) {
  errors.push(String(e?.stack ?? e));
}
await browser.close();
console.log("page errors:", errors.length ? errors : "none");
if (errors.length) process.exit(1);
