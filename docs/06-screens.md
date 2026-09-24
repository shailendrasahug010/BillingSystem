# F. Screen-by-screen specification

Each screen lists who uses it, what it shows, what it lets the user do, the rules it enforces and how it adapts to a phone. **Built** screens exist in the prototype (`apps/web`); the others are specified here and scheduled in [11-roadmap.md](11-roadmap.md). All screens share the shell, components and states from [05-design-system.md](05-design-system.md): skeleton while loading, an empty state that says what to do, an error state with retry, and permission-based hiding of actions.

---

## 1. Login — **Built**
* **Users:** everyone.
* **Layout:** brand panel (desktop only) + form. Language toggle before sign-in.
* **Fields:** mobile number or email, password, "keep me signed in on this device"; *Sign in with OTP instead*; *Forgot password*.
* **After login:** if the user belongs to more than one business, a business chooser (legal name + GSTIN); otherwise straight to the dashboard (or to the last screen used).
* **Rules:** 5 failed attempts → temporary lock + OTP; new device → OTP confirmation; admin roles can require TOTP.
* **Phone:** single column, 48 px fields, numeric keyboard for mobile/OTP.

## 2. Dashboard — **Built**
* **Users:** owner, manager, accountant (financial cards need `dashboard.view_financials`; others see operational cards only).
* **Top:** date and greeting; **quick actions** row (Create Invoice, New Order, Receive Payment, Purchase Entry, Add Customer, Add Supplier, Pay Supplier, Stock Adjustment, Add Product, Add Expense) with shortcut hints.
* **Today:** Sales, Collection, Purchase, Expenses, Orders — each with the comparison to yesterday.
* **Trend:** sales and collection lines, Daily (30 days) / Weekly (12 weeks) / Monthly / Yearly (financial years), hover crosshair, table view.
* **Money:** outstanding receivable (with overdue amount), outstanding payable. **Orders & warehouse:** pending, to pack, to dispatch (each opens its queue).
* **Range section** (Today, Yesterday, Last 7 days, This month, Last month, This FY, custom): total sales with change vs the previous period; top-selling products, top customers, company-wise sales.
* **Bottom:** outstanding by age (not due, 1–30, 31–60, 61–90, 90+ days past due), **Needs attention** (customers with most overdue, one-tap call), **Stock alerts** (out of stock and low stock).
* **This month:** monthly sales, collection, purchase vs the same days last month.
* **Phone:** quick actions scroll horizontally; tiles two per row; charts full width.

## 3. Customer list — **Built**
* **Search:** name, business name, mobile, GSTIN, city, code (instant, forgiving).
* **Filters:** B2B/B2C, route (beat), has outstanding, overdue; sort by outstanding (default), last purchase, name.
* **Columns:** business + contact + city + mobile, GSTIN (or B2C badge), route, last purchase (date + days ago), payment behaviour badge, outstanding (overdue in red).
* **Actions:** Add customer (short form: type, business name, contact, mobile, GSTIN with checksum and state auto-fill, state, pincode, credit limit), export, row → profile.
* **Phone:** card list with business, city · route, outstanding and behaviour badge.

## 4. Customer profile — **Built**
* **Header:** business name, B2B/B2C, category, contact, address and state, GSTIN, route, sales rep, payment terms. Actions: Call, WhatsApp, Receive payment, **New invoice** (opens the invoice with this customer selected).
* **Tiles:** total sales (+ invoice count), outstanding (+ overdue), average order value, last purchase, payment behaviour (average days to pay).
* **Tabs:** *Overview* (most purchased products, reorder suggestions table) · *Invoices* (number, date, due date, total, balance, status) · *Payments* · *Ledger* (running balance statement, debit/credit, export PDF/Excel) · *Products* (every product bought: orders, total qty, last purchase, typical interval) · *Credit/debit notes* (Phase 3).
* **Rules:** financial tabs require `customer.view_ledger`.

## 5. Supplier list — **Built** (live)
* **Built:** search (name, legal name, code, city, GSTIN, mobile), "to pay" filter, payable total, CSV export, add supplier with GSTIN check and bank details (stored encrypted, only the last 4 digits shown). *Due date of oldest bill* column: Phase 4.
* Same pattern as customers: search (name, company, mobile, GSTIN), filters (has payable, due this week), columns (supplier, GSTIN, payable, due date of oldest bill, last purchase), add supplier (bank details stored encrypted, only last 4 digits shown).

## 6. Supplier profile — **Built** (live)
* **Built:** header (GSTIN, terms, masked bank/UPI), tiles (payable, total purchases, last purchase, last payment), tabs purchases / payments / ledger, actions Edit, Pay supplier, New purchase bill. *Products purchased* tab: Phase 4.
* Header with GSTIN, terms, bank/UPI (masked). Tiles: total purchase, outstanding payable, last purchase, products supplied. Tabs: purchase history, payments, outstanding bills (with due dates), products purchased (last rate, average rate), ledger. Actions: Pay supplier, New purchase.

## 7. Product list — **Built**
* **Search:** name, local name, aliases, code, barcode, brand. **Filters:** company/brand, stock level (all / low / out), category (Phase 3).
* **Columns:** product (code, pack, barcode), brand, HSN, GST (or *Nil rated*), MRP, selling price, margin (needs `product.view_cost`), current stock with level badge. Header shows total stock value.
* **Actions:** Add product, bulk import (Excel with row-level errors), export.

## 8. Product profile — Phase 3/4 (editor **Built**)
* **Built (live):** add / edit dialog with names, aliases, brand and category (created inline), HSN, GST category, barcodes, stock unit and case unit, minimum / reorder quantity, opening stock and cost, batch / expiry tracking, purchase / selling / MRP and a price per rate list; only changed fields are sent, and price fields are locked for roles without `product.update_price`.
* **Master data:** name + local name + aliases, code, SKU, barcodes (several), HSN, tax category (with the rate in force today and its history), brand, category/subcategory, base unit and alternate units (1 BOX = 24 PCS), pack size, prices per rate list and unit, MRP, minimum stock / reorder quantity, preferred supplier, batch/expiry/serial tracking, variants, images, active.
* **Analytics tab (Phase 4):** quantity and value sold and purchased, current stock by godown and batch (with expiry), margin, average selling and purchase price, top customers, sales and purchase trend, date filter.
* **Stock tab:** stock ledger (date · transaction · in · out · balance).

## 9. Create invoice — **Built** (highest priority)
Designed for "customer → items → save" in under 30 seconds with the keyboard or a scanner.

**Desktop layout (two columns):**

| Left (work area) | Right (sticky bill summary) |
|---|---|
| **Customer** search (F3) → **customer card**: business, B2B/B2C, payment behaviour, contact, GSTIN, outstanding (overdue), credit limit with used/available meter, last purchase (days ago), average order, average days to pay; credit warning banner when the bill would exceed the limit or invoices are overdue | Invoice number (next in series), date, due date (from credit days) |
| **Product search** (F2) with barcode scan: results show name (local name in Hindi UI), code, brand, pack, HSN, GST, price for this customer's rate list, stock badge, "bought 12×" | Supply type and place of supply: *Intra-state · CGST + SGST* (or UTGST) / *Inter-state · IGST* |
| **Smart suggestions** (tabs: For this customer, Reorder due, Frequently bought, Bought together, Last order): each shows the reason ("Usually every 7 days · last bought 6 days ago"), a "why?" popover with all reasons and batch expiry, stock flags and a one-click **+ suggested qty** button; Alt+1…9 adds the first nine; reorder tab has a table view (product, last qty, last purchase, suggested qty, status) | Lines · qty, subtotal, discount, taxable value, CGST, SGST/UTGST or IGST, cess, round-off, **grand total**, rate-wise tax breakup |
| **Items table:** #, product (code, HSN, pack, batch), qty stepper, rate (editable), discount %, GST %, amount (+ tax); warnings inline: *Only 8 in stock*, *Below purchase cost*; Enter in qty returns to product search | **Amount received** (+ "Fully paid"), payment mode (Cash, UPI, Bank transfer, Cheque, Card), balance or advance |
| | **Save invoice** (Ctrl+Enter), Save & print, Share on WhatsApp |

**Rules:** totals come from the shared engine (identical to the server); tax is resolved on the invoice date; the customer's rate list prices lines; changing the customer re-prices; products already on the bill disappear from suggestions; negative stock and credit follow the business policy (warn or block); nothing is ever added automatically. After save: toast with the number and a *Details* link; the draft resets for the next customer.

**Phone ("Quick invoice"):** three steps with a progress bar — **1 Customer** (search or recent customers) → **2 Products** (large search, scan button, suggestions with one-tap add, cart with −/+ and quick +case/+10 buttons, sticky total + Next) → **3 Review & pay** (customer card, item review, summary with amount received and payment mode, Save / Save & print / WhatsApp).

## 10. Invoice details — **Built**
* Header: number, customer, total, payment status; actions: print, PDF, share (WhatsApp/email), **print language** (English / हिन्दी), cancel (Phase 3), credit note (Phase 3), e-invoice/IRN (Phase 6).
* **Document (A4):** business name, address, GSTIN; *Tax Invoice — Original for recipient*; number, date, due date, place of supply, reverse charge; bill-to and ship-to with GSTIN and state code; lines (description with batch/expiry, HSN, qty + unit, rate, discount, taxable, GST %, CGST + SGST/UTGST or IGST, amount); HSN tax summary; taxable value, taxes, round-off, **grand total**; paid and balance; amount in words (in the print language); bank and UPI details; terms; *For <business> — Authorised signatory*; "computer-generated invoice".
* Templates: A4, A5, 80 mm thermal; configurable header, terms, logo, bank details, columns.

## 11. Sales order — Phase 3
* List with status tabs (Draft, Pending, Confirmed, Packing, Packed, Dispatched, Delivered, Cancelled), route and salesperson filters.
* Create: same customer + items experience as the invoice (suggestions included), expected delivery date, source (counter, salesperson app, phone, WhatsApp).
* Detail: timeline of status changes (who, when, note), fulfilment progress bars (packed / dispatched / delivered / invoiced per line), actions allowed by the workflow (`allowedTransitions`), convert to invoice (full or partial).
* Workflow steps are configurable (skip confirmation, packing or dispatch).

## 12. Packing — Phase 4
* **Queue:** orders to pack, grouped by route / dispatch date, oldest first.
* **Packing screen:** order number, customer, lines with ordered, packed and remaining qty, batch (suggested first-expiry-first-out) and expiry, weight; scan a barcode to count up; partial packing allowed; box count and weight; *Mark packed*; print packing slip.
* **Phone/scanner:** one line at a time, huge counters, scan-driven.

## 13. Dispatch — Phase 4
* Create a dispatch (vehicle trip): vehicle number, driver (employee or name + mobile), transporter, LR number/date, e-way bill number, dispatch date, expected delivery; add packed orders (by route); reorder delivery sequence.
* Delivery: per order *Delivered / Partly delivered / Returned*, received by, proof of delivery photo, remarks; delivery date recorded; print dispatch note.

## 14. Purchase entry — **Built** (live)
* **Built:** supplier search, bill number and dates, ITC eligibility, reverse charge, lines (search/scan, unit or case, qty, free qty, rate, discount, supplier's GST override, batch/expiry when tracked), freight and other charges, payment at entry, live totals from the shared engine (the server rejects any difference), purchase detail with payments and cancel. *Bill photo, duplicate check as you type, landed-cost preview, purchase returns:* Phase 4.
* Supplier (with outstanding and last purchase), supplier invoice number and date (duplicate check as you type), received date, godown.
* Lines: product search/scan, qty, free qty, purchase rate, discount, GST (from tax category, editable for supplier's rate), batch, mfg/expiry, MRP; landed cost preview; other charges (freight, loading) apportioned.
* Totals: taxable, CGST/SGST or IGST (from the supplier's state), round-off, total; ITC eligibility; attach bill photo/PDF.
* **Post:** stock in, cost update, supplier balance, inward GST — one transaction. Purchase return and supplier notes from the purchase detail.

## 15. Inventory — **Built** (live, single godown)
* **Built:** stock list with level filter, value and average cost (for roles allowed to see them), CSV export, stock ledger per product, adjustments (physical count posts the difference; damage, expiry, theft, sample, own use) and their history. *Transfers, per-godown/batch views, expiry list:* Phase 4.
* **Stock list:** product, godown, batch, expiry, qty, value (needs `inventory.view_value`), level; filters: brand, category, godown, low/out/expiring.
* **Stock ledger:** per product (and godown/batch): date · transaction (with link to the document) · in · out · balance.
* **Adjustments:** reason (damage, expiry, count correction, theft, sample, internal use), lines with system qty vs counted qty, approval when configured. **Transfers:** from/to godown, in-transit and receive. **Expiry:** batches expiring in N days with suggested action.

## 16. Payment collection — **Built** (live)
* **Built:** receive payment and pay supplier (oldest bills first, editable per bill, remainder kept as advance), cheque number/date/bank and status (deposited, cleared, bounced — a bounce reverses the allocation), apply an advance later, cancel with reason, list with filters and CSV export. *Receipt print/WhatsApp, the offline phone "Collect" flow:* Phase 4/5.
* **Receive payment:** customer (outstanding, overdue list), amount, method (Cash, UPI, Bank transfer, Cheque — with cheque number/date/bank, Card), reference (UTR), date, collected by; allocation to open invoices (oldest first by default, editable per invoice), remainder as advance; receipt print/WhatsApp.
* **Pay supplier:** mirror image against open bills.
* **Lists:** receipts and payments with filters (method, date, collected by), cheque status (deposited, cleared, bounced — bounce reverses the allocation and notifies).
* **Phone:** "Collect" flow for salespeople on a beat: customer → amount → method → save (works offline).

## 17. Employee management — Phase 4
* List (status, department, designation), profile with personal, job, bank (encrypted, masked), PAN (masked), optional Aadhaar last 4 only, emergency contact, login link; attendance calendar.

## 18. Salary — Phase 4
* Salary structures (basic, allowances, deductions, effective from); monthly payroll run: attendance and leave pulled in, incentive/overtime/bonus/advance and loan recovery entered, net pay computed; review → finalise (frozen) → mark paid (creates payments); salary slips (PDF, Hindi/English); payroll register; employee salary history.

## 19. Leave management — Phase 4
* Apply (type, dates, half-day, reason) with live balance; approver inbox (approve / reject with note); balances per type; history; leave type configuration (paid/unpaid, annual quota, carry forward, half-day allowed). Approved unpaid leave flows into payroll.

## 20. GST reports — Phase 4 (monthly summary **Built**)
* **Built (live):** month picker and period status, outward by section (B2B / B2CL / B2CS) and rate, inward by ITC eligibility and reverse charge, HSN summary (CSV), output tax vs eligible ITC estimate. The rest below is Phase 4.
* Period picker (month / quarter), period status (open, locked, filed).
* **Summary:** outward (B2B, B2C large, B2C small, exports/SEZ, nil/exempt), credit/debit notes, inward with ITC, tax by rate, net liability view.
* **HSN summary**, **rate-wise summary**, **sales register**, **purchase register**, **documents issued**.
* **Validation panel:** B2B invoices without a valid GSTIN, place-of-supply mismatches, missing HSN, HSN shorter than required, cancelled documents.
* **Export:** GSTR-1 (JSON for the offline tool / portal, Excel, CSV), GSTR-3B summary, HSN CSV — each from a named, versioned formatter; export history. **Lock period** after filing.

## 21. Business reports — Phase 4 (core reports **Built**)
* **Built (live):** sales (day/week/month, customer, product, brand, category, salesperson), collections (day/week/month, method, customer), purchases (day/month, supplier, product, brand), outstanding receivable and payable with aging, preset or custom periods, CSV export. The rest below is Phase 4.
* Report catalogue: sales (daily/weekly/monthly/yearly, customer, product, company, category, salesperson), collections (today, yesterday, week, month, year, custom), purchases (supplier, product, company, month, year), outstanding (customer/supplier, aging 0–30/31–60/61–90/90+), expenses, product analytics, company report, BI (gross margin, inventory value and turnover, fast/slow movers, customer and company contribution, period comparison such as Sep 2026 vs Sep 2025).
* Every report: filters (date, customer, supplier, product, company, employee, payment method, GST type), search, sort, column choice, **export Excel / CSV / PDF**, print, saved views.

## 22. Settings — **Built** (partial)
* **Built:** app language, theme; live: business profile editing (legal/trade name, GST registration, GSTIN, PAN, address), negative-stock and credit policies, round-off, invoice print language, payment allocation, expiry warning days, document number patterns. Demo: simulated online/offline.
* **Phase 3:** business profile editing (logo, address, GSTIN, bank), invoice settings (series, templates, print language, terms, round-off, edit window), tax categories and rates, credit policy, order workflow steps, units, rate lists, godowns, reminder rules and channels, keyboard preset (default / Tally-style), backup schedule.

## Additional screens

| Screen | Status | Contents |
|---|---|---|
| Global search (Ctrl+K) | **Built** | Customers, products, invoices and screens; arrow keys + Enter |
| Design system | **Built** | Live tokens and components |
| Planned module pages | **Built** | For every not-yet-built module: its tables (already migrated) and API endpoints |
| Expenses | Phase 4 | Entry (category, amount, GST for ITC, paid by, receipt photo), list, category-wise / monthly / yearly reports |
| Notifications | Phase 5 | Inbox (payment due, low stock, expiring, pending orders, to pack/dispatch, leave, salary due), mark read, reminder rule settings |
| Users & roles | **Built** (live) | Invite by mobile, assign role, deactivate; role editor (permission matrix by module); all changes audit-logged |
| Audit log | Phase 3 | Who, what, entity (linked), old → new values, when, device, IP; filters |
| Backup & restore | Phase 6 | Schedule (daily/weekly), manual backup, list with size and checksum, download, restore with typed confirmation and re-authentication |
