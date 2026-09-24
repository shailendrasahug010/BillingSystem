# J. Development roadmap · K. MVP

Work proceeds in small milestones. Each one ends with something a real user can try and a test suite that keeps it working, so nothing later breaks what is already in use. Estimates assume a team of 2–3 full-stack developers plus part-time design and QA.

## Where we are

| Phase | Status | What exists |
|---|---|---|
| **1 · Product architecture** | ✅ Done | This `docs/` folder (A–K), repository structure, CI |
| **Foundations pulled forward from later phases** | ✅ Done | `@vyapaar/core` (GST engine, invoice totals, stock rules, receivables, credit, workflow, suggestions, search, validators, RBAC) with 66 unit tests; `@vyapaar/i18n` (English + Hindi, parity tests); `@vyapaar/db` (86-table schema, migrations, integrity triggers, row-level security, seeds) with integration tests on PostgreSQL |
| **2 · UI/UX** | ✅ Done for the key screens | Design tokens and components, app shell (desktop sidebar, phone bottom navigation), Login, Dashboard, **Create Invoice** (desktop and phone flows, live GST, smart suggestions), Invoice document (A4, English/Hindi), Customers, Customer profile, Products, Settings, Global search, Design system gallery; remaining screens specified in [06-screens.md](06-screens.md) |
| **3 · MVP** | ✅ 3.1–3.7 built; 3.8 (pilot) next | Multi-tenant SaaS API (`apps/api`, Fastify) with self-service sign-up, auth, team and roles, masters, invoicing, purchases, inventory, payments, dashboard, reports, search — 92 integration tests against PostgreSQL; web app connected (live mode) and verified end to end in a browser; Docker/Compose/Caddy deployment files |
| 4–6 | Planned | See below |

The web app runs against the API; the single-file preview build keeps the demo data so the design can be shared without a server.

### Phase 3: what was built, and what moved

* **Built as planned:** posting transactions for invoices, purchases and payments (gap-free numbering under concurrency, stock and party ledgers, GST register, audit, outbox rows), cancellations with reversals, GST period lock, credit and negative-stock policies, rate lists, moving-average and landed cost, reverse charge, ITC eligibility, batches and expiry, allocation and advances, cheque bounce, statements, aging, dashboard, reports with CSV export, GST summary (B2B/B2CL/B2CS, HSN), global search, purchase-history suggestions with reasons, English/Hindi messages for every API error.
* **SaaS additions:** self-service sign-up with OTP creates the business with its defaults (roles, series, settings, godown, cash account, starter GST rate buckets from the 22-Sep-2025 structure); users can own or join several businesses; trial/active/suspended status; RLS on the businesses table itself; foreign-key ids checked against the tenant.
* **Changed:** Fastify instead of NestJS (see [02-technology-stack.md](02-technology-stack.md#fastify-api)).
* **Moved to Phase 4:** pg-boss worker (outbox rows are already written; summaries are computed live today), server-side PDF and WhatsApp/email share (the browser prints the same template), object storage (MinIO/S3), Excel import, purchase returns and stock transfers, receipt PDF, device registry. The 10,000-invoice randomised client/server property test is replaced for now by: one shared engine, the server rejecting any total difference (`TOTALS_MISMATCH`), and a browser end-to-end run that posts a bill and checks the server total.

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
