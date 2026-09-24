# Vyapaar CRM

Distributor & supplier CRM, billing, inventory, GST and collections for Indian FMCG distributors, wholesalers and suppliers. Web, Windows and Android from one code base, in English and Hindi.

> **Status:** Phases 1–2 (architecture, UI/UX) are done, and the **Phase 3 MVP is built as a multi-tenant SaaS**: a Fastify API over PostgreSQL (self-service sign-up, auth, roles, masters, invoicing, purchases, stock, payments, dashboard, reports, GST summary, search) and the web app connected to it. The next step is a pilot with a real distributor. E-invoicing (IRN) is intentionally not included yet. See [docs/11-roadmap.md](docs/11-roadmap.md).

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
  api/            Fastify REST API, multi-tenant (92 integration tests against PostgreSQL)
  web/            React 19 + Vite + Tailwind 4 — live on the API; demo mode for previews
packages/
  core/           Pure TypeScript business logic shared by server and clients (66 tests)
  contracts/      Zod request schemas and response types shared by API and clients
  i18n/           English + Hindi catalogues, Indian number/date/currency formatting (14 tests)
  db/             PostgreSQL schema (Drizzle), SQL migrations, roles, seeds (9 tests)
deploy/           Caddy configuration (TLS, same-origin /api)
docs/             Architecture and design (A–K)
```

### What is implemented

* **`@vyapaar/core`** — exact-decimal money; GST engine with effective-dated, value-conditional rates, intra/inter-state and UTGST, tax-inclusive pricing, cess, invoice-level discount apportionment and round-off; invoice/document totals with rate-wise and HSN summaries; financial-year numbering with GST number-format checks; stock rules (negative-stock policy, FEFO batch picking, moving-average cost, expiry); payment allocation, aging, credit checks and payment behaviour; configurable order workflow; explainable product suggestions (reorder due, frequently bought, bought together, last order) and product search ranking; GSTIN/PAN/IFSC/mobile/pincode/HSN validators; amount in words (English and Hindi); permission catalogue and default roles.
* **`@vyapaar/i18n`** — typed translation keys, English and Hindi catalogues with parity checks, lakh/crore formatting.
* **`@vyapaar/db`** — 86 tables covering every module; append-only ledgers, no deletion of posted documents, GST period locks and tenant row-level security enforced by PostgreSQL; reference and per-business seeds.
* **`apps/api`** — one transaction per business action with PostgreSQL row-level security (the API connects as a role that cannot bypass it): OTP sign-up that creates the business with its defaults, password/OTP login, rotating refresh tokens with theft detection, several businesses per user, members and roles with anti-escalation rules; masters with GSTIN checks and duplicate hints; invoice posting (gap-free numbers under concurrency, rate lists, dated GST rules, server-verified totals, stock and party ledgers, GST register, payment at sale, idempotency keys), cancellation, purchase bills (batches, landed and moving-average cost, reverse charge, ITC), stock ledger and adjustments, receipts and supplier payments (allocation, advances, cheque bounce), statements, dashboard, reports with CSV export, GST summary, search, audit log. Supplier bank accounts are encrypted at rest.
* **`apps/web`** — sign-up / sign-in (password or OTP) and business picker; app shell (desktop sidebar, phone bottom navigation), login, dashboard, **create invoice** (desktop and phone flows, live GST, smart suggestions with reasons, keyboard shortcuts, barcode entry, credit warnings), printable tax invoice in English or Hindi, customers, customer profile (ledger, reorder list), products, settings (language, theme, offline simulation), global search (Ctrl+K), design-system gallery, and a page for every planned module showing its tables and endpoints.

## Getting started

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

Open the web app, choose **Create account**, and the business is created with default roles, number series, GST rate buckets and a main godown. Add products and customers, then **New Invoice** (Ctrl+I). `apps/web/e2e/billing-flow.mjs` runs this whole flow in a browser (see the header of that file).

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
