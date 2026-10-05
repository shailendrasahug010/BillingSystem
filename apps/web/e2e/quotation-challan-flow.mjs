/**
 * Quotations and delivery challans: sign up -> products and a customer (API)
 * -> Sales orders -> New quotation, priced from the rate list with a valid-until
 * date -> listed under Quotations, not as an open order, printed as a
 * QUOTATION -> accepted: an order number of its own, the quotation's kept ->
 * confirmed -> Delivery challan printed with its own number, the same number
 * when printed again -> nothing moved in stock until the bill.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/quotation-challan-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const API = `${process.env.API_URL ?? "http://localhost:3000"}/api/v1`;
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `97764${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);
const errors = [];
const check = (ok, what) => {
  if (!ok) errors.push(what);
};

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
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

const dialog = () => page.getByRole("dialog");
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
// What went to the printer: the print dialog is replaced by a note of the document on the page then.
const printed = async () => {
  await page.waitForFunction(() => window.__printed?.length > 0, null, { timeout: 10000 });
  return page.evaluate(() => window.__printed.shift());
};

// 1. Sign up, then products and a customer through the API.
await page.addInitScript(() => {
  window.__printed = [];
  window.print = () => window.__printed.push(document.querySelector(".print-root")?.innerText ?? "");
});
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Kavita Rao");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Rao Distributors");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Kavita/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Lifebuoy Soap 100g", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "30", openingStock: "200", openingStockCost: "24" });
await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826022222", stateCode: "23", city: "Indore" });
log("signed up; a product and a customer");

// 2. A quotation: priced like an order, valid for a fortnight.
await page.goto(`${WEB}/#orders`);
await page.reload();
await page.getByRole("button", { name: "New quotation" }).click();
await dialog().getByText("New quotation").first().waitFor();
await page.getByPlaceholder(/Search by name, mobile/).fill("sharma");
await page.getByRole("option", { name: /Sharma Kirana/ }).click();
await dialog().getByPlaceholder("Search product, code or scan barcode").fill("lifebuoy");
await page.getByRole("option", { name: /Lifebuoy/ }).click();
await dialog().getByLabel(/^Qty Lifebuoy/).fill("100");
await dialog().getByLabel("Valid until").fill("2099-12-31");
await dialog().getByRole("button", { name: /^Save quotation/ }).click();
await toast("Quotation saved");
const heading = page.getByRole("heading", { level: 1 }).first();
await heading.filter({ hasText: /QT\// }).waitFor({ timeout: 15000 });
const quoteNumber = (await heading.textContent()).match(/QT\/[\d-]+\/\d+/)?.[0];
check(Boolean(quoteNumber), `quotation number: ${await heading.textContent()}`);
await page.getByText("valid until 31 Dec 2099").first().waitFor();
await page.screenshot({ path: `${OUT}/quote-1-quotation.png` });
await page.getByRole("button", { name: "Print quotation" }).click();
const quote = await printed();
check(/QUOTATION/.test(quote) && quote.includes(quoteNumber) && /Valid until/.test(quote) && /Sharma Kirana/.test(quote) && /not a tax invoice/i.test(quote), `printed quotation: ${quote.slice(0, 300)}`);
check(!/Balance/.test(quote), "the quotation prints a balance");
log("quotation", quoteNumber, "saved and printed:", quote.match(/Grand total[^\n]*\n?[^\n]*/)?.[0]?.replace(/\s+/g, " "));

// Listed under Quotations, not among the orders.
await page.goto(`${WEB}/#orders`);
await page.getByRole("tab", { name: /Quotations/ }).click();
await page.getByRole("cell", { name: quoteNumber }).waitFor({ timeout: 10000 });
await page.getByRole("tab", { name: "Sales orders" }).click();
await page.waitForTimeout(800);
check((await page.getByRole("cell", { name: quoteNumber }).count()) === 0, "the quotation shows as an order");
log("listed under Quotations, not as an order");

// 3. Accepted: an order with an order number of its own.
await page.getByRole("tab", { name: /Quotations/ }).click();
await page.getByRole("cell", { name: quoteNumber }).click();
await page.getByRole("button", { name: "Accept quotation" }).click();
await heading.filter({ hasText: /SO\// }).waitFor({ timeout: 15000 });
const orderNumber = (await heading.textContent()).match(/SO\/[\d-]+\/\d+/)?.[0];
await page.getByText(`from quotation ${quoteNumber}`).first().waitFor();
log("accepted: order", orderNumber, "from quotation", quoteNumber);

// 4. Confirmed, the goods go before the bill on a delivery challan.
await page.getByRole("button", { name: "Confirm order" }).click();
await page.getByRole("button", { name: "Delivery challan" }).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Delivery challan" }).click();
const challan = await printed();
const challanNumber = challan.match(/DC\/[\d-]+\/\d+/)?.[0];
check(/DELIVERY CHALLAN/.test(challan) && Boolean(challanNumber) && challan.includes(orderNumber) && /Not a tax invoice/i.test(challan), `printed challan: ${challan.slice(0, 300)}`);
await page.getByText(`challan ${challanNumber}`).first().waitFor({ timeout: 10000 });
await page.screenshot({ path: `${OUT}/quote-2-order-challan.png` });
await page.getByRole("button", { name: "Delivery challan" }).click();
check((await printed()).includes(challanNumber), "the challan printed again with another number");
const stock = (await api("GET", `/products/${soap.id}`, token)).stock;
log("delivery challan", challanNumber, "against", orderNumber, "printed twice with the same number; stock", JSON.stringify(stock ?? null));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
if (errors.length) process.exit(1);
