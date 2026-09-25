/**
 * End-to-end check of a supplier's PDF bill whose items are not in the
 * product list yet: sign up (no products) -> add the supplier -> Purchases
 * -> Import bill -> the supplier's printed PDF tax invoice -> review ->
 * "Add 4 as new products": name, GST (0% as nil-rated), unit, rate, MRP,
 * HSN and batch tracking come from the bill, selling price by margin ->
 * the new products go straight on the purchase -> save -> the products
 * exist with this supplier as preferred supplier and the stock is in.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/bill-new-products-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional). The PDF is
 * e2e/fixtures/supplier-bill.pdf (made by fixtures/make-pdf-fixtures.mjs).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const mobile = process.env.E2E_MOBILE ?? `98772${String(Date.now()).slice(-5)}`;
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
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");

// 1. Sign up (our GSTIN is printed on the bill as the buyer's); the supplier, and no products at all.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Anand Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Anand Distributors");
await page.locator("#su-state").selectOption("23");
await page.fill("#su-gstin", "23AAGFG5678G1ZA");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Anand/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const supplier = await api("POST", "/suppliers", token, { name: "Shree Ganesh Agencies", stateCode: "23", gstin: "23AAACM1234M1ZR" });
log("signed up; supplier added; product list empty");

// 2. The supplier's printed bill as PDF.
await page.reload();
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Choose bill file").setInputFiles(join(FIXTURES, "supplier-bill.pdf"));
await dialog().getByText("Bill SG/1044").waitFor({ timeout: 20000 });
await dialog().getByRole("button", { name: "Match and review" }).click();
await page.getByText("Imported from supplier-bill.pdf").waitFor({ timeout: 15000 });
log("bill SG/1044 read from the PDF; nothing matched yet");

// 3. Add the four items as new products.
await page.getByRole("button", { name: "Add 4 as new products" }).click();
await dialog().getByRole("heading", { name: "Add new products from the bill" }).waitFor();
const gst = async (item) => {
  const select = dialog().getByLabel(`GST ${item}`, { exact: true });
  return select.locator(`option[value="${await select.inputValue()}"]`).textContent();
};
if ((await gst("TATA SALT 1KG")) !== "Nil rated (0%)") errors.push(`salt GST ${await gst("TATA SALT 1KG")}`);
if ((await gst("HARPIC 500ML")) !== "GST 18%") errors.push(`harpic GST ${await gst("HARPIC 500ML")}`);
if ((await dialog().getByLabel("Product name TATA SALT 1KG").inputValue()) !== "Tata Salt 1kg") errors.push("name not tidied");
await dialog().getByText("Billed per CS above its MRP").waitFor();
await dialog().getByLabel("Selling price = purchase rate +").fill("10");
if ((await dialog().getByLabel("Selling price HARPIC 500ML").inputValue()) !== "93.5") errors.push(`harpic price ${await dialog().getByLabel("Selling price HARPIC 500ML").inputValue()}`);
if ((await dialog().getByLabel("Selling price TATA SALT 1KG").inputValue()) !== "24.2") errors.push("salt price");
await page.screenshot({ path: `${OUT}/new-products-1-dialog.png` });
await dialog().getByRole("button", { name: "Add 4 products" }).click();
await toast("4 new products added");
await page.getByRole("button", { name: /Add \d+ as new products?/ }).waitFor({ state: "detached", timeout: 10000 });
await page.screenshot({ path: `${OUT}/new-products-2-purchase.png`, fullPage: true });
log("4 products added from the bill and put on the purchase");

// 4. Save the purchase.
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
const products = (await api("GET", "/products", token)).data;
log("products now:", products.map((p) => `${p.name} (sell ${p.sellingPrice})`).join(" | "));
if (products.length !== 4) errors.push(`expected 4 products, got ${products.length}`);
const detail = await api("GET", `/products/${products.find((p) => p.name.startsWith("Parle"))?.id}`, token);
if (detail.preferredSupplierId !== supplier.id || !detail.trackBatches || !detail.trackExpiry || detail.hsnCode !== "1905") errors.push(`parle details ${JSON.stringify({ s: detail.preferredSupplierId, b: detail.trackBatches, e: detail.trackExpiry, h: detail.hsnCode })}`);
const purchases = (await api("GET", "/purchases", token)).data;
log("purchase:", purchases.map((p) => `${p.supplierInvoiceNumber} ${p.grandTotal}`).join(" | "));
if (purchases[0]?.grandTotal !== "7495.00") errors.push(`purchase total ${purchases[0]?.grandTotal}, the bill says 7,495.00`);
const stock = Object.fromEntries((await api("GET", "/catalog", token)).products.map((p) => [p.name, p.stock]));
log("stock:", JSON.stringify(stock));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
