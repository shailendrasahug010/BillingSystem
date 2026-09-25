# J. Development roadmap · K. MVP

Work proceeds in small milestones. Each one ends with something a real user can try and a test suite that keeps it working, so nothing later breaks what is already in use. Estimates assume a team of 2–3 full-stack developers plus part-time design and QA.

## Where we are

| Phase | Status | What exists |
|---|---|---|
| **1 · Product architecture** | ✅ Done | This `docs/` folder (A–K), repository structure, CI |
| **Foundations pulled forward from later phases** | ✅ Done | `@vyapaar/core` (GST engine, invoice totals, stock rules, receivables, credit, workflow, suggestions, search, validators, RBAC) with 66 unit tests; `@vyapaar/i18n` (English + Hindi, parity tests); `@vyapaar/db` (86-table schema, migrations, integrity triggers, row-level security, seeds) with integration tests on PostgreSQL |
| **2 · UI/UX** | ✅ Done for the key screens | Design tokens and components, app shell (desktop sidebar, phone bottom navigation), Login, Dashboard, **Create Invoice** (desktop and phone flows, live GST, smart suggestions), Invoice document (A4, English/Hindi), Customers, Customer profile, Products, Settings, Global search, Design system gallery; remaining screens specified in [06-screens.md](06-screens.md) |
| **3 · MVP** | ✅ 3.1–3.7 built; 3.8 (pilot) next | Multi-tenant SaaS API (`apps/api`, Fastify) with self-service sign-up, auth, team and roles, masters, invoicing, purchases, inventory, payments, dashboard, reports, search — 92 integration tests against PostgreSQL; web app connected (live mode) and verified end to end in a browser; Docker/Compose/Caddy deployment files |
| **4 · Operations, people, GST** | ✅ Built (4.1–4.7) | Expenses with GST input credit; GSTR-1 JSON / CSV and the GSTR-3B working from versioned formatters, month lock and filing record; employees, attendance, leave and payroll with printable slips; packing (scan-to-pack, FEFO batches, packing slips) and dispatch (trips, deliveries, trip sheets); discount / rate-difference and supplier credit notes; profit, P&L and product-movement reports — 148 API integration tests, 78 core tests, four browser end-to-end flows |
| 5–6 | Planned | See below |

The web app runs against the API; the single-file preview build keeps the demo data so the design can be shared without a server.

### Phase 3: what was built, and what moved

* **Built as planned:** posting transactions for invoices, purchases and payments (gap-free numbering under concurrency, stock and party ledgers, GST register, audit, outbox rows), cancellations with reversals, GST period lock, credit and negative-stock policies, rate lists, moving-average and landed cost, reverse charge, ITC eligibility, batches and expiry, allocation and advances, cheque bounce, statements, aging, dashboard, reports with CSV export, GST summary (B2B/B2CL/B2CS, HSN), global search, purchase-history suggestions with reasons, English/Hindi messages for every API error.
* **SaaS additions:** self-service sign-up with OTP creates the business with its defaults (roles, series, settings, godown, cash account, starter GST rate buckets from the 22-Sep-2025 structure); users can own or join several businesses; trial/active/suspended status; RLS on the businesses table itself; foreign-key ids checked against the tenant.
* **Web screens:** every Phase 3 API has its screen in the live app (products add/edit, suppliers and statements, purchase bill entry, payments with allocation / advances / cheque status / cancel, inventory with stock ledger and adjustments, sales / collection / purchase / outstanding reports with CSV export, monthly GST summary, users & roles, business profile, rules and number series). Module screens load on first use to keep the first load small. `apps/web/e2e/operations-flow.mjs` drives them end to end.
* **Changed:** Fastify instead of NestJS (see [02-technology-stack.md](02-technology-stack.md#fastify-api)).
* **Added before the pilot** (first planned as Phase 3 leftovers or Phase 4): sales orders with confirmation and full / partial invoicing through the same posting code as invoices, open-order demand against stock; sales and purchase returns as credit / debit notes (stock, ledgers, document balances, GST register with the original invoice, netted in the GST summary); CSV import of products and customers with row-level errors (5,000 products in about two seconds); godowns and stock transfers; printable receipts / vouchers and credit / debit notes, "Save as PDF" from the print dialog, WhatsApp share links; configurable invoice terms; audit log screen.
* **Moved to Phase 4:** pg-boss worker (outbox rows are already written; summaries are computed live today), server-side PDF and the WhatsApp Business API / email adapters (the browser prints the same templates and opens WhatsApp with the message), object storage (MinIO/S3) and bill photos, XLSX files (CSV import is built), packing and dispatch documents (order statuses can already be moved through packing, dispatch and delivery), returns against reverse-charge bills, device registry. The 10,000-invoice randomised client/server property test is replaced for now by: one shared engine, the server rejecting any total difference (`TOTALS_MISMATCH`), and a browser end-to-end run that posts a bill and checks the server total.

### Phase 4: what was built, and what is left

* **4.1 Sales orders** (built before the pilot): workflow steps per business, status history, partial invoicing. Packing and dispatch now move orders through packed, dispatched and delivered.
* **4.2 Packing & dispatch:** packing queue of confirmed orders with what is left per line, scan-to-pack by barcode or name, batches split first-expiry-first, box numbers and weight, printable packing slips, unpack; dispatch of posted bills (with or without an order) as trips with vehicle, driver or employee, transporter and LR, stops in delivery order, planned or leaving now, delivered / partly delivered / returned per stop with the receiver's name, loading list, printable trip sheet with amounts to collect.
* **4.3 Credit/debit notes:** returns (built before the pilot) plus value-only notes: discount after sale and rate difference against an invoice, and the supplier's credit note on a purchase, by percent, amount spread over the lines, or per line; later returns credit only what the goods are still worth.
* **4.4 GST reports & exports:** `gstr1-json@2025.05` (B2B, B2CL, B2CS net of returns, CDNR, CDNUR for notes on B2CL sales, nil / exempt, HSN split B2B / B2C, document summary with cancelled numbers) with warnings to fix before filing, the offline tool's CSV layout per table, every download recorded with its formatter version; GSTR-3B (3.1, 3.2, 4 with section 17(5) reversal, indicative 6.1 with credit used in the rule 88A order and reverse charge in cash); lock / unlock a month and record the filing ARN. Golden-file tests use a month worked out by hand. **Open:** acceptance by the GST offline tool with a real month (the JSON layout and version string must be confirmed against the tool in use before the first filing).
* **4.5 Employees, leave, payroll:** employee master (bank / PAN / Aadhaar encrypted, full values only with `employee.view_sensitive`, audited), departments, daily attendance with overtime and a month register, leave types / balances / requests with approval, salary structures from a date, advances and loans, monthly payroll from attendance and unpaid leave (calendar-month basis) with manual amounts, recalculation, finalize (recoveries applied), pay (one payment per person), salary slip in English or Hindi. **Open:** statutory PF / ESI / PT rule tables (entered as structure amounts or monthly amounts today) and a 25-employee comparison with a real spreadsheet.
* **4.6 Expenses:** categories (editable, Hindi names), entry with the amount before or including GST, vendor GSTIN for input credit (not claimable for composition / unregistered businesses), cancel, report by category / month / method with CSV.
* **4.7 Advanced reports:** margin by product, company, category, customer, salesperson or month (net of returns and discounts, cost at the time of sale), P&L (gross profit, expenses, salaries of finalized months, net profit), product movement (fast / slow / not moving, stock value, days of cover). Saved report views and PDF export of reports remain open.
* **Added after Phase 4:** supplier bill import (Purchases → Import bill: the supplier's Excel / CSV bill matched to our products, reviewed in purchase entry, matches remembered per supplier, duplicate bills flagged); Excel (.xlsx) for product and customer imports; the web app is installable on Windows, Mac, Linux, Android and iPhone (manifest, icons, a service worker that opens the app without a network and updates only when the user reloads); [HOW-TO-RUN.md](../HOW-TO-RUN.md) for running, installing and deploying it; the product is named **Digital Bahi** (logo, tagline, colours, app icon), and each firm has its own identity next to it (uploaded logo, name, address, mobile, email) on screen and on every printed document.
* **PDF import and export:** supplier bills, price lists and customer lists can be imported from PDFs made by billing software (read on the device with pdf.js; scanned PDFs are refused with a message); every report downloads as a PDF with the firm's letterhead, totals and page numbers (made on the server with PDFKit and IBM Plex Sans Devanagari). Photo attachments (bill photos, receipts, proof of delivery) were dropped at the owner's request.
* **Offline billing:** the app opens without a network from the copy of the business kept on the device; bills are saved offline with the device's own series (A1/26-27/0001), printed at once, and sent by themselves when the connection is back (idempotent, numbers kept, block rules only warn); device list and removal in Settings. Payments, orders and customer edits offline, the pull feed and the "needs review" state remain for 5.3 ([10-offline-sync.md](10-offline-sync.md#0-what-is-built-today)).
* **Document PDFs:** tax invoices, bills of supply, credit / debit notes and receipts / payment vouchers are made as PDF files on the server (PDFKit, the firm's letterhead and logo, GST table with CGST / SGST or IGST, HSN summary, totals with payments and returns, amount in words, terms, signatory, page numbers; English or Hindi with Devanagari shaping). **Download PDF** everywhere; on phones **WhatsApp** shares the PDF file itself with the message.
* **WhatsApp Business and email:** each firm's own WhatsApp Business number (Meta Cloud API with approved templates and the PDF as a document header, or any provider through a signed webhook) and email (the platform's mail server or the firm's SMTP); secrets encrypted and write-only; **Send** on invoices, notes and receipts; **Messages** with the log of every send (status, error, retry) and **payment reminders** to customers with overdue bills (queued and sent in the background); new `message.view` / `message.send` permissions; test mode records instead of sending.
* **Excel reports:** every report downloads as an .xlsx workbook (write-excel-file on the server): title, firm and period on top, frozen header row, numbers and dates as real values, totals in bold; text is never written as a formula.
* **Still not built (moved to later phases):** pg-boss worker (outbox rows are written), WhatsApp delivery and read receipts (Meta webhooks), reading scanned bills (OCR), returns against reverse-charge bills, exports and SEZ supplies in GSTR-1, native shells (Capacitor for Android device features, Tauri for direct printing on Windows; store listing works today by packaging the installable app, see HOW-TO-RUN.md section 6).

## Milestones

Each milestone lists its **acceptance test**: the demonstration that proves it is done.

### Phase 3 — MVP (≈ 10–12 weeks)

| # | Milestone | Scope | Acceptance test |
|---|---|---|---|
| 3.1 | API skeleton | `apps/api` (Fastify), config, request context, error format, Zod contracts package, OpenAPI, health checks, pg-boss worker, Docker Compose (API, worker, PostgreSQL, MinIO, Caddy), CI with a Postgres service | `docker compose up` gives a running API; `/health` green; CI runs unit + integration tests on every PR |
| 3.2 | Authentication & access | Login (password + OTP), refresh rotation, devices, business switch, roles/permissions guard, RLS session variables, audit log writer, users & roles screens | Role matrix tests: each default role × each endpoint allowed/denied; cross-tenant test returns 404 |
| 3.3 | Masters | Customers, suppliers, products (units, barcodes, rate lists, tax categories/rates, batches), brands, categories, godowns; Excel import; catalogue delta feed | Import 5,000 products and 1,000 customers; search returns in < 100 ms on the server, < 20 ms on the device |
| 3.4 | Invoicing | Invoice posting transaction (numbering, stock ledger, party ledger, GST register, payment at sale), cancel, PDF (A4/A5/thermal, English/Hindi), WhatsApp/email share adapter, connect the Create Invoice screen | 200 concurrent invoice posts: no duplicate numbers, no negative stock under `block`, ledgers equal balances; totals identical client vs server for 10,000 randomised invoices (property test) |
| 3.5 | Purchases & inventory | Purchase entry and posting (batches, cost), purchase returns, stock list, stock ledger, adjustments, transfers | Stock ledger reproduces every balance; moving-average cost matches a hand-computed fixture |
| 3.6 | Payments | Receipts and supplier payments, allocations (oldest first / manual), advances, cheque status, receipt PDF, customer/supplier ledgers and statements | Statement for a customer reconciles to invoices − receipts ± notes to the paisa |
| 3.7 | Basic reports & dashboard | Dashboard from summary tables, sales/collection/purchase reports (day/week/month/year, customer, product, company), outstanding + aging, Excel/CSV export | Dashboard loads in < 1 s with 2 years of data for a 1,000-invoice/day business |
| 3.8 | Pilot | One real distributor in parallel with their current software for 2–4 weeks | Daily totals, GST summary and outstanding match the old system |

### Phase 4 — Operations, people, GST (≈ 8–10 weeks)

| # | Milestone | Scope | Acceptance test |
|---|---|---|---|
| 4.1 | Sales orders | Order workflow (configurable steps), status history, partial invoicing | Every allowed/forbidden transition tested; partial flows reconcile |
| 4.2 | Packing & dispatch | Packing queue, scan-to-pack, FEFO batch picking, packing slips, dispatch trips (vehicle, driver, transporter, LR), delivery updates, proof of delivery | A 30-order route packed and dispatched on tablets with scanners |
| 4.3 | Credit/debit notes | Sales returns, rate differences, post-sale discounts, supplier notes | Notes flow into ledgers, stock and the GST register correctly |
| 4.4 | GST reports & exports | Summaries, HSN/rate reports, registers, validations, GSTR-1 JSON/Excel/CSV and GSTR-3B summary via versioned formatters, period locking | Golden-file tests per formatter version; a real month's export accepted by the GST offline tool |
| 4.5 | Employees, leave, payroll | Employee master, attendance, leave types/requests/balances, salary structures, payroll runs, slips (PDF, Hindi/English), advances/loans | A month's payroll for 25 employees matches the business's spreadsheet |
| 4.6 | Expenses | Expense entry with receipts and GST (ITC), category/monthly/yearly reports | |
| 4.7 | Advanced reports | Product analytics, company-wise reports, salesperson-wise, category-wise, saved views, PDF exports | |

### Phase 5 — Intelligence, notifications, offline (≈ 6–8 weeks)

| # | Milestone | Scope | Acceptance test |
|---|---|---|---|
| 5.1 | Purchase-history service | Outbox-driven `customer_product_stats`, nightly association mining and drift check, suggestion and reorder endpoints, feedback capture | Stats rebuild equals incremental stats; suggestions < 50 ms p95 |
| 5.2 | Notifications | Reminder rules and scheduler, in-app inbox + SSE, FCM push, WhatsApp/SMS templates in English and Hindi, opt-outs | Each reminder type fires once per condition (dedupe) at the configured time |
| 5.3 | Offline-first | Service worker, IndexedDB cache, mutation outbox, device series, sync push/pull, conflict and "needs review" handling, sync status UI | Chaos test: 3 devices offline for a day, 300 invoices + 100 receipts, sync with no duplicates and all totals matching |
| 5.4 | Android app | Capacitor shell, ML Kit barcode camera, Bluetooth thermal printing, share sheet, route-based salesperson mode (beat plan with reorder suggestions) | Field test with two salespeople on a real beat |
| 5.5 | Business intelligence | KPIs (gross margin, inventory value & turnover, fast/slow movers, customer and company contribution), period comparison | |

### Phase 6 — Hardening and launch (≈ 4–6 weeks)

| # | Milestone | Scope | Acceptance test |
|---|---|---|---|
| 6.1 | Backup & restore | Scheduled/manual encrypted backups, download, guarded restore, point-in-time recovery | Restore drill on a copy completes within the target time |
| 6.2 | Security hardening | MFA enforcement, field encryption with KMS, rate limits, CSP, dependency and secret scanning, penetration test | No high/critical findings open |
| 6.3 | Performance | Load tests (3× the largest pilot), query plans for every list/report, ledger partitioning plan, bundle code-splitting per module | p95 API < 300 ms, invoice post < 500 ms at target load |
| 6.4 | Windows app | Tauri shell, direct printing (A4, ESC/POS thermal), auto-update, local backup folder | |
| 6.5 | Integrations | E-invoice (IRN) and e-way bill via provider adapters; optional GSP filing | Sandbox-certified flows |
| 6.6 | Launch | Onboarding (import from Excel/Tally exports), help content in English and Hindi, monitoring and on-call | |

## K. MVP: the first version a distributor can run their day on

**Goal:** a distributor can stop using their old billing software for daily work: bill customers with correct GST, keep stock right, record purchases, collect money and know who owes what.

### In the MVP

| Area | Included |
|---|---|
| Access | Login (password + OTP), 6 default roles + editable permissions, multiple users, audit log |
| Masters | Customers (with GSTIN validation, credit limit, terms, routes), suppliers, products (HSN, tax category, units, barcodes, rate lists, batch/expiry), godowns, Excel import |
| Sales | **Fast invoice** (desktop + phone), smart suggestions from purchase history (client-side, from synced stats), A4/thermal PDF and print in English/Hindi, WhatsApp/email share, cancel with reversal, payment at sale |
| Purchases | Purchase entry with batches and cost update, purchase returns |
| Inventory | Stock list, stock ledger, adjustments with reasons, low-stock and expiry alerts on the dashboard |
| Money | Customer receipts and supplier payments with allocation, ledgers/statements, outstanding and aging |
| GST | Correct CGST/SGST/UTGST/IGST, dated tax rules, GST register populated from day one, basic GST summary and HSN summary (full return exports in Phase 4) |
| Reports | Dashboard; sales, collection, purchase reports by period, customer, product and company; outstanding; Excel/CSV export |
| Platform | Web app (responsive, installable PWA, online), English + Hindi, daily backups, deployment on a single VPS |

### Deliberately not in the MVP

Sales orders, packing and dispatch · credit/debit notes beyond returns · GSTR-1/3B file exports and filing · e-invoicing and e-way bill · payroll, leave, attendance · expenses · full offline mode and the Android/Windows apps · notifications beyond the dashboard · BI analytics · restore UI (restores done by support).

Why this cut: these are the operations a distributor performs every day and the ones where errors cost money (wrong tax, wrong stock, lost collections). Everything else builds on the same data and can be added module by module without migrating what exists.

## Risks and open questions

| Risk / question | Mitigation / decision needed |
|---|---|
| **GST rates and thresholds in seed and sample data are illustrative** | Verify against current notifications before go-live; maintain as dated data (runbook in [08-gst-architecture.md](08-gst-architecture.md#8-runbook-the-government-changed-a-rule)) |
| E-invoicing needed at launch? (mandatory above the turnover threshold) | If pilot customers are above it, move 6.5 into Phase 4 |
| Single-tenant install vs SaaS first | Architecture supports both; decides hosting, onboarding and pricing |
| Tally data migration | Most distributors run Tally: an import of masters and opening balances (and an export for their CA) is likely a sales requirement |
| Invoice numbering offline | Device series (default) vs "draft until sync": the business's CA should confirm their preference |
| Keyboard shortcuts | Ctrl+P / Ctrl+C conflict with browser Print / Copy; the design uses Alt+P / Alt+C (Ctrl+I and Ctrl+K kept as requested). Confirm with users; a Tally-style F-key preset is planned |
| Hindi copy | Glossary in [05-design-system.md](05-design-system.md#8-localisation) should be reviewed by 3–5 real users (counter staff, salespeople) |

## Definition of done (every milestone)

* Unit tests for business logic in `@vyapaar/core`; integration tests for every transaction against PostgreSQL; E2E test for the user flow (Playwright).
* English and Hindi strings complete (parity test green).
* Permissions defined and tested; audit entries written for every change to money, stock or access.
* Works at 360 px and 1440 px widths; keyboard reachable; empty/loading/error states present.
* Migrations are additive and backward-compatible; documentation updated.
