/**
 * End-to-end check of staff sign-in and of what a role shows: the owner adds
 * a salesperson with a user ID and password -> the member list shows the user
 * ID -> the salesperson signs in with that user ID and password straight away
 * (no OTP) -> sees only what the Sales role allows: the menu, the dashboard's
 * actions, no product editing or exports, the rate-list rate fixed on the
 * bill, a clear message on a screen outside the role -> a warehouse worker
 * (no sales dashboard in the role) lands on a home of their own: orders to
 * pack and send, stock alerts, no sales figures, a menu of their screens.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/team-access-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98776${run}`;
const staffMobile = `98777${run}`;
const staffId = `raju${run}`;
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
const nav = (page, name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();

// 1. The owner signs up; a product and a customer.
const owner = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const ownerState = { signedIn: false };
watch(owner, ownerState);
await owner.goto(WEB);
await owner.getByRole("button", { name: "Create account" }).click();
await owner.fill("#su-name", "Mohan Agarwal");
await owner.fill("#su-mobile", mobile);
await owner.fill("#su-password", password);
await owner.fill("#su-business", "Agarwal Distributors");
await owner.getByRole("button", { name: "Send OTP" }).click();
const hint = owner.getByText(/Development code: \d{6}/);
await hint.waitFor();
await owner.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await owner.getByRole("button", { name: "Verify and create account" }).click();
await owner.getByRole("heading", { name: /Mohan/ }).waitFor({ timeout: 15000 });
ownerState.signedIn = true;
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
await api("POST", "/products", token, { name: "Tata Tea Gold 250g", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "140", purchasePrice: "118", openingStock: "50", openingStockCost: "118" });
await api("POST", "/customers", token, { name: "Verma Kirana", stateCode: "23" });
log("owner signed up; one product, one customer");

// 2. Team -> Add member with a user ID and password.
await owner.reload();
await nav(owner, "Users & Roles");
await owner.getByRole("button", { name: "Add member" }).first().click();
const dialog = owner.getByRole("dialog");
await owner.fill("#inv-name", "Raju Salesman");
await owner.fill("#inv-mobile", staffMobile);
await owner.fill("#inv-username", staffId.toUpperCase());
await owner.fill("#inv-password", "Raju-pass-2026");
await owner.locator("#inv-role").selectOption({ label: "Sales Employee" });
await owner.screenshot({ path: `${OUT}/team-1-add.png` });
await dialog.getByRole("button", { name: "Add member" }).click();
await owner.getByText(`Raju Salesman can sign in now as ${staffId} with the password you set`).waitFor({ timeout: 15000 });
await owner.getByRole("cell", { name: new RegExp(staffId) }).waitFor();
await owner.getByRole("cell", { name: new RegExp(staffId) }).click();
await dialog.getByText(`Signs in with: ${staffId}`).waitFor();
await owner.screenshot({ path: `${OUT}/team-2-member.png` });
await dialog.getByRole("button", { name: "Close" }).first().click();
log("salesperson added with user ID", staffId);

// 3. The salesperson signs in with the user ID and password, no OTP.
const staffPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const staffState = { signedIn: false };
watch(staffPage, staffState);
await staffPage.goto(WEB);
await staffPage.fill("#auth-id", staffId);
await staffPage.fill("#auth-password", "Raju-pass-2026");
await staffPage.getByRole("button", { name: "Sign in", exact: true }).click();
await staffPage.getByRole("heading", { name: /Raju/ }).waitFor({ timeout: 15000 });
staffState.signedIn = true;
await staffPage.screenshot({ path: `${OUT}/team-3-staff-dashboard.png` });
log("salesperson signed in with the user ID");

// 4. Only what the Sales role allows: the menu, the dashboard's actions, the buttons on each screen.
const menu = (await staffPage.getByRole("navigation", { name: "Main" }).getByRole("button").allTextContents()).map((s) => s.replace(/P\d$/, "").trim());
const expectedMenu = ["Dashboard", "New Invoice", "Sales Orders", "Customers", "Payments", "Outstanding", "Beat", "Messages", "Products", "Notifications"];
if (JSON.stringify(menu) !== JSON.stringify(expectedMenu)) errors.push(`sales menu: ${menu.join(", ")}`);
const quick = (await staffPage.getByRole("region", { name: "Quick actions" }).getByRole("button").allTextContents()).map((s) => s.replace(/(Ctrl|Alt).*$/, "").trim());
if (JSON.stringify(quick) !== JSON.stringify(["Create Invoice", "New Order", "Receive Payment", "Add Customer"])) errors.push(`sales quick actions: ${quick.join(", ")}`);
await nav(staffPage, "Products");
await staffPage.getByRole("cell", { name: /Tata Tea Gold/ }).waitFor();
for (const name of ["Add product", "Import", "Export"]) if (await staffPage.getByRole("button", { name, exact: true }).count()) errors.push(`products: ${name} shown to sales`);
await nav(staffPage, "Customers");
await staffPage.getByRole("button", { name: "Add customer" }).first().waitFor();
if (await staffPage.getByRole("button", { name: "Export", exact: true }).count()) errors.push("customers: Export shown to sales");
// The rate is the rate list's: shown, not editable, without the price-override permission.
await nav(staffPage, "New Invoice");
await staffPage.getByRole("combobox", { name: /Search customer/ }).fill("verma");
await staffPage.getByRole("option", { name: /Verma Kirana/ }).click();
await staffPage.getByPlaceholder("Search product, code or scan barcode").fill("tata tea");
await staffPage.getByRole("option", { name: /Tata Tea Gold/ }).click();
await staffPage.getByLabel("Qty Tata Tea Gold 250g").waitFor();
if (await staffPage.getByRole("textbox", { name: "Rate Tata Tea Gold 250g" }).count()) errors.push("invoice: rate editable for sales");
await staffPage.screenshot({ path: `${OUT}/team-4-staff-invoice.png` });
await staffPage.keyboard.press("Control+Enter");
await staffPage.getByText(/Invoice INV\/.* saved/).first().waitFor({ timeout: 15000 });
// A screen outside the role, opened from a link: a clear message, no failed calls.
await staffPage.goto(`${WEB}/#settings`);
await staffPage.getByText("Not part of your role").waitFor({ timeout: 15000 });
await staffPage.screenshot({ path: `${OUT}/team-5-no-access.png` });
log("sales sees its nine screens, its four actions, no product editing or exports, a fixed rate; Settings says no access");

// 5. A warehouse worker has no sales dashboard: their home shows what to pack and send.
const packer = await api("POST", "/members", token, { name: "Pappu Packer", mobile: `98778${run}`, roleId: (await api("GET", "/roles", token)).data.find((r) => r.key === "warehouse").id, username: `pappu${run}`, password: "Pappu-pass-2026" });
if (packer.username !== `pappu${run}`) errors.push("packer user ID");
const packerPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const packerState = { signedIn: false };
watch(packerPage, packerState);
await packerPage.goto(WEB);
await packerPage.fill("#auth-id", `pappu${run}`);
await packerPage.fill("#auth-password", "Pappu-pass-2026");
await packerPage.getByRole("button", { name: "Sign in", exact: true }).click();
await packerPage.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 15000 });
packerState.signedIn = true;
await packerPage.getByRole("heading", { name: "Pack next" }).waitFor({ timeout: 15000 });
for (const figure of ["Orders to Pack", "Orders to Dispatch"]) if ((await packerPage.getByText(figure, { exact: true }).count()) === 0) errors.push(`warehouse home lacks ${figure}`);
if ((await packerPage.getByText("Today's Sales").count()) !== 0) errors.push("warehouse sees the sales figures");
const packerMenu = (await packerPage.getByRole("navigation", { name: "Main" }).getByRole("button").allTextContents()).map((s) => s.replace(/P\d$/, "").trim());
if (JSON.stringify(packerMenu) !== JSON.stringify(["Dashboard", "Sales Orders", "Products", "Inventory", "Purchases", "Packing", "Dispatch", "Notifications"])) errors.push(`warehouse menu: ${packerMenu.join(", ")}`);
await packerPage.screenshot({ path: `${OUT}/team-6-warehouse.png` });
log("warehouse worker lands on their own home (to pack, to send); menu:", packerMenu.join(", "));

// 6. HR: staff today, leave to decide, the salary run; their own screens only.
await api("POST", "/members", token, { name: "Hema HR", mobile: `98773${run}`, roleId: (await api("GET", "/roles", token)).data.find((r) => r.key === "hr").id, username: `hema${run}`, password: "Hema-pass-2026" });
const hrPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const hrState = { signedIn: false };
watch(hrPage, hrState);
await hrPage.goto(WEB);
await hrPage.fill("#auth-id", `hema${run}`);
await hrPage.fill("#auth-password", "Hema-pass-2026");
await hrPage.getByRole("button", { name: "Sign in", exact: true }).click();
await hrPage.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 15000 });
hrState.signedIn = true;
await hrPage.getByRole("heading", { name: "Staff today" }).waitFor({ timeout: 15000 });
for (const h of ["Leave to decide", "Expenses this month"]) if ((await hrPage.getByRole("heading", { name: h }).count()) === 0) errors.push(`HR home lacks ${h}`);
if ((await hrPage.getByRole("heading", { name: /^Salary for / }).count()) === 0) errors.push("HR home lacks the salary run");
if ((await hrPage.getByText("Today's Sales").count()) !== 0 || (await hrPage.getByText("Pack next").count()) !== 0) errors.push("HR sees sales or warehouse parts");
const hrMenu = (await hrPage.getByRole("navigation", { name: "Main" }).getByRole("button").allTextContents()).map((s) => s.replace(/P\d$/, "").trim());
if (JSON.stringify(hrMenu) !== JSON.stringify(["Dashboard", "Expenses", "Employees", "Salary", "Leave", "Notifications"])) errors.push(`HR menu: ${hrMenu.join(", ")}`);
await hrPage.screenshot({ path: `${OUT}/team-7-hr.png` });
log("HR lands on staff today, leave to decide, salary and expenses; menu:", hrMenu.join(", "));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
