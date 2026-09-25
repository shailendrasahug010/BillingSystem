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
   * **Suppliers → Add supplier**, then **Purchases → Import bill** (the supplier's bill as Excel, CSV or the PDF from their software) or **New purchase bill** to bring stock in
   * **Customers → Import** or **Add customer**
   * **New Invoice** (Ctrl+I) and **Payments → Receive payment** (Alt+C)

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

**PDF files.** Every report has a **PDF** button (with your letterhead and page numbers) next to **Excel (CSV)**. Bills, receipts and slips are saved as PDF from **Print / PDF** (choose "Save as PDF" in the print window).

**Keyboard.** Ctrl+I new invoice, Alt+P purchase bill, Alt+O sales order, Alt+C receive payment, Ctrl+K search. The keyboard icon at the bottom of the left menu lists them all.

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
* Invoices and receipts can be sent from their **Share on WhatsApp** button.
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

**Keep a copy of `.env` somewhere safe** (not on the same server). Without `DATA_ENCRYPTION_KEY`, the encrypted bank account numbers cannot be read back.

Start everything:

```bash
docker compose up -d --build
```

This starts PostgreSQL, sets up the database (migrations, the restricted database user, reference data), starts the API, and starts Caddy, which serves the app and gets the https certificate for your domain automatically. After a few minutes, open `https://your-domain`, create the account (section 1, "First use"), and install the app on each computer and phone (sections 3 and 4).

### OTP messages

Sign-up, OTP login and password reset send a 6-digit code. The server does not talk to an SMS company directly: it sends `POST {"mobile": "98xxxxxxxx", "code": "123456", "purpose": "login"}` to `OTP_WEBHOOK_URL`, with `Authorization: Bearer <OTP_WEBHOOK_TOKEN>` when a token is set. Point it at a small adapter for your provider (MSG91, Gupshup, Twilio, a WhatsApp Business API provider, …) that sends the code as a DLT-approved template.

### Everyday operation

| Task | Command (in the `BillingSystem` folder) |
|---|---|
| See what is running | `docker compose ps` |
| Server logs | `docker compose logs -f api` |
| Back up the database (run daily, keep copies elsewhere) | `docker compose exec -T postgres pg_dump -U vyapaar_owner -Fc vyapaar > vyapaar-$(date +%F).dump` |
| Restore a backup (replaces the current data) | `docker compose exec -T postgres pg_restore -U vyapaar_owner -d vyapaar --clean --if-exists < vyapaar-2026-09-25.dump` |
| Update to a new version | `git pull && docker compose up -d --build` (database changes are applied on start; installed apps then show "Reload now") |
| Stop / start | `docker compose stop` / `docker compose start` |

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
