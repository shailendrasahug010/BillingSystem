# D. API design

One REST API serves the web app, the Windows app and the Android app. It is designed for three things: correctness of money and stock, clients that may be offline and retry, and fast list screens over large data.

## 1. Conventions

| Topic | Convention |
|---|---|
| Base URL | `https://api.<domain>/api/v1` — the version is in the path; breaking changes get `/v2` while `/v1` keeps working for installed apps |
| Format | JSON, UTF-8. Money, rates and quantities are **strings** (`"12500.00"`, `"8.6000"`, `"2.500"`) so no client ever parses money into a float |
| Business context | Chosen at login; carried in the access token (`bid` claim). Switching business issues a new token. Every query is scoped to it and PostgreSQL RLS enforces the same |
| Auth | `Authorization: Bearer <access JWT>`; refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie (web) or secure storage (desktop/Android) |
| Idempotency | Every `POST` that creates a document accepts `Idempotency-Key: <uuid>` (also stored as `client_id`). Repeating the request returns the first result, never a duplicate |
| Concurrency | Editable resources return `ETag: "<version>"`; updates require `If-Match`. A stale version gets `412` with the current server copy |
| Pagination | Cursor based: `?limit=50&cursor=<opaque>` → `{ data: [...], nextCursor }`. No page numbers on large tables |
| Filtering / sorting | `?filter[status]=posted&filter[from]=2026-09-01&filter[to]=2026-09-30&sort=-invoiceDate` |
| Sparse fields | `?fields=id,number,grandTotal,balanceDue` for list screens on slow networks |
| Dates | Business dates `YYYY-MM-DD`; timestamps ISO-8601 with offset |
| Language | `Accept-Language: hi` selects the language of server-rendered artefacts (PDFs, notifications); JSON errors are language-neutral codes |
| Documentation | OpenAPI 3.1 generated from the shared Zod schemas (`packages/contracts`), published with the API |
| Rate limits | Per user and per IP (see [09-security.md](09-security.md)); `429` with `Retry-After` |

### Error format

Errors are codes with parameters so every client can translate them (the same codes `@vyapaar/core` throws):

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "params": { "product": "Parle-G Gold 100g", "available": "8", "requested": "20" },
    "field": "lines[2].qty",
    "requestId": "req_01J9Z6…"
  }
}
```

| HTTP | When |
|---|---|
| 400 | Validation failed (`details: [{ field, code, params }]`) |
| 401 | Missing/expired access token (client refreshes silently) |
| 403 | Authenticated but lacks the permission (`code: FORBIDDEN, params: { permission }`) |
| 404 | Not found **in this business** (never reveals other tenants' data) |
| 409 | Business rule conflict: duplicate supplier bill, period locked, invalid status transition, credit blocked |
| 412 | Version mismatch (`If-Match`) |
| 422 | Totals mismatch: the client's computed totals differ from the server's recalculation (`TOTALS_MISMATCH` with field-by-field details) |
| 429 | Rate limited |

### Totals are always recomputed

Clients send line inputs **and** the totals they displayed. The server recalculates with the same `@vyapaar/core` engine and rejects with `422 TOTALS_MISMATCH` if anything differs (`compareTotals`). What the user saw is exactly what is saved, or nothing is saved.

## 2. Endpoints

`★` = MVP (Phase 3). Permissions in brackets.

> **Built in Phase 3** (the OpenAPI document is served at `/api/docs` outside production): sign-up with OTP that creates the business (`POST /auth/otp`, `POST /auth/signup`), password and OTP login (`/auth/login`, `/auth/login/otp`), `/auth/refresh` (cookie, or body token with `X-Client: native`), logout, logout-all, password reset and change, `GET/POST /businesses`, `/auth/switch-business`, `/me`; members, roles and permissions; audit log; business profile, typed settings, number series, godowns; units, brands, categories, rate lists, tax categories with dated rules, products, barcode lookup, catalogue snapshot (`GET /catalog`); customers, suppliers, routes, statements; invoices (preview, post, list, detail, cancel), `GET /customers/:id/insight` and `/suggestions`; purchases (post, list, detail, cancel); stock, stock ledger, adjustments; payments (post, list, detail, cancel, cheque status, allocate advance), payment accounts; dashboard, sales/collection/purchase/outstanding reports with CSV and PDF export (`format=csv|pdf` on every report, also expenses, profit and product movement: the PDF has the firm's letterhead and logo, the period, the table with totals and page numbers, in IBM Plex Sans Devanagari so Hindi names are shaped correctly), GST summary per period, global search. Added before the pilot: sales orders (`POST/GET /sales-orders`, `GET /sales-orders/:id`, `POST /sales-orders/:id/status`, `POST /sales-orders/:id/invoice`, `GET /sales-orders/demand`), returns (`POST /invoices/:id/returns`, `POST /purchases/:id/returns`, `GET /notes`, `GET /notes/:id`, `POST /notes/:id/cancel`), imports (`POST /products/import`, `POST /customers/import`, with `dryRun`), supplier bill import (`POST /purchases/import/match`: a bill file read on the device is matched to a supplier by id, GSTIN or name and each line to a product by what this supplier's item was matched to before, barcode, code or exact name, with close names offered for the rest; the purchase body's `lines[].supplierItem` remembers the matches when the bill is saved), stock transfers (`POST/GET /stock/transfers`), the firm's logo (`PUT /business/logo` with a PNG / JPEG / WebP data URL up to 300 KB, checked by its bytes and kept in the database with the audit trail; `GET /business/logo` for anyone in the business; `DELETE /business/logo`; `/me` carries `logoFileId`). Every create that can be retried (invoice, purchase, payment, order, return, note, expense) accepts an `Idempotency-Key` header.
>
> **Built in Phase 4:** expenses (`POST/GET /expenses`, `GET /expenses/:id`, `POST /expenses/:id/cancel`, `GET/POST /expense-categories`, `PATCH /expense-categories/:id`, `GET /reports/expenses`); GST returns (`GET /gst/returns/gstr1`, `GET /gst/returns/gstr1/file?format=json|csv&section=`, `GET /gst/returns/gstr3b`, `GET /gst/exports`, `GET /gst/periods`, `GET /gst/periods/:period`, `POST /gst/periods/:period/lock|unlock|filed`); employees (`GET/POST /employees`, `GET/PATCH /employees/:id`, `GET /employees/:id/sensitive`, `POST /employees/:id/exit`, `GET/POST /departments`, `GET /salary-components`, `GET/PUT /employees/:id/salary`, `GET/POST /employees/:id/advances`), attendance (`GET/PUT /attendance`, `GET /attendance/month`), leave (`GET /leave-types`, `PATCH /leave-types/:id`, `GET /leave/balances`, `GET/POST /leave/requests`, `POST /leave/requests/:id/decide|cancel`), payroll (`GET/POST /payroll/runs`, `GET/DELETE /payroll/runs/:id`, `POST /payroll/runs/:id/recalculate|finalize|pay`, `PATCH /payroll/runs/:id/slips/:slipId`, `GET /payroll/slips/:id`); packing (`GET /packing/queue`, `POST/GET /packing`, `GET /packing/:id`, `POST /packing/:id/cancel`) and dispatch (`GET /dispatch/ready`, `POST/GET /dispatches`, `GET /dispatches/:id`, `POST /dispatches/:id/start|cancel`, `POST /dispatches/:id/stops/:stopId/deliver`); value-only notes (`POST /invoices/:id/price-notes`, `POST /purchases/:id/price-notes`); analytics (`GET /reports/profit`, `GET /reports/pnl`, `GET /reports/products`). Not yet built: devices, files, backup, sync.

### Authentication and session

| Method & path | Purpose |
|---|---|
| `POST /auth/login` ★ | Mobile/email + password → access token, refresh cookie, list of businesses |
| `POST /auth/otp/request` ★ · `POST /auth/otp/verify` ★ | Mobile OTP login / password reset (rate-limited, hashed codes, 5 attempts) |
| `POST /auth/refresh` ★ | Rotate refresh token; reuse of an old token revokes the whole family |
| `POST /auth/switch-business` ★ | New access token for another business the user belongs to |
| `POST /auth/logout` ★ · `POST /auth/logout-all` | Revoke current / all sessions |
| `GET /me` ★ | Profile, current business, role, effective permissions, settings needed by the client |
| `POST /devices` · `GET /devices` · `POST /devices/:id/revoke` | Register this device or confirm it (returns its series code, pattern and next number for the financial year) / list devices with last seen and offline bill count / revoke one (its unsynced bills are refused). Offline bills are sent to `POST /invoices` with an `Idempotency-Key` and `offline: { deviceId, invoiceNumber, savedAt }` |

### Settings, users and roles

| Method & path | Purpose |
|---|---|
| `GET /settings` ★ · `PATCH /settings/:key` ★ [settings.update] | Typed business rules (negative stock, round-off, credit policy, workflow, reminders…) |
| `GET/POST/PATCH /document-series` ★ | Number series per document type / FY / device; pattern validated against GST limits |
| `GET /members` · `POST /members/invite` · `PATCH /members/:id` [user.*] | Staff logins and their roles |
| `GET/POST/PATCH /roles` · `PUT /roles/:id/permissions` [user.manage_roles] | Configurable roles; every change is audit-logged |
| `GET /permissions` | Permission catalogue with translated descriptions |

### Masters

| Method & path | Purpose |
|---|---|
| `GET /customers` ★ | List with search (`q` matches name, business name, mobile, GSTIN, code), filters (type, route, category, has outstanding, overdue), sort by outstanding / last purchase |
| `POST /customers` ★ · `GET/PATCH /customers/:id` ★ · `DELETE /customers/:id` (soft) | CRUD with GSTIN checksum + state-code validation |
| `GET /customers/:id/summary` ★ | Outstanding, overdue, credit limit/available, last purchase, average order, payment behaviour |
| `GET /customers/:id/ledger` ★ | Statement with running balance (date range, PDF/Excel via `?format=`) |
| `GET /customers/:id/invoices` · `/payments` · `/notes` · `/products` | Profile tabs |
| `GET/POST/PATCH /suppliers` ★ · `GET /suppliers/:id/ledger` ★ | Same pattern for suppliers |
| `GET /products` ★ | Search (name, local name, aliases, code, SKU, barcode), filters (brand, category, stock level), cursor pagination |
| `GET /products/catalog-snapshot?since=<cursor>` ★ | Compact delta feed of active products, prices, tax categories and stock for the device cache |
| `POST/PATCH /products` ★ · `POST /products/import` | CRUD; bulk import from Excel with row-level error report |
| `GET /products/by-barcode/:code` ★ | Exact barcode lookup (scanner) |
| `GET/POST /brands`, `/product-categories`, `/units`, `/price-levels` ★ | Supporting masters |
| `GET/POST /tax-categories` · `POST /tax-categories/:id/rates` [settings.update] | Effective-dated GST rules; overlapping rules rejected (`findOverlappingRules`) |

### Sales

| Method & path | Purpose |
|---|---|
| `POST /invoices` ★ [invoice.create] | Create **and post** an invoice in one transaction (or `?draft=true`). Body: customer, date, lines, charges, discount, payment received, client totals |
| `POST /invoices/preview` ★ | Totals, tax breakup, credit and stock checks without saving (used while editing if the device cache is stale) |
| `GET /invoices` ★ · `GET /invoices/:id` ★ | List (filters: customer, date, status, payment status, salesperson) and detail |
| `PATCH /invoices/:id` [invoice.update] | Edit a posted invoice within the configured window; stores a revision, writes reversing + new ledger rows; blocked if the GST period is locked |
| `POST /invoices/:id/cancel` ★ [invoice.cancel] | Void with reason; reverses stock, ledger and GST register |
| `GET /invoices/:id/pdf?locale=hi` ★ · `GET /notes/:id/pdf` · `GET /payments/:id/pdf` | A4 PDF file made on the server (letterhead, GST table, HSN summary, totals, amount in words; `locale` defaults to the invoice's print language). A5 and 80 mm thermal templates later |
| `POST /invoices/:id/share` | Send via WhatsApp / email / SMS adapter (template + signed PDF link) |
| `POST /invoices/:id/e-invoice` | Generate IRN through the configured IRP adapter; stores IRN, ack and signed QR |
| `GET/POST /sales-orders` · `POST /sales-orders/:id/transitions {to, note}` | Orders and their workflow (`assertTransition`); history in `status_history` |
| `POST /sales-orders/:id/invoice` | Invoice all or part of an order |
| `POST /notes` · `POST /notes/:id/cancel` | Credit / debit notes (sales returns, discounts, rate differences), with or without stock movement |

### Invoice intelligence

| Method & path | Purpose |
|---|---|
| `GET /customers/:id/suggestions?cart=p1,p2&limit=24` ★ | Ranked suggestions with reason codes and suggested quantities (see [07-invoice-intelligence.md](07-invoice-intelligence.md)) |
| `GET /customers/:id/reorder-list` ★ | The reorder table: product, last qty, last purchase, typical interval, suggested qty, status |
| `GET /customers/:id/purchase-stats?since=` | Raw per-product stats for the device cache (offline suggestions) |
| `POST /suggestions/feedback` | Which suggestions were shown / added / ignored (to measure and tune) |

### Fulfilment

| Method & path | Purpose |
|---|---|
| `GET /packing/queue` | Orders waiting to be packed, oldest / route first |
| `POST /sales-orders/:id/packings` · `PATCH /packings/:id` | Pack all or part (scan barcodes, batch pick FEFO via `allocateFefo`, boxes, weight) |
| `GET /packings/:id/slip.pdf` | Packing slip |
| `POST /dispatches` · `POST /dispatches/:id/orders` | Vehicle trip with many orders; vehicle, driver, transporter, LR number, e-way bill |
| `POST /dispatches/:id/orders/:orderId/deliver` | Delivered / partly delivered / returned; proof-of-delivery photo |
| `GET /dispatches/:id/note.pdf` | Dispatch note / delivery challan |

### Purchases and inventory

| Method & path | Purpose |
|---|---|
| `POST /purchases` ★ · `POST /purchases/:id/post` ★ · `POST /purchases/:id/cancel` | Bill entry; posting increases stock, updates cost, supplier balance and inward GST |
| `GET /purchases` ★ · `GET /purchases/:id` ★ | List / detail |
| `GET /stock` ★ | Current stock by product / warehouse / batch with value and level |
| `GET /stock/ledger?productId=&warehouseId=&from=&to=` ★ | Date · transaction · in · out · balance |
| `POST /stock/adjustments` ★ [inventory.adjust] | Adjustment with reason (damage, expiry, count correction…); approval if configured |
| `POST /stock/transfers` · `POST /stock/transfers/:id/receive` | Godown-to-godown transfer |
| `GET /stock/expiring?days=30` · `GET /stock/low` ★ | Alerts |

### Payments

| Method & path | Purpose |
|---|---|
| `POST /payments` ★ [payment.collect / payment.pay] | Receipt from a customer or payment to a supplier; body includes allocations or `auto: "oldest_first"` |
| `GET /payments` ★ · `GET /payments/:id` ★ | List / detail |
| `POST /payments/:id/allocations` | Allocate an advance later |
| `POST /payments/:id/cancel` | Reverse (e.g. bounced cheque: records `cheque_status = bounced`, restores balances) |
| `GET /payments/:id/receipt.pdf` | Receipt |
| `GET/POST /payment-accounts` | Cash, bank, UPI accounts |

### GST

| Method & path | Purpose |
|---|---|
| `GET /gst/summary?period=2026-09` | Outward/inward taxable value and tax by rate, B2B/B2C, intra/inter |
| `GET /gst/hsn-summary?period=` · `GET /gst/rate-summary?period=` | HSN-wise and rate-wise summaries |
| `GET /gst/registers/:direction?period=` | Sales / purchase register (line level) |
| `POST /gst/exports {returnType, period, format}` | Queue an export (GSTR-1 JSON / Excel / CSV, GSTR-3B summary) via a versioned formatter; returns job id |
| `GET /gst/exports/:id` | Status, warnings (e.g. B2B invoice without valid GSTIN), download link |
| `POST /gst/periods/:period/lock` · `/unlock` [gst.lock_period] | Lock after filing (unlock is admin-only and audited) |
| `POST /gst/filing/...` | Optional GSP adapter (Phase 6); credentials server-side only |

### HR, payroll, leave, expenses

| Method & path | Purpose |
|---|---|
| `GET/POST/PATCH /employees` · `POST /attendance/bulk` | Staff master, daily attendance |
| `GET/POST /leave-types` · `POST /leave-requests` · `POST /leave-requests/:id/decision` · `GET /employees/:id/leave-balance` | Leave |
| `POST /employees/:id/salary-structures` · `POST /employees/:id/advances` | Salary history, advances and loans |
| `POST /payroll-runs {month}` · `PATCH /salary-slips/:id` · `POST /payroll-runs/:id/finalize` · `POST /payroll-runs/:id/pay` | Monthly payroll; finalised slips are frozen |
| `GET /salary-slips/:id.pdf` · `GET /reports/payroll?month=` | Slip and register |
| `GET/POST/PATCH /expenses` · `GET /expense-categories` | Expenses with receipt upload |

### Reports and analytics

| Method & path | Purpose |
|---|---|
| `GET /dashboard?range=thisMonth` ★ | All dashboard cards and series in one call (served from summary tables) |
| `GET /reports/sales?groupBy=day\|week\|month\|year\|customer\|product\|brand\|category\|salesperson&from=&to=` ★ | Sales reports |
| `GET /reports/collections?groupBy=…` ★ | Collection reports (today, yesterday, week, month, year, custom) |
| `GET /reports/purchases?groupBy=supplier\|product\|brand\|month\|year` | Purchase reports |
| `GET /reports/outstanding?party=customer\|supplier&aging=30,60,90&basis=due_date` ★ | Outstanding and aging (`ageDocuments`) |
| `GET /reports/products/:id?from=&to=` | Product analytics: sold, purchased, stock, margin, avg prices, top customers, trends |
| `GET /reports/brands/:id?from=&to=` | Company-wise report |
| `GET /reports/expenses?groupBy=category\|month` | Expense reports |
| `GET /analytics/kpis?from=&to=&compareFrom=&compareTo=` | BI KPIs with period comparison (e.g. Sep 2026 vs Sep 2025) |
| `POST /reports/:name/export {format: xlsx\|csv\|pdf, params}` | Async export job |

### Search, notifications, audit, files, backup

| Method & path | Purpose |
|---|---|
| `GET /search?q=` ★ | Global search across customers, suppliers, products, invoices, orders, purchases, payments, employees by name, code, mobile, GSTIN, invoice number, barcode |
| `GET /notifications` · `POST /notifications/:id/read` · `GET /events` (SSE) | In-app notifications and live updates |
| `GET/PATCH /reminder-rules` | Which reminders run, thresholds, channels |
| `GET /audit-logs?entityType=&entityId=&userId=` [audit.view] | Audit trail |
| `POST /files` → pre-signed upload · `GET /files/:id` → signed download | Uploads (validated type and size) |
| `POST /backups` · `GET /backups` · `GET /backups/:id/download` · `POST /backups/:id/restore` [backup.*] | Manual backup, list, download, restore (typed confirmation + re-authentication) |

### Offline sync

| Method & path | Purpose |
|---|---|
| `GET /sync/pull?cursor=` | Changes since the device's cursor for the cached entities (customers, products, prices, stock snapshot, stats, series state) |
| `POST /sync/push` | Batch of client mutations `{ mutationId, type, entityId, baseVersion, payload, createdAt }`; each result is `applied`, `rejected` (with error code) or `conflict` (with server copy). Replays are no-ops (`sync_mutations` primary key) |

Details in [10-offline-sync.md](10-offline-sync.md).

## 3. Example: create an invoice

```http
POST /api/v1/invoices
Authorization: Bearer eyJ…
Idempotency-Key: 01926d3c-5a8e-7b3e-9d51-0f6e2d7c1a44
Content-Type: application/json

{
  "customerId": "0192…",
  "invoiceDate": "2026-09-24",
  "seriesId": "0192…",
  "lines": [
    { "productId": "0192…", "unitId": "0192…", "qty": "24", "rate": "64.0000", "discountPercent": "0" },
    { "productId": "0192…", "unitId": "0192…", "qty": "10", "rate": "53.0000", "discountPercent": "0" }
  ],
  "payment": { "amount": "1000.00", "method": "upi", "reference": "UTR412345678" },
  "clientTotals": { "taxableTotal": "2066.00", "taxTotal": "26.50", "roundOff": "0.50", "grandTotal": "2093.00" }
}
```

```http
201 Created
ETag: "1"

{
  "id": "0192…",
  "number": "INV/26-27/00670",
  "status": "posted",
  "grandTotal": "2093.00",
  "amountPaid": "1000.00",
  "balanceDue": "1093.00",
  "paymentStatus": "partial",
  "warnings": [{ "code": "INSUFFICIENT_STOCK", "params": { "product": "Tata Salt 1kg", "available": "0", "requested": "5" } }]
}
```

Warnings (from `warn` policies) come back with a successful save; `block` policies return `409` instead.
