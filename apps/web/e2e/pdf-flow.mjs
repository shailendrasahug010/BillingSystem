/**
 * End-to-end check of PDF import and export: sign up -> products from a
 * company price list (PDF) -> add the supplier -> Purchases -> Import bill
 * from the supplier's printed tax invoice (PDF: bill number, date and GSTIN
 * above the table, a wrapped item name, a unit on the next line, headings
 * over two lines) -> review and save -> Reports -> download the purchases
 * report as PDF (and as CSV).
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/pdf-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional). The PDFs are in
 * e2e/fixtures (made by fixtures/make-pdf-fixtures.mjs).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const mobile = process.env.E2E_MOBILE ?? `98766${String(Date.now()).slice(-5)}`;
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
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

// 1. Sign up (our GSTIN is also printed on the bill, as the buyer's).
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Anand Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", "Str0ng-pass!");
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
log("signed up");

// 2. Products from the company's PDF price list (wrapped names in the first column).
await nav("Products");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV or PDF file").setInputFiles(join(FIXTURES, "price-list.pdf"));
await dialog().getByRole("button", { name: "Import 5 rows" }).click({ timeout: 20000 });
await toast("5 products added");
await page.getByText("Harpic Toilet Cleaner 500ml").first().waitFor();
log("5 products imported from price-list.pdf");

// 3. The supplier.
await nav("Suppliers");
await page.getByRole("button", { name: "Add supplier" }).first().click();
await dialog().getByLabel("Supplier name").fill("Shree Ganesh Agencies");
await dialog().getByLabel("GSTIN").fill("23AAACM1234M1ZR");
await dialog().getByRole("button", { name: "Save" }).click();
await toast("Supplier saved");

// 4. The supplier's printed bill as PDF.
await nav("Purchases");
await page.getByRole("button", { name: "Import bill" }).click();
await page.getByLabel("Choose bill file").setInputFiles(join(FIXTURES, "supplier-bill.pdf"));
await dialog().getByText("Bill SG/1044").waitFor({ timeout: 20000 });
await dialog().getByText(/4 items · SHREE GANESH AGENCIES · 23AAACM1234M1ZR/).waitFor();
await page.screenshot({ path: `${OUT}/flow-pdf-import-dialog.png` });
await dialog().getByRole("button", { name: "Match and review" }).click();
await page.getByText("Imported from supplier-bill.pdf").waitFor({ timeout: 15000 });
await page.getByText("3 of 4 items matched").waitFor();
if ((await page.locator("#pu-bill").inputValue()) !== "SG/1044") errors.push("bill number not read from the PDF");
if ((await page.locator("#pu-date").inputValue()) !== "2026-09-24") errors.push("bill date not read from the PDF");
await page.getByText("Shree Ganesh Agencies").first().waitFor();
// The wrapped "SURF EXCEL EASY WASH / 1KG" matched by name; "2 CS" came in cartons.
const surf = page.getByRole("row", { name: /Surf Excel Easy Wash 1kg/ });
const unit = await surf.getByLabel("Unit").inputValue();
if (!(await surf.getByLabel("Unit").locator(`option[value="${unit}"]`).textContent()).startsWith("CTN")) errors.push("Surf not in cartons");
if ((await surf.getByLabel("Qty").inputValue()) !== "2") errors.push("Surf quantity");
await page.getByRole("button", { name: "Harpic Toilet Cleaner 500ml" }).click();
await page.screenshot({ path: `${OUT}/flow-pdf-import-review.png`, fullPage: true });
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
log("bill SG/1044 read from the PDF, matched, reviewed and saved");

// 5. Reports as PDF (and CSV).
await nav("Business Reports");
await page.getByRole("tab", { name: "Purchases", exact: true }).click();
await page.getByRole("button", { name: "PDF", exact: true }).waitFor();
const pdfDownload = page.waitForEvent("download");
await page.getByRole("button", { name: "PDF", exact: true }).click();
const pdf = await pdfDownload;
const pdfPath = join(OUT, pdf.suggestedFilename());
await pdf.saveAs(pdfPath);
if (!/^purchases-.*\.pdf$/.test(pdf.suggestedFilename())) errors.push(`PDF name ${pdf.suggestedFilename()}`);
if (readFileSync(pdfPath).subarray(0, 5).toString() !== "%PDF-") errors.push("download is not a PDF");
const csvDownload = page.waitForEvent("download");
await page.getByRole("button", { name: "Excel (CSV)" }).click();
const csv = await csvDownload;
if (!csv.suggestedFilename().endsWith(".csv")) errors.push(`CSV name ${csv.suggestedFilename()}`);
log("purchases report downloaded as", pdf.suggestedFilename(), "and", csv.suggestedFilename());

if (errors.length) {
  console.log("Errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} else log("no console errors or failed requests");
await browser.close();
