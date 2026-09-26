/**
 * End-to-end check of a big company's printed tax invoice as PDF (the layout
 * FMCG makers use): headings over three lines, each item's name above and
 * below its numbers, the tax written as "CGST@6 + SGST@6", the table running
 * on to page 2 without the heading, page footers. Sign up -> the supplier ->
 * Purchases -> Import bill -> the invoice PDF -> 16 items with HSN, unit
 * (Bag / Carton / Piece) and GST 12% or 18% -> add them all as new products
 * (12% is no longer a rate: today's rate is picked once for all of them)
 * -> save -> the purchase keeps the bill's GST and comes to its grand total.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/bill-company-invoice-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional). The PDF is
 * e2e/fixtures/company-invoice.pdf (made by fixtures/make-pdf-fixtures.mjs).
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
const mobile = process.env.E2E_MOBILE ?? `98773${String(Date.now()).slice(-5)}`;
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
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 30000 });
const dialog = () => page.getByRole("dialog");

// 1. Sign up (our GSTIN is the buyer's on the invoice) and add the company as a supplier.
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
const supplier = await api("POST", "/suppliers", token, { name: "Malwa Snacks Limited", stateCode: "23", gstin: "23AAACM1234M1ZR" });
log("signed up; supplier added");

// 2. The company's two-page invoice.
await page.reload();
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Choose bill file").setInputFiles(join(FIXTURES, "company-invoice.pdf"));
await dialog().getByText("Bill 2500104410").waitFor({ timeout: 20000 });
if (!(await dialog().innerText()).includes("24 Aug 2025")) errors.push("bill date not read");
const summary = await dialog().innerText();
if (!/16 items?/.test(summary)) errors.push(`dialog: ${summary.replace(/\s+/g, " ").slice(0, 300)}`);
await page.screenshot({ path: `${OUT}/company-invoice-1-read.png` });
await dialog().getByRole("button", { name: "Match and review" }).click();
await page.getByText("Imported from company-invoice.pdf").waitFor({ timeout: 15000 });
log("invoice 2500104410 read: 16 items over two pages");

// 3. All 16 as new products: GST and unit from the invoice.
await page.getByRole("button", { name: "Add 16 as new products" }).click();
await dialog().getByRole("heading", { name: "Add new products from the bill" }).waitFor();
const chosen = async (label) => {
  const select = dialog().getByLabel(label, { exact: true });
  return select.locator(`option[value="${await select.inputValue()}"]`).textContent();
};
const tomato = "MALWA Namkeen Moon Chips Tomato 11 gm 96 Pkt Rs 5 - With Party Toys";
// The bill is from before the 22 Sep 2025 rate change: 12% is not a rate any more, 18% is.
await dialog().getByText("The bill charges GST 12%, which is not in your GST list").waitFor();
if ((await dialog().getByText("Bill: GST 12%, not in your list").count()) !== 14) errors.push("12% items not marked");
for (const [label, want] of [
  [`GST ${tomato}`, "—"],
  [`Unit ${tomato}`, "BAG"],
  ["GST Hanger", "GST 18%"],
  ["Unit Hanger", "PCS"],
  ["Unit MS Namkeen Puff Tomato 20 gm 210 pkt Rs 5", "CTN"],
]) {
  const got = await chosen(label);
  if (got !== want) errors.push(`${label}: ${got}, expected ${want}`);
}
await dialog().getByLabel("GST for the items without one").selectOption({ label: "GST 5%" });
if ((await chosen(`GST ${tomato}`)) !== "GST 5%" || (await chosen("GST Hanger")) !== "GST 18%") errors.push("GST for the rest not applied");
await dialog().getByLabel("Selling price = purchase rate +").fill("8");
await page.screenshot({ path: `${OUT}/company-invoice-2-new-products.png` });
await dialog().getByRole("button", { name: "Add 16 products" }).click();
await toast("16 new products added");
await page.getByRole("button", { name: /Add \d+ as new products?/ }).waitFor({ state: "detached", timeout: 10000 });
log("16 products added from the invoice");

// 4. Save: the purchase comes to the invoice's grand total.
await page.screenshot({ path: `${OUT}/company-invoice-3-purchase.png`, fullPage: true });
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
const purchases = (await api("GET", "/purchases", token)).data;
log("purchase:", purchases.map((p) => `${p.supplierInvoiceNumber} ${p.supplierInvoiceDate ?? ""} ${p.grandTotal}`).join(" | "));
if (purchases.length !== 1 || purchases[0].grandTotal !== "369249.00" || purchases[0].supplierInvoiceNumber !== "2500104410") errors.push(`purchase ${JSON.stringify(purchases[0])}, the invoice says 369249.00`);
if (purchases[0]?.supplierId && purchases[0].supplierId !== supplier.id) errors.push("wrong supplier");
const products = (await api("GET", "/products", token)).data;
if (products.length !== 16) errors.push(`expected 16 products, got ${products.length}`);

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
