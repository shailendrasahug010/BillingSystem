/**
 * End-to-end check of the day-to-day screens against a real API and database:
 * product editor -> supplier -> purchase bill (server agrees on the total) ->
 * pay the supplier -> stock and adjustment -> sell and collect -> reports and
 * GST summary -> add a team member and a role -> business settings.
 *
 * Run against an empty database, with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/operations-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const API = `${process.env.API_URL ?? "http://localhost:3000"}/api/v1`;
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98765${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Failed loads are reported by the response / requestfailed events below (with their URL).
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
let signedIn = false;
page.on("response", (r) => {
  // Before sign-in the app probes for a session once; that 401 is expected.
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
// Only our own origin counts (web fonts may be blocked in a sandbox).
// Cancelled queries (a screen closed mid-request) are aborted on purpose.
page.on("requestfailed", (r) => r.url().startsWith(WEB) && r.failure()?.errorText !== "net::ERR_ABORTED" && errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText}`));

const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text, { exact: true }).first().waitFor({ timeout: 15000 });
const shot = (name) => page.screenshot({ path: `${OUT}/ops-${name}.png`, fullPage: true });

// Session token for the few API calls (a customer and an invoice to collect against).
let token = null;
page.on("response", async (r) => {
  if (/\/auth\/(signup|login|refresh|switch-business)/.test(r.url()) && r.ok()) token = (await r.json().catch(() => ({}))).accessToken ?? token;
});
async function api(method, path, body) {
  const res = await fetch(API + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// 1. Sign up.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Meena Gupta");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Gupta Traders");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
signedIn = true;
log("signed up");

// 2. Product editor: new brand inline, case unit and an inner strip, prices per rate list.
await nav("Products");
await page.getByRole("button", { name: "Add product" }).first().click();
await page.fill("#p-name", "Parle-G Biscuit 100 g");
await page.selectOption("#p-brand", "__new");
await page.getByPlaceholder("New company / brand").fill("Parle");
await page.fill("#p-pack", "100 g");
await page.selectOption("#p-tax", { label: "GST 18%" });
await page.fill("#p-hsn", "1905");
await page.fill("#p-barcode", "8901719101045");
await page.selectOption("#p-case", { label: "BOX – Box" });
await page.fill("#p-factor", "24");
// A box of 24 packets sold as 4 strips of 6 as well.
await page.selectOption("#p-inner", { label: "STRIP – Strip" });
await page.fill("#p-inner-factor", "6");
await page.fill("#p-min", "48");
await page.fill("#p-cost", "8");
await page.fill("#p-rate", "9.5");
await page.fill("#p-mrp", "10");
await shot("1-product-editor");
await page.getByRole("button", { name: "Save", exact: true }).click();
await toast("Product saved");
await page.getByRole("cell", { name: /Parle-G Biscuit/ }).waitFor();
log("product created from the editor");
// Edit: change the selling price only.
await page.getByRole("cell", { name: /Parle-G Biscuit/ }).click();
await page.locator("#p-rate").waitFor();
if ((await page.locator("#p-inner").inputValue()) === "" || (await page.locator("#p-inner-factor").inputValue()) !== "6" || (await page.locator("#p-factor").inputValue()) !== "24") errors.push("pack units not loaded back");
await page.fill("#p-rate", "9.75");
await page.getByRole("button", { name: "Save", exact: true }).click();
await toast("Product saved");
log("product edited (PATCH of changed fields); box of 24 and strip of 6 kept");

// 3. Supplier.
await nav("Suppliers");
await page.getByRole("button", { name: "Add supplier" }).first().click();
await page.fill("#s-name", "Parle Products Depot");
await page.fill("#s-company", "Parle Products Pvt Ltd");
await page.fill("#s-mobile", "9826012345");
await page.fill("#s-gstin", "23AABCP1234Q1ZF");
await page.fill("#s-city", "Indore");
await page.fill("#s-days", "15");
await page.fill("#s-acno", "123456789012");
await page.fill("#s-ifsc", "SBIN0001234");
await page.getByRole("button", { name: "Save", exact: true }).click();
await toast("Supplier saved");
await page.getByRole("heading", { name: "Parle Products Depot" }).waitFor();
await page.getByText("XXXXXX9012").waitFor();
log("supplier created; bank account shown masked only");

// 4. Purchase bill from the supplier profile.
await page.getByRole("button", { name: "New purchase bill" }).click();
await page.fill("#pu-bill", "PPD/2627/0456");
await page.getByPlaceholder("Search product, code or scan barcode").fill("parle");
await page.getByRole("option", { name: /Parle-G Biscuit/ }).click();
await page.getByLabel("Qty").first().fill("10");
await page.getByRole("button", { name: "Add charge" }).click();
await page.getByPlaceholder("Amount").fill("100");
const grand = (await page.locator("dl").filter({ hasText: "Grand total" }).locator("dd").last().textContent()).trim();
log("purchase total on screen", grand);
await shot("2-purchase-entry");
await page.getByRole("button", { name: "Save purchase" }).click();
await toast("Purchase saved");
await page.getByText("PPD/2627/0456").first().waitFor();
const shown = (await page.locator("dl").filter({ hasText: "Grand total" }).locator("dd").last().textContent()).trim();
if (shown !== grand) throw new Error(`purchase total changed: screen ${grand}, posted ${shown}`);
log("purchase posted; server total matches", shown);
await shot("3-purchase-view");

// 5. Pay the supplier from the bill.
await page.getByRole("button", { name: "Pay supplier" }).click();
await page.fill("#pay-amount", "1000");
await page.selectOption("#pay-method", "upi");
await page.fill("#pay-ref", "UTR998877");
await page.getByRole("button", { name: /^Save/ }).click();
await toast("Payment saved");
await page.getByText("Partly paid").first().waitFor();
log("supplier paid (partly); bill shows partly paid");

// 6. Inventory: 10 boxes = 240 pieces; damage 2.
await nav("Inventory");
await page.getByRole("cell", { name: /240 PCS/ }).waitFor();
await page.getByRole("button", { name: "Adjust stock" }).click();
await page.selectOption("#adj-reason", "damage");
await page.getByRole("dialog").getByPlaceholder("Search product, code or scan barcode").fill("parle");
await page.getByRole("option", { name: /Parle-G Biscuit/ }).click();
await page.getByRole("dialog").getByPlaceholder("Qty").fill("2");
await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
await toast("Stock adjusted");
await page.getByRole("cell", { name: /238 PCS/ }).waitFor();
await page.getByRole("cell", { name: /Parle-G Biscuit/ }).click();
await page.getByRole("dialog").getByText("Damaged").first().waitFor();
await shot("4-stock-ledger");
await page.keyboard.press("Escape");
log("stock 240 -> 238 after damage; ledger shows the movement");

// 7. Sell (API) and collect in the UI.
const me = await api("GET", "/me");
const catalog = await api("GET", "/catalog");
const product = catalog.products.find((p) => p.name.startsWith("Parle-G"));
const customer = await api("POST", "/customers", { name: "Sharma Kirana", businessName: "Sharma Kirana Store", mobile: "9893012345", stateCode: me.business.stateCode, creditDays: 7 });
const invoice = await api("POST", "/invoices", { customerId: customer.id, lines: [{ productId: product.id, qty: "48" }] });
log("invoice via API", invoice.invoiceNumber, invoice.grandTotal);
await page.reload();
await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
await nav("Payments");
await page.getByRole("button", { name: "Receive payment" }).click();
await page.getByPlaceholder(/Search by name, mobile/).fill("sharma");
await page.getByRole("option", { name: /Sharma Kirana Store/ }).click();
await page.fill("#pay-amount", "200");
await page.getByRole("dialog").getByText(invoice.invoiceNumber).waitFor();
await page.getByRole("button", { name: /^Save/ }).click();
await toast("Payment saved");
await page.getByRole("cell", { name: "Sharma Kirana" }).first().waitFor();
await shot("5-payments");
log("collection recorded against the invoice");

// 8. Reports and GST.
await nav("Business Reports");
// Reports open on Insights for the owner; the sales report is the next tab.
await page.getByRole("tab", { name: "Sales", exact: true }).click();
await page.getByRole("cell", { name: "Total" }).first().waitFor();
await page.getByRole("tab", { name: "Outstanding" }).click();
await page.getByRole("cell", { name: /Sharma Kirana/ }).waitFor();
await page.getByRole("radio", { name: "To pay" }).click();
await page.getByRole("cell", { name: /Parle Products Depot/ }).waitFor();
await shot("6-reports-outstanding");
log("reports: sales and outstanding (receivable and payable)");
await nav("GST Reports");
await page.getByRole("cell", { name: "B2CS" }).first().waitFor();
await page.getByRole("cell", { name: "1905" }).first().waitFor();
await shot("7-gst");
log("GST summary: outward B2CS, inward ITC, HSN 1905");

// 9. Team: add a member, create a role.
await nav("Users & Roles");
await page.getByRole("button", { name: "Add member" }).click();
await page.fill("#inv-name", "Raju Salesman");
await page.fill("#inv-mobile", "9111122222");
await page.getByRole("dialog").getByRole("button", { name: "Add member" }).click();
await toast("Member added");
await page.getByRole("cell", { name: /Raju Salesman/ }).waitFor();
await page.getByRole("button", { name: "New role" }).click();
await page.fill("#r-name", "Delivery boy");
await page.getByRole("dialog").getByRole("group").filter({ hasText: "Dispatch" }).getByLabel("Deliver").check();
await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
await toast("Role saved");
await page.getByRole("tab", { name: "Roles" }).click();
await page.getByRole("cell", { name: /Delivery boy/ }).waitFor();
await shot("8-roles");
log("member added; custom role created");

// 10. Settings: a business rule and the profile.
await nav("Settings");
await page.getByRole("radiogroup", { name: "Negative stock" }).getByRole("radio", { name: "Block" }).click();
await toast("Settings saved");
await page.fill("#b-city", "Indore");
await page.fill("#b-pincode", "452001");
await page.getByRole("button", { name: "Save", exact: true }).first().click();
await toast("Settings saved");
const settings = await api("GET", "/settings");
if (settings["stock.negative_policy"] !== "block") throw new Error("setting not saved");
await shot("9-settings");
log("settings saved (stock policy, business address)");

if (errors.length) {
  console.log("Errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} else log("no console errors or failed requests");
await browser.close();
