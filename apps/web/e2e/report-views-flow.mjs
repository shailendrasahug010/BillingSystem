/**
 * End-to-end check of saved report views: sign up -> Reports: sales by
 * company for last month saved as a view shared with the team -> changed to
 * by customer and the change saved -> a private profit view for a custom
 * period -> after a reload both open again as saved (tab, period, grouping)
 * -> a sales analyst (sales and collection reports only) sees the shared
 * sales view with who shared it, not the owner's profit view, and saves a
 * copy of their own -> the owner deletes the shared view: the analyst keeps
 * only their copy -> the menu on a phone.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/report-views-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98759${run}`;
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
const errors = [];
const watch = (page, state) => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("response", (r) => {
    if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
};
const helpers = (page) => ({
  nav: (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click(),
  toast: (text) => page.getByText(text).first().waitFor({ timeout: 15000 }),
  dialog: () => page.getByRole("dialog"),
  menu: async () => {
    await page.getByRole("button", { name: /^Saved views/ }).click();
    const content = page.getByRole("dialog", { name: "Saved views" });
    await content.waitFor();
    return content;
  },
});

// 1. Sign up.
const owner = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const ownerState = { signedIn: false };
watch(owner, ownerState);
const o = helpers(owner);
await owner.goto(WEB);
await owner.getByRole("button", { name: "Create account" }).click();
await owner.fill("#su-name", "Meena Agarwal");
await owner.fill("#su-mobile", mobile);
await owner.fill("#su-password", password);
await owner.fill("#su-business", "Agarwal Traders");
await owner.getByRole("button", { name: "Send OTP" }).click();
const hint = owner.getByText(/Development code: \d{6}/);
await hint.waitFor();
await owner.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await owner.getByRole("button", { name: "Verify and create account" }).click();
await owner.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
ownerState.signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const role = await api("POST", "/roles", token, { key: "sales_analyst", name: "Sales analyst", grants: ["report.view_sales", "report.view_collection"] });
const analystId = `analyst${run}`;
await api("POST", "/members", token, { name: "Kiran Analyst", mobile: `98758${run}`, roleId: role.id, username: analystId, password: "Kiran-pass-2026" });
log("signed up; a sales analyst added");

// 2. Sales by company for last month, saved and shared.
await o.nav("Business Reports");
await owner.getByRole("tab", { name: "Sales", exact: true }).click();
await owner.getByRole("tabpanel").getByLabel("Period", { exact: true }).selectOption("lastMonth");
await owner.getByRole("tabpanel").getByLabel("Group by", { exact: true }).selectOption("brand");
await owner.getByRole("button", { name: "Save view" }).click();
await o.dialog().getByLabel("Name").fill("Sales by company");
await o.dialog().getByText("Share with the team").click();
await o.dialog().getByRole("button", { name: "Save", exact: true }).click();
await o.toast("View “Sales by company” saved");
await owner.getByText("View: Sales by company").waitFor();
log("saved and shared: Sales by company (last month, by company)");

// 3. Changed to by customer: the bar says so, and the change is saved.
await owner.getByRole("tabpanel").getByLabel("Group by", { exact: true }).selectOption("customer");
await owner.getByText("changed, not saved").waitFor();
await owner.getByRole("button", { name: "Save changes" }).click();
await o.toast("View “Sales by company” updated");
await owner.getByText("changed, not saved").waitFor({ state: "detached" });
log("changed to by customer and saved");

// 4. A private profit view for a custom period.
await owner.getByRole("tab", { name: "Profit", exact: true }).click();
if (await owner.getByText("View: Sales by company").count()) errors.push("the sales view stayed open on the Profit tab");
await owner.getByRole("tabpanel").getByLabel("From", { exact: true }).fill("2026-08-15");
await owner.getByRole("tabpanel").getByLabel("To", { exact: true }).fill("2026-09-05");
await owner.getByRole("tabpanel").getByLabel("Group by", { exact: true }).selectOption("customer");
await owner.getByRole("button", { name: "Save view" }).click();
await o.dialog().getByLabel("Name").fill("Festive margin");
await o.dialog().getByRole("button", { name: "Save", exact: true }).click();
await o.toast("View “Festive margin” saved");
log("saved privately: Festive margin (15 Aug – 5 Sep, by customer)");

// 5. After a reload both open as saved.
await owner.reload();
// A reload stays on Business Reports.
await owner.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 15000 });
await o.nav("Business Reports");
let menu = await o.menu();
const listed = await menu.innerText();
// (Section headings are shown in capitals; dates as in India, "5 Sept 2026".)
for (const s of ["my views", "sales by company", "sales · last month · by customer", "festive margin", "profit · 15 aug 2026 – 5 sept 2026 · by customer"]) if (!listed.toLowerCase().includes(s)) errors.push(`menu lacks ${s}: ${listed}`);
await owner.screenshot({ path: `${OUT}/report-views-1-menu.png` });
await menu.getByRole("button", { name: /Sales by company/ }).click();
await owner.getByText("View: Sales by company").waitFor();
if ((await owner.getByRole("tab", { name: "Sales", exact: true }).getAttribute("aria-selected")) !== "true") errors.push("the view did not open its tab");
if ((await owner.getByRole("tabpanel").getByLabel("Period", { exact: true }).inputValue()) !== "lastMonth") errors.push("period not restored");
if ((await owner.getByRole("tabpanel").getByLabel("Group by", { exact: true }).inputValue()) !== "customer") errors.push("grouping not restored");
menu = await o.menu();
await menu.getByRole("button", { name: /Festive margin/ }).click();
await owner.getByText("View: Festive margin").waitFor();
const profitPanel = owner.getByRole("tabpanel");
if ((await profitPanel.getByLabel("From", { exact: true }).inputValue()) !== "2026-08-15" || (await profitPanel.getByLabel("To", { exact: true }).inputValue()) !== "2026-09-05") errors.push("custom period not restored");
await owner.screenshot({ path: `${OUT}/report-views-2-open.png` });
log("both views open again as saved");

// 6. The analyst: the shared sales view with who shared it, not the profit view; a copy of their own.
const analyst = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const analystState = { signedIn: false };
watch(analyst, analystState);
const a = helpers(analyst);
await analyst.goto(WEB);
await analyst.fill("#auth-id", analystId);
await analyst.fill("#auth-password", "Kiran-pass-2026");
await analyst.getByRole("button", { name: "Sign in", exact: true }).click();
await analyst.getByRole("heading", { name: /Kiran/ }).waitFor({ timeout: 15000 });
analystState.signedIn = true;
await a.nav("Business Reports");
menu = await a.menu();
const seen = await menu.innerText();
if (!seen.toLowerCase().includes("shared by the team") || !seen.includes("shared by Meena Agarwal")) errors.push(`analyst menu: ${seen}`);
if (seen.includes("Festive margin")) errors.push("the analyst sees the owner's private profit view");
await menu.getByRole("button", { name: /Sales by company/ }).click();
await analyst.getByText("View: Sales by company").waitFor();
if (await analyst.getByRole("button", { name: "Save changes" }).count()) errors.push("the analyst can change the owner's view");
await analyst.getByRole("button", { name: "Save as my view" }).click();
await a.dialog().getByLabel("Name").fill("My customers last month");
await a.dialog().getByRole("button", { name: "Save", exact: true }).click();
await a.toast("View “My customers last month” saved");
log("analyst sees the shared view (not the private one) and saves a copy");

// 7. The owner deletes the shared view; the analyst keeps only their copy.
menu = await o.menu();
await menu.getByRole("button", { name: /Sales by company/ }).click();
await owner.getByRole("button", { name: "Delete" }).click();
await o.dialog().getByText("It is shared: the team will no longer see it either").waitFor();
await o.dialog().getByRole("button", { name: "Delete" }).click();
await o.toast("View “Sales by company” deleted");
await analyst.reload();
// A reload stays on Business Reports.
await analyst.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 15000 });
await a.nav("Business Reports");
menu = await a.menu();
const after = await menu.innerText();
if (after.includes("Sales by company") || !after.includes("My customers last month")) errors.push(`after delete: ${after}`);
log("shared view deleted by the owner; the analyst's copy stays");

// 8. On a phone.
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const phoneState = { signedIn: false };
watch(phone, phoneState);
await phone.goto(WEB);
await phone.fill("#auth-id", mobile);
await phone.fill("#auth-password", password);
await phone.getByRole("button", { name: "Sign in", exact: true }).click();
await phone.getByRole("heading", { name: /Meena/ }).waitFor({ timeout: 15000 });
phoneState.signedIn = true;
await phone.getByRole("button", { name: "More", exact: true }).first().click();
await phone.getByRole("button", { name: "Business Reports" }).first().click();
await phone.getByRole("heading", { name: "Reports" }).waitFor({ timeout: 15000 });
menu = await helpers(phone).menu();
await menu.getByText("Festive margin").waitFor();
const wide = await phone.evaluate(() => document.documentElement.scrollWidth);
if (wide > 390) errors.push(`page wider than the phone: ${wide}`);
await phone.screenshot({ path: `${OUT}/report-views-3-phone.png` });
log("the menu on a phone");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
