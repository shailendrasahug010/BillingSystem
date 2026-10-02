/**
 * End-to-end check of the bill screen with many lines and the keyboard:
 * on a 1366 x 768 laptop, a customer with a buying history -> a suggestion
 * is added by clicking its card anywhere (its name, not the +qty) -> the
 * suggestions fold into one row, and a chip adds another -> ten lines: the
 * table fits its card (the amounts are on screen, no sideways scrolling),
 * the search stays at the top and Save stays in view -> Ctrl+S saves and a
 * popup says "Invoice added successfully" (print, view, WhatsApp, new) ->
 * another bill: the line of Rin (also sold by the box) has a unit list,
 * "P · PCS" and "B · BOX (24 PCS)", and starts in pieces; "2b" typed in the
 * quantity makes it 2 boxes at the box price, "p" pieces again, the list and
 * its letters change it too; Tab goes qty -> unit -> rate -> Disc % -> back
 * to the search; Ctrl+P saves it (in boxes) and the bill opens with the print
 * dialog -> Crocin, sold by the strip of 10 and the box of 100, starts in
 * strips -> Settings: STRIP's letter T and new lines in each product's own
 * unit: Crocin starts in tablets, "3t" is 3 strips; then back ->
 * on a phone, each line keeps its name on one line, a suggestion card adds by
 * a tap on its text and the rest fold into a row -> on a 1024 px tablet the
 * total and Save stay at the foot of the screen.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true and the
 * outbox worker on (it keeps each customer's buying figures):
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/invoice-screen-flow.mjs
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
const mobile = process.env.E2E_MOBILE ?? `98763${run}`;
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
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("response", (r) => {
    if (!state.signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}
async function signIn(page, state) {
  await page.goto(WEB);
  await page.fill("#auth-id", mobile);
  await page.fill("#auth-password", password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading").first().waitFor({ timeout: 15000 });
  state.signedIn = true;
}

// 1. The owner, fourteen products and a shop that bought most of them before (so it has suggestions).
const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
await api("POST", "/auth/signup", null, { name: "Ramesh Agrawal", mobile, password, otp: otp.devCode, preferredLocale: "en", business: { legalName: "Agrawal Distributors", stateCode: "23", city: "Indore" } });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const catalogue = [
  ["Taaza Tea 250g", "GST 5%", 120], ["Lux Soap 100g", "GST 18%", 35], ["Surf Excel 1kg", "GST 18%", 140], ["Parle-G 800g", "GST 18%", 90],
  ["Tata Salt 1kg", "GST 5%", 28], ["Fortune Oil 1L", "GST 5%", 165], ["Colgate 200g", "GST 18%", 110], ["Maggi 12-pack", "GST 18%", 168],
  ["Dettol Soap 75g", "GST 18%", 45], ["Bru Coffee 100g", "GST 18%", 210], ["Vim Bar 300g", "GST 18%", 30], ["Aashirvaad Atta 5kg", "GST 5%", 260],
  ["Good Day 600g", "GST 18%", 120], ["Rin Bar 250g", "GST 18%", 25],
];
const products = [];
// Rin is also sold by the box of 24.
for (const [name, tax, price] of catalogue) products.push(await api("POST", "/products", token, { name, taxCategoryId: taxes[tax], baseUnitId: units.PCS, sellingPrice: String(price), openingStock: "900", ...(name.startsWith("Rin") ? { units: [{ unitId: units.BOX, conversionFactor: "24" }] } : {}) }));
// Tablets: sold by the strip of 10 and the box of 100.
await api("POST", "/products", token, { name: "Crocin 500 Tablet", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "2", openingStock: "5000", units: [{ unitId: units.STRIP, conversionFactor: "10" }, { unitId: units.BOX, conversionFactor: "100" }] });
const shop = await api("POST", "/customers", token, { name: "Sharma Kirana Store", stateCode: "23", city: "Indore", mobile: `9826${run}1`, creditDays: 15 });
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(today) - n * 86400_000).toISOString().slice(0, 10);
for (const [i, n] of [40, 30, 20, 10].entries()) await api("POST", "/invoices", token, { customerId: shop.id, invoiceDate: daysAgo(n), lines: products.slice(i, i + 9).map((p) => ({ productId: p.id, qty: String(6 + i) })) });
// The outbox worker works out the shop's buying.
for (let i = 0; i < 40; i++) {
  const insight = await api("GET", `/customers/${shop.id}/insight`, token).catch(() => null);
  if ((insight?.stats?.length ?? 0) >= 12) break;
  await new Promise((r) => setTimeout(r, 500));
}
const invoicesOf = async () => (await api("GET", `/invoices?customerId=${shop.id}&limit=50`, token)).data;
const before = (await invoicesOf()).length;
log(`owner, ${products.length} products, Sharma Kirana with ${before} bills before today`);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** Opens a new bill for Sharma Kirana. */
async function newBill(page) {
  await page.goto(`${WEB}/#invoice`);
  await page.getByRole("combobox", { name: "Search customer by name, mobile, GSTIN or code" }).fill("Sharma");
  await page.getByRole("option", { name: /Sharma Kirana/ }).first().click();
}
const search = (page) => page.getByRole("combobox", { name: "Search product, code or scan barcode" });
async function addBySearch(page, name) {
  await search(page).fill(name.split(" ")[0]);
  await page.getByRole("option", { name: new RegExp(name.split(" ")[0]) }).first().click({ timeout: 8000 });
  await page.getByLabel(`Qty ${name}`).waitFor();
}
/** The popup a saved bill opens ("Invoice added successfully"): its number, then on to a new bill. */
async function savedBill(page) {
  const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
  await popup.waitFor({ timeout: 20000 });
  const number = (await popup.innerText()).match(/[A-Z][A-Z0-9]*\/\d\d-\d\d\/\d+/)?.[0] ?? "";
  await popup.getByRole("button", { name: "New invoice" }).click();
  await popup.waitFor({ state: "detached" });
  return number;
}
const lineNames = (page) => page.locator("section[aria-labelledby='items-h'] tbody tr td:nth-child(2) p:first-child").allInnerTexts();

// 2. A laptop: suggestions, many lines, Ctrl+S.
const laptop = await browser.newContext({ viewport: { width: 1366, height: 768 } });
// The print dialog, counted (headless Chromium has none).
await laptop.addInitScript(() => {
  window.print = () => {
    window.__printed = (window.__printed ?? 0) + 1;
  };
});
const page = await laptop.newPage();
const deskState = { signedIn: false };
watch(page, deskState);
await signIn(page, deskState);
await newBill(page);
const panel = page.getByRole("region", { name: "Smart suggestions" }).or(page.locator("section[aria-labelledby='sugg-title']")).first();
await page.getByRole("tablist", { name: "Smart suggestions" }).waitFor({ timeout: 15000 });
// The first card, clicked where its product's name is (as a mouse does: the whole card adds it).
const firstCard = panel.locator("ul > li").first();
const firstName = (await firstCard.locator("p").first().innerText()).trim();
const at = await firstCard.locator("p").first().boundingBox();
await page.mouse.click(at.x + 12, at.y + at.height / 2);
await page.getByLabel(`Qty ${firstName}`).waitFor({ timeout: 5000 });
log(`suggestion card clicked on its name: ${firstName} added`);
// With a line on the bill the suggestions fold into one row of chips; a chip adds too.
if (await page.getByRole("tablist", { name: "Smart suggestions" }).count()) errors.push("suggestions did not fold into a row after the first line");
const chip = page.locator("section[aria-labelledby='sugg-title'] ul button").first();
const chipName = (await chip.getAttribute("aria-label")).replace(/^Add [\d.]+ /, "");
await chip.click();
await page.getByLabel(`Qty ${chipName}`).waitFor({ timeout: 5000 });
log(`then a chip in the folded row: ${chipName} added`);
await page.screenshot({ path: `${OUT}/invoice-screen-1-folded.png` });

// Up to ten lines from the search.
for (const [name] of catalogue) {
  if ((await lineNames(page)).length >= 10) break;
  if ((await lineNames(page)).includes(name)) continue;
  await addBySearch(page, name);
}
const names = await lineNames(page);
// The table fits its card: no sideways scrolling, every amount on screen.
const fit = await page.evaluate(() => {
  const card = document.querySelector("section[aria-labelledby='items-h']");
  const table = card.querySelector("table");
  const amounts = [...card.querySelectorAll("tbody tr td:nth-child(6)")].map((td) => td.getBoundingClientRect().right);
  return { table: table.scrollWidth, card: card.clientWidth, rightmost: Math.max(...amounts), viewport: window.innerWidth };
});
if (fit.table > fit.card + 1 || fit.rightmost > fit.viewport) errors.push(`the lines do not fit: ${JSON.stringify(fit)}`);
// The last line is focused (and scrolled to): the search is still on screen at the top, and Save too.
const box = async (locator) => locator.boundingBox();
const searchBox = await box(search(page));
const saveBox = await box(page.getByRole("button", { name: "Save invoice" }));
if (!searchBox || searchBox.y < 0 || searchBox.y + searchBox.height > 768) errors.push(`search not on screen: ${JSON.stringify(searchBox)}`);
if (!saveBox || saveBox.y < 0 || saveBox.y + saveBox.height > 768) errors.push(`Save not on screen: ${JSON.stringify(saveBox)}`);
const rowHeight = (await box(page.locator("section[aria-labelledby='items-h'] tbody tr").first())).height;
if (rowHeight > 56) errors.push(`lines are ${rowHeight}px tall`);
await page.screenshot({ path: `${OUT}/invoice-screen-2-ten-lines.png` });
log(`${names.length} lines: the table fits (${fit.table}px in ${fit.card}px), lines ${Math.round(rowHeight)}px, search and Save on screen`);

// Ctrl+S saves.
await page.getByLabel(`Qty ${names.at(-1)}`).fill("3");
await page.keyboard.press("Control+s");
// Saved: the popup says so, with what next.
const popup = page.getByRole("dialog", { name: "Invoice added successfully" });
await popup.waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/invoice-screen-2b-saved.png` });
for (const button of ["Print", "View invoice", "New invoice", "Send on WhatsApp"]) if (!(await popup.getByRole("button", { name: button }).count())) errors.push(`saved popup: no ${button}`);
log("saved popup:", (await popup.innerText()).replace(/\s+/g, " ").slice(0, 120));
await savedBill(page);
const saved = await invoicesOf();
if (saved.length !== before + 1) errors.push(`Ctrl+S: ${saved.length - before} bills saved`);
else {
  const bill = await api("GET", `/invoices/${saved[0].id}`, token);
  if (bill.items.length !== 10) errors.push(`Ctrl+S: the bill has ${bill.items.length} lines`);
  log(`Ctrl+S saved ${bill.invoiceNumber} with ${bill.items.length} lines`);
}

// The next bill: Rin's line has a unit list, its pieces and its box of 24, each with its letter; it starts in pieces (no strip).
await newBill(page);
await addBySearch(page, "Rin Bar 250g");
const unitList = (name) => page.getByRole("combobox", { name: `Unit ${name}` });
const optionsOf = (name) => unitList(name).locator("option").allTextContents();
if (JSON.stringify(await optionsOf("Rin Bar 250g")) !== JSON.stringify(["P · PCS", "B · BOX (24 PCS)"])) errors.push(`Rin's units: ${await optionsOf("Rin Bar 250g")}`);
/** Waits up to 3 s for the line to show it (a key or a choice re-renders the line). */
async function lineShows(name, unitId, rate, qty, what) {
  const now = async () => [await unitList(name).inputValue(), await page.getByLabel(`Rate ${name}`).inputValue(), await page.getByLabel(`Qty ${name}`).inputValue()];
  for (let i = 0; i < 30; i++) {
    if (JSON.stringify(await now()) === JSON.stringify([unitId ?? "", rate, qty])) return;
    await page.waitForTimeout(100);
  }
  errors.push(`${what}: unit, rate, qty ${await now()}`);
}
const rinShows = (unitId, rate, qty, what) => lineShows("Rin Bar 250g", unitId, rate, qty, what);
await rinShows(null, "25", "1", "a new line of Rin");
// The quantity has the cursor (once the new line has it): "2" then "b" is 2 boxes, at the box price (24 × ₹25).
await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Qty Rin Bar 250g");
await page.keyboard.type("2b");
await rinShows(units.BOX, "600", "2", '"2b"');
await page.keyboard.press("p");
await rinShows(null, "25", "2", '"p"');
// On the list: a choice, and the letters.
await unitList("Rin Bar 250g").selectOption({ label: "B · BOX (24 PCS)" });
await rinShows(units.BOX, "600", "2", "BOX chosen on the list");
await unitList("Rin Bar 250g").focus();
await page.keyboard.press("p");
await rinShows(null, "25", "2", '"p" on the list');
await page.keyboard.press("b");
await rinShows(units.BOX, "600", "2", '"b" on the list');
await page.getByText("a letter after the qty picks the unit: P PCS, B BOX").waitFor();
await page.screenshot({ path: `${OUT}/invoice-screen-3a-unit-list.png` });
log('Rin: units "P · PCS", "B · BOX (24 PCS)", in pieces at first; "2b" made it 2 boxes at ₹600, "p" pieces, the list and its letters boxes again');
// Tab goes round the line: the unit list comes after the quantity, though it is drawn under the name.
await page.getByLabel("Qty Rin Bar 250g").focus();
const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
const order = [await focused()];
for (let i = 0; i < 4; i++) {
  await page.keyboard.press("Tab");
  order.push(await focused());
}
const expectedOrder = ["Qty Rin Bar 250g", "Unit Rin Bar 250g", "Rate Rin Bar 250g", "Disc % Rin Bar 250g", "Search product, code or scan barcode"];
if (JSON.stringify(order) !== JSON.stringify(expectedOrder)) errors.push(`Tab order: ${order.join(" → ")}`);
log("Tab:", order.join(" → "));
// Ctrl+P: saved and opened with the print dialog.
await page.keyboard.press("Control+p");
await page.waitForFunction(() => window.__printed === 1, null, { timeout: 15000 });
await page.getByRole("button", { name: "Print / PDF" }).or(page.getByText(/Rin Bar 250g/)).first().waitFor();
const afterPrint = await invoicesOf();
if (afterPrint.length !== before + 2) errors.push(`Ctrl+P: ${afterPrint.length - before - 1} bills saved`);
else {
  const [item] = (await api("GET", `/invoices/${afterPrint[0].id}`, token)).items;
  if (item.unitId !== units.BOX || Number(item.qty) !== 2 || Number(item.rate) !== 600) errors.push(`Ctrl+P: the line went as ${item.qty} × ${item.rate} in ${item.unitId}`);
}
await page.screenshot({ path: `${OUT}/invoice-screen-3-printed.png` });
log("Ctrl+P saved the next bill (2 boxes of Rin) and opened it with the print dialog");

// Tablets start in strips (the app's own choice): Crocin at 10 × ₹2.
await newBill(page);
await addBySearch(page, "Crocin 500 Tablet");
if (JSON.stringify(await optionsOf("Crocin 500 Tablet")) !== JSON.stringify(["P · PCS", "S · STRIP (10 PCS)", "B · BOX (100 PCS)"])) errors.push(`Crocin's units: ${await optionsOf("Crocin 500 Tablet")}`);
await lineShows("Crocin 500 Tablet", units.STRIP, "20", "1", "a new line of Crocin (in strips)");
log("Crocin, sold by the strip of 10 and the box of 100: the new line is 1 strip at ₹20");

// The letters and the first unit are the business's: STRIP's letter T, and new lines in each product's own unit.
await page.goto(`${WEB}/#settings`);
const unitsRow = page.getByRole("group", { name: "Units on the bill" });
await unitsRow.waitFor({ timeout: 15000 });
const settingIs = async (key, value) => {
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify((await api("GET", "/settings", token))[key]) === JSON.stringify(value)) return true;
    await page.waitForTimeout(200);
  }
  errors.push(`${key}: ${JSON.stringify((await api("GET", "/settings", token))[key])}, not ${JSON.stringify(value)}`);
  return false;
};
await page.selectOption("#start-unit", { label: "Each product's own unit" });
await settingIs("invoice.default_unit", "own");
await unitsRow.getByLabel("Letter for STRIP").fill("t");
await page.screenshot({ path: `${OUT}/invoice-screen-3b-settings.png` });
await unitsRow.getByRole("button", { name: "Save", exact: true }).click();
await settingIs("invoice.unit_letters", { [units.STRIP]: "T" });
await unitsRow.getByRole("button", { name: "Back to first letters" }).waitFor({ timeout: 15000 });
await newBill(page);
await addBySearch(page, "Crocin 500 Tablet");
await lineShows("Crocin 500 Tablet", null, "2", "1", "Crocin in its own unit");
if (JSON.stringify(await optionsOf("Crocin 500 Tablet")) !== JSON.stringify(["P · PCS", "T · STRIP (10 PCS)", "B · BOX (100 PCS)"])) errors.push(`Crocin's units after Settings: ${await optionsOf("Crocin 500 Tablet")}`);
await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Qty Crocin 500 Tablet");
await page.keyboard.type("3t");
await lineShows("Crocin 500 Tablet", units.STRIP, "20", "3", '"3t"');
await page.getByText("a letter after the qty picks the unit: P PCS, T STRIP, B BOX").waitFor();
log('Settings: STRIP is T, lines start in the product\'s own unit: Crocin 1 tablet, "3t" 3 strips');
// Back to the app's own.
await page.goto(`${WEB}/#settings`);
await unitsRow.getByRole("button", { name: "Back to first letters" }).click();
await unitsRow.getByRole("button", { name: "Back to first letters" }).waitFor({ state: "detached", timeout: 15000 });
await settingIs("invoice.unit_letters", null);
await page.selectOption("#start-unit", { label: "STRIP — Strip" });
await settingIs("invoice.default_unit", units.STRIP);

// 3. A phone: one line a name, a suggestion card tapped on its text, then a row of chips.
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const phone = await phoneCtx.newPage();
const phoneState = { signedIn: false };
watch(phone, phoneState);
await signIn(phone, phoneState);
await phone.goto(`${WEB}/#invoice`);
await phone.getByRole("combobox", { name: "Search customer by name, mobile, GSTIN or code" }).fill("Sharma");
await phone.getByRole("option", { name: /Sharma Kirana/ }).first().click();
await phone.getByRole("tablist", { name: "Smart suggestions" }).waitFor({ timeout: 15000 });
const card = phone.locator("section[aria-labelledby='sugg-title'] ul > li").first();
const cardName = (await card.locator("p").first().innerText()).trim();
// Tapped where its reason is.
const reason = await card.locator("p").nth(1).boundingBox();
await phone.touchscreen.tap(reason.x + 40, reason.y + reason.height / 2);
await phone.getByLabel(`Qty ${cardName}`).waitFor({ timeout: 5000 });
if (await phone.getByRole("tablist", { name: "Smart suggestions" }).count()) errors.push("phone: suggestions did not fold into a row");
for (const name of ["Taaza Tea 250g", "Aashirvaad Atta 5kg", "Fortune Oil 1L"]) {
  if (name === cardName) continue;
  await phone.getByRole("combobox", { name: "Search product, code or scan barcode" }).fill(name.split(" ")[0]);
  await phone.getByRole("option", { name: new RegExp(name.split(" ")[0]) }).first().tap();
  await phone.getByLabel(`Qty ${name}`).waitFor();
}
const heights = await phone.locator("section ul.divide-y > li").evaluateAll((lis) => lis.map((li) => li.getBoundingClientRect().height));
const nameLines = await phone.locator("section ul.divide-y > li > div:first-child > p").evaluateAll((ps) => ps.map((p) => Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight))));
if (heights.some((h) => h > 96) || nameLines.some((n) => n > 1)) errors.push(`phone lines: heights ${heights}, name lines ${nameLines}`);
await phone.screenshot({ path: `${OUT}/invoice-screen-4-phone.png` });
log(`phone: suggestion card tapped on its reason (${cardName} added), the rest in a row; ${heights.length} lines ${Math.round(Math.max(...heights))}px at most, names on one line`);

// 4. A 1024 px screen: the summary is under the lines, the total and Save stay at the foot.
const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const tab = await tablet.newPage();
const tabState = { signedIn: false };
watch(tab, tabState);
await signIn(tab, tabState);
await newBill(tab);
for (const name of ["Taaza Tea 250g", "Lux Soap 100g", "Surf Excel 1kg", "Parle-G 800g", "Tata Salt 1kg", "Fortune Oil 1L", "Colgate 200g", "Maggi 12-pack"]) await addBySearch(tab, name);
const bar = tab.getByRole("button", { name: "Save", exact: true });
const barBox = await bar.boundingBox();
if (!barBox || barBox.y + barBox.height > 768) errors.push(`tablet: Save not at the foot of the screen: ${JSON.stringify(barBox)}`);
await tab.screenshot({ path: `${OUT}/invoice-screen-5-tablet.png` });
await bar.click();
await savedBill(tab);
if ((await invoicesOf()).length !== before + 3) errors.push("tablet: the bill was not saved from the bar");
log("1024 px: the total bar's Save saved the bill");

await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
