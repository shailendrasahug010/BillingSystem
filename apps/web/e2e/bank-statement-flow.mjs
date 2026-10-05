/**
 * End-to-end check of bank reconciliation. Payments → Bank statement: an
 * HDFC-style statement (CSV, the bank's lines above the header) with four
 * lines: a UPI payment from a shop whose mobile number is in the narration
 * (matched, for its open bill), a payment already entered by hand (already
 * recorded), a cash deposit nobody's (not matched, the shop chosen by hand)
 * and a NEFT to a supplier by name (matched). Recording them makes three
 * payments with the bank's reference; the bill is paid; the same statement
 * again shows every line already recorded.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/bank-statement-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98772${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
const check = (ok, message) => ok || errors.push(message);
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

// 1. Sign up.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Arun Bansal");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Bansal Agencies");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Arun/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
log("signed up");

// 2. A shop with an open bill, another shop, a supplier; one payment entered by hand.
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const soap = await api("POST", "/products", token, { name: "Lifebuoy 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "100", openingStockCost: "28" });
const gupta = await api("POST", "/customers", token, { name: "Gupta Stores", mobile: "9826011111", stateCode: "23" });
const khanna = await api("POST", "/customers", token, { name: "Khanna Kirana", stateCode: "23" });
await api("POST", "/suppliers", token, { name: "HUL Distributor", stateCode: "23", gstin: "23AAACM1234M1ZR" });
const bill = await api("POST", "/invoices", token, { customerId: gupta.id, lines: [{ productId: soap.id, qty: "10" }] });
const today = bill.invoiceDate;
await api("POST", "/payments", token, { direction: "in", customerId: khanna.id, amount: "650", method: "upi", referenceNumber: "412345678902" });
const [y, m, d] = today.split("-");
const day = `${d}/${m}/${y.slice(2)}`;
const csv = [
  "HDFC BANK Ltd.,,,,,,",
  "Statement of account,,,,,,",
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  `${day},UPI-RAMESH GUPTA-9826011111@ybl-SBIN0001234-412345678901-PAYMENT,0000412345678901,${day},,"${Number(bill.grandTotal).toFixed(2)}","1,00,000.00"`,
  `${day},UPI-KHANNA-412345678902-PAYMENT,0000412345678902,${day},,650.00,"1,00,650.00"`,
  `${day},CASH DEPOSIT BY SELF,,${day},,"1,200.00","1,01,850.00"`,
  `${day},NEFT DR-HUL DISTRIBUTOR-N260123456,N260123456,${day},"5,000.00",,"96,850.00"`,
].join("\n");
const file = join(tmpdir(), "statement.csv");
await writeFile(file, csv);

// 3. The statement read and matched.
await page.goto(`${WEB}/#payments`);
await page.reload();
await page.getByRole("button", { name: "Bank statement" }).click();
const dialog = page.getByRole("dialog");
await page.locator("#bank-file").setInputFiles(file);
/** Waits for the dialog to say `text`; on failure shows what it says instead. */
const says = (text) =>
  dialog
    .getByText(text)
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      await page.screenshot({ path: `${OUT}/bank-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 1500));
      throw e;
    });
const row = (n) => dialog.locator(`li[data-row="${n}"]`);
await says("4 lines: 2 matched, 0 to check, 1 already recorded, 1 not matched");
check(await row(1).getByText("Matched").isVisible(), "the UPI payment is not matched");
check(await row(1).getByText("Gupta Stores", { exact: true }).isVisible(), "the UPI payment is not Gupta's");
check(await row(2).getByText("Already recorded").isVisible(), "the payment entered by hand is not seen");
check(await row(3).getByText("Not matched").isVisible(), "the cash deposit is matched");
check(await row(4).getByText("HUL Distributor", { exact: true }).isVisible(), "the NEFT is not the supplier's");
await dialog.screenshot({ path: `${OUT}/bank-1-matched.png` });
log("read: 2 matched, 1 already recorded, 1 not matched");

// 4. The deposit given to Khanna by hand; three recorded.
await row(3).locator("#bank-party-3").fill("Khanna");
await page.getByRole("option", { name: /Khanna Kirana/ }).click();
await dialog.getByRole("button", { name: "Record 3 payments" }).click();
await page.getByText("3 payments recorded").first().waitFor({ timeout: 15000 });
const payments = (await api("GET", "/payments", token)).data;
const upi = payments.find((p) => p.referenceNumber === "0000412345678901");
check(upi && upi.method === "upi" && upi.amount === bill.grandTotal && upi.direction === "in", `the UPI payment: ${JSON.stringify(upi)}`);
check(payments.some((p) => p.direction === "in" && p.amount === "1200.00" && p.method === "bank_transfer"), "the cash deposit is not recorded for Khanna");
check(payments.some((p) => p.direction === "out" && p.amount === "5000.00" && p.referenceNumber === "N260123456"), "the NEFT is not recorded");
const paid = await api("GET", `/invoices/${bill.id}`, token);
check(paid.paymentStatus === "paid", `the bill is ${paid.paymentStatus}`);
log("recorded 3 payments; Gupta's bill is paid");

// 5. The same statement again: all in the books.
await page.locator("#bank-file").setInputFiles(file);
await says("4 lines: 0 matched, 0 to check, 4 already recorded, 0 not matched");
check(await dialog.getByRole("button", { name: "Record 0 payments" }).isDisabled(), "nothing to record, yet the button works");
await dialog.screenshot({ path: `${OUT}/bank-2-again.png` });
log("the same statement again: 4 already recorded");

// 6. A phone.
await page.setViewportSize({ width: 390, height: 844 });
await dialog.screenshot({ path: `${OUT}/bank-3-phone.png` });
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page scrolls sideways on a phone");
log("phone: fits");

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
