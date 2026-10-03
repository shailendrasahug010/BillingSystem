/**
 * End-to-end check of beat mode (Phase 5.4): the owner sets up a route at
 * the desk (today's weekday and another, the salesman, three shops in
 * calling order) -> the salesman opens Beat on his phone: today's route,
 * the shops in that order, what each is due to buy again -> at Anand's he
 * books the due tea (the order starts with it, at the usual quantity) ->
 * Bansal is shut: "no order", shop closed -> the connection goes: the beat
 * still shows from the phone, Chouhan's bill screen still suggests his
 * soap (from the beat), and a visit is kept on the phone -> back online it
 * is sent -> the owner's team report shows the day against the plan ->
 * a route through Dewas and Sonkatch made city by city (Dewas however it
 * was typed; its shop on another route comes unticked, and moves when
 * ticked) -> that beat shows one town at a time.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true and
 * the outbox worker on (it keeps each customer's buying figures):
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/beat-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98768${run}`;
const raviMobile = `98769${run}`;
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

const errors = [];
function watch(page, state) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && !m.text().includes("ERR_INTERNET_DISCONNECTED") && errors.push(m.text()));
  page.on("response", (r) => {
    if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}
async function signIn(page, state, id, pass) {
  await page.goto(WEB);
  await page.fill("#auth-id", id);
  await page.fill("#auth-password", pass);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading").first().waitFor({ timeout: 15000 });
  state.signedIn = true;
}

const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(today) - n * 86400_000).toISOString().slice(0, 10);
const isoWeekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const dayName = (n) => new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, n)));
const todayNo = isoWeekday(today);
const otherDay = (todayNo % 7) + 1;

// 1. The owner, Ravi (an employee who signs in as a salesman), and three shops with a history.
const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
await api("POST", "/auth/signup", null, { name: "Ramesh Agrawal", mobile, password, otp: otp.devCode, preferredLocale: "en", business: { legalName: "Agrawal Distributors", stateCode: "23", city: "Indore" } });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const tea = await api("POST", "/products", token, { name: "Taaza Tea 250g", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "120", openingStock: "500" });
const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "1000" });
await api("POST", "/employees", token, { name: "Ravi Salesman", mobile: raviMobile, joiningDate: "2025-04-01" });
const roles = Object.fromEntries((await api("GET", "/roles", token)).data.map((r) => [r.key, r.id]));
await api("POST", "/members", token, { name: "Ravi Salesman", mobile: raviMobile, roleId: roles.sales, username: `ravi${run}`, password: "Ravi-pass-2026" });
const customer = (name) => api("POST", "/customers", token, { name, stateCode: "23", city: "Indore", mobile: `9826${run}${name.length}`.slice(0, 10), creditDays: 7 });
const anand = await customer("Anand Kirana");
const bansal = await customer("Bansal Stores");
const chouhan = await customer("Chouhan General");
// Shops in two other towns, on no route (Dewas typed three ways).
const town = (name, city, pincode, i) => api("POST", "/customers", token, { name, stateCode: "23", city, pincode, mobile: `9827${run}${i}`, creditDays: 7 });
await town("Dewas Traders", "Dewas", "455001", 1);
await town("Malwa Kirana", "DEWAS", "455001", 2);
await town("Shree Ganesh Stores", " dewas", "455111", 3);
const bhawani = await town("Bhawani Provision", "Dewas", "455001", 4);
await town("Sonkatch Agencies", "Sonkatch", "455118", 5);
// Anand buys tea every 7 days, Chouhan soap every 10: both are due again.
for (const n of [36, 29, 22, 15, 8]) await api("POST", "/invoices", token, { customerId: anand.id, invoiceDate: daysAgo(n), lines: [{ productId: tea.id, qty: "6" }] });
for (const n of [42, 32, 22, 12]) await api("POST", "/invoices", token, { customerId: chouhan.id, invoiceDate: daysAgo(n), lines: [{ productId: soap.id, qty: "24" }] });
log(`owner, Ravi (sales), 3 shops (and 5 in Dewas and Sonkatch); today is ${dayName(todayNo)} ${today}`);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// 2. At the desk: the route, worked today and one other day, by Ravi, the shops in calling order.
const desk = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const ownerState = { signedIn: false };
watch(desk, ownerState);
await signIn(desk, ownerState, mobile, password);
await desk.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Beat", exact: true }).click();
await desk.getByRole("heading", { name: "Beat", exact: true }).waitFor({ timeout: 15000 });
await desk.getByRole("tab", { name: "Routes" }).click();
await desk.getByText("No routes yet").waitFor({ timeout: 15000 });
await desk.getByRole("button", { name: "New route" }).click();
const routeDialog = desk.getByRole("dialog");
await desk.fill("#route-name", "Vijay Nagar");
await desk.selectOption("#route-salesperson", { label: "Ravi Salesman" });
await routeDialog.getByRole("button", { name: dayName(todayNo), exact: true }).click();
await routeDialog.getByRole("button", { name: dayName(otherDay), exact: true }).click();
for (const name of ["Anand", "Bansal", "Chouhan"]) {
  await desk.getByPlaceholder("Add a shop…").fill(name);
  await desk.getByRole("option", { name: new RegExp(name) }).first().click();
}
// Chouhan is on the way in: first.
await routeDialog.getByRole("button", { name: "Move Chouhan General up" }).click();
await routeDialog.getByRole("button", { name: "Move Chouhan General up" }).click();
const order = (await routeDialog.locator("ol li p.truncate.text-\\[14px\\]").allInnerTexts()).map((s) => s.trim());
if (JSON.stringify(order) !== JSON.stringify(["Chouhan General", "Anand Kirana", "Bansal Stores"])) errors.push(`route order in the dialog: ${order}`);
await desk.screenshot({ path: `${OUT}/beat-1-route.png` });
await routeDialog.getByRole("button", { name: "Save", exact: true }).click();
await desk.getByText("Route saved").first().waitFor({ timeout: 15000 });
await desk.getByText("Ravi Salesman · 3 shops · Indore").waitFor({ timeout: 15000 });
const seq = (await api("GET", `/beats/today`, token)).customers.map((c) => `${c.name}:${c.sequence}`);
if (JSON.stringify(seq) !== JSON.stringify(["Chouhan General:1", "Anand Kirana:2", "Bansal Stores:3"])) errors.push(`route on the server: ${seq}`);
log("desk: route Vijay Nagar,", dayName(todayNo), "and", dayName(otherDay), "by Ravi, shops", order.join(" → "));

// 3. Ravi's phone: today's beat in calling order, what is due.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await phone.newPage();
const raviState = { signedIn: false };
watch(page, raviState);
await signIn(page, raviState, `ravi${run}`, "Ravi-pass-2026");
await page.getByRole("button", { name: "More", exact: true }).first().click();
await page.getByRole("dialog").getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Beat", exact: true }).click();
await page.getByText("0 of 3 shops called").waitFor({ timeout: 15000 });
const shops = page.locator("ul li button p.truncate.text-\\[15px\\]");
const names = async () => (await shops.allInnerTexts()).map((s) => s.trim());
if (JSON.stringify(await names()) !== JSON.stringify(["Chouhan General", "Anand Kirana", "Bansal Stores"])) errors.push(`phone beat: ${await names()}`);
if (!(await page.getByText("Vijay Nagar (Ravi Salesman)").count())) errors.push("route name and salesman not shown");
for (const c of ["Chouhan General", "Anand Kirana"]) {
  if (!(await page.locator("ul li").filter({ hasText: c }).getByText("1 item due").count())) errors.push(`${c}: no "1 item due"`);
}
await page.screenshot({ path: `${OUT}/beat-2-phone.png` });
log("phone: today's beat,", (await names()).join(" → "), "· tea due at Anand's, soap at Chouhan's");

// 4. Anand's: the due tea, ordered at the usual quantity.
await page.locator("ul li button").filter({ hasText: "Anand Kirana" }).click();
const sheet = page.getByRole("dialog");
await sheet.getByRole("heading", { name: "Anand Kirana" }).waitFor();
await sheet.getByText("Taaza Tea 250g").waitFor();
await page.screenshot({ path: `${OUT}/beat-3-sheet.png` });
await sheet.getByRole("button", { name: "Order 1 due item" }).click();
const orderDialog = page.getByRole("dialog");
await orderDialog.getByText("Taaza Tea 250g").first().waitFor();
await page.screenshot({ path: `${OUT}/beat-4-order.png` });
await orderDialog.getByRole("button", { name: /^Save order/ }).click();
await page.getByText("Order saved").first().waitFor({ timeout: 15000 });
await page.getByText("1 of 3 shops called").waitFor({ timeout: 15000 });
const orders = (await api("GET", `/sales-orders?customerId=${anand.id}`, token)).data;
if (orders.length !== 1 || orders[0].grandTotal !== "756.00") errors.push(`Anand's order: ${JSON.stringify(orders.map((o) => o.grandTotal))}`);
log("Anand: the order started with the due tea (6, as usual): ₹756 booked");

// 5. Bansal is shut: no order, and why.
await page.getByRole("radio", { name: /^All/ }).click();
await page.locator("ul li button").filter({ hasText: "Bansal Stores" }).click();
await page.getByRole("dialog").getByRole("button", { name: "No order", exact: true }).click();
await page.getByRole("dialog").getByRole("radio", { name: "Shop closed" }).click();
await page.fill("#visit-note", "Shutter down, back Monday");
await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
await page.getByText("No order noted").first().waitFor({ timeout: 15000 });
await page.locator("ul li").filter({ hasText: "Bansal Stores" }).getByText("No order: Shop closed").waitFor({ timeout: 15000 });
log("Bansal: no order, shop closed");

// 6. No connection: the beat from the phone; Chouhan's bill screen still suggests his soap.
await phone.setOffline(true);
await page.getByText(/No connection: this is the beat kept on this phone/).waitFor({ timeout: 15000 });
if (JSON.stringify(await names()) !== JSON.stringify(["Chouhan General", "Anand Kirana", "Bansal Stores"])) errors.push(`offline beat: ${await names()}`);
await page.locator("ul li button").filter({ hasText: "Chouhan General" }).click();
await page.getByRole("dialog").getByRole("button", { name: "New bill" }).click();
await page.getByText(/Usually every 10 days/).first().waitFor({ timeout: 15000 });
if (!(await page.getByText("Lux Soap 100g").count())) errors.push("offline: soap not suggested for Chouhan");
await page.screenshot({ path: `${OUT}/beat-5-offline-suggestion.png` });
log("offline: Chouhan's bill screen suggests Lux Soap (usually every 10 days) from the beat kept on the phone");
await page.getByRole("button", { name: "More", exact: true }).first().click();
await page.getByRole("dialog").getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Beat", exact: true }).click();
await page.getByText(/No connection: this is the beat kept on this phone/).waitFor({ timeout: 15000 });
await page.locator("ul li button").filter({ hasText: "Chouhan General" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Visited only" }).click();
await page.getByText("Saved on this device").first().waitFor({ timeout: 15000 });
await page.getByText("3 of 3 shops called").waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/beat-6-offline-visit.png` });
log("offline: Chouhan's visit kept on the phone; 3 of 3 called");

// 7. Back online: the visit is sent.
await phone.setOffline(false);
const raviToken = (await api("POST", "/auth/login", null, { identifier: `ravi${run}`, password: "Ravi-pass-2026" })).accessToken;
let sent = null;
for (let i = 0; i < 40 && !sent; i++) {
  const beat = await api("GET", "/beats/today", raviToken);
  if (beat.customers.find((c) => c.id === chouhan.id)?.today?.outcome === "visited") sent = beat;
  else await page.waitForTimeout(500);
}
if (!sent) errors.push("the visit made offline did not reach the server");
else if (JSON.stringify(sent.summary) !== JSON.stringify({ planned: 3, called: 3, productive: 1, billed: "0.00", ordered: "756.00", collected: "0.00" })) errors.push(`server summary: ${JSON.stringify(sent.summary)}`);
log("online again: the visit sent; the server counts 3 of 3 called, 1 productive");

// 8. The owner's team report for today.
await desk.getByRole("tab", { name: "Team report" }).click();
const row = desk.locator("table tbody tr").filter({ hasText: "Ravi Salesman" });
await row.waitFor({ timeout: 15000 });
const cells = (await row.locator("td").allInnerTexts()).map((s) => s.trim());
// Day, salesman, planned, called, productive, off plan, billed, ordered, collected, why no order.
if (cells.slice(1, 6).join("|") !== "Ravi Salesman|3|3|1|0" || cells[7] !== "₹756" || !cells[9].includes("Shop closed × 1")) errors.push(`report row: ${cells.join(" | ")}`);
await desk.screenshot({ path: `${OUT}/beat-7-report.png` });
log("desk: team report", cells.slice(1).join(" | "));

// 9. A route through Dewas and Sonkatch, a city's shops at once. Bhawani is on another route already.
const highway = await api("POST", "/routes", token, { name: "Dewas Highway" });
await api("PUT", `/routes/${highway.id}/order`, token, { customerIds: [bhawani.id] });
await desk.reload();
await desk.getByRole("tab", { name: "Routes" }).click();
await desk.getByText("No salesperson · 1 shop · Dewas").waitFor({ timeout: 15000 });
await desk.getByRole("button", { name: "New route" }).click();
await desk.fill("#route-name", "Dewas town");
await desk.selectOption("#route-salesperson", { label: "Ravi Salesman" });
await routeDialog.getByRole("button", { name: dayName(otherDay), exact: true }).click();
const cityChoices = (await desk.locator("#route-add-city option").allInnerTexts()).map((s) => s.trim());
if (JSON.stringify(cityChoices) !== JSON.stringify(["Add a city's shops…", "Dewas · 4 shops", "Indore · 3 shops", "Sonkatch · 1 shop"])) errors.push(`city choices: ${cityChoices}`);
await desk.selectOption("#route-add-city", { label: "Dewas · 4 shops" });
const dewas = routeDialog.getByRole("group", { name: "Dewas" });
const listed = async () => (await dewas.locator("li label > span > span:first-child").allInnerTexts()).map((s) => s.trim());
// By PIN code, then name; the shops on no route come ticked.
if (JSON.stringify(await listed()) !== JSON.stringify(["Bhawani Provision", "Dewas Traders", "Malwa Kirana", "Shree Ganesh Stores"])) errors.push(`Dewas shops: ${await listed()}`);
const tickedNow = async () => {
  const out = [];
  for (const name of await listed()) if (await dewas.getByRole("checkbox", { name: new RegExp(`^${name}`) }).isChecked()) out.push(name);
  return out;
};
if (JSON.stringify(await tickedNow()) !== JSON.stringify(["Dewas Traders", "Malwa Kirana", "Shree Ganesh Stores"])) errors.push(`ticked in Dewas: ${await tickedNow()}`);
if (!(await dewas.getByText("now on Dewas Highway").count())) errors.push("Bhawani: not shown as on Dewas Highway");
await desk.screenshot({ path: `${OUT}/beat-8-city.png` });
await dewas.getByRole("button", { name: "Add 3 shops" }).click();
await desk.selectOption("#route-add-city", { label: "Sonkatch · 1 shop" });
await routeDialog.getByRole("group", { name: "Sonkatch" }).getByRole("button", { name: "Add 1 shop" }).click();
// Dewas again: the three are on the list; Bhawani, ticked now, moves here.
await desk.selectOption("#route-add-city", { label: "Dewas · 4 shops" });
await dewas.getByText("3 of its shops are on this route already.").waitFor();
await dewas.getByRole("checkbox", { name: /^Bhawani Provision/ }).check();
await dewas.getByRole("button", { name: "Add 1 shop" }).click();
await routeDialog.getByRole("button", { name: "Move Bhawani Provision up" }).click();
const townOrder = (await routeDialog.locator("ol li p.truncate.text-\\[14px\\]").allInnerTexts()).map((s) => s.trim());
const expected = ["Dewas Traders", "Malwa Kirana", "Shree Ganesh Stores", "Bhawani Provision", "Sonkatch Agencies"];
if (JSON.stringify(townOrder) !== JSON.stringify(expected)) errors.push(`Dewas town in the dialog: ${townOrder}`);
await routeDialog.getByRole("button", { name: "Save", exact: true }).click();
await desk.getByText("Route saved").first().waitFor({ timeout: 15000 });
await desk.getByText("Ravi Salesman · 5 shops · Dewas, Sonkatch").waitFor({ timeout: 15000 });
await desk.getByText("No salesperson · 0 shops").waitFor({ timeout: 15000 });
const dewasTown = (await api("GET", "/routes", token)).data.find((r) => r.name === "Dewas town");
const townSeq = (await api("GET", `/beats/today?routeId=${dewasTown.id}`, token)).customers.map((c) => c.name);
if (JSON.stringify(townSeq) !== JSON.stringify(expected)) errors.push(`Dewas town on the server: ${townSeq}`);
log("desk: route Dewas town made city by city:", townSeq.join(" → "), "(Bhawani moved off Dewas Highway)");

// 10. That beat, one town at a time.
await desk.getByRole("tab", { name: "Today" }).click();
await desk.getByRole("combobox", { name: "Which route" }).selectOption({ label: "Dewas town" });
await desk.getByText("0 of 5 shops called").waitFor({ timeout: 15000 });
const townChips = desk.getByRole("group", { name: "Shops by city" });
const towns = townChips.getByRole("button");
const chips = await towns.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
if (JSON.stringify(chips) !== JSON.stringify(["All cities: 0 of 5 shops called", "Dewas: 0 of 4 shops called", "Sonkatch: 0 of 1 shops called"])) errors.push(`town chips: ${chips}`);
await townChips.getByRole("button", { name: /^Sonkatch/ }).click();
const deskNames = async () => (await desk.locator("ul li button p.truncate.text-\\[15px\\]").allInnerTexts()).map((s) => s.trim());
await desk.getByRole("radio", { name: "To visit · 1" }).waitFor({ timeout: 15000 });
if (JSON.stringify(await deskNames()) !== JSON.stringify(["Sonkatch Agencies"])) errors.push(`Sonkatch only: ${await deskNames()}`);
await desk.screenshot({ path: `${OUT}/beat-9-town.png` });
await townChips.getByRole("button", { name: /^All cities/ }).click();
await desk.getByRole("radio", { name: "To visit · 5" }).waitFor({ timeout: 15000 });
log("desk: Dewas town's beat by town:", chips.join(" | "));

await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
