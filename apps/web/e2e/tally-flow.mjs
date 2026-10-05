/**
 * End-to-end check of Tally both ways. Settings → Tally: a masters file as
 * Tally saves it (UTF-16 XML) is read: two debtors, a creditor and two stock
 * items, other ledgers left out; one debtor with a bad GSTIN is named and
 * nothing is saved; with it fixed everything is imported with opening
 * balances and stock, and the same file again adds nothing. Then a bill is
 * made and the month's vouchers downloaded: the sale and its party ledger
 * are in the file and every voucher balances.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/tally-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { readFile, writeFile } from "node:fs/promises";
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

/** Tally writes its XML as UTF-16 with a byte-order mark. */
async function tallyFile(name, gstin) {
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>Joshi Traders</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Sethi General Store"><PARENT>Sundry Debtors</PARENT><ADDRESS.LIST TYPE="String"><ADDRESS>5 Rajwada</ADDRESS></ADDRESS.LIST><LEDSTATENAME>Madhya Pradesh</LEDSTATENAME><PARTYGSTIN>${gstin}</PARTYGSTIN><LEDGERMOBILE>9826022222</LEDGERMOBILE><OPENINGBALANCE>-2400.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Khanna Kirana"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-650.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="HUL Distributor"><PARENT>Sundry Creditors</PARENT><STATENAME>Madhya Pradesh</STATENAME><OPENINGBALANCE>18000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="SBI Current"><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Lifebuoy 100g"><BASEUNITS>Nos</BASEUNITS><GSTDETAILS.LIST><HSNCODE>3401</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST><OPENINGBALANCE> 60 Nos</OPENINGBALANCE><OPENINGRATE>28.00/Nos</OPENINGRATE><FULLPRICELIST.LIST><PRICELEVELLIST.LIST><RATE>35.00/Nos</RATE></PRICELEVELLIST.LIST></FULLPRICELIST.LIST></STOCKITEM></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Tata Salt 1kg"><BASEUNITS>Pkt</BASEUNITS><GSTDETAILS.LIST><HSNCODE>2501</HSNCODE><TAXABILITY>Exempt</TAXABILITY></GSTDETAILS.LIST><OPENINGBALANCE> 40 Pkt</OPENINGBALANCE><OPENINGVALUE>-960.00</OPENINGVALUE></STOCKITEM></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const path = join(tmpdir(), name);
  await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  return path;
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
await page.fill("#su-name", "Neha Joshi");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Joshi Traders");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Neha/ }).waitFor({ timeout: 15000 });
signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
log("signed up");

// 2. A file with a wrong GSTIN: read, the shop named, nothing saved.
await page.goto(`${WEB}/#settings`);
await page.reload();
const card = page.locator("section", { has: page.getByRole("heading", { name: "Import masters from Tally" }) });
await card.waitFor({ timeout: 15000 });
await page.locator("#tally-file").setInputFiles(await tallyFile("bad-masters.xml", "23AAACM1234M1ZZ"));
await card.getByText("2 customers (Sundry Debtors)").waitFor({ timeout: 15000 });
check(await card.getByText("2 other ledgers (sales, bank, tax…) not imported").isVisible(), "other ledgers not counted");
await card.getByText(/Fix 1 problem/).waitFor();
check(await card.getByText("Customer Sethi General Store").isVisible(), "the bad row is not named");
await card.screenshot({ path: `${OUT}/tally-1-problem.png` });
check((await api("GET", "/customers", token)).data.length === 0, "customers saved from a file with a problem");
log("a wrong GSTIN: Sethi General Store named, nothing saved");

// 3. Fixed: imported with balances and stock; again: nothing new.
await page.locator("#tally-file").setInputFiles(await tallyFile("masters.xml", "23AAACM1234M1ZR"));
const importButton = card.getByRole("button", { name: "Import 5 rows" });
await importButton.waitFor({ timeout: 15000 });
await card.screenshot({ path: `${OUT}/tally-2-ready.png` });
await importButton.click();
await page.getByText("Imported from Tally").first().waitFor({ timeout: 15000 });
const customers = (await api("GET", "/customers", token)).data;
const sethi = customers.find((c) => c.businessName === "Sethi General Store");
check(sethi?.balance === "2400.00" && sethi?.gstin === "23AAACM1234M1ZR", `Sethi: ${JSON.stringify(sethi)}`);
const supplier = (await api("GET", "/suppliers", token)).data.find((s) => s.name === "HUL Distributor");
check(supplier?.balance === "18000.00", `HUL Distributor: ${JSON.stringify(supplier)}`);
const products = (await api("GET", "/products", token)).data;
const soap = products.find((p) => p.name === "Lifebuoy 100g");
const soapStock = (await api("GET", `/products/${soap?.id}`, token)).stock?.total;
check(soapStock === "60.000" && soap?.sellingPrice === "35.0000", `Lifebuoy: ${soapStock} ${soap?.sellingPrice}`);
log("imported: Sethi owes 2400, HUL Distributor is owed 18000, Lifebuoy 60 in stock at 35");
await page.locator("#tally-file").setInputFiles(await tallyFile("masters.xml", "23AAACM1234M1ZR"));
await card.getByText("Everything in this file is already here.").waitFor({ timeout: 15000 });
log("the same file again: nothing new");

// 4. A bill, then the month's vouchers for Tally.
const sale = await api("POST", "/invoices", token, { customerId: sethi.id, lines: [{ productId: soap.id, qty: "10" }] });
await api("POST", "/payments", token, { direction: "in", customerId: sethi.id, amount: "500", method: "upi" });
const exportCard = page.locator("section", { has: page.getByRole("heading", { name: "Export vouchers for Tally" }) });
const [download] = await Promise.all([page.waitForEvent("download"), exportCard.getByRole("button", { name: "Download for Tally" }).click()]);
const xml = await readFile(await download.path(), "utf8");
check(download.suggestedFilename().startsWith("tally-vouchers-"), `file name ${download.suggestedFilename()}`);
check(xml.includes(`<VOUCHERNUMBER>${sale.invoiceNumber}</VOUCHERNUMBER>`), "the sale is not in the file");
check(xml.includes('<LEDGER NAME="Sethi General Store">') && xml.includes("<PARENT>Sundry Debtors</PARENT>"), "the party ledger is not in the file");
check(xml.includes('VCHTYPE="Receipt"') && xml.includes("<LEDGERNAME>Bank</LEDGERNAME>"), "the UPI receipt is not posted to Bank");
for (const v of xml.split("<VOUCHER ").slice(1)) {
  const sum = [...v.matchAll(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].reduce((s, m) => s + Math.round(Number(m[1]) * 100), 0);
  check(sum === 0, `a voucher does not balance: ${v.slice(0, 120)}`);
}
log("downloaded", download.suggestedFilename(), "with", xml.split("<VOUCHER ").length - 1, "vouchers, each balanced");
await exportCard.screenshot({ path: `${OUT}/tally-3-export.png` });

await browser.close();
if (errors.length) {
  console.error("errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no errors");
