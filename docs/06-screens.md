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
| | **Save invoice** (Ctrl+Enter), Save & print, Share on WhatsApp; on the saved invoice: Print, **Download PDF** (made on the server, English / Hindi), **WhatsApp** (the PDF file itself on phones), **Send** (from the firm's WhatsApp Business number or email, with the PDF) |

**Rules:** totals come from the shared engine (identical to the server); tax is resolved on the invoice date; the customer's rate list prices lines; changing the customer re-prices; products already on the bill disappear from suggestions; negative stock and credit follow the business policy (warn or block); nothing is ever added automatically. After save: toast with the number and a *Details* link; the draft resets for the next customer.

**Phone ("Quick invoice"):** three steps with a progress bar — **1 Customer** (search or recent customers) → **2 Products** (large search, scan button, suggestions with one-tap add, cart with −/+ and quick +case/+10 buttons, sticky total + Next) → **3 Review & pay** (customer card, item review, summary with amount received and payment mode, Save / Save & print / WhatsApp).

## 10. Invoice details — **Built**
* Header: number, customer, total, payment status; actions: print, PDF, share (WhatsApp/email), **print language** (English / हिन्दी), cancel (Phase 3), credit note (Phase 3), e-invoice/IRN (Phase 6).
* **Document (A4):** business name, address, GSTIN; *Tax Invoice — Original for recipient*; number, date, due date, place of supply, reverse charge; bill-to and ship-to with GSTIN and state code; lines (description with batch/expiry, HSN, qty + unit, rate, discount, taxable, GST %, CGST + SGST/UTGST or IGST, amount); HSN tax summary; taxable value, taxes, round-off, **grand total**; paid and balance; amount in words (in the print language); bank and UPI details; terms; *For <business> — Authorised signatory*; "computer-generated invoice".
* Templates: A4, A5, 80 mm thermal; configurable header, terms, logo, bank details, columns.

## 11. Sales order — **Built** (live)
* **Built:** list (open / pending / confirmed / all, search), "Stock needed" (open order quantities against stock), new order (Alt+O, or from the customer profile) with units / cases and free goods, prices from the customer's rate list, order page with status history, confirm / cancel (reason) / packing / dispatch / delivered per the workflow and permissions, make invoice for everything open or chosen quantities at the order's rates, linked invoices. *Suggestions in the order entry, route and salesperson filters:* Phase 4.
* List with status tabs (Draft, Pending, Confirmed, Packing, Packed, Dispatched, Delivered, Cancelled), route and salesperson filters.
* Create: same customer + items experience as the invoice (suggestions included), expected delivery date, source (counter, salesperson app, phone, WhatsApp).
* Detail: timeline of status changes (who, when, note), fulfilment progress bars (packed / dispatched / delivered / invoiced per line), actions allowed by the workflow (`allowedTransitions`), convert to invoice (full or partial).
* Workflow steps are configurable (skip confirmation, packing or dispatch).

## 12. Packing — **Built** (live)
* **Built:** queue of confirmed orders (by expected delivery), pack dialog with scan-to-pack (barcode or product name), quantities per line with what is left, batches split first-expiry-first, box numbers, box count, weight and packer; the order moves to packing / packed; packing slips (print, unpack). *Grouping the queue by route, a scanner-first phone layout:* later.
* **Queue:** orders to pack, grouped by route / dispatch date, oldest first.
* **Packing screen:** order number, customer, lines with ordered, packed and remaining qty, batch (suggested first-expiry-first-out) and expiry, weight; scan a barcode to count up; partial packing allowed; box count and weight; *Mark packed*; print packing slip.
* **Phone/scanner:** one line at a time, huge counters, scan-driven.

## 13. Dispatch — **Built** (live)
* **Built:** posted bills not yet on a trip (by route and city), plan a trip with vehicle, driver (employee or name + mobile), transporter, LR and expected date, delivery order, dispatch now or later, per-stop delivered / returned with the receiver's name, loading list, printable trip sheet with amounts to collect. *E-way bill number, proof-of-delivery photo:* later.
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

## 17. Employee management — **Built** (live)
* **Built:** list (current / all, department, search), add / edit (bank, PAN, Aadhaar encrypted; masked copies shown), detail with salary structure, advances and loans, record leaving; daily attendance marking (present, absent, half day, leave, holiday, weekly off, overtime) and a month register. *Login link, photo:* later.
* List (status, department, designation), profile with personal, job, bank (encrypted, masked), PAN (masked), optional Aadhaar last 4 only, emergency contact, login link; attendance calendar.

## 18. Salary — **Built** (live)
* **Built:** payroll runs per month from attendance and unpaid leave, per-slip incentive / bonus / deductions / overtime, recalculate, finalize (advance recovery), pay (one payment per person), salary slip print in English or Hindi. *Payroll register export, statutory PF / ESI / PT tables:* later.
* Salary structures (basic, allowances, deductions, effective from); monthly payroll run: attendance and leave pulled in, incentive/overtime/bonus/advance and loan recovery entered, net pay computed; review → finalise (frozen) → mark paid (creates payments); salary slips (PDF, Hindi/English); payroll register; employee salary history.

## 19. Leave management — **Built** (live)
* **Built:** apply with available balance, approve / reject / withdraw, balances per type and year, leave types (paid, annual quota, half day). *Carry forward at year end:* later.
* Apply (type, dates, half-day, reason) with live balance; approver inbox (approve / reject with note); balances per type; history; leave type configuration (paid/unpaid, annual quota, carry forward, half-day allowed). Approved unpaid leave flows into payroll.

## 20. GST reports — **Built** (live)
* **Built:** Summary tab (outward by section and rate, inward by ITC and reverse charge, notes, HSN summary with CSV, estimate); GSTR-1 tab (tables B2B / B2CL / B2CS / CDNR / CDNUR / nil / HSN B2B and B2C, things to check before filing, documents issued, JSON for the offline tool and CSV per table, files downloaded with their formatter version); GSTR-3B tab (3.1, 3.2, 4, indicative 6.1, CSV); lock / unlock the month and record the filing ARN. *Quarterly returns, exports / SEZ, Excel:* later.
* Period picker (month / quarter), period status (open, locked, filed).
* **Summary:** outward (B2B, B2C large, B2C small, exports/SEZ, nil/exempt), credit/debit notes, inward with ITC, tax by rate, net liability view.
* **HSN summary**, **rate-wise summary**, **sales register**, **purchase register**, **documents issued**.
* **Validation panel:** B2B invoices without a valid GSTIN, place-of-supply mismatches, missing HSN, HSN shorter than required, cancelled documents.
* **Export:** GSTR-1 (JSON for the offline tool / portal, Excel, CSV), GSTR-3B summary, HSN CSV — each from a named, versioned formatter; export history. **Lock period** after filing.

## 21. Business reports — **Built** (live; saved views and PDF later)
* **Built:** sales (day/week/month, customer, product, brand, category, salesperson), collections, purchases, outstanding with aging, profit (margin by product, company, category, customer, salesperson, month), profit & loss (gross profit, expenses, salaries, net profit), products (fast / slow / not moving, stock value, days of cover); Product Reports and Company Reports open the products and company-profit views; preset or custom periods, export as PDF (letterhead, totals, page numbers), Excel (.xlsx with typed numbers and dates, frozen header, totals) or CSV.
* Report catalogue: sales (daily/weekly/monthly/yearly, customer, product, company, category, salesperson), collections (today, yesterday, week, month, year, custom), purchases (supplier, product, company, month, year), outstanding (customer/supplier, aging 0–30/31–60/61–90/90+), expenses, product analytics, company report, BI (gross margin, inventory value and turnover, fast/slow movers, customer and company contribution, period comparison such as Sep 2026 vs Sep 2025).
* Every report: filters (date, customer, supplier, product, company, employee, payment method, GST type), search, sort, column choice, **export Excel / CSV / PDF**, print, saved views.

## 22. Settings — **Built** (partial)
* **Built:** app language, theme; live: business profile editing (legal/trade name, GST registration, GSTIN, PAN, address, mobile, email) with the **firm logo** (upload, change, remove; a preview of the letterhead as it prints), negative-stock and credit policies, round-off, invoice print language, payment allocation, expiry warning days, document number patterns, **devices for offline billing** (series, user, last seen, offline bills; remove a lost device). Demo: simulated online/offline.
* **Phase 3:** business profile editing (logo, address, GSTIN, bank), invoice settings (series, templates, print language, terms, round-off, edit window), tax categories and rates, credit policy, order workflow steps, units, rate lists, godowns, reminder rules and channels, keyboard preset (default / Tally-style), backup schedule.

## Additional screens

| Screen | Status | Contents |
|---|---|---|
| Global search (Ctrl+K) | **Built** | Customers, products, invoices and screens; arrow keys + Enter |
| Design system | **Built** | Live tokens and components |
| Planned module pages | **Built** | For every not-yet-built module: its tables (already migrated) and API endpoints |
| Expenses | **Built** (live) | Entry (category, amount before or including GST, vendor GSTIN for ITC, paid by, bill number), list with totals, cancel, summary by category / month / year / method, category manager. *Receipt photo:* later |
| Notifications | Phase 5 | Inbox (payment due, low stock, expiring, pending orders, to pack/dispatch, leave, salary due), mark read, reminder rule settings |
| Users & roles | **Built** (live) | Invite by mobile, assign role, deactivate; role editor (permission matrix by module); all changes audit-logged |
| Audit log | **Built** (live) | Who, what, record, old → new values, when, IP; filters by record type, user and dates |
| Import (products, customers) | **Built** (live) | Excel (.xlsx), CSV or a PDF made by billing software (a price list), template, header aliases from common exports, check-first with an error table by row and column, then import |
| Import supplier bill | **Built** (live) | Purchases → Import bill: Excel / CSV bill from the supplier, or the PDF their software printed (bill number, date and GSTIN read from above the table, wrapped names and two- or three-line headings joined, company invoices with the name above and below each item's numbers, "CGST@6 + SGST@6" tax text, tables that continue on the next page without the heading; scanned PDFs refused with a message), pick the bill if the file has several, match and open in purchase entry with the unmatched items to pick (close matches, new product prefilled from the bill, or leave out); matches remembered per supplier; duplicate bill flagged |
| Returns (credit / debit notes) | **Built** (live) | From the invoice ("Record return") or the purchase bill ("Return to supplier"): quantities per line, restock or not, reason; printable note; cancel. Also value-only notes: "Discount / rate difference" on an invoice and "Supplier credit note" on a purchase (percent or amount) |
| Backup & restore | Built | Download the whole business as one file (optional password), email a protected copy, earlier backups with size and checksum; restore: choose a file, type its password, check what is in it, confirm, and the app opens the restored business (always a new one). Scheduled backups later |
