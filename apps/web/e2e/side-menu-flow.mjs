/**
 * The menu on a computer hides itself and comes out at the left edge: hidden on the bill
 * screen, out when the mouse rests on the edge, hidden again after picking a screen or moving
 * back to the work, and fixed in place again with "Keep the menu open" (kept after a reload).
 * Phones keep their own menu.
 *
 * Run against an empty database, with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/side-menu-flow.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = `97532${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);
const errors = [];
const check = (ok, what) => ok || errors.push(what);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  // Browser tests start with the menu kept open; this one turns hiding on, as a person's browser has it.
  await page.addInitScript(() => {
    if (localStorage.getItem("digitalbahi:menu-auto-hide") === null) localStorage.setItem("digitalbahi:menu-auto-hide", "1");
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Meena Joshi");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Joshi Agencies");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByText("Today's Sales").waitFor({ timeout: 15000 });

  const menu = page.locator("aside").first();
  const left = async () => (await menu.boundingBox())?.x ?? 0;

  // 1. The bill screen has the whole width; the menu waits off the edge.
  await page.goto(`${WEB}/#invoice`);
  await page.getByPlaceholder("Search customer by name, mobile, GSTIN or code").waitFor();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(400);
  check((await left()) < -200, `menu shown on the bill screen (x ${await left()})`);
  await page.screenshot({ path: `${OUT}/side-menu-1-hidden.png` });

  // 2. The mouse on the left edge brings it out; it stays while the mouse is on it.
  await page.mouse.move(2, 450);
  await page.waitForTimeout(400);
  check((await left()) === 0, `menu did not come out at the left edge (x ${await left()})`);
  await page.mouse.move(150, 400);
  await page.waitForTimeout(400);
  check((await left()) === 0, "menu went away with the mouse still on it");
  await page.screenshot({ path: `${OUT}/side-menu-2-out.png` });

  // 3. Picking a screen opens it and puts the menu away.
  await menu.getByRole("button", { name: "Customers", exact: true }).click();
  await page.waitForTimeout(500);
  check((await page.evaluate(() => location.hash)) === "#customers", "menu: Customers did not open");
  check((await left()) < -200, "menu stayed out after picking a screen");

  // 4. Moving back to the work puts it away too; so does Esc.
  await page.mouse.move(600, 400);
  await page.mouse.move(2, 450);
  await page.waitForTimeout(400);
  for (let x = 400; x <= 800; x += 50) await page.mouse.move(x, 450);
  await page.waitForTimeout(500);
  check((await left()) < -200, "menu stayed out after the mouse went back to the page");
  await page.mouse.move(2, 450);
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check((await left()) < -200, "Esc did not put the menu away");

  // 5. The top bar's menu button opens it too, for a touch screen.
  await page.getByRole("button", { name: "More", exact: true }).first().click();
  await page.waitForTimeout(400);
  check((await left()) === 0, "the top bar's menu button did not bring the menu out");

  // 6. Keep the menu open: fixed beside the page again, also after a reload.
  await menu.getByRole("button", { name: "Keep the menu open" }).click();
  await page.mouse.move(900, 450);
  await page.waitForTimeout(500);
  check((await left()) === 0, "Keep the menu open: the menu still hides");
  await page.reload();
  await page.getByText("Joshi Agencies").first().waitFor();
  await page.mouse.move(900, 450);
  await page.waitForTimeout(500);
  check((await left()) === 0, "Keep the menu open was forgotten after a reload");
  await page.screenshot({ path: `${OUT}/side-menu-3-kept.png` });
  await menu.getByRole("button", { name: "Hide the menu until the mouse reaches the left edge" }).click();
  await page.mouse.move(900, 450);
  await page.waitForTimeout(500);
  check((await left()) < -200, "hiding could not be turned back on");
  log("menu hides on a computer, comes out at the edge, and can be kept open");

  // 7. A phone keeps its own menu sheet.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addInitScript(() => localStorage.setItem("digitalbahi:menu-auto-hide", "1"));
  await phone.goto(WEB);
  await phone.getByLabel("Mobile number, email or user ID").fill(mobile);
  await phone.locator("input[type=password]").fill(password);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await phone.getByText("Today's Sales").waitFor({ timeout: 15000 });
  check(!(await phone.locator("aside").first().isVisible()), "phone: the computer menu shows");
  await phone.getByRole("button", { name: "More", exact: true }).first().click();
  await phone.getByRole("dialog").getByRole("navigation", { name: "Main" }).waitFor();
  log("phone: its own menu sheet");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
}
await browser.close();
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
