# C. Database design

The schema is real and runnable: `packages/db/src/schema/*.ts` (Drizzle) generates `packages/db/migrations/0001_schema.sql`; hand-written migrations add extensions (`0000`) and integrity rules (`0002`). `packages/db/test/integrity.test.ts` applies all migrations to a fresh PostgreSQL database and proves the rules below hold.

**Append-only ledgers · triggers that protect history · row-level security for every business.** How many tables, columns, keys and indexes there are, and every column, is in the generated [database reference](12-database-reference.md).

## 1. Conventions

| Topic | Rule |
|---|---|
| Tenant key | Every business table has `business_id` (FK to `businesses`). A *business* is one legal entity / GSTIN; one login can belong to several businesses (common for owners running two firms). |
| Primary keys | UUID. The application generates **UUIDv7** (time-ordered, index-friendly, creatable offline); the DB default `gen_random_uuid()` is a safety net. Server-only append-only ledgers use `bigint` identity (compact, naturally ordered). |
| Money | `NUMERIC(15,2)` amounts, `NUMERIC(15,4)` unit rates (per-piece prices from case prices), `NUMERIC(15,3)` quantities (kg / litre), `NUMERIC(7,3)` percentages. Never floating point. |
| Dates | `date` for business dates (invoice date, due date); `timestamptz` for events. Business time zone is per business (default `Asia/Kolkata`). |
| Audit columns | `created_at`, `updated_at` (trigger-maintained), `created_by`, `updated_by`. |
| Soft delete | Master data only (`deleted_at`, `deleted_by`): customers, suppliers, products, brands, categories, warehouses, employees, expenses. Unique codes are enforced only among non-deleted rows (partial unique indexes). |
| Financial documents | Never deleted once posted: status moves to `cancelled` with reversing ledger entries (DB trigger enforces). |
| Optimistic locking | `version` integer on editable documents and masters; used for concurrent edits and offline-sync conflict detection. |
| Idempotency | Documents created by clients carry `client_id`; a unique partial index makes retries (e.g. offline sync replays) harmless. |
| Enums | PostgreSQL enums for fixed state machines (values shared with `@digitalbahi/core`); business-editable lists (leave types, expense categories, customer categories…) are tables. |
| Naming | `snake_case`, plural table names, `<table>_<purpose>_{idx,uq,chk}` for indexes and constraints. |

## 2. Entity-relationship diagrams

The model is shown per domain; tables that appear in several diagrams are the joins between domains. Only key columns are listed; see the schema files for everything.

### 2.1 Platform, tenancy and access

```mermaid
erDiagram
  USERS ||--o{ BUSINESS_MEMBERS : "belongs to"
  BUSINESSES ||--o{ BUSINESS_MEMBERS : has
  ROLES ||--o{ BUSINESS_MEMBERS : "assigned to"
  BUSINESSES ||--o{ ROLES : defines
  ROLES ||--o{ ROLE_PERMISSIONS : grants
  PERMISSIONS ||..o{ ROLE_PERMISSIONS : "matched by key or wildcard"
  USERS ||--o{ REFRESH_TOKENS : has
  USERS ||--o{ DEVICES : uses
  BUSINESSES ||--o{ DEVICES : registers
  BUSINESSES ||--o{ DOCUMENT_SERIES : numbers
  DEVICES ||--o| DOCUMENT_SERIES : "offline series"
  BUSINESSES ||--o{ SETTINGS : configures
  BUSINESSES ||--o{ WAREHOUSES : owns
  STATES ||--o{ BUSINESSES : "located in"

  USERS {
    uuid id PK
    varchar mobile UK
    text email UK
    text password_hash
    varchar preferred_locale
  }
  BUSINESSES {
    uuid id PK
    text legal_name
    varchar gstin
    enum gst_registration
    char state_code FK
    smallint financial_year_start_month
  }
  BUSINESS_MEMBERS {
    uuid business_id FK
    uuid user_id FK
    uuid role_id FK
    bool is_owner
  }
  ROLES {
    uuid id PK
    varchar key
    bool is_system
  }
  ROLE_PERMISSIONS {
    uuid role_id FK
    varchar grant "invoice.create | invoice.* | *"
  }
  DOCUMENT_SERIES {
    uuid id PK
    varchar doc_type
    text pattern "e.g. INV/FYS/SEQ5"
    varchar financial_year
    int next_number
    uuid device_id FK
  }
  SETTINGS {
    uuid business_id PK
    text key PK
    jsonb value
  }
```

### 2.2 Catalogue and tax

```mermaid
erDiagram
  PRODUCTS }o--|| TAX_CATEGORIES : "taxed by"
  TAX_CATEGORIES ||--o{ TAX_RATES : "effective-dated rules"
  PRODUCTS }o--o| BRANDS : "company / brand"
  PRODUCTS }o--o| PRODUCT_CATEGORIES : "category"
  PRODUCT_CATEGORIES }o--o| PRODUCT_CATEGORIES : "parent (subcategory)"
  PRODUCTS }o--|| UNITS : "base unit"
  PRODUCTS ||--o{ PRODUCT_UNITS : "alternate units"
  PRODUCTS ||--o{ PRODUCT_BARCODES : barcodes
  PRODUCTS ||--o{ PRODUCT_PRICES : "price per level + unit"
  PRICE_LEVELS ||--o{ PRODUCT_PRICES : ""
  PRODUCTS ||--o{ PRODUCT_IMAGES : images
  PRODUCTS ||--o{ BATCHES : "batch / expiry"
  PRODUCTS }o--o| PRODUCTS : "variant of"
  PRODUCTS }o--o| SUPPLIERS : "preferred supplier"

  PRODUCTS {
    uuid id PK
    varchar code UK
    text name
    text name_local
    text_array aliases
    varchar hsn_code
    uuid tax_category_id FK
    numeric purchase_price
    numeric avg_cost
    numeric selling_price
    numeric mrp
    numeric min_stock
    bool track_batches
    bool track_expiry
  }
  TAX_CATEGORIES {
    uuid id PK
    text name
    enum kind "taxable | exempt | nil_rated | non_gst | zero_rated"
  }
  TAX_RATES {
    uuid id PK
    date effective_from
    date effective_to
    numeric gst_rate
    numeric cess_rate
    numeric cess_per_unit
    jsonb condition "e.g. unitValueLte 2500"
  }
  UNITS {
    uuid id PK
    varchar symbol
    varchar uqc "GST unit quantity code"
  }
  PRODUCT_UNITS {
    uuid product_id FK
    uuid unit_id FK
    numeric conversion_factor "1 BOX = 24 PCS"
  }
  BATCHES {
    uuid id PK
    varchar batch_number
    date mfg_date
    date expiry_date
    numeric mrp
  }
```

A product never stores its GST rate. It points at a tax category whose rates are dated rows, so a government rate change is one new `tax_rates` row (see [08-gst-architecture.md](08-gst-architecture.md)).

### 2.3 Customers, suppliers and the party ledger

```mermaid
erDiagram
  CUSTOMERS }o--|| STATES : "state / place of supply"
  CUSTOMERS }o--o| PRICE_LEVELS : "rate list"
  CUSTOMERS }o--o| CUSTOMER_CATEGORIES : category
  CUSTOMERS }o--o| SALES_ROUTES : "beat"
  CUSTOMERS }o--o| EMPLOYEES : "sales rep"
  CUSTOMERS ||--o{ CUSTOMER_ADDRESSES : "ship-to"
  CUSTOMERS ||--o{ PARTY_LEDGER_ENTRIES : statement
  SUPPLIERS ||--o{ PARTY_LEDGER_ENTRIES : statement
  SALES_ROUTES }o--o| EMPLOYEES : salesperson

  CUSTOMERS {
    uuid id PK
    varchar code UK
    text name
    text business_name
    enum customer_type "b2b | b2c"
    enum gst_registration
    varchar gstin
    varchar mobile
    numeric credit_limit
    smallint credit_days
    numeric opening_balance
    numeric balance "cached, = ledger sum"
  }
  SUPPLIERS {
    uuid id PK
    varchar code UK
    text name
    varchar gstin
    smallint credit_days
    numeric balance "cached payable"
    text bank_account_number_enc
  }
  PARTY_LEDGER_ENTRIES {
    bigint id PK
    enum party_type
    uuid customer_id FK
    uuid supplier_id FK
    date entry_date
    varchar doc_type
    uuid doc_id
    numeric debit
    numeric credit
    bigint reverses_entry_id
  }
```

`customers.balance` is a cache of the ledger kept in the same transaction as every ledger insert, so the customer list (thousands of rows) sorts by outstanding without aggregating; a nightly verifier compares cache and ledger.

### 2.4 Sales: orders, invoices, notes, packing and dispatch

```mermaid
erDiagram
  CUSTOMERS ||--o{ SALES_ORDERS : places
  SALES_ORDERS ||--o{ SALES_ORDER_ITEMS : contains
  SALES_ORDERS ||--o{ PACKINGS : "packed in"
  PACKINGS ||--o{ PACKING_ITEMS : ""
  SALES_ORDER_ITEMS ||--o{ PACKING_ITEMS : ""
  DISPATCHES ||--o{ DISPATCH_ORDERS : carries
  SALES_ORDERS ||--o{ DISPATCH_ORDERS : ""
  SALES_ORDERS ||--o{ INVOICES : "billed as"
  CUSTOMERS ||--o{ INVOICES : billed
  INVOICES ||--o{ INVOICE_ITEMS : lines
  SALES_ORDER_ITEMS ||--o{ INVOICE_ITEMS : ""
  INVOICE_ITEMS }o--o| BATCHES : "batch sold"
  INVOICES ||--o{ INVOICE_REVISIONS : "edit history"
  INVOICES ||--o{ CREDIT_DEBIT_NOTES : "returns / adjustments"
  CREDIT_DEBIT_NOTES ||--o{ CREDIT_DEBIT_NOTE_ITEMS : lines
  INVOICE_ITEMS ||--o{ PRICE_OVERRIDES : "rate changed"

  SALES_ORDERS {
    uuid id PK
    varchar order_number
    enum status "draft..delivered, cancelled"
    date order_date
    varchar source
  }
  SALES_ORDER_ITEMS {
    uuid id PK
    numeric qty
    numeric packed_qty
    numeric dispatched_qty
    numeric delivered_qty
    numeric invoiced_qty
    numeric cancelled_qty
  }
  INVOICES {
    uuid id PK
    varchar invoice_number "<= 16 chars, unique per FY"
    varchar financial_year
    date invoice_date
    enum document_kind "tax_invoice | bill_of_supply"
    enum status "draft | posted | cancelled"
    char place_of_supply
    enum supply_type
    varchar party_gstin "snapshot"
    numeric taxable_total
    numeric cgst_total
    numeric sgst_total
    numeric igst_total
    numeric round_off
    numeric grand_total
    numeric balance_due
    varchar tax_engine_version
    varchar irn "e-invoice"
    uuid client_id "idempotency"
  }
  INVOICE_ITEMS {
    uuid id PK
    text product_name "snapshot"
    varchar hsn_code
    numeric qty
    numeric free_qty
    numeric rate
    numeric taxable_value
    numeric gst_rate
    numeric cgst_amount
    numeric sgst_amount
    numeric igst_amount
    uuid tax_rate_id "rule applied"
    numeric unit_cost "for margin"
  }
  DISPATCHES {
    uuid id PK
    varchar vehicle_number
    text driver_name
    text transporter_name
    varchar lr_number
    varchar eway_bill_number
  }
```

Every GST document (order, invoice, purchase, note) shares the same line and totals column sets (`document-lines.ts`), so one calculator and one reporting path serve all of them.

### 2.5 Purchases, inventory and payments

```mermaid
erDiagram
  SUPPLIERS ||--o{ PURCHASES : bills
  PURCHASES ||--o{ PURCHASE_ITEMS : lines
  PURCHASE_ITEMS }o--o| BATCHES : "creates / uses"
  PRODUCTS ||--o{ STOCK_LEDGER : movements
  WAREHOUSES ||--o{ STOCK_LEDGER : ""
  BATCHES ||--o{ STOCK_LEDGER : ""
  PRODUCTS ||--o{ STOCK_BALANCES : "current stock"
  STOCK_ADJUSTMENTS ||--o{ STOCK_ADJUSTMENT_ITEMS : lines
  STOCK_TRANSFERS ||--o{ STOCK_TRANSFER_ITEMS : lines
  PAYMENTS ||--o{ PAYMENT_ALLOCATIONS : "settles"
  INVOICES ||--o{ PAYMENT_ALLOCATIONS : ""
  PURCHASES ||--o{ PAYMENT_ALLOCATIONS : ""
  PAYMENT_ACCOUNTS ||--o{ PAYMENTS : "cash / bank / UPI"

  PURCHASES {
    uuid id PK
    varchar supplier_invoice_number "unique per supplier + FY"
    date supplier_invoice_date
    enum itc_eligibility
    numeric grand_total
    numeric balance_due
  }
  STOCK_LEDGER {
    bigint id PK
    date txn_date
    enum movement_type "purchase, sale, sale_return, damaged, transfer_in..."
    numeric qty_in
    numeric qty_out
    numeric balance_after
    numeric unit_cost
    varchar ref_type
    uuid ref_id
  }
  STOCK_BALANCES {
    uuid product_id FK
    uuid warehouse_id FK
    uuid batch_id FK "NULLS NOT DISTINCT"
    numeric qty
    bigint last_ledger_id
  }
  PAYMENTS {
    uuid id PK
    enum direction "in | out"
    enum party_type
    numeric amount
    enum method "cash, upi, bank_transfer, cheque, card"
    varchar reference_number "UTR / cheque"
    enum cheque_status
    numeric unallocated_amount
  }
  PAYMENT_ALLOCATIONS {
    uuid payment_id FK
    uuid invoice_id FK
    uuid purchase_id FK
    uuid note_id FK
    numeric amount
  }
```

### 2.6 GST, HR, payroll, expenses and system tables

```mermaid
erDiagram
  INVOICES ||--o{ GST_TRANSACTIONS : "one row per line"
  PURCHASES ||--o{ GST_TRANSACTIONS : ""
  CREDIT_DEBIT_NOTES ||--o{ GST_TRANSACTIONS : ""
  GST_RETURN_PERIODS ||..o{ GST_TRANSACTIONS : "locks period"
  GST_EXPORTS }o--|| GST_RETURN_PERIODS : "generated for"
  EMPLOYEES ||--o{ ATTENDANCE : ""
  EMPLOYEES ||--o{ LEAVE_REQUESTS : ""
  LEAVE_TYPES ||--o{ LEAVE_REQUESTS : ""
  EMPLOYEES ||--o{ LEAVE_BALANCES : ""
  EMPLOYEES ||--o{ EMPLOYEE_SALARY_STRUCTURES : "salary history"
  PAYROLL_RUNS ||--o{ SALARY_SLIPS : ""
  SALARY_SLIPS ||--o{ SALARY_SLIP_LINES : "earnings & deductions"
  SALARY_COMPONENTS ||--o{ SALARY_SLIP_LINES : ""
  EMPLOYEES ||--o{ EMPLOYEE_ADVANCES : "advances / loans"
  EXPENSE_CATEGORIES ||--o{ EXPENSES : ""

  GST_TRANSACTIONS {
    bigint id PK
    enum direction
    enum doc_type
    char return_period "YYYY-MM"
    varchar party_gstin
    char place_of_supply
    enum supply_type
    varchar hsn_code
    numeric taxable_value
    numeric gst_rate
    numeric cgst_amount
    numeric igst_amount
    numeric document_value
    bool is_cancelled
  }
  SALARY_SLIPS {
    uuid id PK
    numeric paid_days
    numeric gross_earnings
    numeric total_deductions
    numeric net_pay "check: gross - deductions"
  }
  AUDIT_LOGS {
    bigint id PK
    varchar action
    varchar entity_type
    uuid entity_id
    text entity_label
    jsonb changes "field: [old, new]"
    varchar request_id
  }
```

## 3. Table catalogue

Every table, with all its columns (type, required, default, meaning), keys, foreign keys, checks, indexes, triggers, row-level security and what the API's role may do, is listed in **[12-database-reference.md](12-database-reference.md)**. That reference is generated from a database migrated from scratch and from the comments next to each table and column in `packages/db/src/schema/*.ts` (`pnpm db:docs`), and CI fails when it is out of date, so it is always the current truth; this document explains the design.

How the requested entities map: *Stock* → `stock_balances`; *StockLedger* → `stock_ledger`; *Salaries* → `salary_slips`; *SalaryComponents* → `salary_components` + `salary_slip_lines`; *Leaves* → `leave_requests` (+ types, balances); *Companies/Brands* → `brands`; *ProductCategories* → `product_categories` (self-referencing for subcategories); *TaxRates* → `tax_categories` + `tax_rates`; *GSTTransactions* → `gst_transactions`.

## 4. Integrity guarantees (enforced by the database)

| Guarantee | Mechanism | Tested |
|---|---|---|
| Invoice numbers unique per business and financial year | `invoices_number_uq (business_id, financial_year, invoice_number)` | ✓ duplicate rejected, whole posting rolled back |
| GST number format (≤ 16 chars; letters, digits, `/`, `-`) | check constraint | ✓ |
| Posted invoices have a number | check `status = 'draft' or invoice_number is not null` | |
| Same supplier bill cannot be entered twice | partial unique index on `(supplier_id, supplier_invoice_number, financial_year)` where not cancelled | |
| Offline retries cannot duplicate documents | partial unique index on `(business_id, client_id)` | |
| Stock ledger, party ledger and audit log are append-only | `BEFORE UPDATE OR DELETE` trigger raises; app role also has no UPDATE/DELETE privilege (`sql/app-role.sql`) | ✓ |
| GST register rows can only be flagged cancelled | trigger compares the row minus `is_cancelled` | ✓ |
| Posted invoices, purchases, payments, notes, adjustments are never deleted | `BEFORE DELETE` trigger unless `status = 'draft'` | ✓ |
| Filed GST periods are locked | trigger blocks changes to tax-relevant invoice fields when GSTR-1 for that month is `locked`/`filed`; payment fields remain editable | ✓ |
| A stock movement is either in or out, never both | check `(qty_in > 0) <> (qty_out > 0)` | ✓ |
| A party-ledger entry is either debit or credit | same pattern | |
| A payment allocation targets exactly one document | check `num_nonnulls(invoice_id, purchase_id, note_id) = 1` | ✓ |
| B2B customers have a GSTIN | check `customer_type = 'b2c' or gstin is not null` | ✓ |
| One stock bucket per product/warehouse/batch, including "no batch" | `UNIQUE NULLS NOT DISTINCT` | ✓ |
| Tenant isolation | Row-level security policy `business_id = current_setting('app.business_id')` on every business table, for non-owner roles | ✓ cross-tenant read and insert blocked |
| Salary slip arithmetic | check `net_pay = gross_earnings - total_deductions` | |

Negative stock is **not** a database constraint on purpose: some distributors bill before the purchase is entered. It is a business setting (`stock.negative_policy = allow | warn | block`) applied by `checkStock` in the posting service, and every movement is still in the ledger.

## 5. Indexing strategy for large data

* Every list screen's main query has a composite index starting with `business_id`: `invoices (business_id, customer_id, invoice_date)`, `invoices (business_id, invoice_date)`, `payments (business_id, customer_id, payment_date)`, `stock_ledger (business_id, product_id, warehouse_id, id)`, `audit_logs (business_id, entity_type, entity_id, created_at)`.
* **Partial indexes** for hot subsets: open invoices (`status = 'posted' and balance_due > 0`) for outstanding and aging; notifications per business by date; pending outbox events; pending leave requests.
* **Trigram (GIN) indexes** on customer, supplier and product names for fuzzy search on the server.
* **Keyset (cursor) pagination** everywhere; no `OFFSET` on large tables.
* **Summary tables** for reports (§7 of the architecture doc) and cached balances for lists.
* Growth path: monthly partitioning of `stock_ledger`, `party_ledger_entries`, `gst_transactions` and `audit_logs`; archive closed financial years to cheaper storage while keeping them queryable.

## 6. Reference data and seeds

`seedReferenceData` (idempotent, run on every deploy): GST state codes with Hindi names and SGST/UTGST component, the permission catalogue, and platform-default dated GST configuration (B2CL threshold history, HSN-digit rules, e-invoice and e-way bill thresholds — each marked for verification against current notifications).

`seedBusinessDefaults` (run when a business is created): editable roles (Admin, Manager, Sales, Accountant, Warehouse, HR), units with GST UQC codes, rate lists (Retail/Wholesale/Distributor), a main godown, a cash account, expense categories, leave types (CL, SL, PL, Unpaid, Other), salary components (Basic, HRA, Conveyance, Incentive, Overtime, Bonus, PF, ESI, Professional Tax, TDS), number series for the current financial year, business rules and reminder rules.

## 7. Running it

```bash
# apply migrations and reference data
DATABASE_URL=postgres://user:pass@host:5432/digitalbahi pnpm --filter @digitalbahi/db migrate
DATABASE_URL=... SEED_DEMO_BUSINESS=1 pnpm --filter @digitalbahi/db seed

# create the least-privileged application role (operator, once per environment)
psql "$DATABASE_URL" -v app_password='…' -f packages/db/sql/app-role.sql

# regenerate docs/12-database-reference.md after changing the schema or its comments (same kind of server)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm db:docs

# integration test on a throw-away database (needs a server you can CREATE DATABASE on)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @digitalbahi/db test
```
