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

Errors are codes with parameters so every client can translate them (the same codes `@digitalbahi/core` throws):

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

Clients send line inputs **and** the totals they displayed. The server recalculates with the same `@digitalbahi/core` engine and rejects with `422 TOTALS_MISMATCH` if anything differs (`compareTotals`). What the user saw is exactly what is saved, or nothing is saved.

## 2. Endpoints

`★` = MVP (Phase 3). Permissions in brackets.

> **Built in Phase 3** (the OpenAPI document is served at `/api/docs` outside production): sign-up with OTP that creates the business (`POST /auth/otp`, `POST /auth/signup`), password and OTP login (`/auth/login`, `/auth/login/otp`), `/auth/refresh` (cookie, or body token with `X-Client: native`), logout, logout-all, password reset and change, `GET/POST /businesses`, `/auth/switch-business`, `/me`; members, roles and permissions; audit log; business profile, typed settings, number series, godowns; units, brands, categories, rate lists, tax categories with dated rules, products, barcode lookup, catalogue snapshot (`GET /catalog`); customers, suppliers, routes, statements; invoices (preview, post, list, detail, cancel), `GET /customers/:id/insight` and `/suggestions`; purchases (post, list, detail, cancel); stock, stock ledger, adjustments; payments (post, list, detail, cancel, cheque status, allocate advance), payment accounts; dashboard, sales/collection/purchase/outstanding reports with Excel, CSV and PDF export (`format=xlsx|csv|pdf` on every report, also expenses, profit and product movement: the .xlsx keeps numbers and dates typed, with the title, firm and period on top, a frozen header and the totals; the PDF has the firm's letterhead and logo, the period, the table with totals and page numbers, in IBM Plex Sans Devanagari so Hindi names are shaped correctly), GST summary per period, global search. Added before the pilot: sales orders (`POST/GET /sales-orders`, `GET /sales-orders/:id`, `POST /sales-orders/:id/status`, `POST /sales-orders/:id/invoice`, `GET /sales-orders/demand`), returns (`POST /invoices/:id/returns`, `POST /purchases/:id/returns`, `GET /notes`, `GET /notes/:id`, `POST /notes/:id/cancel`), imports (`POST /products/import`, `POST /customers/import`, with `dryRun`), supplier bill import (`POST /purchases/import/match`: a bill file read on the device is matched to a supplier by id, GSTIN or name and each line to a product by what this supplier's item was matched to before, barcode, code or exact name, with close names offered for the rest; the purchase body's `lines[].supplierItem` remembers the matches when the bill is saved), browser errors (`POST /client-errors`, no sign-in needed: kind, message, stack, React component stack, screen, page, app build and the reference the app showed; written to the error log at its source file and line, 202 with the reference), saved report views (`GET/POST /report-views`, `PATCH/DELETE /report-views/:id`: a report (`sales`, `collections`, `purchases`, `outstanding`, `profit`, `pnl`, `products`) with its settings (`period` as a preset or `custom` with `from` / `to`, `groupBy`, `party`, `basis`, `movement`, each only where that report has it) under a name, private or `shared` with the team; the list is the person's own views plus shared ones for reports their role opens, with `mine` and `ownerName`; only the person who saved a view changes or deletes it; 50 per person; audit-logged), reading a photographed or scanned page (`POST /imports/read-page`: a PNG or JPEG up to 12 MB and 6000 px a side, sent as `application/octet-stream` by someone who may enter purchases or import products or customers; read with Tesseract on the server, one page at a time (503 `OCR_BUSY` beyond four waiting), straightened, and returned as lines of cells `{width, height, lines: [{y, height, cells: [{text, x0, x1}]}]}` with scraps of table rules dropped; nothing is stored, `cache-control: no-store`), stock transfers (`POST/GET /stock/transfers`), the firm's logo (`PUT /business/logo` with a PNG / JPEG / WebP data URL up to 300 KB, checked by its bytes and kept in the database with the audit trail; `GET /business/logo` for anyone in the business; `DELETE /business/logo`; `/me` carries `logoFileId`). Every create that can be retried (invoice, purchase, payment, order, return, note, expense) accepts an `Idempotency-Key` header.
>
> **Built in Phase 4:** expenses (`POST/GET /expenses`, `GET /expenses/:id`, `POST /expenses/:id/cancel`, `GET/POST /expense-categories`, `PATCH /expense-categories/:id`, `GET /reports/expenses`); GST returns (`GET /gst/returns/gstr1`, `GET /gst/returns/gstr1/file?format=json|csv&section=`, `GET /gst/returns/gstr3b`, `GET /gst/exports`, `GET /gst/periods`, `GET /gst/periods/:period`, `POST /gst/periods/:period/lock|unlock|filed`); employees (`GET/POST /employees`, `GET/PATCH /employees/:id`, `GET /employees/:id/sensitive`, `POST /employees/:id/exit`, `GET/POST /departments`, `GET /salary-components`, `GET/PUT /employees/:id/salary`, `GET/POST /employees/:id/advances`), attendance (`GET/PUT /attendance`, `GET /attendance/month`), leave (`GET /leave-types`, `PATCH /leave-types/:id`, `GET /leave/balances`, `GET/POST /leave/requests`, `POST /leave/requests/:id/decide|cancel`), payroll (`GET/POST /payroll/runs`, `GET/DELETE /payroll/runs/:id`, `POST /payroll/runs/:id/recalculate|finalize|pay`, `PATCH /payroll/runs/:id/slips/:slipId`, `GET /payroll/slips/:id`, `GET /payroll/runs/:id/statutory` (PF, ESI and PT for the month with the challans) and `GET /payroll/runs/:id/statutory/ecr|esi|pt` (the EPFO ECR text file, the ESIC monthly sheet and the PT list; setting `payroll.statutory`)); packing (`GET /packing/queue`, `POST/GET /packing`, `GET /packing/:id`, `POST /packing/:id/cancel`) and dispatch (`GET /dispatch/ready`, `POST/GET /dispatches`, `GET /dispatches/:id`, `POST /dispatches/:id/start|cancel`, `POST /dispatches/:id/stops/:stopId/deliver`); value-only notes (`POST /invoices/:id/price-notes`, `POST /purchases/:id/price-notes`); analytics (`GET /reports/profit`, `GET /reports/pnl`, `GET /reports/products`). Built after Phase 4: devices and offline bills (`POST/GET /devices`, `POST /devices/:id/revoke`, `offline` on `POST /invoices`), document PDFs (`GET /invoices|notes|payments/:id/pdf`), WhatsApp and email (`/messages/*`, `/messaging/*`). Backup & restore (`/backups/*`). Money to collect (`GET /collections/outstanding?city=&routeId=&q=&overdue=&promise=&sort=&format=json|pdf|xlsx|csv`, `GET /collections/outstanding/:customerId`, `POST /collections/notes`); each role's home (`GET /home`); recent bills for a device's offline copy (`GET /offline/documents?days=30`). Not yet built: full sync. Built in Phase 5.5: `GET /insights?from=&to=&compare=previous|last_year` (measures against the earlier period with their change, the 12-month trend, customer, company and salesperson contribution with share, ABC class and growth, fast / slow / dead stock; `&section=customers|companies|salespeople|fast|slow|dead&format=pdf|xlsx|csv` for one table as a file; permission `report.view_bi`, margins and stock values with `report.view_profit`, collections with `report.view_collection`, receivables with `report.view_outstanding`).
>
> **Built in Phase 5 (5.1, purchase history):** `GET /customers/:id/insight` and `GET /customers/:id/suggestions` now read the purchase history stored by the outbox worker (`customer_product_stats`, `customer_stats`; worked out on the spot while none is stored or it is more than two days old; the response's `source` says `stored` or `live`) and the store-wide rules mined nightly (`product_associations`); `GET /customers/:id/reorder` (the reorder table); `GET /reorder/due?routeId=&salespersonId=&limit=` (customers whose habits are due, overdue or lapsed, most urgent first, with each product's status and suggested quantity; `customer.view`); `POST /suggestions/feedback` (`{id, customerId, invoiceId?, shown[], added[]}` with each item's `productId`, `group`, `rank`, `reasons`; the app makes the `id` per bill and sending it again replaces it; 204; `invoice.create`); `GET /suggestions/feedback/summary?from=&to=` (offered, taken and acceptance by reason and by position 1-3 / 4-6 / 7-12 / 13+, and the share of bill lines that came from suggestions; `report.view_sales`). The refresh cookie is `db_rt` (a `vy_rt` cookie from before the rename is still accepted and replaced).

### Authentication and session

| Method & path | Purpose |
|---|---|
| `POST /auth/login` ★ | Mobile/email + password → access token, refresh cookie, list of businesses |
| `POST /auth/otp/request` ★ · `POST /auth/otp/verify` ★ | Mobile OTP login / password reset (rate-limited, hashed codes, 5 attempts) |
| `POST /auth/refresh` ★ | Rotate refresh token; reuse of an old token revokes the whole family |
| `POST /auth/switch-business` ★ | New access token for another business the user belongs to |
| `POST /auth/logout` ★ · `POST /auth/logout-all` | Revoke current / all sessions |
| `GET /me` ★ | Profile, current business, role, effective permissions, settings needed by the client |
| `POST /devices` · `GET /devices` · `POST /devices/:id/revoke` · `POST /devices/check` | Register this device or confirm it: every member's device that keeps a copy is registered; those who bill get a series code, pattern and next number for the financial year (others `seriesCode: null`); each registration returns a fresh `checkSecret` (stored hashed) and the business's `wipeAfterDays` (`no-store`) / list devices with last seen, offline bill count, when removed and when their copy was deleted / revoke one: its unsynced bills are refused and its sign-in (the refresh-token family it registered with) ends / `POST /devices/check {deviceId, secret}`, no sign-in needed, rate-limited: `active`, `removed` (the device deletes its copy and waiting work; `wipedAt` is set) or `unknown`, answered by a `SECURITY DEFINER` function so row-level security stays on. Offline bills are sent to `POST /invoices` with an `Idempotency-Key` and `offline: { deviceId, invoiceNumber, savedAt }` |

### Settings, users and roles

| Method & path | Purpose |
|---|---|
| `GET /settings` ★ · `PUT /settings/:key` ★ [settings.update] | Typed business rules (negative stock, round-off, credit policy, workflow, reminders, `gst.lut` = the letter of undertaking's ARN and last valid day…); a value set to null goes back to the default |
| `GET/POST/PATCH /document-series` ★ | Number series per document type / FY / device; pattern validated against GST limits |
| `GET /members` · `POST /members/invite` · `PATCH /members/:id` [user.*] | Staff logins and their roles |
| `GET/POST/PATCH /roles` · `PUT /roles/:id/permissions` [user.manage_roles] | Configurable roles; every change is audit-logged |
| `GET /permissions` | Permission catalogue with translated descriptions |

### Masters

| Method & path | Purpose |
|---|---|
| `GET /customers` ★ | List with search (`q` matches name, business name, mobile, GSTIN, code), filters (type, route, category, has outstanding, overdue), sort by outstanding / last purchase |
| `GET /me/device-key` · `POST /auth/password/check` [signed in] | The person's device key (32 bytes, base64; `no-store`) that wraps the key of the encrypted copy on their devices / checks their password without a new session (wrong tries count toward the sign-in lock), before a device lets it open that copy offline |
| `POST /customers` ★ · `GET/PATCH /customers/:id` ★ · `DELETE /customers/:id` (soft) | CRUD with GSTIN checksum + state-code validation. `POST` takes an `Idempotency-Key` (UUID) that becomes the customer's id (a customer added offline keeps the id it was billed under; sent again it returns the same customer). `PATCH` takes `If-Match: <version>` (`VERSION_CONFLICT` when someone saved in between); lists and details carry `version` |
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
| `POST /invoices` ★ [invoice.create] | Create **and post** an invoice in one transaction (or `?draft=true`). Body: customer, date, lines, charges, discount, payment received, client totals; for an export or SEZ customer optionally `zeroRated` (`withPayment`, and for exports the shipping bill number, date and port code; left out: under the business's LUT while it is valid on the invoice date, else with payment of IGST). The detail returns `zeroRatedType` (EXPWP / EXPWOP / SEZWP / SEZWOP), the shipping bill and `lutArn` |
| `PATCH /invoices/:id/shipping-bill` ★ [invoice.update] | An export's shipping bill number, date and port code, added or corrected after the invoice (null clears a field; not part of the tax, so allowed in a locked month; audited) |
| `POST /invoices/preview` ★ | Totals, tax breakup, credit and stock checks without saving (used while editing if the device cache is stale) |
| `GET /invoices` ★ · `GET /invoices/:id` ★ | List (filters: customer, date, status, payment status, salesperson) and detail |
| `PATCH /invoices/:id` [invoice.update] | Edit a posted invoice within the configured window; stores a revision, writes reversing + new ledger rows; blocked if the GST period is locked |
| `POST /invoices/:id/cancel` ★ [invoice.cancel] | Void with reason; reverses stock, ledger and GST register |
| `GET /invoices/:id/pdf?locale=hi` ★ · `GET /notes/:id/pdf` · `GET /payments/:id/pdf` | A4 PDF file made on the server (letterhead, GST table, HSN summary, totals, amount in words; `locale` defaults to the invoice's print language). A5 and 80 mm thermal templates later |
| `POST /messages/send` · `GET /messages` · `POST /messages/:id/retry` | Send an invoice, note or receipt with its PDF by WhatsApp Business (Meta Cloud API: media upload + approved template with a document header; or a signed provider webhook) or email (SMTP); every send is logged with status and error. `message.send` / `message.view` |
| `GET /messages/reminders` · `POST /messages/reminders {channel: whatsapp\|sms\|email, customerIds, locale?}` | Customers with a balance (overdue part, oldest due date, `optedOut`) / queue payment reminders, sent one after another in the background; customers who stopped reminders are skipped (`reason: opted_out`). `GET /messages` marks those the rule sent `automatic` |
| `GET /messaging/channels` · `GET/PUT /messaging/settings` · `POST /messaging/test` | Which channels work (WhatsApp, SMS, email) / the firm's WhatsApp (with the Hindi template language), SMS gateway (signed webhook, DLT sender id and template ids) and email set-up (secrets write-only, encrypted) / a test message |
| `POST /webhooks/whatsapp/:key` | **Public, signed.** Meta (or the provider) reports delivered / read ticks and forwards replies: **STOP** (also *unsubscribe*, *band karo*, बंद) stops payment reminders to the customer with that mobile and tells the staff who send messages; **START** turns them on again if a reply stopped them |
| `GET /gst/einvoice?period=` [gst.view] · `GET /einvoice/file?ids=` ★ | The month's B2B, SEZ and export invoices and customer credit notes with their IRN status and what the portal would refuse; the IRP's bulk-upload JSON (INV-01 v1.1) for the chosen ones (refused while any has an error) |
| `PATCH /invoices/:id/irn` ★ [invoice.update] · `PATCH /notes/:id/irn` ★ [note.create] | The IRN, acknowledgement number / time and signed QR code the portal returned (`irn: null` removes them); printed on the invoice and PDF |
| `GET /ewaybills?period=` ★ · `GET /ewaybills/file?ids=&vehicleNo=&transporterId=&transporterName=&distance=` ★ · `GET /dispatches/:id/ewaybills` ★ · `PATCH /invoices/:id/eway-bill` ★ [invoice.update] | Bills above the e-way bill limit (setting `ewaybill.threshold`) with their trip; the e-way bill portal's bulk JSON (Part B from the query or the bill's dispatch trip); a trip's bills still without one; the number, date and validity it returned |
| `POST /invoices/:id/e-invoice` | Later: generate the IRN through a GSP / IRP adapter from the same JSON |
| `GET/POST /sales-orders` · `POST /sales-orders/:id/transitions {to, note}` | Orders and their workflow (`assertTransition`); history in `status_history` |
| `POST /sales-orders/:id/invoice` | Invoice all or part of an order |
| `POST /notes` · `POST /notes/:id/cancel` | Credit / debit notes (sales returns, discounts, rate differences), with or without stock movement |

### Invoice intelligence

| Method & path | Purpose |
|---|---|
| `GET /customers/:id/insight` ★ | Purchase statistics, customer and store-wide rules, payment behaviour and open bills: the billing screen runs the suggestion engine on it, online and offline |
| `GET /customers/:id/suggestions?cart=p1,p2&limit=24` ★ | Ranked suggestions with reason codes and suggested quantities (see [07-invoice-intelligence.md](07-invoice-intelligence.md)) |
| `GET /customers/:id/reorder` ★ | The reorder table: product, last qty, last purchase, typical interval, suggested qty, status |
| `GET /reorder/due?routeId=&salespersonId=` | Customers due to reorder, most urgent first (a salesperson's list for the beat) |
| `GET /customers/:id/purchase-stats?since=` | Raw per-product stats for the device cache (planned, with offline sync of a day's beat) |
| `POST /suggestions/feedback` · `GET /suggestions/feedback/summary` | What the billing screen offered and what was taken, per bill; acceptance by reason and position |

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
| `GET /collections/outstanding?city=&routeId=&q=&overdue=true&sort=amount\|overdue\|oldest\|name&format=` | Money to collect, for collectors (`customer.view_ledger`, which also lets them download it): each customer who owes, with city, route, open bills, oldest due, overdue and last payment; the places with their totals. `city` is matched whatever the case (`-` for customers without one). PDF, Excel and CSV (the PDF has a blank "Collected" column); every download is written to the audit log (`outstanding.exported`) |
| `GET /home` | The home screen for any member, with only what the role covers: `orders` (pending with `order.view`; to pack / to dispatch with `packing.view` / `dispatch.view` or `order.view`; the next five to pack / send, oldest first), `people` (today's attendance; `employee.view`), `leave` (pending requests, on leave today; `leave.view`), `payroll` (this month's run; `payroll.view`), `collections` (to collect, overdue, promises to pay due by today; `customer.view_ledger`), `expenses` (this month; `expense.view`). The sales dashboard stays on `GET /dashboard` (`dashboard.view`) |
| `GET /collections/outstanding/:customerId` | One customer's dues: contact, credit terms, overdue / not due / opening balance, aging, open bills with days late, the last five payments, the open promise to pay and the last ten visit notes (who, when) |
| `POST /collections/notes {customerId, kind: promise\|note, promisedOn?, promisedAmount?, note?}` | A collector's visit when the money did not come (`payment.collect`): a note, or a promise to pay by a date (today to a year ahead; amount optional = everything). The Idempotency-Key (a UUID from the device) becomes the note's id, so one kept offline and sent twice is one note. A promise stays open until the customer's next payment; the list shows it (`promise` on each row, `promise=due\|any`, `sort=promise`, a "Promised" column in downloads). Audited as `collection.promise_noted` / `collection.note_added` |
| `GET /reports/products/:id?from=&to=` | Product analytics: sold, purchased, stock, margin, avg prices, top customers, trends |
| `GET /reports/brands/:id?from=&to=` | Company-wise report |
| `GET /reports/expenses?groupBy=category\|month` | Expense reports |
| `GET /analytics/kpis?from=&to=&compareFrom=&compareTo=` | BI KPIs with period comparison (e.g. Sep 2026 vs Sep 2025) |
| `POST /reports/:name/export {format: xlsx\|csv\|pdf, params}` | Async export job |

### Search, notifications, audit, files, backup

| Method & path | Purpose |
|---|---|
| `GET /search?q=` ★ | Global search across customers, suppliers, products, invoices, orders, purchases, payments, employees by name, code, mobile, GSTIN, invoice number, barcode |
| `GET /notifications?status=all\|unread&limit=&cursor=` · `GET /notifications/unread-count` [notification.view] | The person's notifications, newest first: those addressed to them and those for a permission their role has, without the ones they dismissed; each is `{type, severity, titleKey, bodyKey, params, entityType, entityId, createdAt, readAt}` (the app translates the keys), with the unread count |
| `POST /notifications/:id/read` · `POST /notifications/:id/dismiss` · `POST /notifications/read-all` [notification.view] | Read and dismissed for this person only (204; 404 for one they may not see); read-all returns `{marked}` |
| `GET /notifications/stream` [notification.view] | Server-sent events: `ready`, then `notification {id}` whenever one this person may see is created on any API server; a comment every 25 s; ends when the access token would expire (open it again with a fresh one); `unavailable` if the server cannot listen |
| `GET /reminder-rules` [notification.view] · `PATCH /reminder-rules/:type {isActive?, config?: {hour, daysBefore, dayOfMonth, afterHours, firstAfterDays, repeatDays, maxCount, minAmount, channel}}` [notification.configure] | The twelve rules with their permission, whether they also fire as things happen, whether they run hourly, settings (defaults filled in) and last run (day, and time for hourly ones); a change is audited (`reminder_rule.updated`), settings that do not apply to the type are ignored |
| `POST /reminder-rules/:type/check` [notification.configure] | Runs the rule's check now: `{result: raised\|already\|nothing}`; its notification is the day's (or, for orders waiting, the hour's) one (409 `REMINDER_RULE_OFF` while the rule is off). For payment reminders to customers it sends today's reminders (the scheduled run then sends nothing more today) and adds `sent: {count, amount, unreachable}` |
| `GET /reminder-rules/customer_reminders/due` [notification.configure] | Who the payment reminders write to today under the rule's settings: name, balance, overdue amount, oldest due date, days overdue, reminders sent since it fell due, the channel and language (or `skip: no_contact`); never the number or address |
| `GET /audit-logs?entityType=&entityId=&userId=` [audit.view] | Audit trail |
| `POST /files` → pre-signed upload · `GET /files/:id` → signed download | Uploads (validated type and size) |
| `GET` · `PUT /backups/schedule` [backup.configure; saving also needs backup.download] | Automatic backups: off / daily / weekly, hour, weekday, recipient (empty: the firm's email) and the file's password (write-only; kept when left out); the view has the next time and the last result as an error code |
| `POST /backups/download` · `POST /backups/email` · `GET /backups` · `POST /backups/restore?dryRun=` [backup.*] | The whole business as one file (optional password in the body, never the URL) / a password-protected copy by email / history with size and checksum / restore a file sent as `application/octet-stream` (password base64 in `X-Backup-Passphrase`) as a NEW business; the response carries the new session |

### Offline sync

| Method & path | Purpose |
|---|---|
| `GET /sync/pull?cursor=&lists=&limit=` | **Built (5.3).** What changed since the device's cursor: `products` (as `/catalog`), `customers`, `suppliers` (as their lists), `removed: {product, customer, supplier}` ids, `lists` (tax categories, rate lists, units, brands, categories, godowns, routes, expense categories) only when their hash differs from `lists`, `listsHash`, `more` (ask again at once) and the next `cursor`. Without a cursor, or with one older than the kept changes: `reset: true` and a cursor to load everything from. Limited to what the person's role may see; `INVALID_CURSOR` for one it does not understand. `cache-control: no-store` |
| `PUT /devices/:id/queue {waiting, bills, refused, oldestAt}` | **Built (5.3).** The device's own person reports what waits on it (204); shown by `GET /devices` (`queueWaiting`, `queueBills`, `queueRefused`, `queueOldestAt`, `queueReportedAt`) |
| `GET /invoices?review=needs_review\|reviewed` · `GET /invoices/review-count` [invoice.view] · `POST /invoices/:id/review {note?}` [invoice.review] | **Built (5.3).** Bills made offline held for review (`reviewStatus`, `reviewReasons` on the bill; `reviewerName` on its detail); marking one reviewed is audited and tells whoever made it (409 `NOT_HELD_FOR_REVIEW` otherwise). `GET /home` carries `review` (count and the oldest five) for invoice.review |
| `PATCH /customers/:id` with `If-Match` and `offline: {base, madeAt}` | **Built (5.3).** A change made offline on an old version is merged field by field; the answer carries `merge: {kept, overwritten}` |
| `POST /sync/push` | Designed batch of client mutations; not built: each kind of work goes through its own endpoint with an `Idempotency-Key` (requests with the same key are serialised, so a replay returns the first result) |

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
