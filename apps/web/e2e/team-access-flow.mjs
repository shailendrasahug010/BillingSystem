/**
 * End-to-end check of staff sign-in and of what a role shows: the owner adds
 * a salesperson with a user ID and password -> the member list shows the user
 * ID -> the salesperson signs in with that user ID and password straight away
 * (no OTP) -> sees only what the Sales role allows.
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

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
