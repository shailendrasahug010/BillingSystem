/**
 * End-to-end check of the "easier to use" pieces: sign up -> the dashboard
 * says there is no backup yet -> "Aa": bigger text and the simple menu (only
 * the everyday screens, "Show full menu" brings the rest back) -> "?" help for
 * the screen open, in English and Hindi -> Settings: "Open on phone" (a QR
 * code of the Wi-Fi address when the server lets phones in, else how to start
 * it so) -> Users & Roles: a new member, then "Send invite on WhatsApp" opens
 * WhatsApp with the link and their user ID -> a backup made, and the dashboard
 * shows it.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/comfort-flow.mjs
 * Against Digital Bahi started with "Start Digital Bahi" (phone mode), set
 * API_URL and WEB_URL to http://localhost:8710 and PHONE=1: the QR code is then checked too.
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const PHONE = process.env.PHONE === "1";
const mobile = process.env.E2E_MOBILE ?? `98772${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
let signedIn = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  if (r.status() >= 400 && r.url().startsWith(API)) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const menu = () => page.getByRole("navigation", { name: "Main" });
const nav = (name) => menu().getByRole("button", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 20000 });
const check = (ok, what) => (ok ? log(what) : errors.push(`not so: ${what}`));

// 1. Sign up: no backup yet.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Sunita Jain");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", password);
await page.fill("#su-business", "Jain General Stores");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Sunita/ }).waitFor({ timeout: 15000 });
signedIn = true;
await page.getByText("No backup yet. Keep a copy of your books safe.").waitFor({ timeout: 15000 });
log("dashboard: no backup yet");

// 2. Bigger text and the simple menu.
await page.getByRole("button", { name: "Text size and simple menu" }).click();
const dialog = page.getByRole("dialog");
await dialog.getByRole("radio", { name: "A++" }).click();
check((await page.evaluate(() => document.documentElement.style.zoom)) === "1.25", "text size A++ zooms the app to 125%");
await dialog.getByLabel("Simple menu").check();
await page.screenshot({ path: `${OUT}/comfort-1-display.png` });
await dialog.getByRole("button", { name: "Close" }).first().click();
check((await menu().getByRole("button", { name: "Users & Roles", exact: true }).count()) === 0, "simple menu hides Users & Roles");
check((await menu().getByRole("button", { name: "Customers", exact: true }).count()) === 1, "simple menu keeps Customers");
await page.screenshot({ path: `${OUT}/comfort-2-simple-menu.png` });
await page.reload();
check((await page.evaluate(() => document.documentElement.style.zoom)) === "1.25", "text size kept after reload");
await menu().getByRole("button", { name: "Show full menu" }).click();
await menu().getByRole("button", { name: "Users & Roles", exact: true }).waitFor();
await page.getByRole("button", { name: "Text size and simple menu" }).click();
await dialog.getByRole("radio", { name: "A", exact: true }).click();
await dialog.getByRole("button", { name: "Close" }).first().click();
check((await page.evaluate(() => document.documentElement.style.zoom)) === "", "text size back to normal");

// 3. Help for the screen open, then in Hindi.
await nav("Customers");
await page.getByRole("button", { name: "Help for this screen" }).click();
await dialog.getByRole("heading", { name: "How to use: Customers" }).waitFor();
await dialog.getByText(/Import brings a whole customer list in/).waitFor();
await page.screenshot({ path: `${OUT}/comfort-3-help.png` });
await dialog.getByRole("button", { name: "Close" }).first().click();
await page.getByRole("radio", { name: "हिं" }).first().click();
await page.getByRole("button", { name: "इस स्क्रीन की मदद" }).click();
await dialog.getByRole("heading", { name: "कैसे इस्तेमाल करें: ग्राहक" }).waitFor();
await page.screenshot({ path: `${OUT}/comfort-4-help-hindi.png` });
await page.keyboard.press("Escape");
await page.getByRole("radio", { name: "EN" }).first().click();
log("help for the screen, in English and Hindi");

// 4. Open on phone.
await nav("Settings");
await page.getByRole("heading", { name: "Open on phone" }).waitFor({ timeout: 15000 });
if (PHONE) {
  await page.getByRole("img", { name: "Open on phone" }).waitFor();
  const link = await page.getByText(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/).first().textContent();
  check(!/localhost|127\.0\.0\.1/.test(link), `QR code of the Wi-Fi address ${link}`);
} else {
  await page.getByText(/Phones cannot open Digital Bahi on this computer yet/).waitFor();
  log("not in phone mode: says how to start it for phones");
}
await page.getByRole("heading", { name: "Open on phone" }).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/comfort-5-phone.png` });

// 5. A new member, invited on WhatsApp.
await nav("Users & Roles");
await page.getByRole("button", { name: "Add member" }).click();
await page.fill("#inv-name", "Mohan Counter");
await page.fill("#inv-mobile", "9111133333");
await page.fill("#inv-username", "mohan");
await page.fill("#inv-password", "Mohan-pass-2026");
await dialog.getByRole("button", { name: "Add member" }).click();
await toast("Member added");
// WhatsApp itself is not opened: its address (number and message) is kept.
const whatsAppUrls = [];
await context.route("https://wa.me/**", (route) => {
  whatsAppUrls.push(route.request().url());
  return route.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" });
});
await dialog.getByRole("button", { name: "Send invite on WhatsApp" }).click();
for (let i = 0; i < 50 && whatsAppUrls.length === 0; i++) await page.waitForTimeout(100);
const url = new URL(whatsAppUrls[0] ?? "https://wa.me/");
const text = url.searchParams.get("text") ?? "";
check(url.pathname === "/919111133333", "WhatsApp opened for the member's number");
check(text.includes("Namaste Mohan Counter") && text.includes("Sign in with mohan and the password I gave you."), "invite names the user ID");
check(PHONE ? /Open: http:\/\/\d/.test(text) : true, "invite carries the phone address");
await page.screenshot({ path: `${OUT}/comfort-6-invite.png` });
await dialog.getByRole("button", { name: "Done" }).click();
await page.getByRole("cell", { name: /Mohan Counter/ }).waitFor();

// 6. A backup made: the dashboard shows when.
await nav("Backup & Restore");
await page.getByRole("heading", { name: "Download a backup" }).waitFor({ timeout: 15000 });
const download = page.waitForEvent("download");
await page.getByRole("button", { name: "Download backup" }).click();
await download;
await toast("Backup downloaded");
await nav("Dashboard");
await page.getByText(/^Last backup: /).waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/comfort-7-dashboard.png` });
log("dashboard shows the last backup");

await browser.close();
if (errors.length) {
  console.error("FAILED:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("comfort flow passed");
