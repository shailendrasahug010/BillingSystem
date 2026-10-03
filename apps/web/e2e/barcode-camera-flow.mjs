/**
 * End-to-end check of the barcode camera (Phase 5.4): a phone's camera
 * (Chromium's stand-in camera, playing a video of a soap pack's EAN-13
 * barcode) reads the code on the bill screen and the soap is added, with the
 * camera left on for the next pack; a code no product has is said so; on a
 * desk the camera stays off until asked, and a USB scanner's code (typed,
 * then Enter) adds the product. Headless Chromium has no barcode reader of
 * its own, so this runs the ZXing reader the app ships for such browsers.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/barcode-camera-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98762${run}`;
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

// --- An EAN-13 barcode drawn into a video the stand-in camera plays (YUV4MPEG2). ---
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((c) => [...c].map((b) => (b === "0" ? "1" : "0")).join(""));
const G = R.map((c) => [...c].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
function ean13(twelve) {
  const d = [...twelve].map(Number);
  const sum = d.reduce((s, x, i) => s + x * (i % 2 ? 3 : 1), 0);
  return twelve + ((10 - (sum % 10)) % 10);
}
function eanModules(code) {
  const d = [...code].map(Number);
  const parity = PARITY[d[0]];
  let bits = "101";
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === "L" ? L : G)[d[i]];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  return bits + "101";
}
function barcodeVideo(code, path) {
  const W = 640;
  const H = 480;
  const bits = eanModules(code);
  const module = 4;
  const left = Math.round((W - bits.length * module) / 2);
  const y = Buffer.alloc(W * H, 235);
  for (let row = 130; row < 350; row++) {
    for (let i = 0; i < bits.length; i++) if (bits[i] === "1") y.fill(16, row * W + left + i * module, row * W + left + (i + 1) * module);
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma, chroma]);
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: 20 }, () => frame)]));
}

// 1. The owner, a soap with its pack's barcode, a customer.
const soapCode = ean13("890103086527");
const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
await api("POST", "/auth/signup", null, { name: "Ramesh Agrawal", mobile, password, otp: otp.devCode, preferredLocale: "en", business: { legalName: "Agrawal Distributors", stateCode: "23", city: "Indore" } });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "500", barcodes: [soapCode] });
await api("POST", "/products", token, { name: "Taaza Tea 250g", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", openingStock: "100", barcodes: ["8901725181222"] });
await api("POST", "/customers", token, { name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", stateCode: "23" });
const video = join(mkdtempSync(join(tmpdir(), "barcode-")), "soap.y4m");
barcodeVideo(soapCode, video);
log(`soap's barcode ${soapCode}, played by the stand-in camera`);

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
});
async function signIn(context) {
  const page = await context.newPage();
  const state = { signedIn: false };
  watch(page, state);
  await page.goto(WEB);
  await page.fill("#auth-id", mobile);
  await page.fill("#auth-password", password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading").first().waitFor({ timeout: 15000 });
  state.signedIn = true;
  return page;
}
async function startBill(page) {
  await page.goto(`${WEB}/#invoice`);
  const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
  await customerBox.waitFor({ timeout: 20000 });
  await customerBox.fill("Gupta");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Scan", exact: true }).first().click();
}

// 2. A phone: the camera starts by itself and reads the soap; it stays on for the next pack.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ["camera"] });
const page = await signIn(phone);
await startBill(page);
const dialog = page.getByRole("dialog");
await dialog.getByLabel("Camera", { exact: true }).waitFor({ timeout: 15000 });
await dialog.getByText("Added: Lux Soap 100g").waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/barcode-1-phone-camera.png` });
if (!(await dialog.getByLabel("Camera", { exact: true }).isVisible())) errors.push("the camera closed after the first pack");
// A code no product has, typed in.
await page.fill("#scan-code", "4006381333931");
await page.keyboard.press("Enter");
await dialog.getByText("No product has the barcode 4006381333931.").waitFor();
await page.keyboard.press("Escape");
await page.getByText("Lux Soap 100g").first().waitFor();
const lines = await page.getByText("Lux Soap 100g").count();
if (lines < 1) errors.push("the soap is not on the bill");
await page.screenshot({ path: `${OUT}/barcode-2-phone-bill.png` });
log("phone: the camera read the soap's barcode and it went on the bill; an unknown code is said so");

// 3. A desk: the camera stays off until asked; a USB scanner's code adds the tea.
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ["camera"] });
const deskPage = await signIn(desk);
await startBill(deskPage);
const deskDialog = deskPage.getByRole("dialog");
await deskDialog.getByRole("button", { name: "Scan with the camera" }).waitFor({ timeout: 15000 });
if (await deskDialog.getByLabel("Camera", { exact: true }).count()) errors.push("the camera started by itself on a desk");
// A scanner types the code and presses Enter (the field has the focus).
await deskPage.keyboard.type("8901725181222");
await deskPage.keyboard.press("Enter");
await deskPage.getByText("Taaza Tea 250g").first().waitFor({ timeout: 15000 });
if (await deskDialog.count()) errors.push("the scan dialog stayed open after the scanner's code");
log("desk: no camera until asked; the scanner's code added the tea");

await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
