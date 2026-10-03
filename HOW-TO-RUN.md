# How to run Digital Bahi

*Aapke Business ka Digital Hisab*

On a computer, on a phone, and on your own server.

Digital Bahi has two parts:

* **The server** (the API and the PostgreSQL database). It keeps all the data: bills, stock, ledgers, GST. It runs in one place: your laptop while you try it out, or a rented server with a web address once the business uses it.
* **The app** that people use. The same app runs in a browser and is **installed as an app** on Windows, Mac and Linux computers and on Android phones and iPhones. Once installed, it has its own icon and window, opens from the Start menu, taskbar, Dock or home screen, and updates itself.

So there is no separate "desktop version" or "mobile version" to build. Run the server once (section 1 or section 5), then install the app on each computer and phone (sections 3 and 4).

| I want to… | Go to |
|---|---|
| Install it on my computer with one installer (Windows, Mac, Linux) | [The quick way: the installer](#the-quick-way-the-installer) |
| Try it on my own computer, step by step | [1. Run it on your computer](#1-run-it-on-your-computer) |
| Open it on my phone while trying it | [2. Open it on your phone over Wi-Fi](#2-open-it-on-your-phone-over-wi-fi) |
| Install the desktop app (Windows, Mac, Linux) | [3. Install the desktop app](#3-install-the-desktop-app) |
| Install the mobile app (Android, iPhone) | [4. Install the mobile app](#4-install-the-mobile-app) |
| Run it for my business, with a web address | [5. Put it on a server](#5-put-it-on-a-server) |
| Publish it on the Play Store or Microsoft Store | [6. App stores (optional)](#6-app-stores-optional) |
| Fix a problem | [7. Troubleshooting](#7-troubleshooting) |

---

## 1. Run it on your computer

It works on Windows 10/11, macOS and Linux. The installer below does everything by itself; the steps after it do the same by hand, for developing the app.

### The quick way: the installer

**Windows 10 / 11**

1. Get `DigitalBahi-Setup-<version>.exe`: from the project's GitHub release, from the **Installer** workflow's run (under *Artifacts*), or build it yourself in the `BillingSystem` folder with `node installer/build-bundle.mjs --target win32-x64 --exe` (needs NSIS's `makensis`; the file goes to `dist-installer/`).
2. Double-click it. The installer is not signed yet, so Windows may say **Windows protected your PC**: click **More info → Run anyway**. It installs for you alone and needs no administrator rights.
3. Leave **Start Digital Bahi now** ticked and click **Finish**. The first start needs the internet, once:
   * it downloads **Node.js** if the computer has no Node.js 22 or newer, and **PostgreSQL 16** if it has no PostgreSQL 16 or newer (about 70 MB together, each checked against its published checksum);
   * if Windows lacks the **Microsoft Visual C++ runtime** that PostgreSQL needs, it downloads it from Microsoft and Windows asks for permission to install it: answer **Yes**;
   * it creates Digital Bahi's own database and opens the app in your browser, at **http://localhost:8710**.
4. From then on, the **Digital Bahi** icon on the desktop or in the Start menu starts it and opens the app (a few seconds), and **Stop Digital Bahi** in the Start menu stops it. Turning the computer off is fine too. Then go on with [First use](#first-use), and install the app with its own window as in [section 3](#3-install-the-desktop-app).

**Windows, from the source folder**

In the `BillingSystem` folder (`git clone` it first, as in the steps below), double-click `installer\windows\DigitalBahi.cmd`, or run it in PowerShell. The first time it builds Digital Bahi for this computer into the data folder (a few minutes; Node.js is downloaded first if the computer has none), then does what the installer does and opens the app. Start it again the same way. After `git pull`, run `installer\windows\DigitalBahi.cmd install` to bring it up to date; `stop`, `restart` and `status` work too.

**macOS and Linux**

In a terminal, in the `BillingSystem` folder (`git clone` it first, as in the steps below):

```bash
installer/unix/digitalbahi.sh
```

The first time it builds Digital Bahi for this computer (a few minutes; Node.js is downloaded first if the computer has none), then does what the Windows installer does and opens the app. Later, start and stop it with the copy it made in the data folder (below): `…/app/digitalbahi.sh start`, `stop`, `restart` or `status`. After `git pull`, run `installer/unix/digitalbahi.sh install` to bring that copy up to date. Run it as your normal user, not with `sudo`.

**What it sets up**

| | |
|---|---|
| The database | A PostgreSQL database cluster of Digital Bahi's own, on port 54320 (or the next free one), reachable only from this computer, with passwords made at setup. If the computer already has PostgreSQL 16 or newer, its programs are used; its own databases are never touched. |
| The server | Serves the app and the API at **http://localhost:8710** (or the next free port; the address then stays the same). It is reachable only from this computer: sign-up and OTP codes are shown on the screen, as there is no SMS gateway. |
| The data folder | Windows `%LOCALAPPDATA%\DigitalBahi` (Start menu → Digital Bahi → *Digital Bahi data folder*), macOS `~/Library/Application Support/DigitalBahi`, Linux `~/.local/share/digitalbahi`. It holds the database (`pgdata`), `config.json` (ports, passwords and keys) and the logs (`logs`). |
| Updates | Install the new version over the old one (Windows) or run `installer/unix/digitalbahi.sh install` (macOS / Linux). Your data stays; the database is brought up to date at the next start. |
| Uninstall (Windows) | **Settings → Apps → Digital Bahi → Uninstall**. It asks whether to delete your data too; the answer **No** (the default) keeps it for a later install. |

**Backups.** Use **Settings → Backup** in the app, or copy the whole data folder while Digital Bahi is stopped. Keep `config.json` with it: bank details in the database can only be read with the key in that file.

**Other computers and phones** cannot connect to this one: the server only answers this computer, because anyone who could reach it could read sign-in codes off the screen. To use Digital Bahi from several devices, put it on a server ([section 5](#5-put-it-on-a-server)).

**Settings.** `"env"` in `config.json` adds or changes the server's settings, for example `{"SMTP_URL": "smtps://user:pass@smtp.example.com:465", "MAIL_FROM": "bills@example.com"}` for the platform mail server. Restart Digital Bahi afterwards.

### Step by step

This is for developing the app, or running it without the installer.

#### What to install first

| Software | Version | Where to get it |
|---|---|---|
| Node.js | 22 or newer | https://nodejs.org (choose "LTS") |
| pnpm | 10 | after Node.js, run `corepack enable` in a terminal |
| PostgreSQL | 16 or newer | Windows: the installer from https://www.postgresql.org/download/windows/ · Mac: https://postgresapp.com · Linux: `sudo apt install postgresql` |
| Git | any | https://git-scm.com |

While installing PostgreSQL, set a password for the `postgres` user and remember it. The steps below use `postgres` as that password; use yours instead.

#### Steps

Open a terminal (on Windows: **PowerShell**) and run:

```bash
git clone https://github.com/shailendrasahug010/BillingSystem.git
cd BillingSystem
pnpm install
```

Create the database and set it up (tables, the restricted database user the app connects as, and reference data such as GST states and units):

```bash
createdb -U postgres digitalbahi_dev
```

macOS / Linux:

```bash
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/digitalbahi_dev APP_DB_PASSWORD=devpass pnpm db:deploy
```

Windows PowerShell:

```powershell
$env:MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/digitalbahi_dev"; $env:APP_DB_PASSWORD="devpass"; pnpm db:deploy
```

You should see `Migrations applied`, `Application role ready` and `Reference data seeded`.

Run this command again **every time you update the code** (`git pull`), before starting the API: new versions add tables and database functions. The API checks this when it starts and stops with "the database is behind this version of the API" until it is done. (The installed app does it by itself at every start.)

Start the server (leave this terminal open):

macOS / Linux:

```bash
DATABASE_URL=postgres://digitalbahi_app:devpass@localhost:5432/digitalbahi_dev OTP_DEV_ECHO=true pnpm dev:api
```

Windows PowerShell:

```powershell
$env:DATABASE_URL="postgres://digitalbahi_app:devpass@localhost:5432/digitalbahi_dev"; $env:OTP_DEV_ECHO="true"; pnpm dev:api
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

This is for trying it out. Browsers treat a plain `http://` network address as not secure and switch off a few things there. Billing, payments, Outstanding and the rest work, but on the phone:

* the app cannot be **installed**;
* it cannot keep its copy for **billing without internet**;
* **WhatsApp** opens with the message, and the PDF is downloaded for you to attach (it cannot be handed to WhatsApp directly).

These need a secure (https) address, which you get with section 5. Browsers treat only `localhost` as secure without https, so on the computer itself everything works, and you can install it right away (section 3).

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

**Keyboard.** Ctrl+I new invoice, Alt+P purchase bill, Alt+O sales order, Alt+C receive payment, Ctrl+K search. On the invoice: F3 customer, F2 product search, Alt+1…9 add a suggestion, **Ctrl+S** save (Ctrl+Enter too): a popup says *Invoice added successfully*, with Send on WhatsApp, Print, View invoice and New invoice; **Enter** starts the next bill. **Ctrl+P** save and print (the bill opens with the print dialog). A product sold in more than one unit (pieces, strips, boxes) has a unit list on its line, each unit with a letter: **P · PCS**, **S · STRIP (10 PCS)**, **B · BOX (100 PCS)**. Choose on the list, or type the letter after the quantity (or on the list): **2** then **B** is 2 boxes; a letter two units share picks one, then the other. A new line starts in strips when the product is sold by the strip. Under **Settings → Units on the bill** choose the unit new lines start in (or each product's own) and change any unit's letter (empty: its first letter). A suggestion is added by a click anywhere on it; once the bill has a line the suggestions fold into one row above it (*All* opens them again), and the product search stays at the top while the lines scroll. A whole bill goes in without the mouse: type the product, **Enter** (the cursor goes to its quantity), type the quantity, **Enter** (to the rate), change it or not, **Enter** (back to product search) for the next item; **Tab** also goes round quantity → rate → Disc % and back to the search; they work on any screen 768 px or wider (a small laptop or a tablet with a keyboard as well). On many laptops the F-keys control brightness and volume unless **Fn** is held (or Fn-Lock is on). **Zoom** (Ctrl + and Ctrl −, or pinch on a phone, the Android app included) works on every screen: zoomed out, the screens use the extra width; zoomed in a lot, the phone's bottom bar gives way on a screen under 500 px tall (the menu button opens everything) and the bill screen keeps the field you are in clear of its bars. A shop that is not a customer yet can be added from the invoice's customer search: type its name or mobile number and choose **Add “…” as a new customer**. The keyboard icon at the bottom of the left menu lists every shortcut.

**Updates.** New versions download by themselves. When one is ready, a line at the top says **A new version of Digital Bahi is ready · Reload now**. Click it when you are not in the middle of a bill (nothing changes until you do).

**Uninstall.** Open the app, then the menu at the top right of its window (**⋮** or **⋯**) → **Uninstall Digital Bahi**. Your data is on the server and is not affected.

---

## 4. Install the mobile app

The phone needs the **https** address of your server (section 5).

### Android: the Digital Bahi app

The Android app is the same app with the phone's own Bluetooth printing (classic Bluetooth, which most small receipt printers use), Google's barcode scanner, the share sheet, printing to any Android printer, and push notifications.

1. Get the APK: every change builds one (GitHub → **Actions** → **Android app** → the run → **digitalbahi-android-debug**, a zip with `app-debug.apk` inside), or build it yourself: install **Android Studio** (it brings the Android SDK; open it once so it downloads the SDK), and Java 21 (Android Studio's own works: point `JAVA_HOME` at its `jbr` folder, e.g. `C:\Program Files\Android\Android Studio\jbr`), set `ANDROID_HOME` to the SDK folder (e.g. `%LOCALAPPDATA%\Android\Sdk`), then in the `BillingSystem` folder `pnpm install` and `pnpm --filter @digitalbahi/mobile apk` (Windows, macOS and Linux). The APK is in `apps/mobile/android/app/build/outputs/apk/debug/`.
2. Install it on the phone (allow installing from this source when Android asks).
3. On first start it asks for your **server address** (for example `billing.yourshop.in`; https only). Then sign in as on the website. The sign-in is kept in the phone's secure storage.
4. **Receipt printer:** pair the printer in the phone's **Settings → Bluetooth** first (PIN often 0000 or 1234), then in the app **Settings → Receipt printer** pick it from *Printers paired with this phone*.
5. **Push notifications** need your own Firebase project: put its `google-services.json` in `apps/mobile/android/app/` before building the APK, and its service account key in the server's `.env` as `FCM_SERVICE_ACCOUNT` (section 5). Without them the bell and the inbox still work.

**Trying the app with Digital Bahi on your own computer.** The app only talks to an `https` address, and the server on your computer is `http://localhost`. To try it before you have a server, give your computer a temporary https address with a tunnel, for example Cloudflare's (install `cloudflared`, no account needed):

```bash
cloudflared tunnel --url http://localhost:3000
```

(`http://localhost:8710` for the installed Digital Bahi instead of `pnpm dev:api`). It prints an address like `https://random-words.trycloudflare.com`: type that in the app as the server address. Anyone with that address can reach your copy while the tunnel runs, and sign-up codes are shown on screen there, so use it only to try the app and close it (Ctrl+C) afterwards; for real use, put Digital Bahi on a server (section 5).

### Android (Chrome)

1. Open `https://your-domain` in **Chrome**.
2. Tap **Install** when Chrome offers it, or tap the menu **⋮ → Install app** (on some phones **Add to Home screen → Install**). Inside the app, **More → Install app** does the same.
3. Digital Bahi appears on the home screen and in the app drawer, and opens full screen like any other app. Long-press the icon for **New invoice**, **Customers** and **Products**.

### iPhone and iPad (Safari)

1. Open `https://your-domain` in **Safari**.
2. Tap the **Share** button (the square with an up arrow) → **Add to Home Screen** → **Add**.
3. Open Digital Bahi from the home screen. It runs full screen, without Safari's bars.

### On the phone

* The bottom bar has **Home, Customers, + (create), Outstanding, More** (roles that do not collect money get their own screen in Outstanding's place); everything else, Products included, is under **More**.
* **Beat** (under **More**) is a salesperson's day: the shops of today's routes in the order they are visited, what each is due to buy again, and how many have been called on. A shop opens with **New bill**, **Order** (it starts with the products due, at the quantities the shop usually takes), **Receive payment**, **No order** (and why), **Visited only**, Call and WhatsApp. It works without internet from the beat kept on the phone. The owner sets the routes up under **Beat → Routes** (the days each is worked, the salesperson, and the shops in order: one by one, or a whole town's with **Add a city's shops**, where shops already on another route stay unticked unless you tick them) and sees each salesperson's day under **Beat → Team report**. On a beat through several towns, tap a town to see only its shops. A salesperson is matched to their routes by the employee record with the same mobile number.
* **Scan** on the bill screen opens the **camera**: hold each pack's barcode in the box and it is added with a beep; the camera stays on for the next one. A USB or Bluetooth barcode scanner works too (it types the code and presses Enter). The camera needs the https address (or the Android app).
* **Thermal printer:** a small Bluetooth receipt printer (58 or 80 mm) prints bills and payment receipts, in Hindi too, with a UPI code for what is still owed. Choose it once under **Settings → Receipt printer** (turn the printer on first; in Chrome on Android, Windows or Mac it is found over Bluetooth, in the Android app pair it in the phone's Bluetooth settings first), print a test page, then use **Thermal print** on a bill or receipt. Put your bank and UPI ID under **Settings → Where customers pay** so bills show where to pay.
* **Send** on an invoice, note or receipt sends it from the firm's WhatsApp Business number or by email, with the PDF, without opening WhatsApp on the phone (set up once in **Settings → WhatsApp, SMS & email**, see section 5). **Messages** lists everything sent and sends **payment reminders** to customers with overdue bills; **Notifications → Reminder rules → Payment reminders to customers** sends them by itself on a schedule.
* Invoices, notes and receipts also go out from their **WhatsApp** button, and so does a bill just saved (**Send on WhatsApp** in the *Invoice added successfully* popup), always with the invoice's **PDF file**: on a phone, in the Android app, and in Chrome or Edge on Windows (and most Macs) the share sheet opens with the PDF and the message: pick WhatsApp and the chat (on Windows, WhatsApp's desktop app from the Microsoft Store shows there). In a browser that cannot hand files to other apps, WhatsApp opens with the message to the customer's number and the PDF is downloaded: attach it there with 📎 → Document. A bill still waiting on this device goes as the message only; its PDF can be sent once it reaches the server.
* **Billing without internet.** Open the app once with internet on each phone or PC: it keeps a copy of your products, prices and customers and gets its own bill series (A1, A2 …, see **Settings → Devices for offline billing**). Without internet the app still opens after you type your Digital Bahi password (the copy on the device is encrypted, so a lost phone shows nothing; if you only ever sign in with an OTP, confirm your password once under the cloud button while online), a yellow strip says so, and bills are saved on the device with numbers like `A1/26-27/0001`, ready to print or share. Payments received, orders and new customers (who can be billed at once) are kept the same way, and so are changes to a customer (**Edit** on their page). When the internet is back they are sent by themselves, in the order they were made; the cloud button at the top shows how many are waiting and has **Sync now**. If someone changed the same customer on another device in between, the list says so: **Keep mine** or **Remove** (keeps theirs). Purchases, expenses and reports still need internet. Sign out only when everything is synced (the app warns you).

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

(On a computer with the project installed, `pnpm --filter @digitalbahi/api keys` prints the same.) It prints three lines (`JWT_PRIVATE_KEY=…`, `JWT_PUBLIC_KEY=…`, `DATA_ENCRYPTION_KEY=…`). Open `.env` (`nano .env`) and fill in:

| Setting | Value |
|---|---|
| `DOMAIN` | your domain, e.g. `billing.yourfirm.in` |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | two different long random passwords |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `DATA_ENCRYPTION_KEY` | the three printed lines |
| `OTP_WEBHOOK_URL`, `OTP_WEBHOOK_TOKEN` | your OTP gateway adapter (below) |
| `SMTP_URL`, `MAIL_FROM` (optional) | a mail server for firms that do not use their own, e.g. `smtps://bills%40yourdomain.in:password@smtp.yourmail.in:465` and `bills@yourdomain.in` (below) |
| `FCM_SERVICE_ACCOUNT` (optional) | the Firebase service account key for push messages to the Android app, as one line of base64 (below) |

**Keep a copy of `.env` somewhere safe** (not on the same server). Without `DATA_ENCRYPTION_KEY`, the encrypted bank account numbers cannot be read back.

Start everything:

```bash
docker compose up -d --build
```

This starts PostgreSQL, sets up the database (migrations, the restricted database user, reference data), starts the API, and starts Caddy, which serves the app and gets the https certificate for your domain automatically. After a few minutes, open `https://your-domain`, create the account (section 1, "First use"), and install the app on each computer and phone (sections 3 and 4).

### OTP messages

Sign-up, OTP login and password reset send a 6-digit code. The server does not talk to an SMS company directly: it sends `POST {"mobile": "98xxxxxxxx", "code": "123456", "purpose": "login"}` to `OTP_WEBHOOK_URL`, with `Authorization: Bearer <OTP_WEBHOOK_TOKEN>` when a token is set. Point it at a small adapter for your provider (MSG91, Gupshup, Twilio, a WhatsApp Business API provider, …) that sends the code as a DLT-approved template.

### WhatsApp Business, SMS and email to customers

Bills, credit notes, receipts and payment reminders go out from **each firm's own WhatsApp Business number** and email; payment reminders can also go by SMS. The owner sets this up in the app: **Settings → WhatsApp, SMS & email**. Tokens and passwords are stored encrypted and never shown again. On a development computer nothing is sent (`MESSAGING_DRIVER=log`): messages are only listed under **Messages**, marked as test mode.

**WhatsApp Business (Meta Cloud API)**

1. In [Meta Business Suite](https://business.facebook.com) create a WhatsApp Business account and add your business phone number (it must not be in use on the WhatsApp app).
2. In the Meta developer app (WhatsApp → API Setup) copy the **Phone number ID** and create a **permanent access token** (a system user with the `whatsapp_business_messaging` permission).
3. Create two message templates and wait for approval:
   * bills, category *Utility*, header *Document*, body with four values, e.g. `Namaste {{1}}, your bill {{2}} for {{3}} from {{4}} is attached.`
   * payment reminders, category *Utility*, body e.g. `Namaste {{1}}, your balance with {{4}} is {{2}}, of which {{3}} is overdue. Please pay at the earliest.`
4. In Digital Bahi choose *WhatsApp Business (Meta Cloud API)*, fill in the number, phone number ID, token and the two template names (and the template language code, e.g. `en`), save, and **Send test** to your own mobile. If the same templates are approved in Hindi too, put their language code (`hi`) in *Language code of the same templates in Hindi*: customers whose messages are in Hindi (set on the customer's page) then get the Hindi ones.
5. For the **delivered and read ticks**: after saving, the same card shows a *Callback URL* and a *Verify token*. In the Meta app → WhatsApp → Configuration → Webhook, paste both, click *Verify and save*, and subscribe to the **messages** field. Copy the *App secret* (App settings → Basic) into *Meta app secret* in Digital Bahi and save. Messages then show one tick (sent), two ticks (delivered) and two blue ticks (read), and a customer who replies **STOP** (or *band karo*, बंद) gets no more payment reminders (**START** turns them on again). The server must be reachable from the internet over HTTPS for Meta to call it.

Without approved templates WhatsApp only delivers to customers who wrote to you in the last 24 hours. Another provider (Interakt, Wati, Gupshup …) can be connected with *Another provider (webhook)*: the server posts `{"channel": "whatsapp", "to": "+9198…", "text", "template": {name, language, params}, "document": {filename, contentType, base64}}` to its address, signed with `X-DigitalBahi-Signature: sha256=HMAC(secret, timestamp + "." + body)` and `X-DigitalBahi-Timestamp`. For ticks, the provider posts `{"statuses": [{"id": "<its message id>", "status": "delivered" | "read" | "failed", "timestamp": <unix seconds>}]}` to the *Callback URL* shown in the settings, signed the same way with the same secret (within 5 minutes of the timestamp).

**SMS** (payment reminders only; bills need WhatsApp or email for the PDF): choose *Through our SMS provider (webhook)* and fill in the provider's address, a signing secret, the DLT **sender id** and the DLT **template ids** of the reminder in English and in Hindi. In India the sender id and the reminder text must be registered on the DLT portal first (through your SMS provider). The server posts `{"channel": "sms", "to": "+9198…", "text", "senderId", "templateId"}` to the address, signed like the WhatsApp webhook above; a small adapter for your provider (MSG91, Gupshup, Twilio …) sends it on.

**Email**: either the server's mail server (`SMTP_URL`, `MAIL_FROM`; mail goes out as "Your Firm via Digital Bahi" with replies to the firm's email), or the firm's own SMTP (for Gmail use `smtp.gmail.com`, port 465 with SSL, and an app password).

**Push messages to the Android app.** Notifications (payment reminders due, orders waiting, low stock …) also arrive on the phones of the people they are for, as push messages, once the server has a Firebase project:

1. In the [Firebase console](https://console.firebase.google.com) create a project and add an Android app with the app's package name (the app build needs that project's `google-services.json`; see the Android app's own instructions).
2. In Project settings → Service accounts click *Generate new private key*. Keep the downloaded JSON file safe: it lets anyone send pushes in your project.
3. Put it in `.env` as one line: `FCM_SERVICE_ACCOUNT=` followed by the output of `base64 -w0 your-key.json`, and run `docker compose up -d`.

The app registers each phone when someone signs in and stops pushes when they sign out; a phone also stops getting them when its sign-in ends (removed in Settings → Devices, the member removed, *sign out everywhere*). A push says what the notification says, in the phone's language, and opening it goes to the order, customer or screen it is about. Without the key nothing is pushed and everything else works the same (`PUSH_DRIVER=log` on a development computer writes them to the server log instead).

**Automatic payment reminders** are off until the owner turns them on under **Notifications → Reminder rules → Payment reminders to customers**: when to send the first (days after the oldest unpaid bill fell due), how often to repeat, the most to send while the same bills stay unpaid, the least overdue amount worth a reminder, and the channel (*WhatsApp, else SMS* by default). The card lists who is due one today (and who cannot be reached); **Send now** sends today's at once. Each customer gets at most one a day, in their language, and those who asked not to get them (*No payment reminders* on their page, or a STOP reply) never do. Every reminder sent this way is listed under **Messages**, marked *Automatic*, and the staff who send messages get one notification a day saying how many went.

### Everyday operation

| Task | Command (in the `BillingSystem` folder) |
|---|---|
| See what is running | `docker compose ps` |
| Server logs | `docker compose logs -f api` |
| **Errors, most frequent first**, each with the file and line it happened at | `docker compose exec api node dist/errors.js` (add `--days 7`, `--last 3`, or `--ref <reference>` for the error a person was shown that reference for) |
| The error log files themselves | `docker compose exec api ls logs` then `docker compose exec api cat logs/errors-2026-09-30.log` |
| Back up the database (run daily, keep copies elsewhere) | `docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > digitalbahi-$(date +%F).dump` |
| Restore a backup (replaces the current data) | `docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < digitalbahi-2026-09-25.dump` |
| Update to a new version | `git pull && docker compose up -d --build` (database changes are applied on start; installed apps then show "Reload now") |
| Stop / start | `docker compose stop` / `docker compose start` |

These commands back up the **whole server** (all firms). Each firm's owner can also keep its own copy from the app: **Backup & Restore** downloads one `.dbbackup` file with everything in that business (best with a password; it can also be emailed to the firm, always with a password), and **Restore** brings such a file back as a **new** business next to the current one, never over it (sessions, members of staff, devices and WhatsApp / email passwords are not in the file: add staff again under Users & Roles and re-enter the WhatsApp token and SMTP password in Settings). Restoring asks for the person's own Digital Bahi password again.

**Automatic backups.** Under **Backup & Restore → Automatic backups** the owner picks every day or every week, the time (in the firm's time zone), the email address (the firm's own by default) and a password for the file. The server then emails a password-protected copy at that time by itself; nothing else needs to be scheduled. Email has to be set up first (section on WhatsApp Business, SMS and email above). The Backup screen shows the next time and whether the last copy went out (and why not, e.g. the mail server refused it); a failed copy is tried again at the next time. If the person who set it up is removed or loses the backup permission, automatic backups switch off. The API looks for due backups every 5 minutes (`BACKUP_SCHEDULER_SECONDS`; set `0` on extra API servers if you run more than one, though two servers never send the same copy twice).

**Purchase history and nightly checks.** A few seconds after each bill, payment or note, the API works out that customer's buying again (what they buy, how often, how much, their payment behaviour) and stores it, so the invoice screen's suggestions open at once (`OUTBOX_WORKER_SECONDS`, default 5). Every night after 2:00 in the firm's time zone (`NIGHTLY_ANALYTICS_HOUR`; the API looks every `NIGHTLY_SCHEDULER_SECONDS`, default 600) it rebuilds all of it, mines "bought together" rules, and checks that what it kept matches the bills and that each customer's and supplier's balance and every stock quantity still equals its ledger. If something does not match, it is written to the error log ("Nightly check: …") with the details in the `analytics_runs` table; nothing needs doing otherwise. Several API servers can run both side by side; set `0` to switch one off on a server.

**Notifications.** Each business has ten reminder rules (Notifications → Reminder rules): payments due from customers and to suppliers, low stock, expiring stock, orders to confirm, pack and dispatch, leave requests, salary due, and phones or PCs holding work that has not reached the server. Once a day, after each rule's hour in the firm's time zone, the API checks the rule and leaves one notification when there is something to act on; the API looks for due checks every `REMINDER_SCHEDULER_SECONDS` (default 300; `0` switches it off on a server, several servers can run it side by side). Orders and leave also notify the moment they happen, through the same worker as the purchase history (`OUTBOX_WORKER_SECONDS`). The bell is kept current by a live stream (`GET /api/v1/notifications/stream`, server-sent events): behind a reverse proxy, let that path through without buffering (Caddy, as set up in `deploy/`, passes each event on at once; for nginx, `proxy_buffering off` on it — the API also sends `X-Accel-Buffering: no`) and allow the connection to stay open for up to the access-token lifetime (`ACCESS_TOKEN_TTL_SECONDS`, default 15 minutes). Each API server keeps one extra database connection for it, opened when the first person signs in.

**The error log.** Every failure is written to a file, in plain words, so it can be found and fixed: failed requests (anything the server answers with a 500), crashes of a screen in someone's browser, background jobs (automatic backups, WhatsApp / email sending), lost database connections and anything that would stop the API. Each entry says **what happened**, **where** (the source file and line, e.g. `apps/web/src/features/reports/ReportsPage.tsx line 254` — also for the browser, from the web app's source maps, which the server keeps and the public site never serves), the request or screen, the browser, who was using it, and the **reference** the person was shown ("Reference: …" under the error, or on the "This screen stopped working" page) so a complaint can be matched to its entry. Files are per day, `logs/errors-YYYY-MM-DD.log` (readable) and `.jsonl` (one JSON line each), kept 30 days (`LOG_RETENTION_DAYS`), in the `api_logs` volume (`LOG_DIR`; `off` writes none). Times are in India time (`LOG_TIME_ZONE`). Passwords, tokens and what people typed into forms are never written. On your own computer the files are in `apps/api/logs/`, and `pnpm --filter @digitalbahi/api errors` prints the summary.

A daily backup with cron (`crontab -e`):

```
30 1 * * * cd /root/BillingSystem && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /root/backups/digitalbahi-$(date +\%F).dump
```

### Servers installed before the rename

The project's code name used to be `vyapaar`; it is now `digitalbahi` (the database `digitalbahi`, its owner `digitalbahi_owner` and the API's role `digitalbahi_app`). Nothing inside the tables changed, only these names. A server set up **before** the rename keeps its data by keeping its old names: before `git pull && docker compose up -d --build`, add these lines to its `.env` (they are in `.env.example`, commented out):

```
COMPOSE_PROJECT_NAME=vyapaar
POSTGRES_USER=vyapaar_owner
POSTGRES_DB=vyapaar
APP_DB_ROLE=vyapaar_app
```

Without them Docker would start a new, empty database next to the old one (the old one is not deleted: add the lines and run `docker compose up -d` again). People who are signed in are asked for nothing: their app refreshes its sign-in once by itself. Their theme and language choices are kept.

On your own computer, a development database made before the rename can be renamed instead (stop the API first, then run as the `postgres` user):

```bash
psql -U postgres -c "ALTER DATABASE vyapaar_dev RENAME TO digitalbahi_dev" -c "ALTER ROLE vyapaar_app RENAME TO digitalbahi_app" -c "ALTER ROLE digitalbahi_app PASSWORD 'devpass'"
```

(The password is set again because PostgreSQL clears an MD5 password when a role is renamed.)

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
| `createdb: command not found` (Windows) | Use the full path, e.g. `& "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres digitalbahi_dev`, or create the database in pgAdmin. |
| `password authentication failed for user "postgres"` | Use the password you set when installing PostgreSQL in the database addresses. |
| `port 3000 (or 5173) already in use` | Another copy is still running: close that terminal, or start the API with `PORT=3001` and the app with `API_URL=http://localhost:3001 pnpm dev:web`. |
| The app stays on "Loading your business…" or shows "Could not load" | The API is not running or cannot reach the database: look at the API terminal for the error. |
| "This screen stopped working", or "Something went wrong on the server" with a reference | Find the reference in the error log: `pnpm --filter @digitalbahi/api errors --ref <reference>` (on a server `docker compose exec api node dist/errors.js --ref <reference>`); it shows the file and line where it happened. |
| "You are offline" | The device has no internet, or cannot reach the server, and has not been opened online before. The app continues by itself when it can. |
| "This device is not ready for offline bills yet" | Open the app once with internet on this device (it then gets its bill series), and bill offline after that. |
| "This password does not open the copy on this device" | Type the password you had when this device was last online (after a password change the old one still opens the copy), or connect to the internet: online the copy opens by itself. |
| "This copy opens without internet only after you have signed in with your password" | You signed in on this device with an OTP only. Connect once, open the cloud button at the top and confirm your password there. |
| A bill shows "Not accepted" in **Bills on this device** | The server refused it (the reason is shown, e.g. the product was deleted or the device was removed). Fix the cause and press **Try again**, or **Remove** it and make the bill again online. |
| No OTP arrives (on a server) | Check `docker compose logs api` and the OTP adapter's logs; on your own computer the code is shown on screen instead. |
| No **Install** option | Use Chrome or Edge (Safari on iPhone); open the `https://` address (or `localhost` on the computer itself); it is not offered if the app is already installed. |
| The phone cannot open the computer's address | Same Wi-Fi on both, start the app with `pnpm dev:web --host`, and allow Node.js in the computer's firewall. |
| The API stops at start with "the database is behind this version of the API" or "this version's database step has not run"; or, from an API started before this check, `Failed query: select … from outbox_pending_businesses(…)` warnings, `function … does not exist` / `relation … does not exist` errors and "Something went wrong on the server" | The code was updated but the database was not. Stop the API, run the `pnpm db:deploy` command from **Steps** above, and start the API again. |
| Start again with an empty database (your own computer only) | `dropdb -U postgres digitalbahi_dev`, then repeat the `createdb` and `pnpm db:deploy` steps. |
| `The argument '…\installer\windows\launcher\DigitalBahi.ps1' to the -File parameter does not exist` | An older `DigitalBahi.cmd`, run from the source folder: it only worked in an installed copy. `git pull`, then double-click `installer\windows\DigitalBahi.cmd` again (it now builds Digital Bahi the first time), or use the installer. |
| Installer: **Windows protected your PC** | The installer is not signed yet: click **More info → Run anyway**. |
| Installer: the first start stops while downloading | Check the internet connection and start Digital Bahi again; it carries on from where it stopped. |
| Installer: "Port 8710 (or 54320) is used by another program" | Close that program, or change `apiPort` (or `pgPort`) in `config.json` in the data folder and start again. A new `apiPort` gives the app a new address: install it again from there. |
| Installer: the app does not open, or something else fails | Run **Digital Bahi** again: the window says what went wrong. The details are in the data folder's `logs` (`server.log`, `postgresql.log`); errors are also in the error log there. |

For developers: `pnpm typecheck`, `pnpm test` (with `DATABASE_URL` set to a PostgreSQL admin connection; each test file makes and removes its own database) and the browser scripts in `apps/web/e2e/` are described in the [README](README.md).
