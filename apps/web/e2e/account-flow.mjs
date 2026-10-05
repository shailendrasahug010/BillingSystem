/**
 * The account journey, on a phone and on the computer: clear messages on an
 * empty or wrong sign-in, the 6-box code that sends itself, the resend
 * countdown and Change number, forgot password, two-step sign-up with the
 * password strength bar, the welcome card, the account menu and My profile
 * (name, email, password), and a sign-out that asks first and says goodbye,
 * then greets the person by name.
 *
 * Run with the API started with OTP_DEV_ECHO=true:
 *   API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node apps/web/e2e/account-flow.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? ".";
const mobile = `97642${String(Date.now()).slice(-5)}`;
const password = "Str0ng-pass!";
const newPassword = "N3w-Str0ng-pass!";
const log = (...a) => console.log("•", ...a);
const errors = [];
const check = (ok, what) => ok || errors.push(what);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
function watch(page) {
  page.on("pageerror", (e) => errors.push(e.message));
}
const devCode = async (page) => (await page.getByText(/Development code: \d{6}/).textContent()).match(/\d{6}/)[0];

try {
  // 1-7 on a phone: sign-in messages, OTP screens, forgot password, two-step sign-up.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch(page);
  await page.goto(WEB);
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();

  // 1. An empty sign-in says what to fill, at the box.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Enter your mobile number, email or user ID").waitFor();
  check((await page.locator("#auth-id").getAttribute("aria-invalid")) === "true", "empty sign-in: the box is not marked");
  check(!(await page.getByText(/^identifier$/).count()), "empty sign-in: the raw word 'identifier' is shown");
  log("empty sign-in: a real message at the box");

  // 2. A wrong password offers a reset and a code.
  await page.fill("#auth-id", "9000000001");
  await page.fill("#auth-password", "wrongpass1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Forgot it? Get a code on your mobile instead.").waitFor();
  await page.screenshot({ path: `${OUT}/account-1-wrong-password.png` });
  await page.getByRole("alert").getByRole("button", { name: "Reset password" }).click();

  // 5. Forgot password: the number came along, and the words fit.
  await page.getByRole("heading", { name: "Reset password" }).waitFor();
  await page.getByText("We'll send a 6-digit code to your mobile number.").waitFor();
  check((await page.inputValue("#auth-mobile")) === "9000000001", "reset: the number typed at sign-in was not carried over");
  check(!(await page.getByText("Sign in to manage billing").count()), "reset: still says 'Sign in to manage billing'");
  log("wrong password: reset in one tap, with the number filled");
  await page.getByRole("button", { name: "Back to sign in" }).click();

  // 6-7. Sign-up in two steps, with the strength bar.
  await page.getByRole("button", { name: "Create account" }).click();
  check((await page.locator("[data-signup-step]").getAttribute("data-signup-step")) === "1", "sign-up: step 1 not shown");
  await page.fill("#su-name", "Sunita Verma");
  await page.fill("#su-mobile", mobile);
  await page.fill("#su-password", "abcdefgh");
  check((await page.locator("[data-password-strength]").getAttribute("data-password-strength")) === "1", "strength: 'abcdefgh' not weak");
  await page.fill("#su-password", password);
  await page.getByText("Password strength: Strong").waitFor();
  await page.screenshot({ path: `${OUT}/account-2-signup-you.png`, fullPage: true });
  check(!(await page.locator("#su-business").count()), "sign-up: business fields on the first step");
  await page.getByRole("button", { name: "Next" }).click();
  await page.locator("#su-business").waitFor();
  check((await page.locator("[data-signup-step]").getAttribute("data-signup-step")) === "2", "sign-up: step 2 not shown");
  // Back keeps what was typed.
  await page.getByRole("button", { name: "Back" }).click();
  check((await page.inputValue("#su-name")) === "Sunita Verma", "sign-up: Back lost the name");
  await page.getByRole("button", { name: "Next" }).click();
  await page.fill("#su-business", "Verma Agencies");
  await page.screenshot({ path: `${OUT}/account-3-signup-business.png`, fullPage: true });
  await page.getByRole("button", { name: "Send OTP" }).click();

  // 3-4. Six boxes, the masked number, Change number and the resend countdown.
  await page.getByText(/Development code: \d{6}/).waitFor();
  check((await page.locator("[data-signup-step]").getAttribute("data-signup-step")) === "3", "sign-up: verify step not shown");
  check((await page.getByRole("textbox", { name: /Digit \d of 6/ }).count()) === 6, "OTP: not six boxes");
  await page.getByText(`Code sent to ${mobile.slice(0, 2)}••••${mobile.slice(-4)}`).waitFor();
  await page.getByRole("button", { name: /Resend code in \d+s/ }).waitFor();
  check(await page.getByRole("button", { name: /Resend code in/ }).isDisabled(), "OTP: resend not waiting");
  await page.screenshot({ path: `${OUT}/account-4-otp.png`, fullPage: true });
  await page.getByRole("button", { name: "Change number" }).click();
  await page.locator("#su-mobile").waitFor();
  check((await page.inputValue("#su-mobile")) === mobile, "Change number: the number was lost");
  log("code step: six boxes, masked number, resend countdown, change number");
  // Typing digit by digit moves along and sends itself at the sixth.
  await page.getByRole("button", { name: "Next" }).click();
  // The same number again: the server's wait shows on the button, which counts down.
  await page.getByRole("button", { name: /Resend code in \d+s/ }).waitFor();
  await page.getByRole("button", { name: "Send OTP" }).click({ timeout: 40_000 });
  await page.getByText(/Development code: \d{6}/).waitFor();
  const code = await devCode(page);
  await page.locator("#auth-otp").focus();
  await page.keyboard.type(code, { delay: 40 });

  // 9. The welcome card on the first dashboard.
  await page.getByText("Verma Agencies is ready").waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${OUT}/account-5-welcome.png` });
  log("signed up by typing the code: welcome card shown");

  // 10. The initials at the top right open the account menu.
  await page.getByRole("button", { name: "Your account" }).click();
  const menu = page.getByRole("dialog", { name: "Your account" });
  await menu.getByText("Sunita Verma").waitFor();
  await menu.getByText(/Admin · Verma Agencies/).waitFor();
  await page.screenshot({ path: `${OUT}/account-6-menu.png` });
  await menu.getByRole("button", { name: "My profile" }).click();

  // 11. My profile: name, email and password.
  await page.getByRole("heading", { name: "My profile" }).waitFor();
  await page.fill("#profile-name", "Sunita R Verma");
  await page.fill("#profile-email", `sunita.${mobile}@example.com`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Your details are saved.").waitFor();
  await page.fill("#profile-current", password);
  await page.fill("#profile-new", newPassword);
  await page.fill("#profile-again", "different-1");
  await page.getByRole("button", { name: "Change password" }).last().click();
  await page.getByText("The two passwords are different").waitFor();
  await page.fill("#profile-again", newPassword);
  await page.getByRole("button", { name: "Change password" }).last().click();
  await page.getByText("Password changed. Other devices are signed out.").waitFor();
  await page.screenshot({ path: `${OUT}/account-7-profile.png`, fullPage: true });
  log("profile: name and email saved, password changed");

  // 12. Sign out asks first, then says goodbye; 8. the sign-in screen greets by name.
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("dialog", { name: "Your account" }).getByRole("button", { name: "Sign out" }).click();
  const ask = page.getByRole("dialog", { name: "Sign out of Verma Agencies?" });
  await ask.waitFor();
  await ask.getByRole("button", { name: "Cancel" }).click();
  check(!(await page.getByRole("heading", { name: /Welcome back/ }).count()), "Cancel signed out anyway");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("dialog", { name: "Your account" }).getByRole("button", { name: "Sign out" }).click();
  await ask.getByRole("button", { name: "Sign out" }).click();
  await page.getByText("You're signed out. See you soon!").waitFor({ timeout: 15000 });
  await page.getByRole("heading", { name: "Welcome back, Sunita" }).waitFor();
  check((await page.inputValue("#auth-id")) === mobile, "sign-in: the number was not remembered");
  await page.screenshot({ path: `${OUT}/account-8-signed-out.png` });
  log("sign-out asked first, said goodbye, greets by name");

  // The new password signs in; then "Not you?" clears the remembered person.
  await page.fill("#auth-password", newPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Your account" }).waitFor({ timeout: 20000 });
  check(!(await page.getByText("Verma Agencies is ready").count()), "welcome card came back after signing out");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("dialog", { name: "Your account" }).getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: /Sign out of/ }).getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Not you?" }).click();
  await page.getByRole("heading", { name: "Welcome back", exact: true }).waitFor();
  check((await page.inputValue("#auth-id")) === "", "Not you?: the number stayed");
  log("new password signs in; Not you? clears the remembered person");
  await page.close();

  // The computer: the menu sits at the top right, next to New Invoice.
  const desk = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  watch(desk);
  await desk.goto(WEB);
  await desk.fill("#auth-id", mobile);
  await desk.fill("#auth-password", newPassword);
  await desk.getByRole("button", { name: "Sign in", exact: true }).click();
  await desk.getByRole("button", { name: "Your account" }).click();
  await desk.getByRole("dialog", { name: "Your account" }).getByText("Sunita R Verma").waitFor();
  await desk.screenshot({ path: `${OUT}/account-9-menu-desk.png` });
  log("desktop account menu shown");
  await desk.close();
} catch (e) {
  errors.push(String(e?.stack ?? e));
}
await browser.close();
console.log("page errors:", errors.length ? errors : "none");
if (errors.length) process.exit(1);
