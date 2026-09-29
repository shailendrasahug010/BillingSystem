# How to run Digital Bahi

*Aapke Business ka Digital Hisab*

On a computer, on a phone, and on your own server.

Digital Bahi has two parts:

* **The server** (the API and the PostgreSQL database). It keeps all the data: bills, stock, ledgers, GST. It runs in one place: your laptop while you try it out, or a rented server with a web address once the business uses it.
* **The app** that people use. The same app runs in a browser and is **installed as an app** on Windows, Mac and Linux computers and on Android phones and iPhones. Once installed, it has its own icon and window, opens from the Start menu, taskbar, Dock or home screen, and updates itself.

So there is no separate "desktop version" or "mobile version" to build. Run the server once (section 1 or section 5), then install the app on each computer and phone (sections 3 and 4).

| I want to… | Go to |
|---|---|
| Try it on my own computer | [1. Run it on your computer](#1-run-it-on-your-computer) |
| Open it on my phone while trying it | [2. Open it on your phone over Wi-Fi](#2-open-it-on-your-phone-over-wi-fi) |
| Install the desktop app (Windows, Mac, Linux) | [3. Install the desktop app](#3-install-the-desktop-app) |
| Install the mobile app (Android, iPhone) | [4. Install the mobile app](#4-install-the-mobile-app) |
| Run it for my business, with a web address | [5. Put it on a server](#5-put-it-on-a-server) |
| Publish it on the Play Store or Microsoft Store | [6. App stores (optional)](#6-app-stores-optional) |
| Fix a problem | [7. Troubleshooting](#7-troubleshooting) |

---

## 1. Run it on your computer

This is for trying the app out or developing it. It works on Windows 10/11, macOS and Linux.

### What to install first

| Software | Version | Where to get it |
|---|---|---|
| Node.js | 22 or newer | https://nodejs.org (choose "LTS") |
| pnpm | 10 | after Node.js, run `corepack enable` in a terminal |
| PostgreSQL | 16 or newer | Windows: the installer from https://www.postgresql.org/download/windows/ · Mac: https://postgresapp.com · Linux: `sudo apt install postgresql` |
| Git | any | https://git-scm.com |

While installing PostgreSQL, set a password for the `postgres` user and remember it. The steps below use `postgres` as that password; use yours instead.

### Steps

Open a terminal (on Windows: **PowerShell**) and run:

```bash
git clone https://github.com/shailendrasahug010/BillingSystem.git
cd BillingSystem
pnpm install
```

Create the database and set it up (tables, the restricted database user the app connects as, and reference data such as GST states and units):

```bash
createdb -U postgres vyapaar_dev
```

macOS / Linux:

```bash
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/vyapaar_dev APP_DB_PASSWORD=devpass pnpm db:deploy
```

Windows PowerShell:

```powershell
$env:MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/vyapaar_dev"; $env:APP_DB_PASSWORD="devpass"; pnpm db:deploy
```

You should see `Migrations applied`, `Application role ready` and `Reference data seeded`.

Start the server (leave this terminal open):

macOS / Linux:

```bash
DATABASE_URL=postgres://vyapaar_app:devpass@localhost:5432/vyapaar_dev OTP_DEV_ECHO=true pnpm dev:api
```

Windows PowerShell:

```powershell
$env:DATABASE_URL="postgres://vyapaar_app:devpass@localhost:5432/vyapaar_dev"; $env:OTP_DEV_ECHO="true"; pnpm dev:api
```

Start the app in a **second** terminal (in the same `BillingSystem` folder):

```bash
pnpm dev:web
```

Open **http://localhost:5173** in Chrome or Edge.

### First use

1. Click **Create account**. Enter your name, mobile number, a password, the business name, state and GSTIN (optional).
2. Click **Send OTP**. On your own computer no SMS is sent: the code is shown on the screen ("Development code: 123456"). Type it in and create the account.
3. The business is created with default roles, bill number series, GST rates and a main godown. A typical first day:
   * **Products → Import** (your product list as an Excel, CSV or PDF file) or **Products → Add product**
   * **Suppliers → Add supplier**, then **Purchases → Import bill** (the supplier's bill as Excel, CSV or the PDF from their software) or **New purchase bill** to bring stock in. Items on the bill that are not in your product list can be added in one go with **Add … as new products**: name, GST, unit, rate, MRP, HSN and batch tracking are taken from the bill, you check the selling price (or set a margin %), and they go straight onto the purchase. If the bill charges a GST rate that is no longer in your list (12% on a bill from before 22 Sep 2025, for example), pick today's rate once for all of them; the purchase itself keeps the bill's GST
   * **Customers → Import** or **Add customer**. Each customer buys on a **selling price list**: a new business has **Price A** (the default: the product's selling price), **Price B** and **Price C**. Set the Price B / C rates on each product, pick the list when adding the customer (or change it on their page later), and their bills are priced from it. **Settings → Price lists** renames the lists (Retail, Wholesale…), adds more and picks the default. Businesses set up before this had lists called Retail, Wholesale and Distributor; they are now Price A, B and C (unless one had been renamed), with the same prices and customers, and customer sheets that still say Retail / Wholesale / Distributor (or just A / B / C) import onto them
   * **New Invoice** (Ctrl+I) and **Payments → Receive payment** (Alt+C)
   * **Users & Roles → Add member** for your staff: their name, mobile and role, and a **user ID and password** if they should sign in straight away (tell them the password yourself); left blank, they sign in with an OTP on their mobile. Each person sees only what their role allows

**Your firm's name, logo and details.** Open **Settings → Business profile**. Fill in the address, mobile and email, click **Save**, then **Upload logo** (a PNG, JPG or WebP file of your firm's logo; it is shrunk automatically). The preview shows how the top of your bills will look. The firm's logo, name, address, mobile, email and GSTIN are printed on every invoice, credit note, receipt, salary slip, packing slip and trip sheet, and the logo appears in the menu under the Digital Bahi logo.

`OTP_DEV_ECHO=true` (codes on screen) is only for your own computer. The server refuses to start with it in production.

---

## 2. Open it on your phone over Wi-Fi

While the app runs on your computer (section 1), a phone on the **same Wi-Fi** can open it too.

1. Stop the app terminal (Ctrl+C) and start it again so other devices can reach it:

   ```bash
   pnpm dev:web --host
   ```

   It prints two addresses, for example:

   ```
   Local:   http://localhost:5173/
   Network: http://192.168.1.20:5173/
   ```

2. On the phone, open the **Network** address in Chrome (Android) or Safari (iPhone).
3. If the phone cannot connect, allow Node.js through the computer's firewall (Windows asks the first time; choose **Private networks**), and check that both are on the same Wi-Fi.

This is for trying it out. To **install** the app on a phone, the browser needs a secure (https) address, which you get with section 5. Browsers treat only `localhost` as secure without https, so on the computer itself you can install it right away (section 3).

To try the installed app exactly as users will get it (it opens without internet and updates itself), build it and serve the built app instead of the development one:

```bash
pnpm build
pnpm preview:web
```

Then open **http://localhost:4173** and install it (section 3). The server from section 1 must be running.

---

## 3. Install the desktop app

Works in **Google Chrome** and **Microsoft Edge** on Windows 10/11, macOS and Linux.

1. Open your Digital Bahi address (http://localhost:5173 or :4173 on your own computer, or `https://your-domain` once it is on a server).
2. Install it, any one of:
   * click **Install app** at the bottom of the left menu, or
   * click the install icon (a screen with a down arrow) at the right end of the address bar, or
   * Chrome: menu **⋮ → Cast, save and share → Install page as app**; Edge: menu **⋯ → Apps → Install this site as an app**.
3. Click **Install**.

Digital Bahi now opens in its own window, without the browser's tabs and address bar:

* **Windows:** in the Start menu (search "Digital Bahi") and on the desktop; right-click it in the taskbar and choose **Pin to taskbar**. Right-clicking the taskbar icon also offers **New invoice**, **Customers** and **Products**.
* **Mac:** in Launchpad and the Applications folder (Chrome Apps); drag it to the Dock.
* **Linux:** in the applications menu.

**Printing.** Invoices, receipts, credit notes, packing slips, trip sheets and salary slips have a **Print / PDF** button (or press Ctrl+P). For a thermal or dot-matrix printer, set it as the default printer and choose its paper size in the print window once; the browser remembers it.

**PDF and Excel files.** Every report has **PDF** (with your letterhead and page numbers), **Excel** (an .xlsx workbook: real numbers and dates, totals, the heading row stays in view) and **CSV**. Invoices, credit / debit notes and receipts have **Download PDF**: a proper A4 file made on the server with your logo, GST table, tax summary and amount in words, in English or Hindi (the language switch next to it). Packing slips, trip sheets and salary slips are saved as PDF from **Print / PDF** (choose "Save as PDF" in the print window).

**Keyboard.** Ctrl+I new invoice, Alt+P purchase bill, Alt+O sales order, Alt+C receive payment, Ctrl+K search. On the invoice: F3 customer, F2 product search, Alt+1…9 add a suggestion, Ctrl+Enter save. A whole bill goes in without the mouse: type the product, **Enter** (the cursor goes to its quantity), type the quantity, **Enter** (to the rate), change it or not, **Enter** (back to product search) for the next item; **Tab** also goes round quantity → rate → Disc % and back to the search; they work on any screen 768 px or wider (a small laptop or a tablet with a keyboard as well). On many laptops the F-keys control brightness and volume unless **Fn** is held (or Fn-Lock is on). A shop that is not a customer yet can be added from the invoice's customer search: type its name or mobile number and choose **Add “…” as a new customer**. The keyboard icon at the bottom of the left menu lists every shortcut.

**Updates.** New versions download by themselves. When one is ready, a line at the top says **A new version of Digital Bahi is ready · Reload now**. Click it when you are not in the middle of a bill (nothing changes until you do).

**Uninstall.** Open the app, then the menu at the top right of its window (**⋮** or **⋯**) → **Uninstall Digital Bahi**. Your data is on the server and is not affected.

---

## 4. Install the mobile app

The phone needs the **https** address of your server (section 5).

### Android (Chrome)

1. Open `https://your-domain` in **Chrome**.
2. Tap **Install** when Chrome offers it, or tap the menu **⋮ → Install app** (on some phones **Add to Home screen → Install**). Inside the app, **More → Install app** does the same.
3. Digital Bahi appears on the home screen and in the app drawer, and opens full screen like any other app. Long-press the icon for **New invoice**, **Customers** and **Products**.

### iPhone and iPad (Safari)

1. Open `https://your-domain` in **Safari**.
2. Tap the **Share** button (the square with an up arrow) → **Add to Home Screen** → **Add**.
3. Open Digital Bahi from the home screen. It runs full screen, without Safari's bars.

### On the phone

* The bottom bar has **Home, Customers, + (create), Products, More**; everything else is under **More**.
* Barcode entry works with a Bluetooth scanner, which types like a keyboard.
* **Send** on an invoice, note or receipt sends it from the firm's WhatsApp Business number or by email, with the PDF, without opening WhatsApp on the phone (set up once in **Settings → WhatsApp & email**, see section 5). **Messages** lists everything sent and sends **payment reminders** to customers with overdue bills.
* Invoices, notes and receipts also go out from their **WhatsApp** button: on a phone it shares the **PDF file** with the message (pick WhatsApp and the chat); on a computer it opens WhatsApp with the message, and you attach the file from **Download PDF**.
* **Billing without internet.** Open the app once with internet on each phone or PC: it keeps a copy of your products, prices and customers and gets its own bill series (A1, A2 …, see **Settings → Devices for offline billing**). Without internet the app still opens (a yellow strip says so) and bills are saved on the device with numbers like `A1/26-27/0001`, ready to print or share. When the internet is back they are sent by themselves; the cloud button at the top shows how many are waiting and has **Sync now**. Payments, purchases and reports still need internet. Sign out only when everything is synced (the app warns you).

---

## 5. Put it on a server

For real use: one server, reachable at your own web address with https, used from every computer and phone.

### What you need

* A Linux server (Ubuntu 22.04 or 24.04) with at least **2 CPUs, 4 GB memory and 40 GB disk**, from any cloud provider (a Mumbai or Bangalore region keeps it fast in India).
* A **domain name** (for example `billing.yourfirm.in`) with a DNS **A record** pointing to the server's IP address.
* **Docker** on the server: `curl -fsSL https://get.docker.com | sh`
* An **SMS or WhatsApp gateway** for login OTPs (see "OTP messages" below).

### Steps

On the server:

```bash
git clone https://github.com/shailendrasahug010/BillingSystem.git
cd BillingSystem
cp .env.example .env
```

Create the signing and encryption keys (this runs Node.js inside Docker, so nothing else needs installing on the server):

```bash
docker run --rm node:22-slim node -e '
const c = require("crypto");
const { privateKey, publicKey } = c.generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const one = (p) => p.trim().replace(/\n/g, "\\n");
console.log(`JWT_PRIVATE_KEY="${one(privateKey)}"`);
console.log(`JWT_PUBLIC_KEY="${one(publicKey)}"`);
console.log(`DATA_ENCRYPTION_KEY="${c.randomBytes(32).toString("base64")}"`);'
```

(On a computer with the project installed, `pnpm --filter @vyapaar/api keys` prints the same.) It prints three lines (`JWT_PRIVATE_KEY=…`, `JWT_PUBLIC_KEY=…`, `DATA_ENCRYPTION_KEY=…`). Open `.env` (`nano .env`) and fill in:

| Setting | Value |
|---|---|
| `DOMAIN` | your domain, e.g. `billing.yourfirm.in` |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | two different long random passwords |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `DATA_ENCRYPTION_KEY` | the three printed lines |
| `OTP_WEBHOOK_URL`, `OTP_WEBHOOK_TOKEN` | your OTP gateway adapter (below) |
| `SMTP_URL`, `MAIL_FROM` (optional) | a mail server for firms that do not use their own, e.g. `smtps://bills%40yourdomain.in:password@smtp.yourmail.in:465` and `bills@yourdomain.in` (below) |

**Keep a copy of `.env` somewhere safe** (not on the same server). Without `DATA_ENCRYPTION_KEY`, the encrypted bank account numbers cannot be read back.

Start everything:

```bash
docker compose up -d --build
```

This starts PostgreSQL, sets up the database (migrations, the restricted database user, reference data), starts the API, and starts Caddy, which serves the app and gets the https certificate for your domain automatically. After a few minutes, open `https://your-domain`, create the account (section 1, "First use"), and install the app on each computer and phone (sections 3 and 4).

### OTP messages

Sign-up, OTP login and password reset send a 6-digit code. The server does not talk to an SMS company directly: it sends `POST {"mobile": "98xxxxxxxx", "code": "123456", "purpose": "login"}` to `OTP_WEBHOOK_URL`, with `Authorization: Bearer <OTP_WEBHOOK_TOKEN>` when a token is set. Point it at a small adapter for your provider (MSG91, Gupshup, Twilio, a WhatsApp Business API provider, …) that sends the code as a DLT-approved template.

### WhatsApp Business and email to customers

Bills, credit notes, receipts and payment reminders go out from **each firm's own WhatsApp Business number** and email. The owner sets this up in the app: **Settings → WhatsApp & email**. Tokens and passwords are stored encrypted and never shown again. On a development computer nothing is sent (`MESSAGING_DRIVER=log`): messages are only listed under **Messages**, marked as test mode.

**WhatsApp Business (Meta Cloud API)**

1. In [Meta Business Suite](https://business.facebook.com) create a WhatsApp Business account and add your business phone number (it must not be in use on the WhatsApp app).
2. In the Meta developer app (WhatsApp → API Setup) copy the **Phone number ID** and create a **permanent access token** (a system user with the `whatsapp_business_messaging` permission).
3. Create two message templates and wait for approval:
   * bills, category *Utility*, header *Document*, body with four values, e.g. `Namaste {{1}}, your bill {{2}} for {{3}} from {{4}} is attached.`
   * payment reminders, category *Utility*, body e.g. `Namaste {{1}}, your balance with {{4}} is {{2}}, of which {{3}} is overdue. Please pay at the earliest.`
4. In Digital Bahi choose *WhatsApp Business (Meta Cloud API)*, fill in the number, phone number ID, token and the two template names (and the template language code, e.g. `en` or `hi`), save, and **Send test** to your own mobile.
5. For the **delivered and read ticks**: after saving, the same card shows a *Callback URL* and a *Verify token*. In the Meta app → WhatsApp → Configuration → Webhook, paste both, click *Verify and save*, and subscribe to the **messages** field. Copy the *App secret* (App settings → Basic) into *Meta app secret* in Digital Bahi and save. Messages then show one tick (sent), two ticks (delivered) and two blue ticks (read). The server must be reachable from the internet over HTTPS for Meta to call it.

Without approved templates WhatsApp only delivers to customers who wrote to you in the last 24 hours. Another provider (Interakt, Wati, Gupshup …) can be connected with *Another provider (webhook)*: the server posts `{"channel": "whatsapp", "to": "+9198…", "text", "template": {name, language, params}, "document": {filename, contentType, base64}}` to its address, signed with `X-DigitalBahi-Signature: sha256=HMAC(secret, timestamp + "." + body)` and `X-DigitalBahi-Timestamp`. For ticks, the provider posts `{"statuses": [{"id": "<its message id>", "status": "delivered" | "read" | "failed", "timestamp": <unix seconds>}]}` to the *Callback URL* shown in the settings, signed the same way with the same secret (within 5 minutes of the timestamp).

**Email**: either the server's mail server (`SMTP_URL`, `MAIL_FROM`; mail goes out as "Your Firm via Digital Bahi" with replies to the firm's email), or the firm's own SMTP (for Gmail use `smtp.gmail.com`, port 465 with SSL, and an app password).

### Everyday operation

| Task | Command (in the `BillingSystem` folder) |
|---|---|
| See what is running | `docker compose ps` |
| Server logs | `docker compose logs -f api` |
| Back up the database (run daily, keep copies elsewhere) | `docker compose exec -T postgres pg_dump -U vyapaar_owner -Fc vyapaar > vyapaar-$(date +%F).dump` |
| Restore a backup (replaces the current data) | `docker compose exec -T postgres pg_restore -U vyapaar_owner -d vyapaar --clean --if-exists < vyapaar-2026-09-25.dump` |
| Update to a new version | `git pull && docker compose up -d --build` (database changes are applied on start; installed apps then show "Reload now") |
| Stop / start | `docker compose stop` / `docker compose start` |

These commands back up the **whole server** (all firms). Each firm's owner can also keep its own copy from the app: **Backup & Restore** downloads one `.dbbackup` file with everything in that business (best with a password; it can also be emailed to the firm, always with a password), and **Restore** brings such a file back as a **new** business next to the current one, never over it (sessions, members of staff, devices and WhatsApp / email passwords are not in the file: add staff again under Users & Roles and re-enter the WhatsApp token and SMTP password in Settings). Restoring asks for the person's own Digital Bahi password again.

**Automatic backups.** Under **Backup & Restore → Automatic backups** the owner picks every day or every week, the time (in the firm's time zone), the email address (the firm's own by default) and a password for the file. The server then emails a password-protected copy at that time by itself; nothing else needs to be scheduled. Email has to be set up first (section on WhatsApp & email above). The Backup screen shows the next time and whether the last copy went out (and why not, e.g. the mail server refused it); a failed copy is tried again at the next time. If the person who set it up is removed or loses the backup permission, automatic backups switch off. The API looks for due backups every 5 minutes (`BACKUP_SCHEDULER_SECONDS`; set `0` on extra API servers if you run more than one, though two servers never send the same copy twice).

A daily backup with cron (`crontab -e`):

```
30 1 * * * cd /root/BillingSystem && docker compose exec -T postgres pg_dump -U vyapaar_owner -Fc vyapaar > /root/backups/vyapaar-$(date +\%F).dump
```

---

## 6. App stores (optional)

Installing from the browser (sections 3 and 4) needs no store. If you also want Digital Bahi listed in a store:

* **Google Play Store (Android).** Package the installed app as a Trusted Web Activity with Google's Bubblewrap tool. It needs Node.js and asks to download the Java and Android tools on first use:

  ```bash
  npm install -g @bubblewrap/cli
  bubblewrap init --manifest https://your-domain/manifest.webmanifest
  bubblewrap build
  ```

  Upload the `.aab` file it makes in the Play Console. Bubblewrap also prints a `assetlinks.json`; save it as `apps/web/public/.well-known/assetlinks.json`, then rebuild and redeploy (`docker compose up -d --build`) so the app opens without the browser bar.
* **Microsoft Store (Windows).** Go to https://www.pwabuilder.com, enter `https://your-domain`, choose **Package for stores → Windows**, and upload the package in Microsoft Partner Center.
* **Apple App Store.** Apple needs a native wrapper app; that is planned. Until then iPhone users add it from Safari (section 4).

---

## 7. Troubleshooting

| Problem | What to do |
|---|---|
| `pnpm: command not found` | Run `corepack enable` (once, after installing Node.js), then open a new terminal. |
| `createdb: command not found` (Windows) | Use the full path, e.g. `& "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres vyapaar_dev`, or create the database in pgAdmin. |
| `password authentication failed for user "postgres"` | Use the password you set when installing PostgreSQL in the database addresses. |
| `port 3000 (or 5173) already in use` | Another copy is still running: close that terminal, or start the API with `PORT=3001` and the app with `API_URL=http://localhost:3001 pnpm dev:web`. |
| The app stays on "Loading your business…" or shows "Could not load" | The API is not running or cannot reach the database: look at the API terminal for the error. |
| "You are offline" | The device has no internet, or cannot reach the server, and has not been opened online before. The app continues by itself when it can. |
| "This device is not ready for offline bills yet" | Open the app once with internet on this device (it then gets its bill series), and bill offline after that. |
| A bill shows "Not accepted" in **Bills on this device** | The server refused it (the reason is shown, e.g. the product was deleted or the device was removed). Fix the cause and press **Try again**, or **Remove** it and make the bill again online. |
| No OTP arrives (on a server) | Check `docker compose logs api` and the OTP adapter's logs; on your own computer the code is shown on screen instead. |
| No **Install** option | Use Chrome or Edge (Safari on iPhone); open the `https://` address (or `localhost` on the computer itself); it is not offered if the app is already installed. |
| The phone cannot open the computer's address | Same Wi-Fi on both, start the app with `pnpm dev:web --host`, and allow Node.js in the computer's firewall. |
| Start again with an empty database (your own computer only) | `dropdb -U postgres vyapaar_dev`, then repeat the `createdb` and `pnpm db:deploy` steps. |

For developers: `pnpm typecheck`, `pnpm test` (with `DATABASE_URL` set to a PostgreSQL admin connection; each test file makes and removes its own database) and the browser scripts in `apps/web/e2e/` are described in the [README](README.md).
