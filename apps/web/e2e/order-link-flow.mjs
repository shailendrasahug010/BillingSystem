/**
 * End-to-end check of order links. The owner opens a shop (a customer),
 * makes its order link and copies it. On a phone with no sign-in, the shop
 * opens the link: the business's products at the shop's own rates, per pack;
 * search; soap added by the box, oil by the piece; the review shows the bill's
 * total with GST; the order is placed once, with a note, and listed under
 * "Your orders" as pending. The owner sees it under Sales Orders as Pending,
 * from the order link. The page in Hindi. A new link stops the old one, and
 * turning it off stops the new one.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/order-link-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98791${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), "x-client": "native" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const errors = [];
let signedIn = false;
/** Failures the test causes on purpose: a link opened after it was replaced or turned off. */
let expectOff = false;
const watch = (p, who) => {
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`${who}: ${m.text()}`));
  p.on("response", (r) => {
    if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (expectOff && r.status() === 410) return;
    if (r.status() >= 400) errors.push(`${who}: ${r.status()} ${r.request().method()} ${r.url()}`);
  });
};
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await desk.newPage();
watch(page, "owner");
// The shop: its own phone, never signed in.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const shopPage = await phone.newPage();
watch(shopPage, "shop");
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // 1. Sign up; soap sold by the piece or the box of 12, oil by the piece; a shop on a lower rate list.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Suresh Jain");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Jain Distributors");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Suresh/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soapItem = await api("POST", "/products", token, {
    name: "Lux Soap 100g",
    taxCategoryId: taxes["GST 18%"],
    baseUnitId: units.PCS,
    sellingPrice: "40",
    openingStock: "600",
    units: [{ unitId: units.BOX, conversionFactor: "12" }],
  });
  await api("POST", "/products", token, { name: "Parachute Oil 200ml", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "90", openingStock: "100" });
  await api("POST", "/products", token, { name: "Tata Salt 1kg", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "28" });
  const shop = await api("POST", "/customers", token, { name: "Sharma General Store", stateCode: "23", mobile: "9826055555" });
  log("signed up; soap (boxes of 12), oil, salt; a shop");

  // 2. The owner makes the shop's order link.
  await page.goto(`${WEB}/#customer/${shop.id}`);
  await page.reload();
  await page.getByRole("button", { name: "Order link" }).click();
  const dialog = page.getByRole("dialog", { name: "Order link for Sharma General Store" });
  await dialog.getByText("Make a link and send it").waitFor();
  await dialog.getByRole("button", { name: "Make the link" }).click();
  const field = dialog.locator("[data-order-link]");
  await field.waitFor();
  const link = await field.inputValue();
  if (!/#shop\/[A-Za-z0-9_-]{32}$/.test(link)) errors.push(`the link looks wrong: ${link}`);
  await dialog.getByRole("button", { name: "Copy" }).click();
  await page.getByText("Link copied").first().waitFor();
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== link) errors.push("the copied text is not the link");
  await dialog.getByRole("button", { name: "Send on WhatsApp" }).waitFor();
  await dialog.screenshot({ path: `${OUT}/link-1-owner.png` });
  await page.keyboard.press("Escape");
  log("owner: made the link and copied it", link.replace(/[A-Za-z0-9_-]{32}$/, "…"));

  // 3. The shop opens it on a phone: its rates, per pack.
  await shopPage.goto(link);
  await shopPage.getByRole("heading", { name: "Order for Sharma General Store" }).waitFor({ timeout: 15000 });
  await shopPage.getByText("Jain Distributors").first().waitFor();
  const soap = shopPage.locator('[data-product="Lux Soap 100g"]');
  await soap.getByText("₹40.00").waitFor();
  await soap.getByRole("button", { name: /BOX/ }).click();
  await soap.getByText("₹480.00").waitFor();
  await soap.getByRole("button", { name: "Add Lux Soap 100g" }).click();
  await soap.getByRole("button", { name: "One more" }).click();
  if ((await soap.getByLabel("Quantity of Lux Soap 100g").first().inputValue()) !== "2") errors.push("soap: two boxes not counted");
  await shopPage.getByLabel("Search products").fill("parach");
  if ((await shopPage.locator("[data-product]").count()) !== 1) errors.push("search: not only the oil");
  await shopPage.locator('[data-product="Parachute Oil 200ml"]').getByRole("button", { name: "Add Parachute Oil 200ml" }).click();
  await shopPage.getByLabel("Search products").fill("");
  await shopPage.locator('[data-product="Tata Salt 1kg"]').getByText("Out of stock").waitFor();
  await shopPage.getByText("2 items").waitFor();
  if (!(await fits(shopPage))) errors.push("the shop page scrolls sideways on a phone");
  await shopPage.screenshot({ path: `${OUT}/link-2-shop.png`, fullPage: true });
  log("shop: rates per pack (₹40 a piece, ₹480 a box), 2 boxes of soap and an oil in the cart");

  // 4. Review: the bill's total with GST; placed once with a note.
  await shopPage.getByRole("button", { name: "Review order" }).click();
  const review = shopPage.getByRole("dialog");
  // (2 × 480 + 90) × 1.18 = 1239
  await review.locator("[data-total]").getByText("₹1,239.00").waitFor({ timeout: 15000 });
  await review.getByLabel("Note for the order").fill("Deliver on Monday");
  await review.screenshot({ path: `${OUT}/link-3-review.png` });
  await review.getByRole("button", { name: /Place order/ }).click();
  const placed = shopPage.locator("[data-placed]");
  await placed.waitFor({ timeout: 15000 });
  const number = (await placed.textContent()).match(/SO\/[^\s]+/)?.[0];
  if (!number) errors.push(`no order number in "${await placed.textContent()}"`);
  await shopPage.locator(`[data-order="${number}"]`).getByText("Pending").waitFor();
  if (await shopPage.getByText("2 items").isVisible()) errors.push("the cart was not emptied");
  log("shop: placed", number, "for ₹1,239, listed under Your orders as Pending");

  // 5. The owner sees it under Sales Orders: pending, from the order link.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Sales Orders", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: number });
  await row.getByText("Order link").waitFor({ timeout: 15000 });
  await row.getByText("Pending").waitFor();
  await row.click();
  await page.getByText("Deliver on Monday").first().waitFor({ timeout: 10000 });
  log("owner: the order is under Sales Orders, Pending, from the order link, with its note");

  // 5b. The shop's own account on its link: what it owes, its bill, a UPI link to pay, its statement.
  await api("PUT", "/settings/invoice.payment_details", token, { value: { bankName: "", accountNumber: "", ifsc: "", upiId: "jain.dist@okaxis" } });
  // 10 soaps at ₹40 with 18% GST: ₹472; ₹100 paid.
  const bill = await api("POST", "/invoices", token, { customerId: shop.id, lines: [{ productId: soapItem.id, qty: "10" }] });
  await api("POST", "/payments", token, { direction: "in", customerId: shop.id, amount: "100", method: "cash" });
  await shopPage.reload();
  const account = shopPage.locator("[data-shop-account]");
  await account.locator("[data-balance]").getByText("₹372.00").waitFor({ timeout: 15000 });
  const pay = await account.locator("[data-pay]").getAttribute("href");
  if (!pay?.startsWith("upi://pay?pa=jain.dist%40okaxis&pn=Jain%20Distributors&am=372.00")) errors.push(`pay link: ${pay}`);
  await account.locator(`[data-bill="${bill.invoiceNumber}"]`).getByText("₹372.00 due").waitFor();
  const download = shopPage.waitForEvent("download");
  await account.getByRole("button", { name: "Statement (PDF)" }).click();
  if (!(await download).suggestedFilename().endsWith(".pdf")) errors.push("statement: not a PDF");
  if (!(await fits(shopPage))) errors.push("the shop's account scrolls sideways on a phone");
  await account.screenshot({ path: `${OUT}/link-2b-account.png` });
  log("shop: owes ₹372 on its bill, a UPI link for it, its statement as a PDF");

  // 6. Hindi.
  await shopPage.getByRole("button", { name: "हिन्दी" }).click();
  await shopPage.getByRole("heading", { name: "Sharma General Store का ऑर्डर" }).waitFor();
  await shopPage.getByRole("button", { name: "English" }).click();
  log("shop page in Hindi");

  // 7. A new link stops the old one; turning it off stops the new one.
  await page.goto(`${WEB}/#customer/${shop.id}`);
  await page.getByRole("button", { name: "Order link" }).click();
  await dialog.getByText("1 order placed").waitFor({ timeout: 10000 });
  await dialog.getByRole("button", { name: "Make a new link" }).click();
  await page.getByRole("dialog", { name: "Make a new link?" }).getByRole("button", { name: "Make a new link" }).click();
  await field.waitFor();
  await page.waitForFunction((old) => document.querySelector("[data-order-link]")?.value !== old, link);
  const fresh = await field.inputValue();
  expectOff = true;
  await shopPage.goto(link);
  await shopPage.reload();
  await shopPage.getByText("This order link is off").waitFor({ timeout: 15000 });
  await shopPage.goto(fresh);
  await shopPage.reload();
  await shopPage.getByRole("heading", { name: "Order for Sharma General Store" }).waitFor({ timeout: 15000 });
  await dialog.getByRole("button", { name: "Turn off" }).click();
  await page.getByRole("dialog", { name: "Turn off the order link?" }).getByRole("button", { name: "Turn off" }).click();
  await page.getByText("Order link for Sharma General Store turned off").first().waitFor();
  await shopPage.reload();
  await shopPage.getByText("This order link is off").waitFor({ timeout: 15000 });
  await shopPage.screenshot({ path: `${OUT}/link-4-off.png` });
  log("a new link stops the old one; turned off, the new one stops too");
} catch (e) {
  errors.push(e.message);
  await page.screenshot({ path: `${OUT}/link-error-owner.png` }).catch(() => undefined);
  await shopPage.screenshot({ path: `${OUT}/link-error-shop.png` }).catch(() => undefined);
}

await browser.close();
if (errors.length) {
  console.error("✗", errors.join("\n✗ "));
  process.exit(1);
}
log("order links: all passed");
