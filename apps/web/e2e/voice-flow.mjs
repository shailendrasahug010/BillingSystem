/**
 * End-to-end check of voice search. The browser's speech recogniser is
 * stood in for (it hears what the test sets). On a new bill, the mic in the
 * product search: "Parle G 10 box" adds 10 boxes of Parle G; "Dolo 650 2"
 * adds 2 of Dolo 650 (the number in the name kept as the name); "Dolo 650"
 * adds one more to that line. Ctrl+K search by voice finds a customer. On a
 * phone the mic sits in the search field; a browser that cannot listen shows
 * no mic.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/voice-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98767${run}`;
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

/** A stand-in for the browser's speech recogniser: it "hears" window.__say. */
const fakeSpeech = () => {
  class FakeRecognition {
    start() {
      setTimeout(() => {
        const text = window.__say ?? "";
        if (text) this.onresult?.({ results: [[{ transcript: text }]] });
        else this.onerror?.({ error: "no-speech" });
        this.onend?.();
      }, 150);
    }
    abort() {
      this.onend?.();
    }
  }
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
};

const errors = [];
let signedIn = false;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addInitScript(fakeSpeech);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const say = async (text, mic) => {
  await page.evaluate((t) => (window.__say = t), text);
  await mic.click();
};
const productMic = () => page.getByRole("button", { name: /Say a product/ });
const qtyOf = (name) => page.getByLabel(`Qty ${name}`).first();
const unitOf = (name) => page.getByRole("combobox", { name: `Unit ${name}` }).first();
const waitFor = async (check, what) => {
  for (let i = 0; i < 30; i++) {
    if (await check().catch(() => false)) return true;
    await page.waitForTimeout(100);
  }
  errors.push(what);
  return false;
};
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // 1. Sign up; a few products, one sold in boxes, one in strips; a customer.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Ramesh Gupta");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Gupta Distributors");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Ramesh/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  await api("POST", "/products", token, { name: "Parle G Biscuit 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "2000", units: [{ unitId: units.BOX, conversionFactor: "24" }] });
  await api("POST", "/products", token, { name: "Dolo 650 Tablet", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "2", openingStock: "5000", units: [{ unitId: units.STRIP, conversionFactor: "15" }] });
  await api("POST", "/products", token, { name: "Good Day Cookies", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "20", openingStock: "500" });
  const shop = await api("POST", "/customers", token, { name: "Gupta Kirana", stateCode: "23", mobile: "9826044444" });
  log("signed up; Parle G (boxes of 24), Dolo 650 (strips of 15), a customer");

  // 2. A new bill: products said aloud.
  await page.goto(`${WEB}/#invoice/new/${shop.id}`);
  await page.reload();
  await page.getByRole("heading", { name: "New Invoice" }).waitFor({ timeout: 15000 });
  await productMic().first().waitFor({ timeout: 15000 });
  await say("Parle G 10 box", productMic().first());
  await waitFor(async () => (await qtyOf("Parle G Biscuit 100g").inputValue()) === "10", `"Parle G 10 box": qty ${await qtyOf("Parle G Biscuit 100g").inputValue().catch(() => "none")}`);
  if ((await unitOf("Parle G Biscuit 100g").inputValue()) !== units.BOX) errors.push('"Parle G 10 box": the line is not in boxes');
  log('"Parle G 10 box": 10 boxes');
  await say("Dolo 650 2", productMic().first());
  await waitFor(async () => (await qtyOf("Dolo 650 Tablet").inputValue()) === "2", `"Dolo 650 2": qty ${await qtyOf("Dolo 650 Tablet").inputValue().catch(() => "none")}`);
  log('"Dolo 650 2": 2 of Dolo 650, in', (await unitOf("Dolo 650 Tablet").inputValue()) === units.STRIP ? "strips" : "its own unit");
  await say("Dolo 650", productMic().first());
  await waitFor(async () => (await qtyOf("Dolo 650 Tablet").inputValue()) === "3", `"Dolo 650": qty ${await qtyOf("Dolo 650 Tablet").inputValue()}`);
  log('"Dolo 650": one more on that line (650 kept as the name)');
  await page.screenshot({ path: `${OUT}/voice-1-bill.png` });

  // 3. Search by voice (Ctrl+K).
  await page.keyboard.press("Control+k");
  await say("Gupta Kirana", page.getByRole("dialog").getByRole("button", { name: "Search by voice" }));
  await page.getByRole("dialog").getByText("Gupta Kirana").first().waitFor({ timeout: 10000 });
  if ((await page.getByRole("dialog").locator("input").inputValue()) !== "Gupta Kirana") errors.push("the search box does not hold what was said");
  await page.getByRole("dialog").screenshot({ path: `${OUT}/voice-2-search.png` });
  await page.keyboard.press("Escape");
  log("search by voice found the customer");

  // 4. A phone: the mic in the product search; it fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await productMic().first().waitFor();
  if (!(await fits())) errors.push("the bill scrolls sideways on a phone");
  await page.screenshot({ path: `${OUT}/voice-3-phone.png` });
  log("phone: mic in the search, fits");

  // 5. A browser that cannot listen: no mic.
  const plain = await context.newPage();
  await plain.addInitScript(() => {
    delete window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
  });
  await plain.goto(`${WEB}/#invoice/new/${shop.id}`);
  await plain.getByRole("heading", { name: "New Invoice" }).waitFor({ timeout: 15000 });
  if (await plain.getByRole("button", { name: /Say a product/ }).count()) errors.push("a mic shown where the browser cannot listen");
  await plain.close();
  log("no speech recogniser: no mic");
} catch (e) {
  errors.push(String(e?.stack ?? e));
  await page.screenshot({ path: `${OUT}/voice-failed.png` }).catch(() => undefined);
}
await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
