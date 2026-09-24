# Vyapaar CRM

Distributor & supplier CRM, billing, inventory, GST and collections for Indian FMCG distributors, wholesalers and suppliers. Web, Windows and Android from one code base, in English and Hindi.

> **Status:** Phase 1 (architecture) and Phase 2 (UI/UX for the key screens) are done, together with the shared business-logic engine, the localisation package and the full database schema. The web app is a working **prototype on sample data** (nothing is saved). Phase 3 connects it to a real API. See [docs/11-roadmap.md](docs/11-roadmap.md).

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
  web/            React 19 + Vite + Tailwind 4 — design system and key screens (prototype)
packages/
  core/           Pure TypeScript business logic shared by server and clients (66 tests)
  i18n/           English + Hindi catalogues, Indian number/date/currency formatting (11 tests)
  db/             PostgreSQL schema (Drizzle), SQL migrations, seeds, integration tests (9 tests)
docs/             Architecture and design (A–K)
```

### What is implemented

* **`@vyapaar/core`** — exact-decimal money; GST engine with effective-dated, value-conditional rates, intra/inter-state and UTGST, tax-inclusive pricing, cess, invoice-level discount apportionment and round-off; invoice/document totals with rate-wise and HSN summaries; financial-year numbering with GST number-format checks; stock rules (negative-stock policy, FEFO batch picking, moving-average cost, expiry); payment allocation, aging, credit checks and payment behaviour; configurable order workflow; explainable product suggestions (reorder due, frequently bought, bought together, last order) and product search ranking; GSTIN/PAN/IFSC/mobile/pincode/HSN validators; amount in words (English and Hindi); permission catalogue and default roles.
* **`@vyapaar/i18n`** — typed translation keys, English and Hindi catalogues with parity checks, lakh/crore formatting.
* **`@vyapaar/db`** — 86 tables covering every module; append-only ledgers, no deletion of posted documents, GST period locks and tenant row-level security enforced by PostgreSQL; reference and per-business seeds.
* **`apps/web`** — app shell (desktop sidebar, phone bottom navigation), login, dashboard, **create invoice** (desktop and phone flows, live GST, smart suggestions with reasons, keyboard shortcuts, barcode entry, credit warnings), printable tax invoice in English or Hindi, customers, customer profile (ledger, reorder list), products, settings (language, theme, offline simulation), global search (Ctrl+K), design-system gallery, and a page for every planned module showing its tables and endpoints.

## Getting started

Requirements: Node.js 22+, pnpm 10, PostgreSQL 16+ (only for the database tests).

```bash
pnpm install
pnpm dev:web          # prototype at http://localhost:5173
pnpm test             # core + i18n unit tests; db tests are skipped without DATABASE_URL
pnpm typecheck
pnpm build

# database integration tests (creates and drops a temporary database)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @vyapaar/db test
```

Try in the prototype: **New Invoice** (Ctrl+I) → type `ABC` and press Enter → the suggestions explain themselves ("Usually every 7 days · last bought 6 days ago") → Alt+1 adds the first → F2 and type `namak` → Ctrl+Enter saves. Switch **EN / हिं** in the top bar at any time.

## Notes for reviewers

* GST rates, thresholds and product data in seeds and samples are **illustrative**; the system stores them as dated configuration to be verified against current notifications before go-live.
* Keyboard shortcuts: Ctrl+K (search) and Ctrl+I (invoice) are as requested; purchase and collection use **Alt+P / Alt+C** because Ctrl+P and Ctrl+C are the browser's Print and Copy.
