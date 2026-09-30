/**
 * End-to-end check of PF, ESI and professional tax in payroll, for a
 * Maharashtra business and September 2026: sign up -> three employees with
 * salary structures (through the API) -> PF, ESI and PT turned on in
 * Settings (the state's built-in slabs shown) -> a UAN, ESI number and
 * gender entered on the employee form -> payroll run: each slip's PF, ESI
 * and PT as worked out by hand, the challan totals, the missing ESI number,
 * the ECR file -> manual ESI / PT no longer offered -> the slip shows the UAN
 * and the employer's shares -> the run on a phone.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/payroll-statutory-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98756${run}`;
const password = "Str0ng-pass!";
const MONTH = "2026-09";
const log = (...a) => console.log("•", ...a);
const check = (ok, what) => {
  if (!ok) throw new Error(`check failed: ${what}`);
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
const errors = [];
const state = { signedIn: false };
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("requestfailed", (r) => r.failure()?.errorText !== "net::ERR_ABORTED" && errors.push(`failed ${r.url()} ${r.failure()?.errorText}`));
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 15000 });
const dialog = () => page.getByRole("dialog");

// 1. Sign up in Maharashtra; employees and salaries through the API.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Neha Kulkarni");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Kulkarni Distributors");
await page.selectOption("#su-state", "27");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Neha/ }).waitFor({ timeout: 15000 });
state.signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const comp = Object.fromEntries((await api("GET", "/salary-components", token)).data.map((c) => [c.code, c.id]));
const employee = async (name, n, extra = {}) => (await api("POST", "/employees", token, { name, mobile: `9${n}${run}`.slice(0, 10).padEnd(10, "0"), joiningDate: "2025-06-01", ...extra })).id;
const asha = await employee("Asha Patil", "7001");
const bharat = await employee("Bharat Joshi", "7002", { gender: "male", uan: "100200300401", epsMember: false });
const chetan = await employee("Chetan More", "7003", { gender: "male", pfMember: false });
await api("PUT", `/employees/${asha}/salary`, token, { effectiveFrom: "2025-06-01", basic: "12000", components: [{ componentId: comp.HRA, percent: "40" }, { componentId: comp.CONV, amount: "1600" }] });
await api("PUT", `/employees/${bharat}/salary`, token, { effectiveFrom: "2025-06-01", basic: "25000", components: [{ componentId: comp.HRA, percent: "40" }] });
await api("PUT", `/employees/${chetan}/salary`, token, { effectiveFrom: "2025-06-01", basic: "9000", components: [{ componentId: comp.CONV, amount: "1000" }] });
await api("PUT", `/employees/${chetan}/salary`, token, { effectiveFrom: `${MONTH}-01`, basic: "22000", components: [{ componentId: comp.CONV, amount: "1000" }] });
await api("PUT", "/attendance", token, { date: `${MONTH}-10`, entries: [{ employeeId: bharat, status: "absent" }] });
log("signed up in Maharashtra; three employees with salaries");

// 2. PF, ESI and PT turned on in Settings.
await nav("Settings");
const card = page.getByRole("heading", { name: "Salary: PF, ESI and professional tax" }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
await card.waitFor({ timeout: 15000 });
await card.getByText(/^Provident fund: 12%/).click();
await page.fill("#pf-code", "mhban0012345000");
check((await page.inputValue("#pf-code")) === "MHBAN0012345000", "establishment code in capitals");
check((await page.inputValue("#pf-wages")) === "codes", "PF wages under the labour codes by default");
await card.getByText(/^ESI: 0.75%/).click();
await page.fill("#esi-code", "31000123450000999");
await card.getByText(/^Professional tax on the month/).click();
check((await page.inputValue("#pt-state")) === "27", "professional tax state defaults to the business's");
await card.getByText("Built-in slabs for Maharashtra").waitFor();
check((await card.getByLabel("Pay above 2").inputValue()) === "10000" && (await card.getByLabel("Tax that month 2").inputValue()) === "300", "Maharashtra slabs with ₹300 in February");
await card.getByText(/^Women: > ₹25000: ₹200/).waitFor();
await page.screenshot({ path: `${OUT}/statutory-1-settings.png`, fullPage: true });
await card.getByRole("button", { name: "Save", exact: true }).click();
await toast("Settings saved");
const saved = (await api("GET", "/settings", token))["payroll.statutory"];
check(saved.pf.enabled && saved.esi.enabled && saved.pt.enabled && saved.pt.rule === null && saved.pf.establishmentCode === "MHBAN0012345000", `settings stored: ${JSON.stringify(saved)}`);
log("PF, ESI and PT turned on; built-in Maharashtra slabs");

// 3. Asha's UAN, ESI number and gender on the employee form.
await nav("Employees");
await page.getByRole("cell", { name: /Asha Patil/ }).click();
await dialog().getByRole("button", { name: "Edit", exact: true }).click();
const form = page.getByRole("dialog", { name: /Edit · Asha Patil/ });
await form.getByLabel("UAN (PF)").fill("100200300400");
await form.getByLabel("ESI insurance number").fill("3100123456");
await form.getByLabel("Gender").selectOption("female");
check(await form.getByLabel("PF member").isChecked(), "PF member by default");
await form.getByRole("button", { name: "Save" }).click();
await toast("Employee updated");
await page.keyboard.press("Escape");
const ashaRow = await api("GET", `/employees/${asha}`, token);
check(ashaRow.uan === "100200300400" && ashaRow.esiNumber === "3100123456" && ashaRow.gender === "female", `Asha stored: ${JSON.stringify(ashaRow)}`);
log("UAN, ESI number and gender saved");

// 4. The payroll run: each slip and the challans.
await nav("Salary");
await page.getByLabel("Month").fill(MONTH);
await page.getByRole("button", { name: /^Run payroll/ }).click();
await page.getByRole("button", { name: "Finalize" }).waitFor({ timeout: 15000 });
const net = async (name) => (await page.getByRole("row", { name: new RegExp(name) }).innerText()).replace(/\s+/g, " ");
check((await net("Asha Patil")).includes("₹16,822.00"), `Asha's net pay: ${await net("Asha Patil")}`);
check((await net("Bharat Joshi")).includes("₹31,833.34"), `Bharat's net pay: ${await net("Bharat Joshi")}`);
check((await net("Chetan More")).includes("₹22,627.00"), `Chetan's net pay: ${await net("Chetan More")}`);
const statutory = page.getByRole("heading", { name: "PF, ESI and professional tax" }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
await statutory.getByText("Chetan More has no ESI number").waitFor({ timeout: 15000 });
const text = (await statutory.innerText()).replace(/\s+/g, " ");
check(/Provident fund \(EPF\) 2 members · MHBAN0012345000/.test(text), `PF block: ${text}`);
check(/Challan total ₹7,115\.00/.test(text) && /A\/c 1 ₹5,480\.00 · A\/c 2 ₹500\.00 · A\/c 10 ₹1,000\.00 · A\/c 21 ₹135\.00/.test(text), `PF challan: ${text}`);
check(/Challan total ₹1,657\.00/.test(text) && /Challan total ₹400\.00/.test(text), `ESI and PT totals: ${text}`);
await page.screenshot({ path: `${OUT}/statutory-2-run.png`, fullPage: true });
const download = page.waitForEvent("download");
await statutory.getByRole("button", { name: "Download ECR" }).click();
const ecr = await download;
const ecrPath = `${OUT}/${ecr.suggestedFilename()}`;
await ecr.saveAs(ecrPath);
const lines = readFileSync(ecrPath, "utf8").split("\n");
check(ecr.suggestedFilename() === "ECR_092026.txt", `ECR name ${ecr.suggestedFilename()}`);
check(
  lines[0] === "100200300400#~#ASHA PATIL#~#18400#~#12000#~#12000#~#12000#~#1440#~#1000#~#440#~#0#~#0" && lines[1] === "100200300401#~#BHARAT JOSHI#~#33833#~#15000#~#0#~#15000#~#1800#~#0#~#1800#~#1#~#0",
  `ECR lines: ${JSON.stringify(lines)}`,
);
log("run: net pay, PF challan ₹7,115, ESI ₹1,657, PT ₹400; ECR", lines.length, "lines");

// 5. ESI and PT are not entered by hand any more.
await page.getByRole("row", { name: /Asha Patil/ }).getByRole("button", { name: "Adjust" }).click();
await dialog().getByLabel("TDS (deduction)").waitFor();
await dialog().getByLabel("Incentive").waitFor();
check((await dialog().getByLabel("Professional Tax (deduction)").count()) === 0 && (await dialog().getByLabel("ESI (deduction)").count()) === 0, "no manual ESI or PT");
await page.keyboard.press("Escape");

// 6. The slip: PF, ESI, UAN and the employer's shares.
await page.getByRole("row", { name: /Asha Patil/ }).click();
const slip = page.getByRole("dialog").locator("article").first();
await slip.getByText("SALARY SLIP").waitFor({ timeout: 15000 });
const slipText = (await slip.innerText()).replace(/\s+/g, " ");
check(/UAN 100200300400/.test(slipText) && /ESI no\. 3100123456/.test(slipText), `slip header: ${slipText.slice(0, 400)}`);
check(/Provident Fund ₹1,440\.00/.test(slipText) && /ESI ₹138\.00/.test(slipText), `slip deductions: ${slipText}`);
check(slipText.includes("Paid by the employer, not deducted from pay: PF ₹440.00 + pension ₹1,000.00 on PF wages ₹12,000.00 · ESI ₹598.00 on ₹18,400.00"), `employer shares: ${slipText}`);
await page.screenshot({ path: `${OUT}/statutory-3-slip.png` });
await page.keyboard.press("Escape");
log("slip shows PF, ESI, UAN and the employer's shares");

// 7. The run on a phone.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
await page.screenshot({ path: `${OUT}/statutory-4-phone.png`, fullPage: true });
log("phone view fits");

await browser.close();
if (errors.length) {
  console.error("errors:", errors);
  process.exit(1);
}
log("PF, ESI and PT flow passed");
