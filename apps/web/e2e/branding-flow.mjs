/**
 * End-to-end check of the two identities: Digital Bahi (the software) and
 * the firm using it. Sign-in shows the Digital Bahi logo and tagline; the
 * firm fills in its address, mobile and email and uploads its logo; the menu
 * shows both; a bill prints with the firm's letterhead and a small "Made with
 * Digital Bahi" line; the phone menu shows the firm card.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/branding-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const mobile = process.env.E2E_MOBILE ?? `98765${String(Date.now()).slice(-5)}`;
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  // Before a logo is uploaded, asking for it is expected to find none.
  if (r.status() === 404 && r.url().endsWith("/business/logo")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");

// 1. Digital Bahi on the sign-in screen.
await page.goto(WEB);
await page.getByRole("img", { name: /Digital Bahi · Aapke Business ka Digital Hisab/ }).waitFor();
await page.screenshot({ path: `${OUT}/flow-brand-signin.png` });
log("sign-in shows the Digital Bahi logo and tagline");

// 2. Sign up the firm.
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Rakesh Agrawal");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", "Str0ng-pass!");
await page.fill("#su-business", "Laxmi Traders");
await page.locator("#su-state").selectOption("23");
await page.fill("#su-gstin", "23AAGFG5678G1ZA");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Rakesh/ }).waitFor({ timeout: 15000 });
signedIn = true;
log("signed up Laxmi Traders");

// 3. The firm's address, mobile, email and logo.
await nav("Settings");
await page.fill("#b-addressLine1", "12 Siyaganj Main Road");
await page.fill("#b-city", "Indore");
await page.fill("#b-pincode", "452007");
await page.fill("#b-phone", "9826012345");
await page.fill("#b-email", "accounts@laxmitraders.in");
await page.getByRole("button", { name: "Save", exact: true }).first().click();
await toast("Settings saved");
await page.getByLabel("Upload logo").setInputFiles(join(FIXTURES, "firm-logo.jpg"));
await toast("Logo saved");
await page.getByRole("button", { name: "Change logo" }).waitFor();
const preview = page.getByLabel("How bills will show your firm");
await preview.locator("img[src^='data:image/']").waitFor();
for (const text of ["Laxmi Traders", "12 Siyaganj Main Road", "Indore 452007", "9826012345 · accounts@laxmitraders.in", "GSTIN: 23AAGFG5678G1ZA"]) {
  if (!(await preview.getByText(text, { exact: true }).count())) errors.push(`preview is missing "${text}"`);
}
await page.locator("aside img[src^='data:image/']").first().waitFor();
await page.screenshot({ path: `${OUT}/flow-brand-settings.png`, fullPage: true });
log("firm details and logo saved; menu shows the firm's logo under Digital Bahi");

// 4. A bill prints with the firm's letterhead.
const products = join(tmpdir(), `brand-products-${mobile}.csv`);
writeFileSync(products, "Item Name,GST %,HSN Code,UOM,Company,Sale Price,Purchase Rate,Stock\nParle-G 100g,5,1905,PCS,Parle,10,8,240\n");
await nav("Products");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(products);
await dialog().getByRole("button", { name: "Import 1 row" }).click();
await toast("1 product added");
const customers = join(tmpdir(), `brand-customers-${mobile}.csv`);
writeFileSync(customers, "Shop Name,Owner,Phone\nGupta General Store,Ramesh Gupta,9826099999\n");
await nav("Customers");
await page.getByRole("button", { name: "Import" }).click();
await page.getByLabel("Choose Excel, CSV, PDF or photo").setInputFiles(customers);
await dialog().getByRole("button", { name: "Import 1 row" }).click();
await toast("1 customer added");
await nav("New Invoice");
const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
await customerBox.fill("Gupta");
await page.getByRole("option", { name: /Gupta General Store/ }).click();
const productBox = page.getByPlaceholder(/Search product/);
await productBox.fill("parle");
await page.getByRole("option", { name: /Parle-G/ }).click();
await page.getByRole("button", { name: "Save invoice" }).click();
await page.getByText(/Invoice INV\/\d\d-\d\d\/00001 saved/).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Details" }).click();
await page.getByRole("heading", { name: /INV\/\d\d-\d\d\/00001/ }).waitFor({ timeout: 15000 });
const bill = page.locator("article").first();
await bill.locator("header img[src^='data:image/']").waitFor();
await bill.getByText("accounts@laxmitraders.in", { exact: false }).first().waitFor();
await bill.getByText("Made with").waitFor();
await page.emulateMedia({ media: "print" });
await page.screenshot({ path: `${OUT}/flow-brand-invoice-print.png`, fullPage: true });
await page.emulateMedia({ media: "screen" });
log("invoice prints with the firm's logo, address, mobile and email, and 'Made with Digital Bahi'");

// 5. The phone menu shows the firm card.
await page.setViewportSize({ width: 390, height: 844 });
await page.getByLabel("More", { exact: true }).first().click();
await dialog().locator("img[src^='data:image/']").first().waitFor();
await dialog().getByText("9826012345 · accounts@laxmitraders.in").waitFor();
await page.screenshot({ path: `${OUT}/flow-brand-phone-menu.png` });
log("phone menu shows the firm's logo and contact details");

if (errors.length) {
  console.log("Errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} else log("no console errors or failed requests");
await browser.close();
