# I. Security: authentication, authorisation and data protection

The system holds a business's customers, prices, margins, receivables, employees' bank details and GST data. The threat model covers: an outsider guessing passwords or scraping the API, a staff member seeing or changing more than their role allows (the most common real risk in distribution businesses), a lost phone with cached data, another tenant's data leaking through a bug, and an operator or script rewriting financial history.

## 1. Authentication

| Control | Design |
|---|---|
| Identity | Mobile number is the primary login (many staff have no work email); email optional |
| Passwords | **argon2id** (memory-hard; parameters tuned to ~100 ms on the server), minimum length 8, checked against a breached-password list, never logged, never returned by the API (`password_hash` is excluded from every select) |
| OTP | 6-digit codes for mobile login, password reset and new-device confirmation; only a SHA-256 hash is stored (`otp_challenges`), 5-minute expiry, max 5 attempts, per-number send rate limit |
| Access token | JWT signed with an asymmetric key (EdDSA/ES256), **15-minute** lifetime, claims: user, business, role version, device; kept in memory on the client (not in `localStorage`) |
| Refresh token | Opaque random 256-bit token, stored hashed (`refresh_tokens`), **rotated on every use**; re-use of an already-rotated token revokes the whole token family (theft detection). Web: `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`. Desktop/Android: OS secure storage (Windows Credential Manager, Android Keystore) |
| Sessions | Idle timeout configurable per business; "log out everywhere"; role or permission change bumps the role version, forcing a token refresh |
| Devices | Each app install registers a device; admins see and revoke devices. A revoked device's refresh fails and its local cache is wiped on next contact |
| Brute force | Per-account progressive lockout (5 failures → 15 min, then OTP required), per-IP rate limits, generic "invalid credentials" messages |
| MFA | TOTP (authenticator app) available for everyone, **enforceable for Admin and Accountant roles** |
| Key rotation | JWT signing keys rotate with a `kid` header and a two-key overlap window |

## 2. Authorisation

Three layers, all of which must allow an action.

### 2.1 Tenant isolation (which business)
* The business id comes from the verified token, never from the URL or body.
* Every repository query filters by `business_id`, and **PostgreSQL row-level security** enforces the same rule underneath: the API connects as a non-owner role (`vyapaar_app`) and sets `app.business_id` per transaction, so a query that forgets its filter returns nothing and cannot insert into another tenant (tested in `packages/db/test/integrity.test.ts`).
* Resource ids of other tenants return `404`, never `403`, so existence is not revealed.

### 2.2 Role-based permissions (what action)
* Permissions are code-defined (`PERMISSION_CATALOG` in `@vyapaar/core`, `<module>.<action>`, 100 of them); roles are data, fully editable per business. Grants support wildcards (`invoice.*`, `*`) so new permissions reach Admin automatically.
* Default roles seeded per business: **Admin** (everything), **Manager** (sales, purchase, inventory, customers, reports), **Sales Employee** (customers, orders, invoices, collection — no purchase cost, no profit reports), **Accountant** (payments, GST, expenses, reports, audit), **Warehouse** (packing, dispatch, inventory), **HR** (employees, salary, leave).
* A NestJS guard checks the permission on every endpoint (`@RequirePermission("invoice.cancel")`); the client uses the same catalogue only to hide what the user cannot do.
* Sensitive operations have their own permissions: `invoice.override_price`, `invoice.override_credit_limit`, `invoice.backdate`, `invoice.cancel`, `gst.lock_period`, `backup.restore`, `user.manage_roles`, `employee.view_sensitive`.

### 2.3 Field- and record-level rules
* **Field level:** purchase price, average cost and margin are removed from API responses unless the user has `product.view_cost` / `report.view_profit`; bank account numbers, PAN and Aadhaar are masked unless `employee.view_sensitive`.
* **Record level (configurable):** "salespeople see only customers on their routes", "warehouse sees only its godown".
* **Business rules as limits:** discount above X %, credit override, back-dating beyond N days or editing a posted invoice after N hours require a higher permission or a manager's approval (recorded).

## 3. Input validation and injection defence

* Every request body, query and path parameter is parsed by a **Zod schema** shared with the clients (`packages/contracts`). Unknown fields are rejected; money arrives as decimal strings with bounded precision; lengths and array sizes are capped.
* Domain validators from `@vyapaar/core`: GSTIN (format + check digit + state), PAN, IFSC, pincode, Indian mobile, HSN, invoice-number pattern.
* **SQL injection:** all queries go through Drizzle's parameterised builder or tagged `sql` templates (parameters bound, never string-concatenated). Dynamic sorting/filtering uses allow-listed column maps.
* Output: React escapes by default; no `dangerouslySetInnerHTML` with user content; invoice templates use an escaping template engine.
* Server-side totals recalculation (`compareTotals`) means a tampered client cannot change what a customer is charged or what tax is reported.

## 4. Rate limiting and abuse

| Scope | Limit (defaults) |
|---|---|
| Login / OTP per mobile | 5 / 15 min, then OTP + backoff |
| OTP sends per mobile / per IP | 3 / 10 min, 20 / hour |
| Authenticated API per user | 600 requests / min (burst), lower for exports |
| Exports and PDFs | Queued jobs, max N concurrent per business |
| Sync push | Batches of ≤ 500 mutations, ≤ 5 MB |

Implemented in PostgreSQL (token buckets) at small scale; Redis when volume demands.

## 5. Data protection

| Data | Protection |
|---|---|
| In transit | TLS 1.2+ everywhere (HSTS, modern ciphers); certificate pinning in the Android and desktop apps for the API host |
| At rest | Managed PostgreSQL and object storage with disk encryption; self-hosted installs use encrypted volumes |
| Highly sensitive fields | **Application-level encryption** (AES-256-GCM, envelope keys from a KMS / secret manager) for bank account numbers, PAN of employees, Aadhaar (if stored at all), GSP session tokens; a masked copy (last 4) is kept for display |
| Aadhaar | Not required by the product; if a business insists, only the last 4 digits are stored by default; full number only encrypted, with explicit purpose and access logging (Aadhaar Act and DPDP considerations) |
| Backups | Encrypted archives with a per-business key, stored in a different region/account, checksummed, access-logged |
| Offline device cache | IndexedDB holds only what the role needs (customers on routes, catalogue, recent history); encrypted with a device key held in the platform keystore on Android/desktop; wiped on logout, device revocation or after N days without sync |
| Logs | Structured, with ids but no personal data or secrets in messages; secrets redacted by the logger; retention 30–90 days |
| Retention | GST records must be kept for at least **72 months** after the annual return due date; financial documents are therefore retained 8 years, then archived or purged per business policy; personal data of former employees minimised after statutory periods |

**Privacy (Digital Personal Data Protection Act, 2023):** personal data of customers' contact persons and employees is processed for stated purposes (billing, collection, payroll); WhatsApp/SMS reminders respect per-customer opt-out; businesses can export or delete a person's data where law allows; data is hosted in India by default; a breach-response procedure notifies affected businesses.

## 6. Secrets and credentials

* No secret ever ships in frontend code or mobile/desktop bundles: database credentials, JWT private keys, GSP/IRP credentials, WhatsApp/SMS API keys, storage keys all live in the server's secret manager (or environment injected at runtime), never in the repository (`.env*` is git-ignored; secret scanning in CI).
* Integrations run in the worker process only; credentials are encrypted at rest and decrypted just-in-time.
* The database is reachable only from the API/worker network; operators use a bastion with MFA; migrations run with a separate owner role; the app role cannot alter schema or rewrite ledgers.

## 7. Integrity and audit

* **Append-only history:** stock ledger, party ledger and audit log reject UPDATE/DELETE at the trigger level and by privilege; posted documents can only be cancelled; filed GST periods are locked (all enforced in PostgreSQL, see [03-database-design.md](03-database-design.md#4-integrity-guarantees-enforced-by-the-database)).
* **Audit log** (`audit_logs`), written in the same transaction as the change:

| User | Action | Entity | Old → new | When | Where |
|---|---|---|---|---|---|
| Raj (Sales) | `invoice.updated` | INV/26-27/10023 | grand total ₹12,500.00 → ₹13,200.00 | 24/09/2026 14:32 | device "Counter PC", IP, request id |

Logged actions include: invoice create/update/cancel/print/share, price overrides, credit overrides, purchase changes, stock adjustments and transfers, payments and allocations, cheque bounces, customer and product changes (including price and tax-category changes), GST period lock/unlock and exports, user invitations, role and permission changes, logins (success/failure), device registrations and revocations, backup downloads and restores, settings changes.

## 8. Secure file uploads

* Upload via pre-signed URL issued only after a permission check; the URL fixes content type and maximum size (images 5 MB, PDFs 10 MB).
* Allow-listed types (JPEG, PNG, WebP, PDF, XLSX for imports); the worker verifies the real type from file signatures, re-encodes images (dropping EXIF location), scans with an antivirus engine, and quarantines failures.
* Buckets are private; downloads use short-lived signed URLs; filenames are never used as storage keys.

## 9. Backup and restore safety

* Automatic daily (configurable) encrypted backups plus point-in-time recovery on managed PostgreSQL.
* Manual backup and download require `backup.download` and are audit-logged.
* **Restore** requires `backup.restore`, re-entering the password (or OTP), typing the business name to confirm, shows what will be replaced, takes a safety backup first, refuses backups from an incompatible schema version, and is logged.

## 10. Application security practices

* Security headers: strict Content-Security-Policy (no inline scripts in production), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`.
* CSRF: refresh endpoint uses `SameSite=Strict` cookies + origin check; all other endpoints use bearer tokens (not cookies).
* CORS: allow-listed origins only.
* Dependencies: lockfile, automated update PRs, `pnpm audit` and secret scanning in CI; container images scanned.
* Testing: permission tests for every endpoint (each role × each action), tenant-isolation tests, fuzzing of money inputs, periodic external penetration test before SaaS launch.
* Incident response: runbook, on-call alerts for auth anomalies (spikes in failed logins, token reuse detections, unusual export volume).
