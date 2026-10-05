/**
 * The sales bills list, free quantity on a bill, links that survive a reload
 * and the browser's Back button, and a bill left half made being kept:
 * sign up -> products and a customer (API) -> a bill with a scheme's free
 * pieces -> the server took them (stock, PDF) -> Invoices lists it, filters
 * -> reload on the bill and on a module keeps the screen, Back goes back ->
 * a bill left half made is offered again and can be thrown away -> a bill
 * copied into a new one, asking first over an unfinished bill -> the menu:
 * an entry pinned, a group folded, kept after a reload.
 *
 * Run against an empty database, with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/bills-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const API = `${process.env.API_URL ?? "http://localhost:3000"}/api/v1`;
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `97765${String(Date.now()).slice(-5)}`;
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

// 1. Sign up, then products and a customer through the API.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Meena Joshi");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Meena Traders");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const parle = await api("POST", "/products", token, { name: "Parle-G 100g", hsnCode: "1905", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "10", openingStock: "100", openingStockCost: "8" });
await api("POST", "/products", token, { name: "Surf Excel 1kg", hsnCode: "3402", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "150", openingStock: "20", openingStockCost: "120" });
await api("POST", "/customers", token, { name: "Gupta Stores", mobile: "9826011111", stateCode: "23", city: "Bhopal", creditDays: 7 });
log("signed up; 2 products and a customer");

// 2. A bill: 10 Parle-G with 1 free (10+1), and a Surf Excel.
await page.goto(`${WEB}/#invoice`);
await page.reload();
const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
await customerBox.waitFor({ timeout: 15000 });
await customerBox.fill("Gupta");
await page.keyboard.press("Enter");
const productBox = page.getByPlaceholder(/Search product/);
await productBox.fill("parle");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.getByRole("textbox", { name: "Qty Parle-G 100g" }).fill("10");
await page.getByRole("textbox", { name: "Free Parle-G 100g" }).fill("1");
await productBox.fill("surf");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/bills-1-free-qty.png` });
await page.getByRole("button", { name: "Save invoice" }).click();
const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
await popup.waitFor({ timeout: 20000 });
const number = (await popup.innerText()).match(/[A-Z][A-Z0-9]*\/\d\d-\d\d\/\d+/)?.[0] ?? "";
await popup.getByRole("button", { name: "View invoice" }).click();
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });
const listed = (await api("GET", "/invoices", token)).data[0];
const detail = await api("GET", `/invoices/${listed.id}`, token);
const parleLine = detail.items.find((i) => i.productId === parle.id);
check(Number(parleLine?.qty) === 10 && Number(parleLine?.freeQty) === 1, `free qty not saved: ${JSON.stringify(parleLine)}`);
check(Number(detail.grandTotal) === 282, `bill total ${detail.grandTotal} (free pieces must carry no value)`);
const stock = (await api("GET", `/products/${parle.id}`, token)).stock;
log("bill", number, "saved: Parle-G 10 + 1 free, total", detail.grandTotal, "stock now", JSON.stringify(stock ?? null));
check(await page.getByText("+1 Free").first().isVisible(), "the bill does not show +1 Free");
await page.screenshot({ path: `${OUT}/bills-2-bill-free.png`, fullPage: true });

// 3. Invoices: the bill is listed, the filters work, a row opens the bill.
await page.goto(`${WEB}/#invoices`);
await page.reload();
await page.getByRole("heading", { name: "Sales bills" }).waitFor({ timeout: 15000 });
await page.getByText(number).waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/bills-3-list.png` });
await page.getByRole("combobox", { name: "Payment" }).selectOption("paid");
await page.waitForTimeout(800);
check((await page.getByText(number).count()) === 0, "an unpaid bill stays listed under Paid");
await page.getByRole("combobox", { name: "Payment" }).selectOption("open");
await page.getByText(number).waitFor({ timeout: 10000 });
await page.getByPlaceholder("Search by bill number or customer").fill("Gupta");
await page.getByText(number).waitFor({ timeout: 10000 });
log("Invoices lists", number, "and filters by payment and customer");
await page.getByText(number).click();
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });

// 4. Each screen has its own link: a reload keeps it, Back and Forward move between screens in the app.
const billUrl = page.url();
check(/#invoice\/[0-9a-f-]{36}$/.test(billUrl), `bill link ${billUrl}`);
await page.reload();
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });
log("reload on the bill keeps the bill:", new URL(billUrl).hash);
await page.goBack();
await page.getByRole("heading", { name: "Sales bills" }).waitFor({ timeout: 15000 });
await page.goForward();
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });
log("browser Back returns to Sales bills, Forward to the bill");
await page.getByRole("link", { name: "Payments" }).or(page.getByRole("button", { name: "Payments", exact: true })).first().click();
await page.waitForURL(/#payments$/);
await page.reload();
await page.waitForTimeout(1500);
check(page.url().endsWith("#payments") && (await page.getByRole("heading", { name: "Payments" }).count()) > 0, `reload on Payments: ${page.url()}`);
await page.goBack();
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });
log("reload on Payments keeps it; Back returns to the bill");

// 5. A bill left half made: kept across another screen and a reload, thrown away on request, gone once saved.
const lineCount = () => page.getByRole("textbox", { name: /^Qty / }).count();
await page.goto(`${WEB}/#invoice`);
await customerBox.waitFor({ timeout: 15000 });
await customerBox.fill("Gupta");
await page.keyboard.press("Enter");
await productBox.fill("surf");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.getByRole("textbox", { name: "Qty Surf Excel 1kg" }).fill("3");
await page.waitForTimeout(600);
await page.getByRole("link", { name: "Customers" }).or(page.getByRole("button", { name: "Customers", exact: true })).first().click();
await page.waitForURL(/#customers$/);
await page.getByRole("link", { name: "New Invoice" }).or(page.getByRole("button", { name: "New Invoice", exact: true })).first().click();
await page.getByText("Unfinished bill brought back").waitFor({ timeout: 10000 });
check((await page.getByRole("textbox", { name: "Qty Surf Excel 1kg" }).inputValue()) === "3", "the kept bill came back without its quantity");
log("another screen and back: the unfinished bill came back (Surf Excel × 3, Gupta Stores)");
await page.reload();
await page.getByText("Unfinished bill brought back").waitFor({ timeout: 15000 });
check((await lineCount()) === 1 && (await page.getByText("Gupta Stores").count()) > 0, "the kept bill did not come back after a reload");
await page.screenshot({ path: `${OUT}/bills-4-kept.png` });
log("reload: the unfinished bill came back");
await page.getByRole("button", { name: "Start a new bill" }).click();
await page.waitForTimeout(400);
check((await lineCount()) === 0, "Start a new bill kept the lines");
await page.reload();
await customerBox.waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
check((await lineCount()) === 0 && (await page.getByText("Unfinished bill brought back").count()) === 0, "a discarded bill came back");
log("Start a new bill: thrown away, not back after a reload");
await customerBox.fill("Gupta");
await page.keyboard.press("Enter");
await productBox.fill("parle");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
await page.getByRole("button", { name: "Save invoice" }).click();
await page.getByRole("dialog", { name: "Invoice added successfully" }).waitFor({ timeout: 20000 });
await page.reload();
await customerBox.waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
check((await lineCount()) === 0 && (await page.getByText("Unfinished bill brought back").count()) === 0, "a saved bill came back as unfinished");
log("saved bill: not offered again");

// 6. Copy a bill: the first bill's items, quantities, free pieces and rates on a new bill for the same shop.
await page.goto(billUrl);
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Copy bill" }).click();
await page.getByText(`Copied from ${number}`).first().waitFor({ timeout: 10000 });
check((await page.getByRole("textbox", { name: "Qty Parle-G 100g" }).inputValue()) === "10", "copied bill: Parle-G quantity");
check((await page.getByRole("textbox", { name: "Free Parle-G 100g" }).inputValue()) === "1", "copied bill: free pieces");
check((await lineCount()) === 2 && (await page.getByText("Gupta Stores").count()) > 0, "copied bill: lines or customer");
await page.screenshot({ path: `${OUT}/bills-5-copied.png` });
log("Copy bill: a new bill with", number, "'s two lines (Parle-G 10 + 1 free) for Gupta Stores");
// Copying again over the copy not saved yet asks first.
await page.waitForTimeout(600);
await page.goto(billUrl);
await page.getByRole("heading", { name: number }).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Copy bill" }).click();
const replace = page.getByRole("dialog", { name: "Replace the unfinished bill?" });
await replace.waitFor({ timeout: 10000 });
await replace.getByRole("button", { name: "Copy bill" }).click();
await page.getByText(`Copied from ${number}`).first().waitFor({ timeout: 10000 });
await page.getByRole("button", { name: "Save invoice" }).click();
await page.getByRole("dialog", { name: "Invoice added successfully" }).waitFor({ timeout: 20000 });
const copies = (await api("GET", "/invoices", token)).data.filter((b) => Number(b.grandTotal) === 282);
check(copies.length === 2, `bills of 282 after the copy: ${copies.length}`);
log("over an unfinished bill it asks first; the copy saved for the same total");

// 7. The menu: an entry pinned to the top, a group folded away; both kept after a reload.
await page.keyboard.press("Escape");
await page.getByRole("dialog").waitFor({ state: "detached" });
const menu = page.getByRole("navigation", { name: "Main" });
await menu.getByRole("button", { name: "Payments", exact: true }).hover();
await menu.getByRole("button", { name: "Pin Payments to the top" }).click();
await menu.getByText("Pinned").waitFor();
const firstEntry = async () => (await menu.locator("button:not([aria-expanded]):not([aria-pressed])").first().textContent()).trim();
check((await firstEntry()) === "Payments", `first menu entry after pinning: ${await firstEntry()}`);
await menu.getByRole("button", { name: "Stock", exact: true }).click();
check((await menu.getByRole("button", { name: "Products", exact: true }).count()) === 0, "the folded Stock group still shows Products");
await page.screenshot({ path: `${OUT}/bills-6-menu.png` });
await page.reload();
await menu.getByText("Pinned").waitFor({ timeout: 15000 });
check((await firstEntry()) === "Payments" && (await menu.getByRole("button", { name: "Products", exact: true }).count()) === 0, "the menu's pins and folds were not kept");
await menu.getByRole("button", { name: "Stock", exact: true }).click();
await menu.getByRole("button", { name: "Products", exact: true }).waitFor();
await menu.getByRole("button", { name: "Unpin Payments" }).click();
check((await menu.getByText("Pinned").count()) === 0, "the Pinned section stayed after unpinning");
log("menu: Payments pinned to the top, Stock folded, both kept after a reload, then undone");

console.log("errors:", errors.length ? errors : "none");
await browser.close();
if (errors.length) process.exit(1);
