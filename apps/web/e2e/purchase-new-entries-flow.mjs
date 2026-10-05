/**
 * A purchase bill with a supplier and products not in the lists yet: they are
 * added from the bill itself. Sign up (no suppliers, no products) -> import a
 * supplier's PDF bill -> "Add as new supplier" with the name and GSTIN from
 * the bill -> the bill's items as new products -> saved against the new
 * supplier; then a bill typed in by hand: a new supplier and a new product
 * added from their search boxes.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/purchase-new-entries-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH) and a Chromium (CHROMIUM_PATH optional).
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
const check = (ok, what) => {
  if (!ok) errors.push(what);
};
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

// 1. Sign up (our GSTIN is printed on the bill as the buyer's); no suppliers, no products.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Anand Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Anand Distributors");
await page.locator("#su-state").selectOption("23");
await page.fill("#su-gstin", "23AAGFG5678G1ZA");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Anand/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
log("signed up; no suppliers and no products");

// 2. A supplier's bill from a supplier not in the list: added from the bill, name and GSTIN filled in.
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Choose bill file").setInputFiles(join(FIXTURES, "supplier-bill.pdf"));
await dialog().getByText("Bill SG/1044").waitFor({ timeout: 20000 });
await dialog().getByRole("button", { name: "Match and review" }).click();
await page.getByText("Imported from supplier-bill.pdf").waitFor({ timeout: 15000 });
await page.getByText(/Supplier not found in your list/).waitFor();
await page.getByRole("button", { name: "Add as new supplier" }).click();
await dialog().getByRole("heading", { name: "Add supplier" }).waitFor();
const billName = await dialog().getByLabel("Supplier name", { exact: false }).first().inputValue().catch(() => "");
const billGstin = await dialog().locator("input[maxlength='15']").first().inputValue().catch(() => "");
log("new supplier from the bill:", billName, billGstin);
if (billGstin !== "23AAACM1234M1ZR") errors.push(`GSTIN not filled from the bill: ${billGstin}`);
await page.screenshot({ path: `${OUT}/new-entries-1-supplier-from-bill.png` });
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await toast("Supplier saved");
await page.getByText(/Supplier not found in your list/).waitFor({ state: "detached", timeout: 10000 });
check((await page.getByText("23AAACM1234M1ZR").count()) > 0, "the new supplier is not on the purchase");

// The bill's items are new too: added as products in one go, then the purchase is saved.
await page.getByRole("button", { name: "Add 4 as new products" }).click();
await dialog().getByRole("button", { name: "Add 4 products" }).click();
await toast("4 new products added");
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
const suppliers = (await api("GET", "/suppliers", token)).data;
const fromBill = suppliers.find((s) => s.gstin === "23AAACM1234M1ZR");
const purchases = (await api("GET", "/purchases", token)).data;
check(Boolean(fromBill) && purchases[0]?.supplierId === fromBill.id, `purchase supplier ${purchases[0]?.supplierId}, new supplier ${fromBill?.id}`);
check((await api("GET", "/products", token)).data.length === 4, "the 4 products were not added");
log("bill saved against the new supplier", fromBill?.name, "with 4 new products");

// 3. A bill typed in by hand: a supplier and a product not in the lists, added from their search boxes.
await page.goto(`${WEB}/#purchase-new`);
await page.reload();
const supplierBox = page.locator("#pu-supplier");
await supplierBox.waitFor({ timeout: 15000 });
await supplierBox.fill("Naya Traders");
await page.getByRole("option", { name: "Add “Naya Traders” as a new supplier" }).click();
await dialog().getByRole("heading", { name: "Add supplier" }).waitFor();
check((await dialog().getByLabel("Supplier name").inputValue()) === "Naya Traders", "the supplier name was not filled in");
await dialog().getByLabel("GST registration").selectOption("unregistered");
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await toast("Supplier saved");
await page.getByText(/Naya Traders · /).first().waitFor({ timeout: 10000 });
log("supplier added from the search box: Naya Traders");
const productBox = page.getByPlaceholder(/Search product/);
await productBox.fill("Haldi Powder 200g");
await page.getByRole("option", { name: "Add “Haldi Powder 200g” as a new product" }).click();
check((await dialog().locator("#p-name").inputValue()) === "Haldi Powder 200g", "the product name was not filled in");
await dialog().locator("#p-tax").selectOption({ label: "GST 5%" });
await page.screenshot({ path: `${OUT}/new-entries-2-product.png` });
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await page.getByRole("textbox", { name: /Haldi Powder 200g/ }).first().waitFor({ timeout: 10000 }).catch(() => undefined);
const products = (await api("GET", "/products", token)).data;
check(products.some((p) => p.name === "Haldi Powder 200g"), "the new product was not added");
check((await page.getByText("Haldi Powder 200g").count()) > 0, "the new product is not on the purchase");
await page.screenshot({ path: `${OUT}/new-entries-3-manual.png`, fullPage: true });
log("product added from the search box and put on the purchase: Haldi Powder 200g");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
if (errors.length) process.exit(1);
