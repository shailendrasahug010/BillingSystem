/**
 * A new business from sign-up to a paid bill, on the computer and on a phone:
 * the sign-up page, a first look with nothing in it (customers, products,
 * dashboard), opening stock corrected on an existing product, GST taken from
 * an HSN already in use, a walk-in bill with Cash sale on a phone (Save bar at
 * the bottom, no tab bar), and payment taken from the saved popup and from a
 * bill's own page.
 *
 * Run against an empty database, with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/start-to-end-flow.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const API = `${process.env.API_URL ?? "http://localhost:3000"}/api/v1`;
const OUT = process.env.OUT ?? ".";
const mobile = `97531${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);
const errors = [];
const check = (ok, what) => ok || errors.push(what);

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
function watch(page) {
  let signedIn = false;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return () => (signedIn = true);
}
async function signIn(page) {
  const done = watch(page);
  await page.goto(WEB);
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await page.getByLabel("Mobile number, email or user ID").fill(mobile);
  await page.locator("input[type=password]").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Today's Sales").waitFor({ timeout: 15000 });
  done();
}

try {
  // 1. Sign-up says what it does: a business of your own, no trial.
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const signedUp = watch(page);
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Create your business" }).waitFor();
  check((await page.getByText(/free trial/i).count()) === 0, "sign-up still speaks of a free trial");
  await page.fill("#su-name", "Asha Verma");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Asha Traders");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByText("Today's Sales").waitFor({ timeout: 15000 });
  signedUp();
  log("signed up from a page titled Create your business");

  // 2. Nothing yet: no staff cards, no made-up chart scale, lists that say "yet" with what to do.
  check((await page.getByText("Staff today").count()) === 0, "dashboard: staff card shown with no employees");
  check((await page.getByText("Salary for", { exact: false }).count()) === 0, "dashboard: salary card shown with no employees");
  check((await page.getByText("₹1", { exact: true }).count()) === 0, "dashboard: the empty chart shows ₹1 on its axis");
  await page.getByText("Your best-selling products show here once bills are made.").waitFor();
  await page.screenshot({ path: `${OUT}/s2e-1-dashboard-new.png`, fullPage: true });
  await page.goto(`${WEB}/#customers`);
  await page.getByText("No customers yet").waitFor({ timeout: 15000 });
  check((await page.getByText("No customers match your filters").count()) === 0, "customers: a new business is told its filters match nobody");
  await page.getByRole("button", { name: "Import from Excel or Tally" }).waitFor();
  await page.goto(`${WEB}/#products`);
  await page.getByText("No products yet").waitFor({ timeout: 15000 });
  log("new business: no staff cards, plain empty lists with Add and Import");

  // 3. Masters through the API, then opening stock corrected from the product's own form.
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const parle = await api("POST", "/products", token, { name: "Parle-G 100g", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "100", openingStockCost: "8" });
  await api("POST", "/products", token, { name: "Surf Excel 1kg", hsnCode: "3402", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "20", openingStockCost: "120" });
  const sharma = await api("POST", "/customers", token, { name: "Sharma Kirana", businessName: "Sharma Kirana", customerType: "b2c", mobile: "9826012345", stateCode: "23", city: "Indore" });
  await page.reload();
  await page.getByRole("cell", { name: /Parle-G 100g/ }).click();
  await page.locator("#p-open").waitFor();
  check((await page.locator("#p-open").inputValue()) === "100", "edit product: opening stock not shown");
  await page.fill("#p-open", "120");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Product saved").first().waitFor();
  const corrected = await api("GET", `/products/${parle.id}`, token);
  check(corrected.stock.total === "120.000" && corrected.stock.opening === "120.000", `opening stock 100 -> 120 left stock ${corrected.stock.total}, opening ${corrected.stock.opening}`);
  log("opening stock corrected on edit:", corrected.stock.total);

  // 4. A new product: the short form, GST from the HSN another product has.
  await page.getByRole("button", { name: "Add product" }).first().click();
  await page.locator("#p-name").waitFor();
  check((await page.locator("#p-brand").count()) === 0, "add product: brand shown before More details");
  await page.fill("#p-name", "Parle Monaco 75g");
  await page.fill("#p-hsn", "1905");
  check((await page.locator("#p-tax").evaluate((e) => e.options[e.selectedIndex].text)) === "GST 5%", "HSN 1905 did not bring GST 5%");
  await page.getByText("Same as Parle-G 100g, which has this HSN").waitFor();
  await page.fill("#p-rate", "20");
  await page.screenshot({ path: `${OUT}/s2e-2-short-product-form.png` });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Product saved").first().waitFor();
  log("short product form; GST 5% from HSN 1905");

  // 5. A credit bill, paid later from the bill's own page.
  await page.goto(`${WEB}/#invoice`);
  await page.reload();
  await page.getByPlaceholder("Search customer by name, mobile, GSTIN or code").fill("Sharma");
  await page.keyboard.press("Enter");
  await page.getByPlaceholder(/Search product/).fill("surf");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save invoice" }).click();
  const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
  await popup.waitFor({ timeout: 20000 });
  await popup.getByRole("button", { name: "View invoice" }).click();
  await page.getByRole("button", { name: "Receive Payment" }).click();
  const pay = page.getByRole("dialog", { name: "Receive payment" });
  await pay.waitFor();
  check((await pay.getByLabel("Amount").inputValue()) === "177.00", "bill page: payment not filled with the bill's balance");
  await pay.getByRole("button", { name: /^Save/ }).click();
  await page.getByText("Payment saved").first().waitFor({ timeout: 15000 });
  const credit = (await api("GET", `/invoices?customerId=${sharma.id}`, token)).data[0];
  check(credit.balanceDue === "0.00", `bill page payment left ${credit.balanceDue} due`);
  log("credit bill paid from its own page");

  // 6. Phone: walk-in bill with Cash sale, Save at the bottom, paid from the popup.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await signIn(phone);
  await phone.goto(`${WEB}/#invoice`);
  await phone.getByRole("button", { name: "Cash sale" }).click();
  check(!(await phone.getByRole("navigation", { name: "Primary" }).isVisible()), "phone: the tab bar covers the bill");
  await phone.getByPlaceholder(/Search product/).fill("parle 12");
  await phone.waitForTimeout(400);
  await phone.keyboard.press("Enter");
  await phone.getByRole("button", { name: "Next" }).click();
  const bar = phone.locator("[data-overlay=bottom]").filter({ hasText: "Grand total" });
  check(await bar.getByRole("button", { name: "Save invoice" }).isVisible(), "phone: no Save at the bottom of the review");
  await phone.screenshot({ path: `${OUT}/s2e-3-phone-review.png` });
  await bar.getByRole("button", { name: "Save invoice" }).click();
  const saved = phone.getByRole("dialog", { name: "Invoice added successfully" });
  await saved.waitFor({ timeout: 20000 });
  await saved.getByRole("button", { name: "Receive Payment" }).click();
  const cash = phone.getByRole("dialog", { name: "Receive payment" });
  await cash.waitFor();
  await cash.getByRole("button", { name: /^Save/ }).click();
  await phone.getByText("Payment saved").first().waitFor({ timeout: 15000 });
  const walkIn = (await api("GET", "/invoices", token)).data.find((i) => i.partyName === "Cash sale");
  check(walkIn && walkIn.balanceDue === "0.00", `cash sale bill: ${walkIn ? `${walkIn.balanceDue} due` : "not made"}`);
  // The same counter customer next time, not a second one.
  await phone.goto(`${WEB}/#invoice`);
  await phone.getByRole("button", { name: "Cash sale" }).click();
  await phone.getByPlaceholder(/Search product/).waitFor();
  const counters = (await api("GET", "/customers?q=cash", token)).data.length;
  check(counters === 1, `cash sale made ${counters} customers`);
  log("phone: Cash sale bill, Save at the bottom, paid from the popup");

  // 7. Phone More menu: the screens before the look-and-feel options.
  await phone.goto(`${WEB}/#dashboard`);
  await phone.getByRole("button", { name: "More", exact: true }).first().click();
  const sheet = phone.getByRole("dialog");
  const screensTop = (await sheet.getByRole("button", { name: "Customers" }).boundingBox())?.y ?? 0;
  const sizeTop = (await sheet.getByText("Text size").boundingBox())?.y ?? 0;
  check(screensTop > 0 && screensTop < sizeTop, "phone More menu: screens are below the appearance options");
  log("phone More menu lists the screens first");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
}
await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
