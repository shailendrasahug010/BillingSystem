/**
 * End-to-end check of the Phase 4 modules against a real API and database:
 * sign up (with GSTIN) -> CSV import -> sales order -> packing -> invoice ->
 * discount credit note -> dispatch trip and delivery -> expense with GST ->
 * employee, salary structure, attendance, leave -> payroll run, finalize,
 * pay, salary slip print -> GSTR-1 file, GSTR-3B, month lock / unlock ->
 * profit and P&L reports.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/phase4-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98763${String(Date.now()).slice(-5)}`;
const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7);
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
const numberIn = async (re) => (await page.getByRole("heading", { level: 1 }).first().textContent()).match(re)[0];

// 1. Sign up a GST-registered business in Madhya Pradesh.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Anil Sethi");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", "Str0ng-pass!");
await page.fill("#su-business", "Sethi Distributors");
await page.locator("#su-state").selectOption("23");
await page.fill("#su-gstin", "23AAGFG5678G1ZA");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Anil/ }).waitFor({ timeout: 15000 });
signedIn = true;
log("signed up");

// 2. Products and a customer from CSV.
const products = join(tmpdir(), `p4-products-${mobile}.csv`);
writeFileSync(products, "Item Name,GST %,HSN Code,UOM,Company,Sale Price,Purchase Rate,Stock\nParle-G 100g,5,1905,PCS,Parle,10,8,240\nSurf Excel 1kg,18,3402,PCS,HUL,128,115,36\n");
await nav("Products");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(products);
await dialog().getByRole("button", { name: "Import 2 rows" }).click();
await toast("2 products added");
const customers = join(tmpdir(), `p4-customers-${mobile}.csv`);
writeFileSync(customers, "Shop Name,Owner,Phone,Beat\nGupta General Store,Ramesh Gupta,9826099999,Rajwada\n");
await nav("Customers");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(customers);
await dialog().getByRole("button", { name: "Import 1 row" }).click();
await toast("1 customer added");
log("imported products and a customer");

// 3. Order -> confirm -> pack.
await page.keyboard.press("Alt+o");
await dialog().getByText("New order").first().waitFor();
await page.getByPlaceholder(/Search by name, mobile/).fill("gupta");
await page.getByRole("option", { name: /Gupta General Store/ }).click();
await dialog().getByPlaceholder("Search product, code or scan barcode").fill("parle");
await page.getByRole("option", { name: /Parle-G/ }).click();
await dialog().getByLabel(/^Qty Parle-G/).fill("48");
await dialog().getByRole("button", { name: /^Save order/ }).click();
await toast("Order saved");
const orderNumber = await numberIn(/SO\/[\d-]+\/\d+/);
await page.getByRole("button", { name: "Confirm order" }).click();
await page.getByText("Confirmed").first().waitFor();
await nav("Packing");
await page.getByRole("row", { name: new RegExp(orderNumber) }).click();
await dialog().getByPlaceholder("Scan a barcode or type a product").fill("parle");
await dialog().getByPlaceholder("Scan a barcode or type a product").press("Enter");
await dialog().getByRole("button", { name: "Save packing" }).click();
await toast("Packed");
log("order", orderNumber, "confirmed and packed");

// 4. Invoice the order, then a 5% discount credit note on the bill.
await nav("Sales Orders");
await page.getByRole("cell", { name: orderNumber }).click();
await page.getByRole("button", { name: "Make invoice" }).click();
await dialog().getByRole("button", { name: "Save invoice" }).click();
await page.getByRole("button", { name: "Print / PDF" }).waitFor();
const invoiceNumber = await numberIn(/INV\/[\d-]+\/\d+/);
await page.getByRole("button", { name: "Discount / rate difference" }).click();
await dialog().getByLabel("Percent of the bill", { exact: true }).fill("5");
await dialog().getByRole("button", { name: "Save" }).click();
await toast("Credit note saved");
log("invoiced", invoiceNumber, "and credited a 5% discount");

// 5. Dispatch and deliver.
await nav("Dispatch");
await page.getByRole("checkbox", { name: invoiceNumber }).check();
await page.getByRole("button", { name: /^Plan trip/ }).click();
await dialog().getByLabel("Vehicle", { exact: true }).fill("mp09ab1234");
await dialog().getByLabel("Driver name").fill("Raju");
await dialog().getByRole("button", { name: "Save and dispatch" }).click();
await toast("Trip dispatched");
await dialog().getByLabel(/^Received by/).first().fill("Ramesh Gupta");
await dialog().getByRole("button", { name: "Delivered", exact: true }).first().click();
await toast("Delivery recorded");
await page.keyboard.press("Escape");
log("dispatched and delivered");

// 6. An expense with GST input credit.
await nav("Expenses");
await page.getByRole("button", { name: "New expense" }).click();
await dialog().getByLabel("Category").selectOption({ label: "Electricity" });
await dialog().getByLabel("Amount before GST").fill("1180");
await dialog().getByLabel("GST on the bill").selectOption("18");
await dialog().getByLabel("Vendor GSTIN").fill("23AAACM1234M1ZR");
await dialog().getByText("The amount I entered already includes GST").click();
await dialog().getByRole("button", { name: /^Save/ }).click();
await toast("Expense saved");
log("expense recorded with GST credit");

// 7. Employee, salary, attendance, leave.
await nav("Employees");
await page.getByRole("button", { name: "Add employee" }).click();
await dialog().getByLabel("Name", { exact: true }).fill("Mohan Lal");
await dialog().getByLabel("Mobile").fill("9812345678");
await dialog().getByLabel("Joining date").fill("2026-01-05");
await dialog().getByRole("button", { name: "Save" }).click();
await toast("Employee added");
await page.getByRole("cell", { name: /Mohan Lal/ }).click();
await dialog().getByRole("button", { name: "Change salary" }).click();
await dialog().getByLabel("Basic").fill("10000");
await dialog().getByLabel("House Rent Allowance").fill("40");
await dialog().getByRole("button", { name: "Save" }).click();
await toast("Salary structure saved");
await page.keyboard.press("Escape");
await page.getByRole("tab", { name: "Attendance" }).click();
await page.getByRole("radiogroup", { name: "Status Mohan Lal" }).getByRole("radio", { name: "A" }).click();
await page.getByRole("button", { name: /^Save 1 mark/ }).click();
await toast("Attendance saved");
await nav("Leave");
await page.getByRole("button", { name: "Apply leave" }).click();
const option = (await dialog().getByLabel("Employee").locator("option", { hasText: "Mohan Lal" }).textContent()).trim();
await dialog().getByLabel("Employee").selectOption({ label: option });
await dialog().getByLabel("Leave type").selectOption({ index: 1 });
await dialog().getByRole("button", { name: "Send request" }).click();
await toast("Leave request sent");
await page.getByRole("button", { name: "Approve" }).first().click();
await toast("Leave approved");
log("employee added with salary, attendance and approved leave");

// 8. Payroll: run, finalize, pay, print the slip.
await nav("Salary");
await page.getByLabel("Month").fill(month);
await page.getByRole("button", { name: /^Run payroll/ }).click();
await page.getByRole("button", { name: "Finalize" }).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Finalize" }).click();
await toast("Payroll finalized");
await page.getByRole("button", { name: "Pay salaries" }).click();
await dialog().getByRole("button", { name: /^Pay / }).click();
await toast("Salaries paid");
await page.getByRole("row", { name: /Mohan Lal/ }).click();
await dialog().getByText("SALARY SLIP").first().waitFor();
await page.emulateMedia({ media: "print" });
await page.screenshot({ path: `${OUT}/flow-salary-slip-print.png` });
await page.emulateMedia({ media: "screen" });
await page.keyboard.press("Escape");
log("payroll run, finalized and paid; slip printable");

// 9. GST: GSTR-1 file, GSTR-3B, month lock.
await nav("GST Reports");
await page.getByLabel("Period").fill(month);
await page.getByRole("tab", { name: "GSTR-1" }).click();
await page.getByText("GSTR-1 tables").waitFor();
const download = page.waitForEvent("download");
await page.getByRole("button", { name: "Download JSON" }).click();
const file = (await download).suggestedFilename();
if (!file.startsWith("GSTR1_23AAGFG5678G1ZA_")) errors.push(`unexpected GSTR-1 file name ${file}`);
await page.getByRole("tab", { name: "GSTR-3B" }).click();
await page.getByText("3.1 Outward supplies").waitFor();
await page.getByRole("button", { name: "Lock month" }).click();
await dialog().getByRole("button", { name: "Lock month" }).click();
await page.getByText(/locked$/).first().waitFor();
await page.getByRole("button", { name: "Unlock" }).click();
await dialog().getByRole("button", { name: "Unlock" }).click();
await page.getByText(/unlocked$/).first().waitFor();
log("GSTR-1 downloaded as", file, "; GSTR-3B shown; month locked and unlocked");

// 10. Profit and P&L.
await nav("Business Reports");
await page.getByRole("tab", { name: "Profit", exact: true }).click();
await page.getByRole("cell", { name: /Parle-G/ }).first().waitFor();
await page.getByRole("tab", { name: "Profit & loss" }).click();
await page.getByText("Electricity").first().waitFor();
await page.getByText("Salaries").first().waitFor();
await page.screenshot({ path: `${OUT}/flow-pnl.png`, fullPage: true });
log("profit and P&L reports show the month");

if (errors.length) {
  console.log("Errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} else log("no console errors or failed requests");
await browser.close();
