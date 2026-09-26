import { ALL_PERMISSIONS, DEFAULT_ROLES, financialYearOf, GST_STATES } from "@vyapaar/core";
import { sql } from "drizzle-orm";
import type { Executor } from "../executor.js";
import * as s from "../schema/index.js";

type Db = Executor;

/** Global reference data: GST state codes and the permission catalogue. Idempotent. */
export async function seedReferenceData(db: Db): Promise<void> {
  await db
    .insert(s.states)
    .values(
      GST_STATES.map((st) => ({
        code: st.code,
        name: st.name,
        nameHi: st.nameHi,
        kind: st.kind,
        stateTaxComponent: st.component,
        isLegacy: Boolean(st.legacy),
      })),
    )
    .onConflictDoUpdate({
      target: s.states.code,
      set: { name: sql`excluded.name`, nameHi: sql`excluded.name_hi`, stateTaxComponent: sql`excluded.state_tax_component` },
    });

  await db
    .insert(s.permissions)
    .values(ALL_PERMISSIONS.map((key) => ({ key, module: key.split(".")[0]! })))
    .onConflictDoNothing();

  // Platform-default GST configuration. These are dated VALUES, not code:
  // when a notification changes a threshold, add a row with the new effective date.
  // Always verify against the current CBIC / GSTN notifications before relying on them.
  await db
    .insert(s.gstConfig)
    .values([
      { key: "b2cl_invoice_threshold", effectiveFrom: "2017-07-01", value: { amount: 250000 }, source: "Initial GSTR-1 B2CL limit" },
      { key: "b2cl_invoice_threshold", effectiveFrom: "2024-08-01", value: { amount: 100000 }, source: "Revised B2CL limit" },
      {
        key: "hsn_min_digits",
        effectiveFrom: "2021-04-01",
        value: { rules: [{ maxTurnover: 50000000, digits: 4 }, { maxTurnover: null, digits: 6 }] },
        source: "HSN digits by aggregate turnover",
      },
      { key: "einvoice_turnover_threshold", effectiveFrom: "2023-08-01", value: { amount: 50000000 }, source: "E-invoicing applicability" },
      { key: "eway_bill_value_threshold", effectiveFrom: "2018-04-01", value: { amount: 50000 }, source: "E-way bill consignment value" },
      { key: "invoice_number_rules", effectiveFrom: "2017-07-01", value: { maxLength: 16, pattern: "^[A-Za-z0-9/-]+$" }, source: "Invoice serial number format" },
    ])
    .onConflictDoNothing();
}

const UNITS = [
  { name: "Pieces", symbol: "PCS", uqc: "PCS", decimals: 0 },
  { name: "Numbers", symbol: "NOS", uqc: "NOS", decimals: 0 },
  { name: "Box", symbol: "BOX", uqc: "BOX", decimals: 0 },
  { name: "Carton", symbol: "CTN", uqc: "CTN", decimals: 0 },
  { name: "Packet", symbol: "PAC", uqc: "PAC", decimals: 0 },
  // No GST UQC for strips: returns report them as OTH (others).
  { name: "Strip", symbol: "STRIP", uqc: "OTH", decimals: 0 },
  { name: "Bottle", symbol: "BTL", uqc: "BTL", decimals: 0 },
  { name: "Dozen", symbol: "DOZ", uqc: "DOZ", decimals: 0 },
  { name: "Bag", symbol: "BAG", uqc: "BAG", decimals: 0 },
  { name: "Kilogram", symbol: "KG", uqc: "KGS", decimals: 3 },
  { name: "Gram", symbol: "G", uqc: "GMS", decimals: 0 },
  { name: "Litre", symbol: "L", uqc: "LTR", decimals: 3 },
  { name: "Millilitre", symbol: "ML", uqc: "MLT", decimals: 0 },
];

const EXPENSE_CATEGORIES: Array<[string, string]> = [
  ["Rent", "किराया"],
  ["Electricity", "बिजली"],
  ["Salary", "वेतन"],
  ["Transport", "परिवहन"],
  ["Fuel", "ईंधन"],
  ["Office Expense", "ऑफ़िस खर्च"],
  ["Maintenance", "रखरखाव"],
  ["Marketing", "मार्केटिंग"],
  ["Other", "अन्य"],
];

const LEAVE_TYPES = [
  { code: "CL", name: "Casual Leave", nameHi: "आकस्मिक छुट्टी", isPaid: true, annualQuota: "12" },
  { code: "SL", name: "Sick Leave", nameHi: "बीमारी की छुट्टी", isPaid: true, annualQuota: "7" },
  { code: "PL", name: "Paid Leave", nameHi: "सवेतन छुट्टी", isPaid: true, annualQuota: "15", allowCarryForward: true, maxCarryForward: "30" },
  { code: "UL", name: "Unpaid Leave", nameHi: "बिना वेतन छुट्टी", isPaid: false, annualQuota: "0" },
  { code: "OL", name: "Other", nameHi: "अन्य", isPaid: false, annualQuota: "0" },
];

const SALARY_COMPONENTS = [
  { code: "BASIC", name: "Basic", nameHi: "मूल वेतन", type: "earning" as const, calcType: "fixed" as const },
  { code: "HRA", name: "House Rent Allowance", nameHi: "मकान किराया भत्ता", type: "earning" as const, calcType: "percent_of_basic" as const },
  { code: "CONV", name: "Conveyance", nameHi: "वाहन भत्ता", type: "earning" as const, calcType: "fixed" as const },
  { code: "INCENT", name: "Incentive", nameHi: "इंसेंटिव", type: "earning" as const, calcType: "manual" as const, isProrated: false },
  { code: "OT", name: "Overtime", nameHi: "ओवरटाइम", type: "earning" as const, calcType: "per_hour" as const, isProrated: false },
  { code: "BONUS", name: "Bonus", nameHi: "बोनस", type: "earning" as const, calcType: "manual" as const, isProrated: false },
  { code: "PF", name: "Provident Fund", nameHi: "भविष्य निधि", type: "deduction" as const, calcType: "percent_of_basic" as const },
  { code: "ESI", name: "ESI", nameHi: "ईएसआई", type: "deduction" as const, calcType: "manual" as const },
  { code: "PT", name: "Professional Tax", nameHi: "व्यवसाय कर", type: "deduction" as const, calcType: "manual" as const, isProrated: false },
  { code: "TDS", name: "TDS", nameHi: "टीडीएस", type: "deduction" as const, calcType: "manual" as const, isProrated: false },
];

/**
 * Starter GST rate buckets. Rates are data: each bucket is an effective-dated
 * rule the business can edit or extend, and products point at a bucket. The
 * taxable buckets start on 22-Sep-2025 (slab rationalisation), so back-dated
 * documents fail loudly until the older rate is added instead of silently
 * using today's rate. Always confirm each product's HSN rate.
 */
const TAX_BUCKETS: Array<{ name: string; kind: "taxable" | "exempt" | "nil_rated"; gstRate?: string; description: string }> = [
  { name: "GST 5%", kind: "taxable", gstRate: "5", description: "Merit rate: most packaged food, daily-use items" },
  { name: "GST 18%", kind: "taxable", gstRate: "18", description: "Standard rate" },
  { name: "GST 40%", kind: "taxable", gstRate: "40", description: "Special rate: aerated / sugary beverages, luxury and sin goods" },
  { name: "Nil rated (0%)", kind: "nil_rated", description: "Goods notified at 0%" },
  { name: "Exempt", kind: "exempt", description: "Exempt supplies (fresh produce, unbranded staples...)" },
];

/**
 * Defaults created for every new business: editable roles, units, rate lists,
 * a main godown, cash account, expense categories, leave types, salary
 * components, number series for the current financial year and business rules.
 */
export async function seedBusinessDefaults(db: Db, businessId: string, today: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const role of DEFAULT_ROLES) {
      const [row] = await tx
        .insert(s.roles)
        .values({ businessId, key: role.key, name: role.name, nameHi: role.nameHi, description: role.description, isSystem: true })
        .onConflictDoNothing()
        .returning({ id: s.roles.id });
      if (!row) continue;
      // Store wildcards as granted so new permissions added later flow to roles like Admin automatically.
      await tx.insert(s.rolePermissions).values(role.grants.map((grant) => ({ roleId: row.id, grant })));
    }

    await tx.insert(s.units).values(UNITS.map((u) => ({ ...u, businessId }))).onConflictDoNothing();
    await tx
      .insert(s.priceLevels)
      .values([
        { businessId, name: "Retail", isDefault: true, sortOrder: 1 },
        { businessId, name: "Wholesale", sortOrder: 2 },
        { businessId, name: "Distributor", sortOrder: 3 },
      ])
      .onConflictDoNothing();
    await tx.insert(s.warehouses).values({ businessId, name: "Main Godown", code: "MAIN", isDefault: true }).onConflictDoNothing();
    await tx.insert(s.paymentAccounts).values({ businessId, name: "Cash", type: "cash", isDefault: true }).onConflictDoNothing();
    await tx
      .insert(s.expenseCategories)
      .values(EXPENSE_CATEGORIES.map(([name, nameHi]) => ({ businessId, name, nameHi, isSystem: true })))
      .onConflictDoNothing();
    await tx.insert(s.leaveTypes).values(LEAVE_TYPES.map((l) => ({ ...l, businessId }))).onConflictDoNothing();
    await tx
      .insert(s.salaryComponents)
      .values(SALARY_COMPONENTS.map((c, i) => ({ ...c, businessId, sortOrder: i })))
      .onConflictDoNothing();

    for (const bucket of TAX_BUCKETS) {
      const [cat] = await tx
        .insert(s.taxCategories)
        .values({ businessId, name: bucket.name, kind: bucket.kind, description: bucket.description })
        .onConflictDoNothing()
        .returning({ id: s.taxCategories.id });
      if (cat && bucket.gstRate) {
        await tx.insert(s.taxRates).values({
          businessId,
          taxCategoryId: cat.id,
          effectiveFrom: "2025-09-22",
          gstRate: bucket.gstRate,
          reference: "GST rate rationalisation effective 22-Sep-2025 (starter bucket, verify per HSN)",
        });
      }
    }

    const fy = financialYearOf(today);
    const series: Array<[string, string, string]> = [
      ["invoice", "Tax invoice", "INV/{FYS}/{SEQ:5}"],
      ["sales_order", "Sales order", "SO/{FYS}/{SEQ:5}"],
      ["purchase", "Purchase", "PUR/{FYS}/{SEQ:5}"],
      ["payment_in", "Receipt", "RCT/{FYS}/{SEQ:5}"],
      ["payment_out", "Payment", "PAY/{FYS}/{SEQ:5}"],
      ["credit_note", "Credit note", "CN/{FYS}/{SEQ:5}"],
      ["debit_note", "Debit note", "DN/{FYS}/{SEQ:5}"],
      ["expense", "Expense", "EXP/{FYS}/{SEQ:5}"],
      ["packing", "Packing slip", "PK/{FYS}/{SEQ:5}"],
      ["dispatch", "Dispatch", "DSP/{FYS}/{SEQ:5}"],
      ["stock_transfer", "Stock transfer", "STR/{FYS}/{SEQ:5}"],
    ];
    await tx
      .insert(s.documentSeries)
      .values(series.map(([docType, name, pattern]) => ({ businessId, docType, name, pattern, financialYear: fy.label, isDefault: true })))
      .onConflictDoNothing();

    const settings: Record<string, unknown> = {
      "stock.negative_policy": "warn",
      "stock.valuation": "moving_average",
      "stock.expiry_warning_days": 30,
      "invoice.round_off": { mode: "nearest", step: 1 },
      "invoice.edit_window_hours": 24,
      "invoice.default_print_locale": "en",
      "invoice.offline_mode": "device_series",
      "credit.policy": { onLimitExceeded: "warn", onOverdue: "warn", overdueGraceDays: 0 },
      "orders.workflow": { requireConfirmation: true, usePacking: true, useDispatch: true },
      "payments.allocation": "oldest_first",
      "reports.aging_buckets": [30, 60, 90],
      "suggestions.weights": { reorder: 1, frequent: 0.6, together: 0.5, last_order: 0.3 },
      "suggestions.window_days": 365,
      "backup.schedule": { frequency: "daily", time: "02:00", retainDays: 30 },
    };
    await tx
      .insert(s.settings)
      .values(Object.entries(settings).map(([key, value]) => ({ businessId, key, value })))
      .onConflictDoNothing();

    const reminders = [
      "customer_payment_due",
      "supplier_payment_due",
      "low_stock",
      "expiring_stock",
      "pending_orders",
      "to_pack",
      "to_dispatch",
      "leave_request",
      "salary_due",
    ];
    await tx.insert(s.reminderRules).values(reminders.map((type) => ({ businessId, type }))).onConflictDoNothing();
  });
}
