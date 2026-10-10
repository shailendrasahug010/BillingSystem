/**
 * End-to-end check of bank reconciliation. Payments → Bank statement opens
 * the Bank tab; the business's bank account is added there. An HDFC-style
 * statement (CSV, the bank's lines above the header) with four lines: a UPI
 * payment from a shop whose mobile number is in the narration (matched, for
 * its open bill), a payment already entered by hand (reconciled by itself),
 * a cash deposit (the bank's own kind of line) and a NEFT to a supplier by
 * name (matched). The three are reconciled in one go: a receipt that pays
 * the bill, a transfer from the cash drawer, a supplier payment. The
 * reconciliation statement agrees with the bank once the books' opening
 * balance is set; the same statement again adds nothing.
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
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
/** Waits for the page to say `text`; on failure shows what it says instead. */
const says = (text, within = page) =>
  within
    .getByText(text)
    .first()
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      await page.screenshot({ path: `${OUT}/bank-failed.png` });
      console.error("the page says:", (await page.locator("body").innerText()).slice(0, 2000));
      throw e;
    });

try {
  // 1. Sign up.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Arun Bansal");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Bansal Agencies");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Arun/ }).waitFor({ timeout: 15000 });
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
  const total = Number(bill.grandTotal);
  const opening = 100000 - total;
  const inr = (n) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const csv = [
    "HDFC BANK Ltd.,,,,,,",
    "Statement of account,,,,,,",
    "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
    `${day},UPI-RAMESH GUPTA-9826011111@ybl-SBIN0001234-412345678901-PAYMENT,0000412345678901,${day},,"${total.toFixed(2)}","${inr(100000)}"`,
    `${day},UPI-KHANNA-412345678902-PAYMENT,0000412345678902,${day},,650.00,"${inr(100650)}"`,
    `${day},CASH DEPOSIT BY SELF,,${day},,"1,200.00","${inr(101850)}"`,
    `${day},NEFT DR-HUL DISTRIBUTOR-N260123456,N260123456,${day},"5,000.00",,"${inr(96850)}"`,
  ].join("\n");
  const file = join(tmpdir(), "statement.csv");
  await writeFile(file, csv);

  // 3. Payments → Bank statement: the Bank tab, where the bank account is added.
  await page.goto(`${WEB}/#payments`);
  await page.reload();
  await page.getByRole("button", { name: "Bank statement" }).click();
  await page.locator("#bank-account-name").fill("HDFC current");
  await page.locator("#bank-account-bank").fill("HDFC Bank");
  await page.locator("#bank-account-last4").fill("1234");
  await page.getByRole("button", { name: "Add bank account" }).click();
  await toast("Bank account added");
  await page.locator("#bank-account").waitFor({ timeout: 15000 });
  log("bank account added");

  // 4. The statement imported: Khanna's payment is in the books already; the rest suggested.
  await page.locator("#bank-file").setInputFiles(file);
  await toast("4 new lines, 0 already saved; 1 matched to entries in the books");
  const row = (n) => page.locator(`li[data-line="${n}"]`);
  await row(1).waitFor({ timeout: 15000 });
  check(await row(1).getByText("Matched", { exact: true }).isVisible(), "the UPI payment is not matched");
  await says("Gupta Stores, found by mobile number, name, bill amount", row(1));
  check((await row(3).getByRole("combobox", { name: "What is it?" }).inputValue()) === "cash_deposit", "the cash deposit is not suggested as one");
  check(await row(4).getByText("Matched", { exact: true }).isVisible(), "the NEFT is not matched");
  await says("HUL Distributor", row(4));
  check((await page.locator("li[data-line]").count()) === 3, "Khanna's line is still to reconcile");
  await page.screenshot({ path: `${OUT}/bank-1-lines.png`, fullPage: true });
  log("imported: 1 reconciled by itself, 3 suggested");

  // 5. All three reconciled in one go.
  await page.locator("[data-reconcile]").getByText("Reconcile 3 lines").click();
  await toast("3 lines reconciled");
  await says("Nothing here.");
  const payments = (await api("GET", "/payments", token)).data;
  const upi = payments.find((p) => p.referenceNumber === "0000412345678901");
  check(upi && upi.method === "upi" && upi.amount === bill.grandTotal && upi.direction === "in", `the UPI payment: ${JSON.stringify(upi)}`);
  check(payments.some((p) => p.direction === "out" && p.amount === "5000.00" && p.referenceNumber === "N260123456"), "the NEFT is not recorded");
  const paid = await api("GET", `/invoices/${bill.id}`, token);
  check(paid.paymentStatus === "paid", `the bill is ${paid.paymentStatus}`);
  const cashBook = await api("GET", `/payments/cash-book?from=${today}&to=${today}&book=cash`, token);
  check(cashBook.rows.some((r) => r.kind === "transfer" && r.direction === "out" && r.amount === "1200.00"), "the deposit is not out of the cash book");
  log("reconciled: a receipt (the bill is paid), a transfer from cash, a supplier payment");

  // 6. The reconciliation statement agrees once the books start where the bank did.
  const brs = page.locator("[data-brs]");
  await says("Not explained yet", brs);
  await brs.getByRole("button", { name: "Change" }).click();
  await brs.getByLabel("Opening balance in the books").fill(String(opening));
  await brs.getByRole("button", { name: "Save" }).click();
  await toast("Opening balance saved");
  await says("Agrees with the bank", brs);
  await brs.screenshot({ path: `${OUT}/bank-2-brs.png` });
  log("BRS: agrees with the bank (opening", opening, ")");

  // 7. The same statement again adds nothing; all four lines are done.
  await page.locator("#bank-file").setInputFiles(file);
  await toast("0 new lines, 4 already saved; 0 matched to entries in the books");
  await page.getByRole("radio", { name: "Done", exact: true }).click();
  await page.locator('li[data-line-status="reconciled"]').nth(3).waitFor({ timeout: 15000 });
  check((await page.locator('li[data-line-status="reconciled"]').count()) === 4, "not every line is done");
  check(await row(3).getByText("Cash deposited ·").isVisible(), "the deposit does not say what it is");
  log("the same statement again: nothing new; 4 lines done");

  // 8. A phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${OUT}/bank-3-phone.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page scrolls sideways on a phone");
  log("phone: fits");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/bank-failed.png` }).catch(() => {});
}

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
