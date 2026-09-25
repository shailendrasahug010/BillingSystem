# Digital Bahi

*Aapke Business ka Digital Hisab*

Distributor & supplier CRM, billing, inventory, GST and collections for Indian FMCG distributors, wholesalers and suppliers. Web, Windows, Mac, Android and iPhone from one code base (installable app), in English and Hindi. Each firm using it gets its own letterhead: its logo, name, address, mobile, email and GSTIN on every printed document, with Digital Bahi as the app around it.

(The code still uses the working name `vyapaar` for packages, the database and its roles; users never see it.)

> **Status:** Phases 1–2 (architecture, UI/UX) are done, the **Phase 3 MVP is built as a multi-tenant SaaS** (a Fastify API over PostgreSQL with web screens for billing, customers, products, suppliers, purchases, payments, inventory, godowns and transfers, sales orders, returns, CSV import, printing and WhatsApp share, reports, GST summary, audit log, users & roles and settings), and **Phase 4 is built**: expenses with GST input credit, GSTR-1 files (JSON for the offline tool, CSV per table) and the GSTR-3B working with month lock and filing record, employees, attendance, leave and payroll with printable salary slips, packing (scan-to-pack, first-expiry-first batches, packing slips) and dispatch (trips, delivery updates, trip sheets), discount / rate-difference credit notes and supplier credit notes, and profit, P&L and product-movement reports. Since then: supplier bill import (Excel, CSV, PDF), PDF reports, **invoice, note and receipt PDFs made on the server** (shared as files from phones), **WhatsApp Business and email** (bills with the PDF and payment reminders from the firm's own number), the installable app, and **billing without internet** (device bill series, sync when back online). The next step is a pilot with a real distributor. E-invoicing (IRN) is intentionally not included yet. See [docs/11-roadmap.md](docs/11-roadmap.md).

## Design documents

| | Document | Contents |
|---|---|---|
| A | [Product architecture](docs/01-architecture.md) | System overview, modules, request lifecycle, critical transactions, reporting, files, notifications, localisation, deployment |
| B | [Technology stack](docs/02-technology-stack.md) | Every choice and why; platform support; hosting cost |
| C | [Database design](docs/03-database-design.md) | Conventions, ER diagrams, 86-table catalogue, integrity guarantees, indexing |
| D | [API design](docs/04-api-design.md) | REST conventions, error format, all endpoints, example requests |
| E | [UI/UX design system](docs/05-design-system.md) | Principles, tokens, components, layout, patterns, shortcuts, Hindi glossary, accessibility |
| F | [Screen specifications](docs/06-screens.md) | All 22 requested screens plus supporting screens |
| G | [Invoice intelligence](docs/07-invoice-intelligence.md) | Exactly how purchase-history suggestions, reorder lists and search ranking work |
| H | [GST architecture](docs/08-gst-architecture.md) | Calculation, recording, reporting and export as separate layers; updating when rules change |
| I | [Security](docs/09-security.md) | Authentication, authorisation, data protection, audit |
| — | [Offline & sync](docs/10-offline-sync.md) | What works offline, numbering, sync protocol, conflicts |
| J, K | [Roadmap & MVP](docs/11-roadmap.md) | Testable milestones, MVP scope, risks and open questions |

## Repository

```
apps/
  api/            Fastify REST API, multi-tenant (180 integration tests against PostgreSQL)
  web/            React 19 + Vite + Tailwind 4 — live on the API; demo mode for previews
packages/
  core/           Pure TypeScript business logic shared by server and clients (85 tests)
  contracts/      Zod request schemas and response types shared by API and clients
  i18n/           English + Hindi catalogues, Indian number/date/currency formatting (14 tests)
  db/             PostgreSQL schema (Drizzle), SQL migrations, roles, seeds (9 tests)
deploy/           Caddy configuration (TLS, same-origin /api)
docs/             Architecture and design (A–K)
```

### What is implemented

* **`@vyapaar/core`** — GST return formatters (GSTR-1 JSON / offline-tool CSV, GSTR-3B with credit set-off in the rule 88A order, golden-file tests); payroll (payable days, salary slips, advance recovery); exact-decimal money; GST engine with effective-dated, value-conditional rates, intra/inter-state and UTGST, tax-inclusive pricing, cess, invoice-level discount apportionment and round-off; invoice/document totals with rate-wise and HSN summaries; financial-year numbering with GST number-format checks; stock rules (negative-stock policy, FEFO batch picking, moving-average cost, expiry); payment allocation, aging, credit checks and payment behaviour; configurable order workflow; explainable product suggestions (reorder due, frequently bought, bought together, last order) and product search ranking; GSTIN/PAN/IFSC/mobile/pincode/HSN validators; amount in words (English and Hindi); permission catalogue and default roles.
* **`@vyapaar/i18n`** — typed translation keys, English and Hindi catalogues with parity checks, lakh/crore formatting.
* **`@vyapaar/db`** — 86 tables covering every module; append-only ledgers, no deletion of posted documents, GST period locks and tenant row-level security enforced by PostgreSQL; reference and per-business seeds.
* **`apps/api`** — one transaction per business action with PostgreSQL row-level security (the API connects as a role that cannot bypass it): OTP sign-up that creates the business with its defaults, password/OTP login, rotating refresh tokens with theft detection, several businesses per user, members and roles with anti-escalation rules; masters with GSTIN checks and duplicate hints; invoice posting (gap-free numbers under concurrency, rate lists, dated GST rules, server-verified totals, stock and party ledgers, GST register, payment at sale, idempotency keys), cancellation, purchase bills (batches, landed and moving-average cost, reverse charge, ITC), stock ledger and adjustments, receipts and supplier payments (allocation, advances, cheque bounce), statements, dashboard, reports with CSV export, GST summary, search, audit log; expenses, GST return files and month locking, employees / attendance / leave / payroll, packing and dispatch, value-only credit notes, profit / P&L / product reports. Supplier and employee bank accounts, PAN and Aadhaar are encrypted at rest.
* **`apps/web`** — sign-up / sign-in (password or OTP) and business picker; app shell (desktop sidebar, phone bottom navigation), login, dashboard, **create invoice** (desktop and phone flows, live GST, smart suggestions with reasons, keyboard shortcuts, barcode entry, credit warnings), printable tax invoice in English or Hindi, customers, customer profile (ledger, reorder list), products, settings (language, theme, devices for offline billing), **offline billing** (opens without a network, bills numbered by the device and synced later), global search (Ctrl+K), design-system gallery, and a page for every planned module showing its tables and endpoints.

## Getting started

**Step-by-step instructions for everyone** (running it on a computer, installing the desktop app on Windows / Mac / Linux and the mobile app on Android / iPhone, putting it on a server with your own web address, backups and troubleshooting) are in **[HOW-TO-RUN.md](HOW-TO-RUN.md)**. The short version for developers:

Requirements: Node.js 22+, pnpm 10, PostgreSQL 16+.

```bash
pnpm install
pnpm typecheck
# unit tests, plus database and API integration tests (each test file creates and drops its own database)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
pnpm build
```

### Run it locally

```bash
createdb vyapaar_dev                                  # as the database owner
# migrations, the restricted application role (vyapaar_app) and reference data
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/vyapaar_dev APP_DB_PASSWORD=devpass pnpm db:deploy
# API on :3000 (OpenAPI at http://localhost:3000/api/docs); OTP codes are shown in the sign-up screen
DATABASE_URL=postgres://vyapaar_app:devpass@localhost:5432/vyapaar_dev OTP_DEV_ECHO=true pnpm dev:api
pnpm dev:web                                          # http://localhost:5173, proxies /api to the API
```

Open the web app, choose **Create account**, and the business is created with default roles, number series, GST rate buckets and a main godown. A typical first day: **Products → Add product**, **Suppliers → Add supplier**, **Purchases → New purchase bill** (Alt+P) to bring stock in, **Customers → Add customer**, then **New Invoice** (Ctrl+I) and **Payments → Receive payment** (Alt+C).

Nine browser end-to-end scripts run against a real API and database (see the header of each file): `apps/web/e2e/billing-flow.mjs` (sign-up, bill, server total, the invoice PDF downloaded and shared as a file from a phone, session restore), `apps/web/e2e/operations-flow.mjs` (product editor, supplier, purchase bill with the server agreeing on the total, supplier payment, stock adjustment, collection, reports, GST summary, team and roles, settings), `apps/web/e2e/onboarding-orders-flow.mjs` (CSV import, second godown and transfer, sales order to part invoice, sales return with a printable credit note, receipt print, audit log, GST netting of returns) `apps/web/e2e/phase4-flow.mjs` (order, packing, invoice, discount note, dispatch and delivery, expense with GST, employee, attendance, leave, payroll to a printed slip, GSTR-1 file, GSTR-3B, month lock, profit and P&L) and `apps/web/e2e/bill-import-flow.mjs` (products from an Excel sheet, a supplier's Excel bill matched, reviewed and saved, then the same bill again: remembered and flagged as a duplicate) and `apps/web/e2e/branding-flow.mjs` (Digital Bahi on the sign-in screen, the firm's address, mobile, email and logo, the menu, a printed invoice with the firm's letterhead, the phone menu) and `apps/web/e2e/pdf-flow.mjs` (products from a company's PDF price list, a supplier's printed PDF bill read, matched and saved, the purchases report downloaded as PDF and CSV) and `apps/web/e2e/offline-flow.mjs` (on the production build: the app opens without a network, two bills saved offline with the device's numbers, sign-out refused offline, the bills synced with their numbers when the connection returns, a bill made during a drop sent by itself) and `apps/web/e2e/messaging-flow.mjs` (the firm's WhatsApp Business number set up with its token hidden, an invoice sent with its PDF, listed under Messages, a payment reminder to a customer with an overdue bill).

To bring an existing business in, use **Products → Import** and **Customers → Import**: download the template or upload the Excel file (.xlsx), a CSV, or a PDF made by other billing software (a company's price list, for example; common header names are recognised); every row is checked first and nothing is saved until the whole file is right.

To enter a supplier's bill from the file they send, use **Purchases → Import bill**: upload their Excel or CSV bill, or the PDF their billing software printed (exports from Marg, Tally, Busy or a company DMS work: title rows above the header, bill number only on the first line, split CGST / SGST, scheme quantity, PTR, batch and expiry are all understood; in a PDF the bill number, date and the supplier's GSTIN are read from above the table, and item names that wrap onto a second line are joined). A scanned or photographed PDF has no text to read and gets a message asking for the Excel or the software's PDF instead. The supplier is found by GSTIN or name, and each item by barcode, code or name; the rest you pick from close matches or add as new products. The bill then opens in purchase entry for checking, and the matches you keep are remembered for that supplier, so their next bill matches on its own. A bill already entered is flagged.

Every report (sales, collections, purchases, outstanding, expenses, profit, product movement) downloads as **PDF** or **Excel (CSV)**. The PDF carries the firm's letterhead (logo, name, address, contact, GSTIN), the period, the table with its totals and page numbers, and prints Hindi names correctly.

Demo mode without a server: `VITE_DATA_SOURCE=mock pnpm dev:web`, or `pnpm --filter @vyapaar/web build:preview` for a single shareable HTML file. In demo mode: **New Invoice** (Ctrl+I) → type `ABC` and press Enter → the suggestions explain themselves ("Usually every 7 days · last bought 6 days ago") → Alt+1 adds the first → F2 and type `namak` → Ctrl+Enter saves. Switch **EN / हिं** in the top bar at any time.

### Deploy (one server)

```bash
cp .env.example .env                  # fill in passwords, domain and the OTP gateway URL
pnpm --filter @vyapaar/api keys       # prints JWT_PRIVATE_KEY, JWT_PUBLIC_KEY, DATA_ENCRYPTION_KEY for .env
docker compose up -d --build          # PostgreSQL, release job (migrations), API, Caddy with TLS
```

The API refuses to start in production without signing keys, the data-encryption key and an OTP gateway (`OTP_WEBHOOK_URL`, which receives `{mobile, code, purpose}` and sends the SMS/WhatsApp). Back up `DATA_ENCRYPTION_KEY`: data encrypted with a lost key cannot be recovered.

## Notes for reviewers

* GST rates, thresholds and product data in seeds and samples are **illustrative**; the system stores them as dated configuration to be verified against current notifications before go-live.
* Keyboard shortcuts: Ctrl+K (search) and Ctrl+I (invoice) are as requested; purchase and collection use **Alt+P / Alt+C** because Ctrl+P and Ctrl+C are the browser's Print and Copy.
