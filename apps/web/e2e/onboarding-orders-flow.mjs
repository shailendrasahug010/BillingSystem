/**
 * End-to-end check of onboarding and the order-to-return cycle against a
 * real API and database: sign up -> import products and customers from CSV ->
 * second godown and a stock transfer -> sales order, confirm, part invoice ->
 * sales return (credit note, printable) -> receipt print -> audit log ->
 * GST summary nets the return.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/onboarding-orders-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
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
page.on("requestfailed", (r) => r.url().startsWith(WEB) && r.failure()?.errorText !== "net::ERR_ABORTED" && errors.push(`failed ${r.method()} ${r.url()}`));

const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");

// 1. Sign up.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kavita Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", "Str0ng-pass!");
await page.fill("#su-business", "Jain Distributors");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
signedIn = true;
log("signed up");

// 2. Import products and customers from CSV (headers as other software exports them).
const products = join(tmpdir(), `products-${mobile}.csv`);
writeFileSync(products, "Item Name,GST %,HSN Code,UOM,Company,Sale Price,Purchase Rate,Stock,Case Unit,Case Size\nParle-G 100g,5,1905,PCS,Parle,10,8,240,BOX,24\nSurf Excel 1kg,18,3402,PCS,HUL,128,115,36,,\n");
await nav("Products");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(products);
await page.getByText(/2 rows ready/).waitFor();
await dialog().getByRole("button", { name: "Import 2 rows" }).click();
await toast("2 products added");
const customers = join(tmpdir(), `customers-${mobile}.csv`);
writeFileSync(customers, "Shop Name,Owner,Phone,Beat,Balance\nGupta General Store,Ramesh Gupta,9826099999,Rajwada,500\n");
await nav("Customers");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(customers);
await page.getByText(/1 row ready/).waitFor();
await dialog().getByRole("button", { name: "Import 1 row" }).click();
await toast("1 customer added");
log("imported 2 products (with opening stock) and 1 customer (with opening balance)");

// 3. A second godown and a transfer.
await nav("Settings");
await page.fill("#wh-name", "Shop Counter");
await page.fill("#wh-code", "SHOP");
await page.getByRole("button", { name: "Add godown" }).click();
await toast("Godown added");
await nav("Inventory");
await page.getByRole("button", { name: "Transfer stock" }).click();
await dialog().getByPlaceholder("Search product, code or scan barcode").fill("parle");
await page.getByRole("option", { name: /Parle-G/ }).click();
await dialog().getByLabel(/^Qty Parle-G/).fill("48");
await dialog().getByRole("button", { name: "Save", exact: true }).click();
await toast("Stock transferred");
await page.getByLabel("Godown").selectOption({ label: "Shop Counter" });
await page.getByRole("cell", { name: /48 PCS/ }).waitFor();
log("transferred 48 pieces to the shop counter");

// 4. Sales order -> confirm -> part invoice.
await page.keyboard.press("Alt+o");
await dialog().getByText("New order").first().waitFor();
await page.getByPlaceholder(/Search by name, mobile/).fill("gupta");
await page.getByRole("option", { name: /Gupta General Store/ }).click();
await dialog().getByPlaceholder("Search product, code or scan barcode").fill("parle");
await page.getByRole("option", { name: /Parle-G/ }).click();
await dialog().getByLabel(/^Qty Parle-G/).fill("24");
await dialog().getByRole("button", { name: /^Save order/ }).click();
await toast("Order saved");
await page.getByRole("button", { name: "Confirm order" }).click();
await page.getByRole("button", { name: "Make invoice" }).click();
await dialog().getByLabel(/^Invoice now Parle-G/).fill("10");
await dialog().getByRole("button", { name: "Save invoice" }).click();
await page.getByRole("button", { name: "Print / PDF" }).waitFor();
const invoiceNumber = (await page.getByRole("heading", { level: 1 }).first().textContent()).trim();
log("order confirmed and part-invoiced:", invoiceNumber);

// 5. Sales return against that invoice: a printable credit note.
await page.getByRole("button", { name: "Record return" }).click();
await dialog().getByLabel(/^Return Parle-G/).fill("2");
await dialog().getByRole("button", { name: /^Save/ }).click();
await toast("Credit note saved");
await page.getByRole("button", { name: /CN\// }).click();
await dialog().getByText("CREDIT NOTE").first().waitFor();
await page.emulateMedia({ media: "print" });
await page.screenshot({ path: `${OUT}/flow-credit-note-print.png` });
await page.emulateMedia({ media: "screen" });
await page.keyboard.press("Escape");
log("credit note posted and printable");

// 6. Collect and print the receipt.
await nav("Payments");
await page.getByRole("button", { name: "Receive payment" }).click();
await page.getByPlaceholder(/Search by name, mobile/).fill("gupta");
await page.getByRole("option", { name: /Gupta General Store/ }).click();
await page.fill("#pay-amount", "100");
await dialog().getByRole("button", { name: /^Save/ }).click();
await toast("Payment saved");
await page.getByRole("cell", { name: /RCT\// }).first().click();
await dialog().getByRole("button", { name: "Print receipt" }).waitFor();
await page.emulateMedia({ media: "print" });
await page.screenshot({ path: `${OUT}/flow-receipt-print.png` });
await page.emulateMedia({ media: "screen" });
await page.keyboard.press("Escape");
log("receipt recorded and printable");

// 7. Audit log and GST summary.
await nav("Audit Log");
await page.getByText("credit_note.posted").first().waitFor();
await page.getByText("sales_order.invoiced").first().waitFor();
await nav("GST Reports");
await page.getByText("Returns (credit and debit notes)").waitFor();
await page.getByRole("cell", { name: "CDNUR" }).first().waitFor();
log("audit log shows the return and the order; GST summary lists the credit note");

if (errors.length) {
  console.log("Errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} else log("no console errors or failed requests");
await browser.close();
