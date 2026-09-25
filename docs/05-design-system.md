# E. UI/UX design system

The design system is implemented, not just described: tokens in `apps/web/src/styles/app.css`, components in `apps/web/src/components`, and a live gallery at **Design System** in the app (`#design`).

## 1. Principles

1. **Built for the counter, not the conference room.** A billing clerk with a queue of customers, a salesperson on a phone in a shop, a warehouse picker with a scanner. Big targets, few fields, keyboard and scanner first on desktop, thumb first on phones.
2. **Money is always legible.** Tabular figures, Indian digit grouping (₹12,34,567.00), two decimals on documents, compact lakh/crore on dashboards (₹5.9L, ₹1.2Cr).
3. **State is never colour alone.** Every status (paid, overdue, low stock, credit warning) is text + colour, often + icon; charts have legends and table views.
4. **Explain, don't surprise.** Smart suggestions say why they appear; warnings say what will happen and how to proceed; nothing is added or changed automatically.
5. **Same screen, every size.** One responsive layout per screen with a dedicated phone flow only where the task differs (quick invoice).
6. **Two languages from day one.** Hindi strings are first-class, not an afterthought.

## 2. Visual identity

| Element | Choice | Reason |
|---|---|---|
| Accent | **Royal blue** `#1450B4` from the Digital Bahi logo (dark theme `#7AA7FF`) | Matches the brand; distinct from the status colours (green = paid, red = overdue) |
| Brand | The **Digital Bahi** logo (open ledger with the rupee sign and a green swoosh), wordmark "Digital" in navy `#0B2D72` and "Bahi" in green `#2F8F1F`, tagline *Aapke Business ka Digital Hisab* | The software's identity: sign-in screen, top of the menu, installed-app icon, and a small "Made with Digital Bahi" line on printouts |
| Firm identity | The business's own uploaded logo, name, address, mobile, email and GSTIN | The user's identity: the firm card in the menu and the letterhead of every printed document |
| Neutrals | Cool greys with a slight blue bias (`--bg #F3F5FA`, `--ink #0E1A33`) | Look deliberate next to the accent |
| Display type | **Anek Latin / Anek Devanagari** (Ek Type, Indian foundry) | One design across both scripts; confident headings and big numbers |
| UI type | **IBM Plex Sans / IBM Plex Sans Devanagari** | Highly legible at 13–15 px, true tabular figures, matching Devanagari companion |
| Identifiers | **IBM Plex Mono** | GSTINs, invoice numbers, HSN codes, barcodes are read character by character |

Fonts are bundled with the app in production (not loaded from Google Fonts) so offline devices render correctly.

## 3. Tokens

All colours are CSS custom properties on `:root`; the dark theme redefines only the tokens, under `@media (prefers-color-scheme: dark)` (guarded by `:root:not([data-theme="light"])`) and again under `:root[data-theme="dark"]`, so System / Light / Dark all work. Components never use raw hex values.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F3F6F6` | `#0C1618` | Page |
| `--surface` / `-2` / `-3` | `#FFFFFF` / `#EEF3F3` / `#E3EAEB` | `#122023` / `#172A2E` / `#1F363A` | Cards, inputs, hovers |
| `--border` / `-strong` | `#D7E0E1` / `#B9C7C9` | `#25393D` / `#37525A` | Dividers, control borders |
| `--ink` / `-2` / `-3` | `#0F2629` / `#4A5F62` / `#6F8487` | `#E6EFF0` / `#A8BABD` / `#7F9497` | Primary, secondary, muted text |
| `--accent` (+ `-hover`, `-soft`, `-ink`) | `#0B6E82` | `#3CB4CA` | Primary actions, selection, focus |
| `--good` / `-soft` | `#0B7A3E` / `#E1F3E8` | `#4CC987` / `#12301F` | Paid, on time, in stock |
| `--warn` / `-soft` | `#8A5A00` / `#FCEFD2` | `#F2BD4F` / `#36290C` | Due, low stock, credit warning |
| `--danger` / `-soft` | `#B42318` / `#FDE7E4` | `#F2837A` / `#3D1714` | Overdue, out of stock, blocked, destructive |
| `--series-1..3` | `#2A78D6` `#EB6834` `#1BAF7A` | `#3987E5` `#D95926` `#199E70` | Chart series (validated colour-blind-safe order) |
| `--ordinal-1..4` | blue ramp light → dark | reversed for dark | Ordered buckets (aging) |

| Scale | Values |
|---|---|
| Type | 11 (eyebrow) · 12.5 (caption) · 13.5 (table) · 14 (body) · 15–16 (inputs on phone) · 18 (section) · 24–26 (page title) · 30 (hero figure) |
| Line height | 1.5 for Latin; **1.65 when the UI is in Hindi** (room for matras above and below) |
| Spacing | 4 px base; component gaps 8/12/16; page gutter 16 (phone) → 32 (desktop) |
| Radius | Controls 10 px, cards 14 px, pills full |
| Elevation | `shadow-card` (resting cards), `shadow-pop` (menus, dialogs, toasts) |
| Motion | 160 ms ease-out pop-in for overlays; spinners only for sync; all disabled under `prefers-reduced-motion` |
| Breakpoints | `sm 640` · `md 768` · `lg 1024` (sidebar appears, quick invoice becomes the full invoice screen) · `xl 1280` · `2xl 1536` |

## 4. Components

| Component | Notes |
|---|---|
| **Button** | `primary`, `secondary`, `soft`, `ghost`, `danger`; sizes 32 / 40 / 48 px (48 px for primary actions on phones); optional icon and keyboard hint |
| **Input / Select / Field** | Label always visible (no placeholder-only fields); hint or specific error under the field; leading icon; `invalid` state; numeric inputs keep what the user typed (`12.`) and commit valid numbers |
| **Combobox** (customer / product search) | ARIA combobox + listbox, arrow keys, Enter to choose, results show the information needed to choose correctly (outstanding for customers; stock, price and "bought 12×" for products) |
| **Badge** | Neutral, accent, good, warn, danger; optional dot; one mapping from workflow state to tone (`lib/status.ts`) |
| **Card / CardHeader** | Used by role, not everywhere: grouped content, lists, charts |
| **Stat tile** | Label · value (tabular, compact) · delta vs previous period (colour by whether up is good) · optional footnote; clickable when it leads to a list |
| **Dialog** | Radix dialog: focus trap, Esc closes, titled; becomes a **bottom sheet on phones** |
| **Toast** | Result of an action with an optional follow-up action ("Invoice INV/26-27/00670 saved · Details"); offline saves say so |
| **Segmented control** | Mutually exclusive views (daily/weekly/monthly, B2B/B2C) |
| **Tabs** | Profile sections |
| **Data table** | Sticky header, right-aligned tabular numbers, row click opens detail, horizontal scroll inside its own container on small screens, card list alternative on phones; production version adds column chooser, virtualised rows (TanStack), bulk select and export |
| **Empty / loading / error states** | Every list has all three: skeletons that match the final layout, an empty state that says what to do next, an error state with retry |
| **Progress / meter** | Credit used; the track is a lighter step of the same hue |
| **Kbd** | Shortcut hints next to actions on desktop |
| **Command palette** | Ctrl+K global search and navigation |
| **Charts** | Trend (line + area, crosshair tooltip, keyboard, table view), ranked bar list, ordinal columns (aging) |
| **Sync chip** | Online / Offline / Syncing with pending count |
| **Language toggle** | EN / हिं, always one tap away (top bar, login, settings) |

## 5. Layout

### Desktop (≥ 1024 px)
* **Sidebar** (248 px): brand, current business + GSTIN, navigation grouped by *Daily work · Stock · Money · People · Insights · Admin*, user and shortcuts at the bottom. Items the user's role cannot use are hidden.
* **Top bar**: global search (Ctrl+K), sync status, language, theme, notifications, **+ New Invoice** (Ctrl+I).
* **Content**: max 1480 px wide; list screens use full width; forms and settings a readable column.

### Phone (< 1024 px)
* **Top bar**: menu, brand, search icon, sync, language, theme, notifications.
* **Bottom navigation**: Home · Customers · **Create (+)** · Products · More. *Create* opens a sheet of quick actions (invoice, order, collect payment, add customer, purchase, product). *More* opens the full module list.
* Primary actions sit in a sticky bottom bar (e.g. invoice total + Next), above the bottom navigation and the safe-area inset.

## 6. Patterns

| Pattern | Rule |
|---|---|
| Forms | Only fields needed now; everything else defaulted and editable on the profile. Validate on blur, then as the user types; messages name the problem ("This GSTIN has a typo (check digit does not match)") |
| Smart defaults | GSTIN fills the state; the customer's rate list, credit days and place of supply fill the invoice; payment "Fully paid" in one tap |
| Confirmation | Reversible actions do not ask; they offer undo or cancel. Destructive or financial actions confirm with the consequence ("Cancel INV/26-27/00412? Stock and the customer balance will be reversed."). Restore from backup requires typing the business name and re-entering the password |
| Warnings vs blocks | Policies set to *warn* show inline and let the user continue; *block* disables Save and explains who can override |
| Numbers | Right-aligned, tabular; currency symbol on totals, not on every cell of dense tables |
| Search | Always forgiving: punctuation and spacing ignored ("parleg" → Parle-G), local-language aliases ("namak" / "नमक" → Tata Salt) |
| Lists | Default sort is the one people act on (customers by outstanding, orders oldest first) |
| Printing | Invoice print language is chosen per invoice; A4, A5 and 80 mm thermal templates |

## 7. Keyboard shortcuts

Shortcuts use physical keys (`KeyboardEvent.code`), so they work with Hindi keyboard layouts and on macOS.

| Action | Shortcut | Note |
|---|---|---|
| Global search | **Ctrl + K** | as requested |
| New invoice | **Ctrl + I** | as requested |
| New order | **Alt + O** | |
| Purchase entry | **Alt + P** | Ctrl + P is the browser's Print command, which billing users rely on; overriding it breaks printing |
| Receive payment (collection) | **Alt + C** | Ctrl + C is Copy; overriding it would stop users copying GSTINs and amounts |
| Jump to customer / product search (invoice) | **F3 / F2** | |
| Add suggestion 1–9 (invoice) | **Alt + 1…9** | |
| Save invoice | **Ctrl + Enter** | |
| Close dialog | **Esc** | |
| Shortcut help | **?** | |

A **Tally-style preset** (F8 sales, F9 purchase, F6 receipt, F5 payment) is planned as a setting for accountants coming from Tally (Phase 3).

## 8. Localisation

* Every string comes from `packages/i18n/src/locales/{en,hi}.json`; keys are type-checked; a test fails the build when a language misses a key or a placeholder.
* **Hindi style guide**: everyday trade Hindi in Devanagari, using the loanwords shopkeepers actually use where the "pure" word is unfamiliar. Glossary (extend, don't vary):

| English | Hindi used | Not used |
|---|---|---|
| Invoice | इनवॉइस (बिल in casual copy) | बीजक |
| Customer | ग्राहक | |
| Supplier | सप्लायर | आपूर्तिकर्ता |
| Product | प्रोडक्ट | उत्पाद |
| Stock | स्टॉक | भंडार |
| Outstanding | बकाया | |
| Receivable / Payable | लेनदारी / देनदारी | प्राप्य / देय |
| Collection | वसूली | |
| Payment | भुगतान | |
| Purchase / Sales | खरीद / बिक्री | क्रय / विक्रय |
| Discount | छूट | |
| Rate | रेट | दर (used for GST rate only) |
| Expense | खर्च | व्यय |
| Leave | छुट्टी | अवकाश |
| Salary | वेतन | |
| Godown / Warehouse | गोदाम | |
| Debit / Credit (ledger) | नामे / जमा | |

* GST terms stay as the acronyms people know (GST, CGST, SGST, IGST, HSN, GSTIN) in both languages.
* Numbers use Latin digits in both languages (what Indian businesses use on invoices); dates are `dd/mm/yyyy`; month and weekday names are localised.
* Layout allows ~30 % text expansion; no fixed-width buttons with text.
* Amounts in words on invoices are available in English (Indian system: lakh, crore) and Hindi (`amountInWords(…, "hi")`).

## 9. Accessibility

WCAG 2.2 AA target: 4.5:1 text contrast in both themes, visible focus rings, full keyboard operation, ARIA combobox/listbox/tabs/dialog semantics from Radix, labelled icon buttons, touch targets ≥ 40 px (48 px on primary phone actions), `prefers-reduced-motion` respected, charts with keyboard crosshair and a table view.
