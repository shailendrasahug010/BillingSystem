/**
 * End-to-end check of importing a supplier's bill from their Excel file:
 * sign up -> products from an Excel sheet -> add the supplier -> Purchases ->
 * Import bill (a Marg-style export with title rows, split GST, scheme qty) ->
 * lines matched by barcode, code and name; one picked from close matches, one
 * added as a new product -> save -> import the same file again: every item is
 * now remembered for this supplier and the duplicate bill is flagged.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/bill-import-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional). The Excel files are in
 * e2e/fixtures (made by fixtures/make-fixtures.py).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const mobile = process.env.E2E_MOBILE ?? `98764${String(Date.now()).slice(-5)}`;
const log = (...a) => console.log("•", ...a);

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

// 1. Sign up a GST-registered business.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Neha Agrawal");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", "Str0ng-pass!");
await page.getByRole("button", { name: "Next" }).click();
await page.fill("#su-business", "Agrawal Distributors");
await page.locator("#su-state").selectOption("23");
await page.fill("#su-gstin", "23AAGFG5678G1ZA");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("heading", { name: /, Neha/ }).waitFor({ timeout: 15000 });
signedIn = true;
log("signed up");

// 2. Products from an Excel sheet.
await nav("Products");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(join(FIXTURES, "products.xlsx"));
await dialog().getByRole("button", { name: "Import 4 rows" }).click();
await toast("4 products added");
log("4 products imported from products.xlsx");

// 3. The supplier.
await nav("Suppliers");
await page.getByRole("button", { name: "Add supplier" }).first().click();
await dialog().getByLabel("Supplier name").fill("Shree Ganesh Agencies");
await dialog().getByLabel("GSTIN").fill("23AAACM1234M1ZR");
await dialog().getByRole("button", { name: "Save" }).click();
await toast("Supplier saved");
log("supplier added");

// 4. Import their bill.
const importBill = async () => {
  await nav("Purchases");
  await page.getByRole("button", { name: "Import bill" }).click();
  await page.getByLabel("Choose bill file").setInputFiles(join(FIXTURES, "supplier-bill.xlsx"));
  await dialog().getByText("Bill SG/1021").waitFor();
  await dialog().getByRole("button", { name: "Match and review" }).click();
  await page.getByText("Imported from supplier-bill.xlsx").waitFor({ timeout: 15000 });
};
await importBill();
await page.getByText("3 of 5 items matched").waitFor();
await page.getByText("2 items to match").waitFor();
if ((await page.locator("#pu-bill").inputValue()) !== "SG/1021") errors.push("bill number not filled");
if ((await page.locator("#pu-date").inputValue()) !== "2026-09-20") errors.push("bill date not filled");
await page.getByText("Shree Ganesh Agencies").first().waitFor();
await page.screenshot({ path: `${OUT}/flow-bill-import-review.png`, fullPage: true });

// Harpic: one of the close matches. Colgate: a new product, filled from the bill.
await page.getByRole("button", { name: "Harpic Toilet Cleaner 500ml" }).click();
await page.getByText("1 item to match").waitFor();
await page.getByRole("button", { name: "New product", exact: true }).click();
if ((await dialog().locator("input").first().inputValue()) !== "Colgate Strong Teeth 200g") errors.push("new product not prefilled");
await dialog().getByRole("button", { name: "Save" }).click();
await toast("Product saved");
await page.getByText(/items? to match/).waitFor({ state: "detached" });
log("all 5 items matched (2 by hand, 1 new product)");

// Surf came in cartons (CS on the bill) at 1380 less 2.5%, 18% GST.
await page.getByRole("row", { name: /Surf Excel 1 kg/ }).getByRole("combobox").first().waitFor();
const surfUnit = await page.getByRole("row", { name: /Surf Excel 1 kg/ }).getByLabel("Unit").inputValue();
const surfUnitText = await page.getByRole("row", { name: /Surf Excel 1 kg/ }).getByLabel("Unit").locator(`option[value="${surfUnit}"]`).textContent();
if (!surfUnitText.startsWith("CTN")) errors.push(`Surf unit ${surfUnitText}`);
await page.screenshot({ path: `${OUT}/flow-bill-import-matched.png`, fullPage: true });
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
await page.getByRole("button", { name: /Print|Cancel purchase/ }).first().waitFor();
log("purchase saved from the imported bill");

// 5. The same file again: remembered for this supplier, and flagged as already entered.
await importBill();
await page.getByText("5 of 5 items matched").waitFor();
await page.getByText(/is already entered/).waitFor();
if ((await page.getByText("Remembered").count()) < 5) errors.push("items not remembered");
await page.screenshot({ path: `${OUT}/flow-bill-import-again.png`, fullPage: true });
log("second import: all remembered, duplicate flagged");

if (errors.length) {
  console.log("Errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} else log("no console errors or failed requests");
await browser.close();
