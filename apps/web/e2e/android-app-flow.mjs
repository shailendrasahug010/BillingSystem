/**
 * End-to-end check of the Android app's side of the web app (Phase 5.4),
 * without a phone: the production build served at https://localhost (where
 * Capacitor serves the app's pages) with a stand-in for Capacitor's Android
 * bridge and the app's plugins, and the API at its own https address (a TLS
 * proxy in front of the API), so CORS is the real one.
 *
 * The first start asks for the server (an http address is refused) -> sign
 * in: the refresh token goes to the phone's secure store, not a cookie, and
 * the phone registers for push (the server counts it) -> a restart signs in
 * from the stored token -> the back button closes a dialog, then goes back a
 * screen -> a paired Bluetooth printer prints a test page (the bytes reach
 * the printer plugin) -> the phone's scanner adds a product to a bill -> a
 * bill prints through Android's printing and its PDF goes to the share sheet
 * -> a tapped notification opens its bill -> signing out removes the push
 * token and the stored sign-in.
 *
 * Run against a database with the API started with OTP_DEV_ECHO=true and the
 * web app built (pnpm build); needs ports 443 and 8443:
 *   API_URL=http://localhost:3000 node apps/web/e2e/android-app-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API_BASE = process.env.API_URL ?? "http://localhost:3000";
const API = `${API_BASE}/api/v1`;
const DIST = new URL("../dist/", import.meta.url).pathname;
const OUT = process.env.OUT ?? ".";
const run = String(Date.now()).slice(-5);
const mobile = process.env.E2E_MOBILE ?? `98761${run}`;
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

// --- https://localhost (the app's pages) and https://localhost:8443 (the business's server). ---
if (!existsSync(join(DIST, "index.html"))) throw new Error("build the web app first (pnpm build)");
const certDir = mkdtempSync(join(tmpdir(), "app-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
const tls = { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const pages = createServer(tls, (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "https://localhost").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
const server = createServer(tls, (req, res) => {
  const upstream = httpRequest(`${API_BASE}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(API_BASE).host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
});
await new Promise((r) => pages.listen(443, r));
await new Promise((r) => server.listen(8443, r));

const errors = [];

// 1. The owner and a soap with its barcode; a bill to open from a notification.
const otp = await api("POST", "/auth/otp", null, { mobile, purpose: "signup" });
await api("POST", "/auth/signup", null, { name: "Ramesh Agrawal", mobile, password, otp: otp.devCode, preferredLocale: "en", business: { legalName: "Agrawal Distributors", stateCode: "23", city: "Indore" } });
const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "35", openingStock: "500", barcodes: ["8901030865275"] });
const gupta = await api("POST", "/customers", token, { name: "Gupta Kirana", mobile: "9826022222", city: "Dewas", stateCode: "23" });
const bill = await api("POST", "/invoices", token, { customerId: gupta.id, lines: [{ productId: soap.id, qty: "12" }] });

// 2. The phone: Capacitor's Android bridge and the app's plugins, standing in.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
await phone.addInitScript(() => {
  const calls = (window.__native = []);
  const store = JSON.parse(sessionStorage.getItem("fake-secure-store") ?? "{}");
  const listeners = {};
  let next = 1;
  const emit = (plugin, event, data) => (listeners[`${plugin}:${event}`] ?? []).forEach((cb) => cb(data));
  window.__emit = emit;
  window.__secure = store;
  const plugins = {
    SecureStore: {
      get: ({ key }) => ({ value: store[key] ?? null }),
      set: ({ key, value }) => {
        store[key] = value;
        sessionStorage.setItem("fake-secure-store", JSON.stringify(store));
      },
      remove: ({ key }) => {
        delete store[key];
        sessionStorage.setItem("fake-secure-store", JSON.stringify(store));
      },
    },
    BahiApp: { config: () => ({ push: true, version: "1.0" }) },
    PushNotifications: {
      checkPermissions: () => ({ receive: "granted" }),
      requestPermissions: () => ({ receive: "granted" }),
      createChannel: () => undefined,
      register: () => setTimeout(() => emit("PushNotifications", "registration", { value: "fake-fcm-registration-token-0123456789" }), 50),
      unregister: () => undefined,
      removeAllListeners: () => Object.keys(listeners).filter((k) => k.startsWith("PushNotifications:")).forEach((k) => delete listeners[k]),
    },
    ThermalPrinter: { list: () => ({ devices: [{ name: "RPP02N", address: "00:11:22:33:44:55" }] }), print: () => undefined },
    BarcodeScanner: { scan: () => ({ barcodes: [{ rawValue: "8901030865275", format: "EAN_13" }] }) },
    Filesystem: { writeFile: ({ path }) => ({ uri: `file:///data/cache/${path}` }) },
    Share: { share: () => undefined },
    WebPrint: { print: () => undefined },
    App: { exitApp: () => undefined },
  };
  const header = (name, methods) => ({ name, methods: [...methods.map((m) => ({ name: m, rtype: "promise" })), { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "promise" }, { name: "removeAllListeners", rtype: "promise" }] });
  window.androidBridge = { postMessage() {} };
  window.Capacitor = {
    PluginHeaders: Object.entries(plugins).map(([name, impl]) => header(name, Object.keys(impl))),
    nativePromise: async (plugin, method, options) => {
      calls.push({ plugin, method, options });
      const fn = plugins[plugin]?.[method];
      if (fn) return fn(options ?? {});
      if (method === "removeAllListeners" || method === "removeListener") return undefined;
      throw new Error(`${plugin}.${method} is not in the stand-in`);
    },
    nativeCallback: (plugin, method, options, callback) => {
      calls.push({ plugin, method, options });
      if (method === "addListener") (listeners[`${plugin}:${options.eventName}`] ??= []).push(callback);
      return String(next++);
    },
  };
});
const page = await phone.newPage();
const state = { signedIn: false };
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("response", (r) => {
  if (r.status() === 401 && r.url().endsWith("/auth/refresh") && !state.signedIn) return;
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const native = (plugin, method) => page.evaluate(([p, m]) => window.__native.filter((c) => c.plugin === p && c.method === m), [plugin, method]);

// A step that fails leaves a picture of the screen.
process.on("uncaughtException", async (e) => {
  await page.screenshot({ path: `${OUT}/android-failure.png` }).catch(() => undefined);
  console.error(e);
  process.exit(1);
});

// 3. First start: the server's address (https only), then sign in.
await page.goto("https://localhost/");
await page.getByRole("heading", { name: "Connect to your Digital Bahi" }).waitFor({ timeout: 20000 });
await page.fill("#server-address", "http://localhost:8443");
await page.getByRole("button", { name: "Connect" }).click();
await page.getByText("The address must start with https:// (a secure server).").waitFor();
await page.fill("#server-address", "localhost:8443");
await page.getByRole("button", { name: "Connect" }).click();
await page.getByText("localhost:8443").waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/android-1-server.png` });
await page.fill("#auth-id", mobile);
await page.fill("#auth-password", password);
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.getByRole("heading").first().waitFor({ timeout: 20000 });
state.signedIn = true;
await page.waitForTimeout(1500);
const stored = await page.evaluate(() => window.__secure.refreshToken ?? null);
if (!stored || stored.length < 20) errors.push("the refresh token is not in the secure store");
const cookies = await phone.cookies("https://localhost:8443");
if (cookies.some((c) => c.name === "db_rt")) errors.push("a refresh cookie was set for the app");
const pushed = await api("POST", "/push/test", (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken, {});
if (pushed.phones < 1) errors.push(`push: the server knows ${pushed.phones} phones`);
log(`server chosen (https only); signed in, the refresh token in the secure store, no cookie; push registered (${pushed.phones} phone)`);

// 4. A restart signs in from the stored token.
await page.reload();
await page.getByRole("heading").first().waitFor({ timeout: 20000 });
if (await page.getByRole("button", { name: "Sign in", exact: true }).count()) errors.push("the restart asked to sign in again");
log("restart: signed in from the stored token");

// 5. The back button: closes a dialog, then goes back a screen.
const back = () => page.evaluate(() => window.__emit("App", "backButton", { canGoBack: false }));
await page.goto("https://localhost/#customers");
await page.getByRole("heading", { name: "Customers", exact: true }).first().waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "More", exact: true }).first().click();
await page.getByRole("dialog").waitFor();
await back();
await page.getByRole("dialog").waitFor({ state: "detached" });
await page.getByRole("dialog").getByRole("navigation", { name: "Main" }).waitFor({ state: "detached" }).catch(() => undefined);
await page.goto("https://localhost/#outstanding");
await page.getByRole("heading", { name: "Outstanding", exact: true }).waitFor({ timeout: 15000 });
await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Customers" }).click();
await page.getByRole("heading", { name: "Customers", exact: true }).first().waitFor();
await back();
await page.getByRole("heading", { name: "Outstanding", exact: true }).waitFor({ timeout: 15000 });
log("back button: closed the menu, then went back from Customers to Outstanding");

// 6. A printer paired with the phone: a test page.
await page.goto("https://localhost/#settings");
await page.getByText("Printers paired with this phone").waitFor({ timeout: 15000 });
await page.getByRole("button", { name: /RPP02N/ }).click();
await page.getByRole("button", { name: "Print a test page" }).click();
await page.getByText("Sent to the printer").first().waitFor({ timeout: 15000 });
const prints = await native("ThermalPrinter", "print");
const bytes = prints.length ? Buffer.from(prints[0].options.data, "base64") : Buffer.alloc(0);
const raster = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
if (prints[0]?.options.address !== "00:11:22:33:44:55" || raster < 0 || bytes[raster + 4] !== 48) errors.push(`printer: ${prints.length} prints, raster at ${raster}`);
log(`paired printer RPP02N: a test page of ${bytes.length} bytes (ESC/POS raster, 384 dots)`);

// 7. The phone's scanner on the bill screen.
await page.goto("https://localhost/#invoice");
const customerBox = page.getByPlaceholder("Search customer by name, mobile, GSTIN or code");
await customerBox.waitFor({ timeout: 20000 });
await customerBox.fill("Gupta");
await page.keyboard.press("Enter");
await page.getByRole("button", { name: "Scan", exact: true }).first().click();
await page.getByRole("dialog").getByRole("button", { name: "Scan with the camera" }).click();
await page.getByRole("dialog").getByText("Added: Lux Soap 100g").waitFor({ timeout: 15000 });
if ((await native("BarcodeScanner", "scan")).length !== 1) errors.push("the phone's scanner was not used");
await page.keyboard.press("Escape");
log("scanner: the phone's ML Kit scanner added the soap");

// 8. A bill: printed through Android, its PDF to the share sheet.
await page.evaluate(() => window.__emit("PushNotifications", "pushNotificationActionPerformed", { actionId: "tap", notification: { data: {} } }));
await page.goto("https://localhost/#outstanding");
await page.locator("ul li button:visible").filter({ hasText: "Gupta Kirana" }).click();
await page.getByRole("dialog").getByRole("button", { name: new RegExp(bill.invoiceNumber.replace(/\//g, "\\/")) }).first().click();
await page.getByRole("heading", { name: new RegExp(bill.invoiceNumber.replace(/\//g, "\\/")) }).first().waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "Print / PDF" }).click();
await page.waitForTimeout(300);
if ((await native("WebPrint", "print")).length !== 1) errors.push("printing did not go through Android");
await page.getByRole("button", { name: "Download PDF" }).click();
await page.waitForTimeout(1500);
const written = await native("Filesystem", "writeFile");
const shared = await native("Share", "share");
if (!written.some((w) => w.options.path.endsWith(".pdf")) || !shared.some((s) => s.options.files?.[0]?.endsWith(".pdf"))) errors.push(`share sheet: ${JSON.stringify({ written: written.map((w) => w.options.path), shared: shared.map((s) => s.options.files) })}`);
log("bill: printed through Android's printing; the PDF went to the share sheet");

// 9. A tapped notification opens its bill.
await page.goto("https://localhost/#dashboard");
await page.waitForTimeout(500);
await page.evaluate((id) => window.__emit("PushNotifications", "pushNotificationActionPerformed", { actionId: "tap", notification: { data: { type: "invoice_held", entityType: "invoice", entityId: id } } }), bill.id);
await page.getByRole("heading", { name: new RegExp(bill.invoiceNumber.replace(/\//g, "\\/")) }).first().waitFor({ timeout: 15000 });
log("notification tapped: its bill opened");

// 10. Signing out: no more pushes to this phone, the stored sign-in gone.
await page.getByRole("button", { name: "More", exact: true }).first().click();
await page.getByRole("button", { name: "Sign out" }).last().click();
await page.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 15000 });
state.signedIn = false;
if (await page.evaluate(() => window.__secure.refreshToken ?? null)) errors.push("the stored sign-in stayed after signing out");
const after = await api("POST", "/push/test", (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken, {});
if (after.phones !== 0) errors.push(`after sign-out the server still knows ${after.phones} phones`);
await page.screenshot({ path: `${OUT}/android-2-signed-out.png` });
log("signed out: the push token removed, the stored sign-in deleted");

await browser.close();
// The proxy's open streams (the notification stream) would keep the servers up.
for (const s of [pages, server]) {
  s.closeAllConnections();
  s.close();
}
if (errors.length) {
  console.error("✗ errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("no errors");
process.exit(0);
