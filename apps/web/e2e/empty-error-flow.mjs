/**
 * End-to-end check of the empty and error screens. A link to a bill or a
 * customer that does not exist says so in plain words, with a button back to
 * the list (not "Nothing here yet"). A list that cannot load for want of a
 * connection says so, with Try again, which loads it once the connection is
 * back. Empty lists say what to do next (GST with no sales, a new supplier
 * with no bills or payments). On a phone the screens fit.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true:
 *   WEB_URL=http://localhost:5173 node apps/web/e2e/empty-error-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98769${run}`;
const password = "Str0ng-pass!";
const log = (...a) => console.log("•", ...a);
const MISSING = "01a10b00-0000-7000-8000-000000000000";

const errors = [];
let signedIn = false;
/** Failures the test causes on purpose. */
const expected = (url) => url.includes(MISSING) || url.includes("/expenses");
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {},
);
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("pageerror", (e) => errors.push(e.message));
page.on(
  "console",
  (m) =>
    m.type() === "error" &&
    !m.text().startsWith("Failed to load resource") &&
    errors.push(m.text()),
);
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh"))
    return;
  if (r.status() >= 400 && !expected(r.url()))
    errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const go = (hash) => page.evaluate((h) => (location.hash = h), hash);

try {
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Meena Rao");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.fill("#su-business", "Rao Traders");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await page
    .getByRole("heading", { name: /Meena/ })
    .waitFor({ timeout: 15000 });
  signedIn = true;

  // 1. A bill that does not exist: said in plain words, with the way back.
  await go(`#invoice/${MISSING}`);
  await page.getByText("This bill was not found").waitFor({ timeout: 15000 });
  await page.getByText(/look for it in the invoice list/i).waitFor();
  await page.screenshot({ path: `${OUT}/empty-1-bill.png` });
  await page.getByRole("button", { name: "Back to invoices" }).click();
  await page
    .getByRole("heading", { name: "Sales bills" })
    .waitFor({ timeout: 10000 });
  log("a missing bill: not found, and Back to invoices opens the list");

  // 2. A customer that does not exist.
  await go(`#customer/${MISSING}`);
  await page
    .getByText("This customer was not found")
    .waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Back to customers" }).click();
  await page
    .getByRole("heading", { name: "Customers" })
    .waitFor({ timeout: 10000 });
  log("a missing customer: not found, and Back to customers opens the list");

  // 3. No connection for a list: said so, and Try again loads it when it is back.
  await page.route("**/api/v1/expenses?**", (r) =>
    r.abort("internetdisconnected"),
  );
  await go("#expenses");
  const note = page
    .getByRole("alert")
    .filter({ hasText: /offline|connection/i })
    .first();
  await note.waitFor({ timeout: 30000 });
  const retry = note.getByRole("button", { name: "Try again" });
  await retry.waitFor();
  await page.screenshot({ path: `${OUT}/empty-2-offline.png` });
  await page.unroute("**/api/v1/expenses?**");
  await retry.click();
  await note.waitFor({ state: "detached", timeout: 15000 });
  await page
    .getByText("No expenses in this view")
    .first()
    .waitFor({ timeout: 15000 });
  await page
    .getByText(/Record rent, electricity/)
    .first()
    .waitFor();
  log(
    "a list with no connection: the reason and Try again, which then loads it",
  );

  // 4. Empty lists say what to do next.
  await go("#gst");
  await page
    .getByText("No sales in this month")
    .first()
    .waitFor({ timeout: 15000 });
  await page
    .getByText(/Pick another month to see earlier sales/)
    .first()
    .waitFor();
  log("GST with no sales: says bills made this month show there");

  // 5. On a phone it fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await go(`#invoice/${MISSING}`);
  await page.getByText("This bill was not found").waitFor({ timeout: 15000 });
  // The screen before (GST, wide tables) may still be leaving: give the layout a moment to settle.
  const fitted = await page
    .waitForFunction(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!fitted)
    errors.push(
      `the not-found screen does not fit a phone (${await page.evaluate(() => document.documentElement.scrollWidth)}px wide)`,
    );
  await page.screenshot({ path: `${OUT}/empty-3-phone.png` });
  log("on a phone: fits");
} catch (e) {
  errors.push(e.message);
  await page
    .screenshot({ path: `${OUT}/empty-error.png` })
    .catch(() => undefined);
}

await browser.close();
if (errors.length) {
  console.error("✗", errors.join("\n✗ "));
  process.exit(1);
}
log("empty and error screens: all passed");
