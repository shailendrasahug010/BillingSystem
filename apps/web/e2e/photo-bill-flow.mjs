/**
 * End-to-end check of reading printed bills from a photo and from a scanned
 * PDF: sign up -> three products and the supplier -> a photo of the printed
 * bill (taken at a slight angle, in uneven light, with a ruled table) ->
 * Purchases -> Import bill -> Photo of the bill -> read by the server, the
 * table rebuilt, the supplier and all three items matched -> review (with
 * the note to check against the paper) -> saved with the right quantities
 * and rates -> the same bill as a scanned PDF (only a picture inside) is read
 * too, and flagged as already entered -> a photographed customer list is
 * imported -> without a connection a photo is refused with a message saying
 * why.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/photo-bill-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional). The photo and the
 * scanned PDF are made by the browser during the run (a made-up bill).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98760${String(Date.now()).slice(-5)}`;
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
let signedIn = false;
let offline = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  // A list request cancelled by moving on to the next screen is not a failure of the app.
  if (!offline && r.url().includes("/api/") && r.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");

// 1. Sign up; three products and the supplier.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Suresh Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Jain Traders");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Suresh/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const items = [
  ["Glucose Biscuit 100g", "GST 5%", "10"],
  ["Salted Crackers 75g", "GST 18%", "12"],
  ["Cream Biscuit 60g", "GST 18%", "30"],
];
const products = {};
for (const [name, tax, price] of items) products[name] = (await api("POST", "/products", token, { name, hsnCode: "1905", taxCategoryId: taxes[tax], baseUnitId: units.PCS, sellingPrice: price })).id;
const supplier = await api("POST", "/suppliers", token, { name: "Sample Biscuit Agency", stateCode: "23", gstRegistration: "unregistered" });
await page.reload();
await page.getByRole("heading", { name: /Suresh/ }).waitFor({ timeout: 15000 });
log("signed up; 3 products and the supplier");

// 2. The printed bill, photographed at an angle in uneven light; and scanned into a PDF.
// A phone camera gives about twice the screen's pixels.
const camera = await browser.newContext({ deviceScaleFactor: 2 });
const paper = await camera.newPage();
await paper.setViewportSize({ width: 1100, height: 720 });
const rows = [
  ["1", "Glucose Biscuit 100g", "1905", "120", "8.50", "5", "1020.00"],
  ["2", "Salted Crackers 75g", "1905", "48", "9.20", "18", "441.60"],
  ["3", "Cream Biscuit 60g", "1905", "24", "25.00", "18", "600.00"],
];
const td = (c, i) => `<td style="border:1px solid #333;padding:5px 8px;text-align:${i >= 3 ? "right" : "left"}">${c}</td>`;
await paper.setContent(`<body style="margin:0;background:#5b4f45"><div style="position:absolute;left:50px;top:40px;width:960px;padding:26px;transform:rotate(-1deg);filter:blur(0.5px);font:15px Arial;color:#1c1c1c;background:linear-gradient(115deg,#fffdf6,#e2dccb 70%,#c9c2b0)">
  <div style="font-size:21px;font-weight:bold">SAMPLE BISCUIT AGENCY</div>
  <div style="margin:6px 0 14px">Invoice No: SB/118 &nbsp;&nbsp;&nbsp; Date: 21/09/2026</div>
  <table style="border-collapse:collapse;width:100%"><tr>${["Sr", "Item Description", "HSN", "Qty", "Rate", "GST%", "Amount"].map((h) => `<th style="border:1px solid #333;padding:5px 8px">${h}</th>`).join("")}</tr>
  ${rows.map((r) => `<tr>${r.map(td).join("")}</tr>`).join("")}</table>
  <div style="text-align:right;margin-top:12px">Grand Total: 2130.60</div></div></body>`);
const photoPath = `${OUT}/bill-photo.jpg`;
const photo = await paper.screenshot({ path: photoPath, type: "jpeg", quality: 80, scale: "device" });
await paper.setContent(`<body style="margin:0"><img style="width:100%" src="data:image/jpeg;base64,${photo.toString("base64")}"></body>`);
const scanPath = `${OUT}/bill-scan.pdf`;
await paper.pdf({ path: scanPath, format: "A4", printBackground: true });
await paper.close();
log("made a photo and a scanned PDF of the bill");

// 3. Import the photo.
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Photo of the bill").setInputFiles(photoPath);
await dialog().getByText("Bill SB/118").waitFor({ timeout: 60000 });
await dialog().getByText("3 items").waitFor();
await page.screenshot({ path: `${OUT}/photo-bill-1-read.png` });
await dialog().getByRole("button", { name: "Match and review" }).click();
await page.getByText("Imported from bill-photo.jpg").waitFor({ timeout: 15000 });
await page.getByText("Read from a photo or scan: check every item").waitFor();
await page.getByText("3 of 3 items matched").waitFor();
if ((await page.locator("#pu-bill").inputValue()) !== "SB/118") errors.push("bill number not read from the photo");
if ((await page.locator("#pu-date").inputValue()) !== "2026-09-21") errors.push("bill date not read from the photo");
await page.getByText("Sample Biscuit Agency").first().waitFor();
await page.screenshot({ path: `${OUT}/photo-bill-2-review.png`, fullPage: true });
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
const saved = (await api("GET", "/purchases", token)).data;
if (saved.length !== 1) errors.push(`purchases: ${saved.length}`);
const detail = await api("GET", `/purchases/${saved[0].id}`, token);
if (detail.supplierId !== supplier.id) errors.push("wrong supplier");
const got = detail.items.map((i) => [i.productId, Number(i.qty), Number(i.rate)]);
const want = [
  [products["Glucose Biscuit 100g"], 120, 8.5],
  [products["Salted Crackers 75g"], 48, 9.2],
  [products["Cream Biscuit 60g"], 24, 25],
];
if (JSON.stringify(got) !== JSON.stringify(want)) errors.push(`lines ${JSON.stringify(got)}`);
log("photo read; purchase", detail.purchaseNumber, "saved with", got.map((g) => `${g[1]} @ ${g[2]}`).join(", "));

// 4. The scanned PDF: read page by page, and flagged as already entered.
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Choose bill file").setInputFiles(scanPath);
await dialog().getByText("Bill SB/118").waitFor({ timeout: 60000 });
await dialog().getByRole("button", { name: "Match and review" }).click();
await page.getByText("Imported from bill-scan.pdf").waitFor({ timeout: 15000 });
await page.getByText("3 of 3 items matched").waitFor();
await page.getByText(/Bill SB\/118 from this supplier is already entered/).waitFor();
await page.screenshot({ path: `${OUT}/photo-bill-3-scan.png`, fullPage: true });
log("scanned PDF read; the same bill is flagged as already entered");

// 5. A photographed customer list.
const list = await camera.newPage();
await list.setViewportSize({ width: 800, height: 360 });
await list.setContent(`<body style="margin:0;background:#fff;font:16px Arial;padding:30px"><b>Customer list</b><table style="margin-top:14px;border-collapse:collapse">
  <tr>${["Name", "Mobile", "City"].map((h) => `<th style="text-align:left;padding:6px 40px 6px 0;border-bottom:1px solid #333">${h}</th>`).join("")}</tr>
  ${[["Gupta Kirana", "9826011111", "Indore"], ["Verma General Store", "9826022222", "Dewas"]].map((r) => `<tr>${r.map((c) => `<td style="padding:6px 40px 6px 0">${c}</td>`).join("")}</tr>`).join("")}</table></body>`);
const listPath = `${OUT}/customer-list.png`;
await list.screenshot({ path: listPath, scale: "device" });
await camera.close();
await nav("Customers");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(listPath);
await dialog().getByRole("button", { name: "Import 2 rows" }).click({ timeout: 60000 });
await toast("2 customers added");
const customers = (await api("GET", "/customers", token)).data.map((c) => `${c.name}|${c.mobile}|${c.city}`).sort();
if (JSON.stringify(customers) !== JSON.stringify(["Gupta Kirana|9826011111|Indore", "Verma General Store|9826022222|Dewas"])) errors.push(`customers ${JSON.stringify(customers)}`);
log("2 customers imported from a photo of a list");

// 6. No connection: a photo cannot be read, and the screen says why.
offline = true;
await context.setOffline(true);
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Photo of the bill").setInputFiles(photoPath);
await dialog().getByText("Reading a photo or a scanned PDF needs an internet connection").waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/photo-bill-4-offline.png` });
log("offline: the photo is refused with the reason");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
