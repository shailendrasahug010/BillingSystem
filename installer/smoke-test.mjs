#!/usr/bin/env node
/**
 * Checks a Digital Bahi started by the launcher, as its first user would use
 * it: the app loads, a business signs up with the code shown on screen,
 * signs in with its password, adds a product and a customer, makes a bill
 * and downloads its PDF. Used by .github/workflows/installer.yml.
 *
 *   node installer/smoke-test.mjs [http://localhost:8710]
 *
 * Without an address it reads the port from the data folder's config.json
 * (DIGITALBAHI_HOME, or the default for this system).
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultAddress() {
  const home =
    process.env.DIGITALBAHI_HOME ??
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "DigitalBahi")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "DigitalBahi")
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "digitalbahi"));
  return `http://localhost:${JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).apiPort}`;
}

const BASE = process.argv[2] ?? defaultAddress();
const API = `${BASE}/api/v1`;
const ok = (msg) => console.log(`  ok  ${msg}`);

async function call(method, url, { token, body } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return { data, type };
}

const home = await fetch(`${BASE}/`);
const html = await home.text();
if (!home.ok || !html.includes("<div id=\"root\"")) throw new Error(`the app did not load at ${BASE}/ (${home.status})`);
const screen = await fetch(`${BASE}/invoices/new`);
if (!screen.ok || !(await screen.text()).includes("<div id=\"root\"")) throw new Error("a screen's address did not load the app");
ok(`the app loads at ${BASE}`);

const mobile = `98${String(Date.now()).slice(-8)}`;
const password = "Str0ng-pass!";
const { data: otp } = await call("POST", "/auth/otp", { body: { mobile, purpose: "signup" } });
if (!/^\d{6}$/.test(otp.devCode ?? "")) throw new Error(`no sign-up code on screen: ${JSON.stringify(otp)}`);
await call("POST", "/auth/signup", {
  body: { name: "Smoke Test", mobile, password, otp: otp.devCode, business: { legalName: "Smoke Test Traders", stateCode: "23" } },
});
ok("signed up with the code shown on screen");

const { data: session } = await call("POST", "/auth/login", { body: { identifier: mobile, password } });
const token = session.accessToken;
ok("signed in with the password");

const units = (await call("GET", "/units", { token })).data.data;
const taxes = (await call("GET", "/tax-categories", { token })).data.data;
const { data: product } = await call("POST", "/products", {
  token,
  body: { name: "Tata Tea 250g", taxCategoryId: taxes.find((t) => t.name === "GST 5%").id, baseUnitId: units.find((u) => u.symbol === "PCS").id, sellingPrice: "120", openingStock: "20", openingStockCost: "100" },
});
const { data: customer } = await call("POST", "/customers", { token, body: { name: "Sharma Kirana", stateCode: "23" } });
const { data: invoice } = await call("POST", "/invoices", { token, body: { customerId: customer.id, lines: [{ productId: product.id, qty: "2" }] } });
if (invoice.grandTotal !== "252.00") throw new Error(`bill total ${invoice.grandTotal}, expected 252.00`);
ok(`bill ${invoice.invoiceNumber} for ₹${invoice.grandTotal}`);

const pdf = await call("GET", `/invoices/${invoice.id}/pdf`, { token });
if (!pdf.type.includes("application/pdf") || pdf.data.subarray(0, 5).toString() !== "%PDF-") throw new Error("the bill's PDF did not come");
ok(`the bill's PDF (${Math.round(pdf.data.length / 1024)} KB)`);

const docs = await fetch(`${BASE}/api/docs`);
if (docs.ok) throw new Error("the API documentation should be off on one computer");
console.log("smoke test passed");
