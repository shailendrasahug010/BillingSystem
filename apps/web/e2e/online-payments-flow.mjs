/**
 * End-to-end check of online payments. Without a gateway, "Ask to pay" on a
 * bill shows the firm's own UPI QR code and a way to record the payment.
 * Settings → Online payments: Razorpay's test keys saved (secrets hidden),
 * the keys tested, the webhook address shown. "Ask to pay" then makes a
 * payment link: a QR code and a link to send, waiting for the payment. The
 * gateway reports the payment (a signed webhook): the dialog turns to Paid,
 * the receipt is recorded against the bill and listed under Payments →
 * Online. The shop pays its next bill online from its order link.
 *
 * The API must use the stand-in gateway (PAYMENT_GATEWAY_DRIVER=fake, the
 * default outside production): links are made by the API itself, nothing is
 * charged. Run against a database with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/online-payments-flow.mjs
 * Needs the `playwright` package (PLAYWRIGHT_PATH if it is not resolvable
 * from here) and a Chromium (CHROMIUM_PATH optional).
 */
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const API = (process.env.API_URL ?? "http://localhost:3000") + "/api/v1";
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = process.env.E2E_MOBILE ?? `98763${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const webhookSecret = "e2e-razorpay-webhook-secret";
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
let signedIn = false;
const watch = (p, who) => {
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`${who}: ${m.text()}`));
  p.on("response", (r) => {
    if (!signedIn && r.status() === 401 && r.url().endsWith("/auth/refresh")) return;
    if (r.status() >= 400) errors.push(`${who}: ${r.status()} ${r.request().method()} ${r.url()}`);
  });
};
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await desk.newPage();
watch(page, "owner");
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const shopPage = await phone.newPage();
watch(shopPage, "shop");
const toast = (p, text) => p.getByText(text).first().waitFor({ timeout: 15000 });
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const open = async (hash) => {
  await page.goto(`${WEB}/${hash}`);
  await page.reload();
};

try {
  // 1. Sign up; a shop with a bill of ₹1,180; the firm's UPI ID on its bills.
  await page.goto(WEB);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.fill("#su-name", "Suresh Jain");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Jain Agencies");
  await page.getByRole("button", { name: "Send OTP" }).click();
  const hint = page.getByText(/Development code: \d{6}/);
  await hint.waitFor();
  await page.fill("#auth-otp", (await hint.textContent()).match(/\d{6}/)[0]);
  await page.getByRole("heading", { name: /, Suresh/ }).waitFor({ timeout: 15000 });
  signedIn = true;
  const token = (await api("POST", "/auth/login", null, { identifier: mobile, password })).accessToken;
  const units = Object.fromEntries((await api("GET", "/units", token)).data.map((u) => [u.symbol, u.id]));
  const taxes = Object.fromEntries((await api("GET", "/tax-categories", token)).data.map((c) => [c.name, c.id]));
  const soap = await api("POST", "/products", token, { name: "Lux Soap 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "200", openingStockCost: "70" });
  const shop = await api("POST", "/customers", token, { name: "Sharma Kirana", mobile: "9826012345", stateCode: "23" });
  const bill = await api("POST", "/invoices", token, { customerId: shop.id, lines: [{ productId: soap.id, qty: "10" }] });
  await api("PUT", "/settings/invoice.payment_details", token, { value: { bankName: "", accountNumber: "", ifsc: "", upiId: "jain.agencies@okaxis" } });
  log("signed up; Sharma Kirana owes", bill.grandTotal, "on", bill.invoiceNumber);

  // 2. No gateway yet: the firm's own UPI QR code for the bill, and recording the payment by hand.
  await open(`#invoice/${bill.id}`);
  await page.getByRole("button", { name: "Ask to pay" }).click();
  let dialog = page.getByRole("dialog", { name: "Ask Sharma Kirana to pay" });
  await dialog.getByText(`Bill ${bill.invoiceNumber}: ₹1,180.00 due`).waitFor({ timeout: 15000 });
  await dialog.getByText("Scan with any UPI app to pay ₹1,180.00 to jain.agencies@okaxis").waitFor();
  await dialog.locator("[data-pay-upi] svg").waitFor();
  await dialog.getByRole("button", { name: "Record payment" }).waitFor();
  await dialog.getByText("set up Razorpay or Cashfree").waitFor();
  await dialog.screenshot({ path: `${OUT}/online-1-upi.png` });
  await page.keyboard.press("Escape");
  log("without a gateway: the UPI QR code for ₹1,180.00 and Record payment");

  // 3. Settings → Online payments: Razorpay's test keys; secrets never shown again.
  await open("#settings");
  const card = page.locator("[data-gateway-card]");
  await card.waitFor({ timeout: 15000 });
  await card.getByText("This server makes test links itself").waitFor();
  await page.locator("#gw-provider").selectOption("razorpay");
  await page.locator("#gw-env").selectOption("test");
  await page.locator("#gw-key-id").fill("rzp_test_E2E1234567");
  await page.locator("#gw-key-secret").fill("e2e-razorpay-key-secret");
  await page.locator("#gw-webhook-secret").fill(webhookSecret);
  await card.getByRole("button", { name: "Save" }).click();
  await toast(page, "Online payments saved");
  const webhookUrl = await card.locator("[data-gateway-webhook]").inputValue();
  if (!/\/api\/v1\/webhooks\/payments\/[A-Za-z0-9_-]{24}$/.test(webhookUrl)) errors.push(`webhook address: ${webhookUrl}`);
  if ((await page.locator("#gw-key-secret").inputValue()) !== "") errors.push("key secret shown after saving");
  if ((await page.content()).includes("e2e-razorpay-key-secret") || (await page.content()).includes(webhookSecret)) errors.push("a secret is in the page");
  await card.getByRole("button", { name: "Test the keys" }).click();
  await toast(page, "Razorpay accepted the keys");
  await card.screenshot({ path: `${OUT}/online-2-settings.png` });
  log("Razorpay (test) saved and tested; webhook address", webhookUrl.replace(/[A-Za-z0-9_-]{24}$/, "…"));

  // 4. Ask to pay: a payment link as a QR code and a link to send, waiting for the payment.
  await open(`#invoice/${bill.id}`);
  await page.getByRole("button", { name: "Ask to pay" }).click();
  dialog = page.getByRole("dialog", { name: "Ask Sharma Kirana to pay" });
  const amount = dialog.locator("#pay-link-amount");
  await amount.waitFor({ timeout: 15000 });
  if ((await amount.inputValue()) !== "1180.00") errors.push(`amount asked: ${await amount.inputValue()}`);
  await dialog.getByText("Test link: nothing is charged.").waitFor();
  await dialog.getByRole("button", { name: "Make payment link" }).click();
  const url = dialog.locator("[data-pay-link-url]");
  await url.waitFor({ timeout: 15000 });
  const linkUrl = await url.inputValue();
  if (!/^https:\/\/pay\.example\.test\/razorpay\/plink_test\w+$/.test(linkUrl)) errors.push(`link: ${linkUrl}`);
  await dialog.getByRole("img", { name: "Scan to pay" }).waitFor();
  await dialog.getByText("Waiting for the payment").waitFor();
  await dialog.getByRole("button", { name: "Send on WhatsApp" }).waitFor();
  await dialog.screenshot({ path: `${OUT}/online-3-link.png` });
  log("payment link made:", linkUrl);

  // 5. The gateway reports the payment (a signed webhook): the dialog sees it, the receipt is recorded.
  const link = (await api("GET", `/payment-links?customerId=${shop.id}`, token)).data[0];
  const key = webhookUrl.split("/").at(-1);
  const raw = JSON.stringify({
    entity: "event",
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: "plink_from_gateway", reference_id: link.id, status: "paid", amount: 118000, amount_paid: 118000 } },
      payment: { entity: { id: "pay_E2E0001", amount: 118000, method: "upi", status: "captured", created_at: Math.floor(Date.now() / 1000), acquirer_data: { rrn: "428912340001" } } },
    },
  });
  const unsigned = await fetch(`${API}/webhooks/payments/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  if (unsigned.status !== 403) errors.push(`unsigned webhook answered ${unsigned.status}`);
  const signed = await fetch(`${API}/webhooks/payments/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": createHmac("sha256", webhookSecret).update(raw).digest("hex") },
    body: raw,
  });
  if (signed.status !== 200) errors.push(`signed webhook answered ${signed.status}`);
  await dialog.locator('[data-pay-link="paid"]').waitFor({ timeout: 20000 });
  await dialog.getByText("Paid ₹1,180.00").waitFor();
  await dialog.getByText(/Recorded as receipt /).waitFor();
  await toast(page, "Sharma Kirana paid ₹1,180.00 online");
  await dialog.screenshot({ path: `${OUT}/online-4-paid.png` });
  await page.keyboard.press("Escape");
  // The bill is paid: nothing left to ask for.
  await page.getByRole("button", { name: "Ask to pay" }).waitFor({ state: "detached", timeout: 15000 });
  const receipts = (await api("GET", `/payments?customerId=${shop.id}`, token)).data;
  if (receipts.length !== 1 || receipts[0].method !== "upi" || receipts[0].referenceNumber !== "428912340001") errors.push(`receipts: ${JSON.stringify(receipts)}`);
  const notes = (await api("GET", "/notifications", token)).data.filter((n) => n.type === "payment_received_online");
  if (notes.length !== 1) errors.push(`notifications: ${notes.length}`);
  log("paid by the webhook: receipt", receipts[0]?.paymentNumber, "UTR", receipts[0]?.referenceNumber);

  // 6. Payments → Online lists it as paid.
  await open("#payments");
  await page.getByRole("tab", { name: "Online" }).click();
  await page.getByRole("radio", { name: "Paid", exact: true }).click();
  const row = page.getByRole("row", { name: /Sharma Kirana/ });
  await row.waitFor({ timeout: 15000 });
  if (!(await row.innerText()).includes(bill.invoiceNumber)) errors.push(`online list row: ${await row.innerText()}`);
  await page.screenshot({ path: `${OUT}/online-5-list.png` });
  log("listed under Payments → Online as paid");

  // 7. The shop pays its next bill online from its order link.
  const next = await api("POST", "/invoices", token, { customerId: shop.id, lines: [{ productId: soap.id, qty: "2" }] });
  const orderLink = await api("POST", `/customers/${shop.id}/order-link`, token, { showsAccount: true });
  // The stand-in gateway's page.
  await shopPage.route("https://pay.example.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Test gateway</title><h1>Test gateway page</h1>" }));
  await shopPage.goto(`${WEB}/#shop/${orderLink.key}`);
  await shopPage.locator("[data-shop-account]").waitFor({ timeout: 15000 });
  const payBill = shopPage.locator(`[data-pay-bill="${next.invoiceNumber}"]`);
  await payBill.waitFor();
  await shopPage.locator("[data-pay-online]").waitFor();
  if (!(await fits(shopPage))) errors.push("the shop page scrolls sideways on a phone");
  await shopPage.screenshot({ path: `${OUT}/online-6-shop.png`, fullPage: true });
  await payBill.click();
  await shopPage.waitForURL(/^https:\/\/pay\.example\.test\/razorpay\//, { timeout: 15000 });
  await shopPage.getByRole("heading", { name: "Test gateway page" }).waitFor();
  const shopLinks = (await api("GET", `/payment-links?customerId=${shop.id}&status=open`, token)).data;
  if (!shopLinks.some((l) => l.source === "shop" && l.invoiceId === next.id && l.amount === "236.00")) errors.push(`shop link: ${JSON.stringify(shopLinks)}`);
  log("the shop opened the gateway's page for", next.invoiceNumber, "(₹236.00)");
} catch (e) {
  errors.push(`flow stopped: ${e.message}`);
  await page.screenshot({ path: `${OUT}/online-failed.png` }).catch(() => {});
}

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
