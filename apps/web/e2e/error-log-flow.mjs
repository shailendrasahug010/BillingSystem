/**
 * End-to-end check of the error log: sign up -> a report whose data comes back
 * broken makes that screen crash: it says so with a reference, the menu stays
 * usable, and the API's error log has the error in plain words at its source
 * file and line (mapped from the build, or by the development server), with
 * the screen, the browser and who it was -> a server failure shows its
 * reference under the message -> the errors summary lists the place.
 *
 * Run against the API (OTP_DEV_ECHO=true) with its error log in LOG_DIR, and
 * the web app either from the dev server or from the production build:
 *   LOG_DIR=apps/api/logs API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/error-log-flow.mjs
 *   (production build: pnpm --filter @digitalbahi/web build && (cd apps/web && npx vite preview --port 4173); WEB_URL=http://localhost:4173)
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const LOG_DIR = resolve(process.env.LOG_DIR ?? join(here, "../../api/logs"));
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98757${String(Date.now()).slice(-5)}`;
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
let signedIn = false;
page.on("response", (r) => {
  if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
  // The failures below are made on purpose.
  if (r.status() >= 400 && !r.url().includes("/reports/sales")) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();

/** The block of the error log with this reference (waits for it to be written). */
async function logBlock(reference) {
  for (let i = 0; i < 40; i++) {
    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(LOG_DIR, `errors-${day}.log`), "utf8").catch(() => "");
    const block = text.split(/━{78}\n/).find((b) => b.includes(`reference ${reference}`));
    if (block) return block;
    await page.waitForTimeout(250);
  }
  return null;
}

// 1. Sign up.
await page.goto(WEB);
await page.getByRole("button", { name: "Create account" }).click();
await page.fill("#su-name", "Anil Sharma");
await page.fill("#su-mobile", mobile);
await page.fill("#su-password", "Str0ng-pass!");
await page.fill("#su-business", "Sharma Traders");
await page.getByRole("button", { name: "Send OTP" }).click();
const hint = page.getByText(/Development code: \d{6}/);
await hint.waitFor();
await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
await page.getByRole("button", { name: "Verify and create account" }).click();
await page.getByRole("heading", { name: /Anil/ }).waitFor({ timeout: 15000 });
signedIn = true;
log("signed up");

// 2. The sales report's data comes back broken: the screen crashes and says so.
await page.route("**/api/v1/reports/sales?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: "broken", totals: {} }) }));
await nav("Business Reports");
// Reports open on Insights: the Sales tab loads the broken report.
await page.getByRole("tab", { name: "Sales", exact: true }).click();
await page.getByText("This screen stopped working").waitFor({ timeout: 15000 });
const reference = (await page.getByText(/^Reference: [0-9a-f-]{36}$/).textContent()).replace("Reference: ", "");
await page.screenshot({ path: `${OUT}/error-log-1-crash.png` });
// The menu still works.
await nav("Customers");
await page.getByRole("heading", { name: "Customers" }).first().waitFor();
log("the report screen crashed with reference", reference, "; the menu still works");

// 3. In the error log: what happened, where (source file and line), the screen, the browser, who.
const block = await logBlock(reference);
if (!block) errors.push(`no error log entry for ${reference} in ${LOG_DIR}`);
else {
  console.log(block.trim().split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
  if (!block.includes("ERROR in the app (browser)")) errors.push("not written as a browser error");
  if (!/What happened : .*is not a function {2}\(TypeError while showing a screen\)/.test(block)) errors.push("what happened is not in plain words");
  if (!/Where {9}: apps\/web\/src\/features\/reports\/ReportsPage\.tsx {2}line \d+, column \d+/.test(block)) errors.push("the source file and line are not shown");
  if (!block.includes("Screen        : reports")) errors.push("the screen is not shown");
  if (!/Browser {7}: Chrome \d+ on Linux {2}· {2}app build \S+/.test(block)) errors.push("the browser and build are not shown");
  if (!block.includes("Who           : Anil Sharma")) errors.push("who it was is not shown");
  if (!/components {2}: .*GroupedReport/.test(block)) errors.push("the components are not listed");
}

// 4. A server failure shows its reference under the message.
await page.unroute("**/api/v1/reports/sales?**");
await page.route("**/api/v1/reports/sales?**", (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", requestId: "01926b3e-1111-7222-8333-944455556666" } }) }),
);
// (A reload clears the broken report kept from before.)
await page.reload();
await page.getByRole("heading", { name: "Customers" }).first().waitFor({ timeout: 15000 });
await nav("Business Reports");
await page.getByRole("tab", { name: "Sales", exact: true }).click();
await page.getByText("Reference: 01926b3e-1111-7222-8333-944455556666 — quote it if this keeps happening.").waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/error-log-2-server.png` });
log("a server failure shows its reference");

// 5. The summary lists the place.
const summary = execFileSync("npx", ["tsx", "src/errors.ts", "--days", "1"], { cwd: join(here, "../../api"), env: { ...process.env, LOG_DIR }, encoding: "utf8" });
if (!/apps\/web\/src\/features\/reports\/ReportsPage\.tsx:\d+/.test(summary)) errors.push(`summary lacks the place:\n${summary}`);
log("summary:", summary.split("\n").find((l) => l.includes("ReportsPage.tsx"))?.trim());

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
