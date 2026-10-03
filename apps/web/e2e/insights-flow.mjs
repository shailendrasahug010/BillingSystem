/**
 * End-to-end check of business intelligence (Phase 5.5): a distributor with
 * July stock, August and September sales, a return, a payment, a new and a
 * lost customer and stock that never sells -> Reports opens on Insights ->
 * last month against the month before: the measures with their change, the
 * 12-month trend, where sales come from (customers with ABC class, new and
 * lost; companies), fast, slow and dead stock -> the same dates a year
 * earlier -> saved as a view and opened again -> the customers table
 * downloaded -> in Hindi -> on a phone.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true, on a
 * day in October 2026 or later (the sales are dated August and September 2026):
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/insights-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98761${run}`;
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
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  // A reload cancels the requests under way (net::ERR_ABORTED); the live stream is cut that way too.
  if (r.url().includes("/api/") && r.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const panel = () => page.getByRole("tabpanel");
/** The tile of a measure: its value and the line under it. */
const tile = async (label) => (await panel().getByLabel("Measures").getByText(label, { exact: true }).locator("..").innerText()).replace(/\s+/g, " ");

try {
  // 1. A new business, signed up in the browser.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Meena Agarwal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Agarwal Traders");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
  signedIn = true;

  // 2. July stock, August and September sales (the API, as the business would have entered them).
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const tata = (await api("POST", "/brands", token, { name: "Tata" })).id;
  const hul = (await api("POST", "/brands", token, { name: "HUL" })).id;
  const product = async (name, brandId, price, tax) => (await api("POST", "/products", token, { name, brandId, taxCategoryId: taxes[tax], baseUnitId: units.PCS, sellingPrice: price })).id;
  const tea = await product("Tea 250g", tata, "100", "GST 5%");
  const soap = await product("Bath Soap", hul, "50", "GST 18%");
  const oil = await product("Mustard Oil 1L", undefined, "200", "GST 5%");
  const idle = await product("Old Soap", hul, "20", "GST 18%");
  const supplier = (await api("POST", "/suppliers", token, { name: "Wholesale Co", stateCode: "23", gstin: "23AAACM1234M1ZR" })).id;
  await api("POST", "/purchases", token, {
    supplierId: supplier,
    supplierInvoiceNumber: "W/77",
    supplierInvoiceDate: "2026-07-15",
    receivedDate: "2026-07-15",
    lines: [
      { productId: tea, qty: "50", rate: "60" },
      { productId: soap, qty: "200", rate: "30" },
      { productId: oil, qty: "10", rate: "150" },
      { productId: idle, qty: "50", rate: "10" },
    ],
  });
  const customer = async (name) => (await api("POST", "/customers", token, { name, stateCode: "23" })).id;
  const one = await customer("Kirana One");
  const two = await customer("Kirana Two");
  const three = await customer("Kirana Three");
  const bill = (customerId, invoiceDate, lines) => api("POST", "/invoices", token, { customerId, invoiceDate, lines });
  await bill(one, "2026-08-10", [{ productId: tea, qty: "10" }]);
  await bill(three, "2026-08-20", [{ productId: soap, qty: "20" }]);
  const big = await bill(one, "2026-09-05", [{ productId: tea, qty: "20" }, { productId: soap, qty: "10" }]);
  await bill(two, "2026-09-12", [{ productId: oil, qty: "3" }]);
  await api("POST", `/invoices/${big.id}/returns`, token, { noteDate: "2026-09-15", lines: [{ lineId: big.items[1].id, qty: "2" }] });
  await api("POST", "/payments", token, { direction: "in", customerId: one, amount: "1000", method: "cash", paymentDate: "2026-09-16" });
  log("stock bought in July; August and September billed, a return and a payment");

  // 3. Reports open on Insights: September against August.
  await nav("Business Reports");
  if ((await page.getByRole("tab", { name: "Insights", exact: true }).getAttribute("aria-selected")) !== "true") errors.push("Reports did not open on Insights");
  await panel().getByLabel("Period", { exact: true }).selectOption("lastMonth");
  await panel().getByText("Compared with 2 Aug 2026 – 31 Aug 2026").waitFor();
  const sales = await tile("Net sales");
  if (!/₹3,000/.test(sales) || !/\+50%/.test(sales) || !/was ₹2,000/.test(sales)) errors.push(`net sales tile: ${sales}`);
  const margin = await tile("Margin %");
  if (!/37%/.test(margin) || !/-3 pts/.test(margin) || !/was 40%/.test(margin)) errors.push(`margin tile: ${margin}`);
  const owe = await tile("Customers owe");
  if (!/₹4,432/.test(owe)) errors.push(`receivables tile: ${owe}`);
  const stock = await tile("Stock value");
  if (!/₹7,910/.test(stock) || !/was ₹9,800/.test(stock)) errors.push(`stock tile: ${stock}`);
  const days = await tile("Days of stock");
  if (!/141 days/.test(days)) errors.push(`days of stock tile: ${days}`);
  await page.screenshot({ path: `${OUT}/insights-1-measures.png`, fullPage: true });
  log("measures:", sales, "|", margin, "|", stock);

  // 4. Where sales come from: customers, then companies.
  const contribution = panel().locator("section, div").filter({ has: page.getByRole("heading", { name: "Where sales come from" }) }).last();
  await page.getByText("A: 1 customer, 80.0% of sales").waitFor();
  await page.getByText("1 new · 1 lost (they bought ₹1,000 before)").waitFor();
  const oneRow = (await page.getByRole("row", { name: /Kirana One/ }).innerText()).replace(/\s+/g, " ");
  if (!/₹2,400/.test(oneRow) || !/\bA\b/.test(oneRow) || !/Growing/.test(oneRow)) errors.push(`Kirana One row: ${oneRow}`);
  const threeRow = (await page.getByRole("row", { name: /Kirana Three/ }).innerText()).replace(/\s+/g, " ");
  if (!/Lost/.test(threeRow)) errors.push(`Kirana Three row: ${threeRow}`);
  await page.getByRole("radio", { name: "Companies" }).click();
  const hulRow = (await page.getByRole("row", { name: /^HUL/ }).innerText()).replace(/\s+/g, " ");
  if (!/₹400/.test(hulRow) || !/Declining/.test(hulRow) || !/-60%/.test(hulRow)) errors.push(`HUL row: ${hulRow}`);
  await page.getByRole("row", { name: /No company/ }).waitFor();
  void contribution;
  log("contribution: Kirana One A and growing, Kirana Three lost; HUL declining");

  // 5. Stock movement: fast, slow and dead.
  const dead = (await page.getByRole("row", { name: /Old Soap/ }).innerText()).replace(/\s+/g, " ");
  if (!/Never sold/.test(dead) || !/₹500/.test(dead)) errors.push(`dead stock row: ${dead}`);
  await page.getByText("₹5,160 tied up in 1 product").waitFor();
  await page.screenshot({ path: `${OUT}/insights-2-contribution-stock.png`, fullPage: true });
  log("stock: Bath Soap slow (₹5,160 tied up), Old Soap dead");

  // 6. Against the same dates a year earlier: nothing to compare.
  await panel().getByLabel("Compared with", { exact: true }).selectOption("last_year");
  await panel().getByText("Compared with 1 Sept 2025 – 30 Sept 2025").waitFor();
  const yearAgo = await tile("Net sales");
  if (!/nothing before/.test(yearAgo)) errors.push(`year-ago tile: ${yearAgo}`);
  log("against September 2025: nothing before");

  // 7. Saved as a view, opened again after a reload.
  await page.getByRole("button", { name: "Save view" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Month vs last year");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("View “Month vs last year” saved").first().waitFor();
  await page.reload();
  await page.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
  await nav("Business Reports");
  await page.getByRole("button", { name: /^Saved views/ }).click();
  const menu = page.getByRole("dialog", { name: "Saved views" });
  const listed = (await menu.innerText()).toLowerCase();
  if (!listed.includes("insights · last month · compared with the same period last year")) errors.push(`saved view described as: ${listed}`);
  await menu.getByRole("button", { name: /Month vs last year/ }).click();
  await page.getByText("View: Month vs last year").waitFor();
  if ((await panel().getByLabel("Compared with", { exact: true }).inputValue()) !== "last_year") errors.push("comparison not restored");
  log("saved as a view and opened again");

  // 8. The customers table as a file.
  await panel().getByLabel("Compared with", { exact: true }).selectOption("previous");
  await page.getByText("Compared with 2 Aug 2026 – 31 Aug 2026").waitFor();
  const download = page.waitForEvent("download");
  await page.getByRole("radio", { name: "Customers" }).click();
  const card = page.getByRole("heading", { name: "Where sales come from" }).locator("xpath=ancestor::div[contains(@class,'shadow-card')][1]");
  await card.getByRole("button", { name: "CSV" }).click();
  const file = await download;
  const path = join(OUT, file.suggestedFilename());
  await file.saveAs(path);
  const csv = readFileSync(path, "utf8");
  if (!/Kirana One/.test(csv) || !/2400\.00/.test(csv)) errors.push(`customers CSV: ${csv.slice(0, 200)}`);
  log("customers downloaded:", file.suggestedFilename());

  // 9. In Hindi.
  await page.getByRole("radio", { name: "हिं" }).first().click();
  await page.getByRole("heading", { name: "बिक्री कहाँ से आती है" }).waitFor();
  await page.getByText("डेड स्टॉक", { exact: true }).first().waitFor();
  await page.screenshot({ path: `${OUT}/insights-3-hindi.png`, fullPage: true });
  await page.getByRole("radio", { name: "EN" }).first().click();
  log("in Hindi: बिक्री कहाँ से आती है");

  // 10. On a phone: nothing wider than the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Where sales come from" }).waitFor();
  // The chart takes the new width a moment after the window changes (it measures itself).
  let wide = 0;
  for (let i = 0; i < 30 && (wide = await page.evaluate(() => document.documentElement.scrollWidth)) > 390; i++) await page.waitForTimeout(100);
  if (wide > 390) {
    // What sticks out (outside any scrolling box), to say where to look.
    const culprits = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el.getBoundingClientRect().right <= 392) return false;
          for (let p = el.parentElement; p; p = p.parentElement) if (["auto", "hidden", "scroll", "clip"].includes(getComputedStyle(p).overflowX)) return false;
          return true;
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" right=${Math.round(el.getBoundingClientRect().right)}`),
    );
    errors.push(`page wider than the phone: ${wide} (${culprits.join("; ")})`);
  }
  await page.screenshot({ path: `${OUT}/insights-4-phone.png`, fullPage: true });
  log("on a phone, as wide as the screen:", wide);
} catch (e) {
  errors.push(`step failed: ${e.message}`);
  await page.screenshot({ path: `${OUT}/insights-failure.png`, fullPage: true }).catch(() => {});
}

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
