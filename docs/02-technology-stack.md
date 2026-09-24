# B. Technology stack

The stack was chosen for one overriding reason and five supporting ones.

**The overriding reason:** the same business logic must run on the server (authoritative), in the browser (instant totals as the user types) and on an offline Android phone (invoices without internet). That means one language end to end. TypeScript is the only mainstream choice that runs natively in all three places, so the GST engine, invoice totals and suggestion logic exist exactly once, in `@vyapaar/core`.

Supporting criteria, in order: data integrity for money and stock, cross-platform reach (web, Windows, Android) from one UI code base, low hosting cost, maintainability by a small team, and a modern, fast UI.

## Summary

| Layer | Choice | Version in repo | Status |
|---|---|---|---|
| Language | TypeScript (strict) | 6.0 | Used everywhere |
| Shared domain logic | `@vyapaar/core` (pure TS) + decimal.js | 10.6 | **Built, 66 tests** |
| Database | PostgreSQL | 16+ (tested on 16.13) | **Schema built, integration-tested** |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.45 / 0.31 | **Built** |
| API framework | NestJS on the Fastify adapter | 12.x | Phase 3 |
| Validation / contracts | Zod (shared schemas) | 4.x | Phase 3 |
| Background jobs | pg-boss (queues + cron on PostgreSQL) | 12.x | Phase 3 |
| Web UI | React + Vite | 19.3 / 8.3 | **Prototype built** |
| Styling | Tailwind CSS v4 on CSS-variable design tokens | 4.3 | **Built** |
| Accessible primitives | Radix UI (dialog, popover, tabs…) | 1.6 | **Built** |
| Icons | Lucide | 1.x | Used |
| Server state (client) | TanStack Query | 5.x | Phase 3 |
| Routing (client) | TanStack Router | 1.x | Phase 3 |
| Data grids | TanStack Table + TanStack Virtual | 9.x / 3.x | Phase 3 |
| Offline store | IndexedDB via Dexie + service worker (vite-plugin-pwa / Workbox) | 4.x | Phase 5 |
| Localisation | `@vyapaar/i18n` (typed keys, i18next-compatible JSON) | — | **Built** |
| Charts | Hand-built SVG components following one chart spec | — | **Built** (dashboard) |
| Windows desktop | Tauri 2 | 2.x | Phase 6 |
| Android | Capacitor + ML Kit barcode scanning | 8.x | Phase 5–6 |
| PDF | HTML/CSS templates rendered by headless Chromium (Playwright) | — | Phase 3 |
| Excel/CSV export | ExcelJS / streaming CSV | 4.x | Phase 4 |
| Object storage | S3-compatible (AWS S3, Cloudflare R2, or MinIO when self-hosted) | — | Phase 3 |
| Auth crypto | argon2id (password hashing), JWT (EdDSA/ES256), SHA-256 token hashes | — | Phase 3 |
| Observability | pino logs, OpenTelemetry, Sentry | — | Phase 6 |
| Tests | Vitest (unit + DB integration), Playwright (E2E) | 5.0 | **Unit + DB tests running** |
| CI | GitHub Actions (typecheck, tests with a Postgres service, build) | — | **Built** |
| Package manager | pnpm workspaces | 10.x | Used |

## Why each choice

### PostgreSQL (not MySQL, not MongoDB, not Firebase)
* **Exact money:** `NUMERIC` is exact; amounts, rates and quantities are never floats.
* **Integrity in the database:** check constraints, partial unique indexes (`one default warehouse`, `same supplier bill cannot be entered twice`), `UNIQUE NULLS NOT DISTINCT` (stock without a batch is one bucket), triggers that make ledgers append-only and lock filed GST periods — all tested in `packages/db/test/integrity.test.ts`.
* **Row-level security** for tenant isolation as a second line of defence behind the API.
* **Row locks** (`SELECT … FOR UPDATE`) for gap-free invoice numbering and race-free stock.
* **`pg_trgm`** trigram indexes for fuzzy name search; JSONB for typed settings and export summaries.
* **Cheap and everywhere:** runs on a small VPS or any managed service (AWS RDS, Azure, GCP, DigitalOcean, Neon, Supabase), all with Mumbai regions.
* A document store (MongoDB/Firestore) would push multi-document transactional integrity — the most important property of billing and stock — into application code.

### Drizzle ORM (not Prisma, not raw SQL only)
* SQL-shaped query builder: report queries with joins, window functions and aggregates stay readable and type-safe.
* The schema expresses check constraints, partial and trigram indexes and `NULLS NOT DISTINCT` directly; migrations are **plain SQL files** reviewed in pull requests (`packages/db/migrations`). Hand-written SQL migrations (triggers, RLS) sit in the same sequence.
* Thin runtime (no query engine binary), which matters for cold starts and small servers.

### NestJS on Fastify (API)
* Enforces the module structure the architecture depends on (modules, providers, dependency injection), so a growing team does not slide into a tangle.
* Guards (permissions), interceptors (audit, request context), pipes (Zod validation) and OpenAPI generation are built in.
* Fastify adapter for throughput and low memory.
* Alternatives considered: plain Fastify (lighter, but we would rebuild module structure and DI by hand), .NET or Go (excellent, but they break the "one engine everywhere" rule).

### pg-boss (jobs) instead of Redis + BullMQ at the start
Jobs, retries, cron schedules and the outbox all live in PostgreSQL: one fewer service to run, back up and pay for, and job enqueueing can happen inside the business transaction. Redis is added only when caching or rate-limit volume needs it.

### React + Vite + Tailwind + Radix (UI)
* React has the largest hiring pool in India and first-class support in both desktop and mobile shells.
* Vite builds in about a second; the PWA plugin gives offline caching.
* Tailwind utilities are driven by **CSS-variable tokens** (`apps/web/src/styles/app.css`), so light/dark themes and future white-labelling change one file.
* Radix provides accessible dialogs, popovers and tabs (focus trap, keyboard, ARIA) that we style ourselves, instead of a heavy component kit with its own look.
* Charts are small SVG components written to one chart specification (thin marks, one axis, hover tooltips, table view). This avoids a 100 KB+ chart library for five chart types and keeps them on-brand in both themes.

### Tauri (Windows) and Capacitor (Android) instead of Electron / React Native / Flutter
* Both wrap **the same web build**, so there is one UI code base for web, Windows and Android.
* **Tauri**: ~10 MB installer (Electron: 100 MB+), uses the WebView2 runtime already on Windows 10/11, Rust-side access to printers (thermal/ESC-POS, A4), local backup folders and auto-update.
* **Capacitor**: native plugins for ML Kit barcode scanning (fast camera scanning), Bluetooth thermal printers, share sheet (WhatsApp) and FCM push; the app runs fully offline from its bundled assets.
* React Native/Flutter would mean a second UI implementation and a second copy of screens to keep in sync.

### Headless Chromium for PDFs
Invoice PDFs must render Hindi correctly. Devanagari needs complex text shaping (conjuncts, matras); browser engines do this correctly, while common PDF libraries often break it. Invoices are HTML/CSS templates: the same template prints from the browser/desktop and renders to PDF on the server.

### decimal.js in the shared core
JavaScript numbers cannot represent ₹0.10 exactly. All arithmetic runs on arbitrary-precision decimals with explicit rounding rules (half-up to the paisa, configurable invoice round-off), mirrored by `NUMERIC(15,2)` amounts, `NUMERIC(15,4)` rates and `NUMERIC(15,3)` quantities in the database.

## Platform support

| Platform | How | Offline | Barcode | Printing |
|---|---|---|---|---|
| Web (Chrome, Edge, Safari, Firefox) | PWA | Daily operations (Phase 5) | USB/Bluetooth scanners (keyboard mode) | Browser print (A4, 80 mm thermal CSS) |
| Windows 10/11 | Tauri app | Yes | USB scanners | Direct to printer, including ESC/POS thermal |
| Android 8+ | Capacitor app | Yes | Camera (ML Kit) + Bluetooth scanners | Bluetooth thermal, share PDF |
| iOS | PWA or Capacitor later | Yes | Camera | AirPrint |
| macOS / Linux | Browser or Tauri build | Yes | USB scanners | Browser / system |

## Hosting cost at a glance

| Setup | Monthly |
|---|---|
| Single business, self-hosted VPS (Docker Compose: Caddy, API, worker, PostgreSQL, MinIO) + off-site backups | ₹1,500–3,000 |
| Multi-tenant SaaS for ~100 businesses (managed PostgreSQL with point-in-time recovery, 2 API instances, 1 worker, object storage, CDN) | ₹15,000–40,000 |

## Things deliberately not used (yet)

| Not used | Why not now | When to add |
|---|---|---|
| Microservices / Kubernetes | Operational cost with no benefit at this scale | If one module needs independent scaling |
| Redis | PostgreSQL covers jobs, locks and caching at this size | High-volume rate limiting or hot caches |
| Elasticsearch / Meilisearch | Catalogue search runs on the device; server search uses `pg_trgm` | Cross-tenant or very large text search |
| GraphQL | REST with explicit, cacheable resources is simpler to secure and to make offline | — |
| A separate data warehouse | Summary tables + read replica suffice | Multi-year cross-business analytics |
