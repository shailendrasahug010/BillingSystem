/**
 * End-to-end check of GSTR-2B matching. Three purchase bills entered last
 * month: one as the supplier reported it, one with its GST typed wrong, one
 * the supplier has not reported. GST Reports → GSTR-2B takes the portal's
 * JSON file: the credit on the portal, in the bills, at risk and not
 * entered; each bill's status, with what to do; "Enter bill" for the one not
 * entered opens a purchase for its supplier; "Open bill" opens the one that
 * differs; the result as CSV; a wrong file said so in plain words; phone
 * width.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/gstr2b-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98792${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

const SHARMA = "23AAAFS1111K1ZR";
const MEHTA = "27AAAFM2222L1ZH";
const KAPOOR = "23AAAFK3333M1ZJ";
// Last month (the statement comes out after the month ends).
const now = new Date();
const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const month = last.toISOString().slice(0, 7);
const [yyyy, mm] = month.split("-");
const day = (d) => `${month}-${String(d).padStart(2, "0")}`;
const portalDay = (d) => `${String(d).padStart(2, "0")}-${mm}-${yyyy}`;

const statement = {
  chksum: "e2e",
  data: {
    gstin: "",
    rtnprd: `${mm}${yyyy}`,
    docdata: {
      b2b: [
        {
          ctin: SHARMA,
          trdnm: "Sharma Agencies",
          inv: [
            { inum: "SA/0012", dt: portalDay(5), val: 1180, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0, itcavl: "Y", rev: "N" },
            { inum: "SA-15", dt: portalDay(12), val: 590, txval: 500, igst: 0, cgst: 45, sgst: 45, cess: 0, itcavl: "Y", rev: "N" },
          ],
        },
        { ctin: MEHTA, trdnm: "Mehta Traders", inv: [{ inum: "MT-77", dt: portalDay(20), val: 2360, txval: 2000, igst: 360, cgst: 0, sgst: 0, cess: 0, itcavl: "Y", rev: "N" }] },
      ],
    },
  },
};

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
let expectBad = false;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (expectBad && r.status() === 400 && r.url().includes("/gstr2b/")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const file = (name, content) => ({ name, mimeType: "application/json", buffer: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)) });
const openTab = async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "GST Reports", exact: true }).click();
  await page.getByLabel("Period").fill(month);
  await page.getByRole("tab", { name: "GSTR-2B" }).click();
};

try {
  // 1. Sign up; three suppliers; three purchase bills last month.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Anil Kapoor");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Kapoor Wholesale");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page.getByRole("heading", { name: /Anil/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soap = (await api("POST", "/products", token, { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "120" })).id;
  const sharma = (await api("POST", "/suppliers", token, { name: "Sharma Agencies", stateCode: "23", gstin: SHARMA })).id;
  const mehta = (await api("POST", "/suppliers", token, { name: "Mehta Traders", stateCode: "27", gstin: MEHTA })).id;
  const kapoor = (await api("POST", "/suppliers", token, { name: "Kapoor & Sons", stateCode: "23", gstin: KAPOOR })).id;
  const buy = (supplierId, number, d, qty, rate) => api("POST", "/purchases", token, { supplierId, supplierInvoiceNumber: number, supplierInvoiceDate: day(d), lines: [{ productId: soap, qty, rate }] });
  await buy(sharma, "sa-12", 5, "10", "100");
  const wrong = await buy(sharma, "SA/15", 12, "4", "100");
  await buy(kapoor, "K-9", 25, "1", "300");
  log(`signed up; three purchase bills in ${month}`);

  // 2. The statement: what agrees, what differs, what is missing on either side.
  await page.reload();
  await openTab();
  await page.getByText("No GSTR-2B file chosen").waitFor({ timeout: 15000 });
  await page.locator("[data-gstr2b-file]").setInputFiles(file(`returns_R2B_${mm}${yyyy}.json`, statement));
  await page.locator("[data-gstr2b-for]").waitFor({ timeout: 15000 });
  const tile = (label) => page.getByText(label, { exact: true }).locator("xpath=..");
  for (const [label, amount] of [
    ["Credit on GSTR-2B", "₹630.00"],
    ["Credit in your bills", "₹306.00"],
    ["Credit at risk", "₹54.00"],
    ["Credit not entered", "₹360.00"],
  ]) {
    const text = await tile(label).textContent();
    if (!text.includes(amount)) errors.push(`${label}: "${text}", expected ${amount}`);
  }
  const statusOf = async (number) => (await page.getByRole("row").filter({ hasText: number }).first().textContent()) ?? "";
  for (const [number, status] of [
    ["SA/0012", "Matched"],
    ["SA-15", "Amounts differ"],
    ["MT-77", "Not entered"],
    ["K-9", "Not on portal"],
  ]) {
    if (!(await statusOf(number)).includes(status)) errors.push(`${number}: not "${status}"`);
  }
  if (!(await statusOf("SA-15")).includes("differs by ₹18.00")) errors.push("SA-15: the difference is not shown");
  await page.screenshot({ path: `${OUT}/2b-1-match.png`, fullPage: true });
  log("matched: 1 agrees, 1 differs by ₹18, 1 not entered (₹360), 1 not on the portal (₹54 at risk)");

  // 3. Each kind says what to do.
  await page.getByRole("radio", { name: /Not on portal/ }).click();
  await page.getByText("Ask the supplier to file their GSTR-1").waitFor();
  if ((await page.getByRole("row").count()) !== 2) errors.push("Not on portal: not only K-9");
  await page.getByRole("radio", { name: /^All/ }).click();

  // 4. CSV.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  const csv = await readFile(await download.path(), "utf8");
  if (!csv.includes("Amounts differ") || !csv.includes("MT-77")) errors.push("the CSV lacks the rows");
  log("CSV:", download.suggestedFilename());

  // 5. Enter the bill not entered: a purchase for its supplier. Open the one that differs.
  await page.getByRole("row").filter({ hasText: "MT-77" }).getByRole("button", { name: "Enter bill" }).click();
  await page.waitForFunction((id) => location.hash.includes(id), mehta, { timeout: 10000 });
  await page.getByText("Mehta Traders").first().waitFor({ timeout: 10000 });
  log("Enter bill: a purchase for Mehta Traders");
  await page.goBack();
  await page.getByRole("tab", { name: "GSTR-2B" }).click();
  // The result is kept while moving about.
  await page.locator("[data-gstr2b-for]").waitFor({ timeout: 10000 });
  await page.getByRole("row").filter({ hasText: "SA-15" }).getByRole("button", { name: "Open bill" }).click();
  await page.waitForFunction((id) => location.hash.includes(id), wrong.id, { timeout: 10000 });
  log("Open bill: the purchase that differs");

  // 6. A file that is not a statement.
  await page.goBack();
  await page.getByRole("tab", { name: "GSTR-2B" }).click();
  expectBad = true;
  await page.locator("[data-gstr2b-file]").setInputFiles(file("sales.json", { invoices: [] }));
  await page.getByText("This is not a GSTR-2B file").waitFor({ timeout: 10000 });
  await page.locator("[data-gstr2b-file]").setInputFiles(file("report.json", "not json at all"));
  await page.getByText("This file is not a JSON file").waitFor({ timeout: 10000 });
  log("wrong files: said so in plain words");

  // 7. A phone.
  await page.locator("[data-gstr2b-file]").setInputFiles(file("r2b.json", statement));
  await page.locator("[data-gstr2b-for]").waitFor({ timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  if (!(await fits())) errors.push("the GSTR-2B tab scrolls sideways on a phone");
  await page.screenshot({ path: `${OUT}/2b-2-phone.png`, fullPage: true });
  log("phone: fits");
} catch (e) {
  errors.push(e.message);
  await page.screenshot({ path: `${OUT}/2b-error.png` }).catch(() => undefined);
}

await browser.close();
if (errors.length) {
  console.error("✗", errors.join("\n✗ "));
  process.exit(1);
}
log("GSTR-2B matching: all passed");
