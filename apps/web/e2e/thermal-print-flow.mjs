/**
 * End-to-end check of thermal printing (Phase 5.4), with a stand-in for a
 * Bluetooth printer that keeps every byte it is sent: Settings → Receipt
 * printer finds it and prints a test page (58 mm) -> a bill opened from
 * Outstanding prints in Hindi with the firm's UPI code for what it owes ->
 * a payment taken there prints its receipt -> on 80 mm paper the receipt is
 * wider -> with the printer forgotten, printing asks for one first. Each
 * print is read back from the printer's bytes (ESC/POS raster) and saved as
 * a picture next to the screenshots.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/thermal-print-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98763${run}`;
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

const errors = [];
function watch(page, state) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("response", (r) => {
    if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

// --- What the printer got: ESC/POS raster bands (GS v 0) put back together, saved as a PNG. ---
function rasterImage(bytes) {
  let width = 0;
  const rows = [];
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] !== 0x1d || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x30) continue;
    const perRow = bytes[i + 4] | (bytes[i + 5] << 8);
    const height = bytes[i + 6] | (bytes[i + 7] << 8);
    width = perRow * 8;
    for (let r = 0; r < height; r++) rows.push(bytes.slice(i + 8 + r * perRow, i + 8 + (r + 1) * perRow));
    i += 8 + perRow * height - 1;
  }
  return { width, height: rows.length, rows };
}
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function savePng(path, img) {
  const raw = Buffer.alloc((img.width + 1) * img.height);
  img.rows.forEach((row, y) => {
    for (let x = 0; x < img.width; x++) raw[y * (img.width + 1) + 1 + x] = (row[x >> 3] >> (7 - (x & 7))) & 1 ? 0 : 255;
  });
  const head = Buffer.alloc(13);
  head.writeUInt32BE(img.width, 0);
  head.writeUInt32BE(img.height, 4);
  head.set([8, 0, 0, 0, 0], 8);
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
const blackShare = (img) => img.rows.reduce((a, row) => a + row.reduce((s, b) => s + bits(b), 0), 0) / (img.width * img.height);
function bits(b) {
  let n = 0;
  for (; b; b &= b - 1) n++;
  return n;
}

// 1. The owner, where customers pay (UPI), a customer with a bill not yet paid.
const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
await api("POST", "/auth/signup", null, { name: "Ramesh Agrawal", mobile, password, otp: otp.devCode, preferredLocale: "en", business: { legalName: "Agrawal Distributors", stateCode: "23", city: "Indore" } });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
await api("PUT", "/settings/invoice.payment_details", token, { value: { bankName: "State Bank of India", accountNumber: "30123456789", ifsc: "SBIN0001234", upiId: "agrawal.dist@okaxis" } });
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Bath Soap", nameLocal: "नहाने का साबुन", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "500" });
const tea = await api("POST", "/products", token, { name: "Taaza Tea 250g", nameLocal: "ताज़ा चाय 250 ग्राम", hsnCode: "0902", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", openingStock: "100" });
const gupta = await api("POST", "/customers", token, { name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", stateCode: "23", creditDays: 15 });
const bill = await api("POST", "/invoices", token, { customerId: gupta.id, lines: [{ productId: soap.id, qty: "12" }, { productId: tea.id, qty: "6" }] });
log(`bill ${bill.invoiceNumber} for ₹${bill.grandTotal}, nothing paid`);

// 2. A phone with a Bluetooth printer in reach (a stand-in that keeps what it is sent).
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await phone.addInitScript(() => {
  window.__printed = [];
  const writer = {
    properties: { write: true, writeWithoutResponse: true },
    async writeValueWithoutResponse(v) {
      const b = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (const x of b) window.__printed.push(x);
    },
    async writeValueWithResponse(v) {
      return this.writeValueWithoutResponse(v);
    },
  };
  const server = {
    connected: false,
    async connect() {
      server.connected = true;
      return server;
    },
    async getPrimaryServices() {
      return [{ getCharacteristics: async () => [writer] }];
    },
  };
  const device = { id: "printer-1", name: "MTP-II", gatt: server };
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device, getDevices: async () => [device] } });
});
const page = await phone.newPage();
const state = { signedIn: false };
watch(page, state);
const printed = async () => Uint8Array.from(await page.evaluate(() => window.__printed.splice(0)));
/** Everything the printer was sent for one receipt: until the cut at its end (GS V 66 0). */
const waitPrinted = async () => {
  for (let i = 0; i < 120; i++) {
    const done = await page.evaluate(() => {
      const b = window.__printed;
      const n = b.length;
      return n >= 4 && b[n - 4] === 0x1d && b[n - 3] === 0x56 && b[n - 2] === 0x42 && b[n - 1] === 0x00;
    });
    if (done) return printed();
    await page.waitForTimeout(250);
  }
  errors.push("the printer was not sent a whole receipt");
  return printed();
};
await page.goto(WEB);
await page.fill("#auth-id", mobile);
await page.fill("#auth-password", password);
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.getByRole("heading").first().waitFor({ timeout: 15000 });
state.signedIn = true;

// 3. Settings → Receipt printer: find it, 58 mm, a test page.
await page.goto(`${WEB}/#settings`);
await page.getByText("Receipt printer").first().waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Find a Bluetooth printer" }).click();
await page.getByText("MTP-II").first().waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Print a test page" }).click();
await page.getByText("Sent to the printer").first().waitFor({ timeout: 15000 });
let img = rasterImage(await waitPrinted());
savePng(`${OUT}/thermal-1-test-58mm.png`, img);
if (img.width !== 384 || img.height < 200) errors.push(`test page: ${img.width}×${img.height}`);
log(`test page: ${img.width}×${img.height} dots (58 mm)`);
await page.locator("#pay-upiId").scrollIntoViewIfNeeded();
if ((await page.inputValue("#pay-upiId")) !== "agrawal.dist@okaxis") errors.push(`settings UPI: ${await page.inputValue("#pay-upiId")}`);
await page.screenshot({ path: `${OUT}/thermal-1-settings.png` });

// 4. The bill from Outstanding, printed in Hindi, with the UPI code for what it owes.
await page.goto(`${WEB}/#outstanding`);
await page.locator("ul li button:visible").filter({ hasText: "Gupta Kirana" }).click();
await page.getByRole("dialog").getByRole("button", { name: new RegExp(bill.invoiceNumber.replace(/\//g, "\\/")) }).first().click();
await page.getByRole("heading", { name: new RegExp(bill.invoiceNumber.replace(/\//g, "\\/")) }).first().waitFor({ timeout: 15000 });
await page.getByRole("radio", { name: "हिन्दी" }).click();
await page.getByRole("button", { name: "Thermal print" }).click();
await page.getByText("Sent to the printer").first().waitFor({ timeout: 15000 });
img = rasterImage(await waitPrinted());
savePng(`${OUT}/thermal-2-bill-hindi.png`, img);
if (img.width !== 384 || img.height < 700) errors.push(`bill receipt: ${img.width}×${img.height}`);
await page.screenshot({ path: `${OUT}/thermal-2-invoice.png` });
log(`bill ${bill.invoiceNumber} in Hindi: ${img.width}×${img.height} dots, ${(blackShare(img) * 100).toFixed(1)}% black`);

// 5. A payment taken for it, and its receipt.
await page.goto(`${WEB}/#outstanding`);
await page.locator("ul li button:visible").filter({ hasText: "Gupta Kirana" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Receive payment" }).click();
await page.fill("#pay-amount", "500");
await page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
await page.getByRole("dialog").getByRole("heading", { name: /^Receipt RCT\// }).waitFor({ timeout: 15000 });
await page.getByRole("dialog").getByRole("button", { name: "Thermal print" }).click();
await page.getByText("Sent to the printer").first().waitFor({ timeout: 15000 });
img = rasterImage(await waitPrinted());
savePng(`${OUT}/thermal-3-receipt.png`, img);
if (img.width !== 384 || img.height < 300) errors.push(`payment receipt: ${img.width}×${img.height}`);
log(`payment receipt: ${img.width}×${img.height} dots`);
await page.keyboard.press("Escape");

// 6. 80 mm paper: wider; then the printer forgotten: printing asks for one first.
await page.goto(`${WEB}/#settings`);
await page.getByRole("radio", { name: "80 mm" }).click();
await page.getByRole("button", { name: "Print a test page" }).click();
await page.getByText("Sent to the printer").first().waitFor({ timeout: 15000 });
img = rasterImage(await waitPrinted());
savePng(`${OUT}/thermal-4-test-80mm.png`, img);
if (img.width !== 576) errors.push(`80 mm test page: ${img.width} dots wide`);
log(`80 mm: ${img.width} dots wide`);
await page.getByRole("button", { name: "Forget" }).click();
await page.getByText("No printer chosen yet").waitFor();
await page.goto(`${WEB}/#outstanding`);
await page.locator("ul li button:visible").filter({ hasText: "Gupta Kirana" }).click();
await page.getByRole("dialog").getByRole("button", { name: new RegExp(bill.invoiceNumber.replace(/\//g, "\\/")) }).first().click();
await page.getByRole("button", { name: "Thermal print" }).click();
await page.getByRole("dialog").getByRole("heading", { name: "Choose the receipt printer" }).waitFor({ timeout: 15000 });
await page.getByRole("dialog").getByRole("button", { name: "Find a Bluetooth printer" }).click();
await page.getByText("Sent to the printer").first().waitFor({ timeout: 15000 });
img = rasterImage(await waitPrinted());
if (img.width !== 576) errors.push(`after choosing again: ${img.width} dots wide`);
log("forgotten printer: asked for one, chosen, then printed (80 mm)");

await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
