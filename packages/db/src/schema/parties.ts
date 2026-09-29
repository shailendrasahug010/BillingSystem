import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, money, pk, softDelete, versioned } from "./columns.js";
import { balanceSide, customerType, partyGstRegistration } from "./enums.js";
import { employees } from "./hr.js";
import { businessId, states } from "./platform.js";

/** Rate lists (selling price lists): Price A / B / C, or Retail, Wholesale, Distributor... Each customer buys on one. */
export const priceLevels = pgTable(
  "price_levels",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    sortOrder: smallint().notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    unique("price_levels_name_uq").on(t.businessId, t.name),
    uniqueIndex("price_levels_one_default_uq").on(t.businessId).where(sql`${t.isDefault}`),
  ],
);

/** Kirana, Wholesaler, Medical, HoReCa, Modern Trade... */
export const customerCategories = pgTable(
  "customer_categories",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    ...auditColumns,
  },
  (t) => [unique("customer_categories_name_uq").on(t.businessId, t.name)],
);

/** Distributor "beats": the route a salesperson / vehicle covers on given weekdays. */
export const salesRoutes = pgTable(
  "sales_routes",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    /** ISO weekdays 1-7 the route is visited, e.g. {1,4}. */
    visitDays: smallint().array(),
    salespersonId: uuid().references(() => employees.id),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [unique("sales_routes_name_uq").on(t.businessId, t.name)],
);

export const customers = pgTable(
  "customers",
  {
    id: pk(),
    businessId: businessId(),
    code: varchar({ length: 20 }).notNull(),
    name: text().notNull(),
    businessName: text(),
    customerType: customerType().notNull().default("b2c"),
    gstRegistration: partyGstRegistration().notNull().default("consumer"),
    mobile: varchar({ length: 15 }),
    altMobile: varchar({ length: 15 }),
    email: text(),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    pincode: varchar({ length: 6 }),
    gstin: varchar({ length: 15 }),
    pan: varchar({ length: 10 }),
    /** null = no limit. */
    creditLimit: money(),
    /** Payment terms in days; drives invoice due dates and aging. */
    creditDays: smallint().notNull().default(0),
    priceLevelId: uuid().references(() => priceLevels.id),
    categoryId: uuid().references(() => customerCategories.id),
    routeId: uuid().references(() => salesRoutes.id),
    salesRepId: uuid().references(() => employees.id),
    openingBalance: money().notNull().default("0"),
    openingBalanceSide: balanceSide().notNull().default("debit"),
    openingBalanceDate: date({ mode: "string" }),
    /**
     * Cached receivable balance (debit positive). Maintained in the same
     * transaction as every party_ledger_entries insert; a nightly job verifies
     * it equals the ledger sum. Lets the list of 5,000 customers sort by
     * outstanding without aggregating the ledger.
     */
    balance: money().notNull().default("0"),
    notes: text(),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
    ...softDelete,
    ...versioned,
  },
  (t) => [
    uniqueIndex("customers_code_uq").on(t.businessId, t.code).where(sql`${t.deletedAt} is null`),
    index("customers_mobile_idx").on(t.businessId, t.mobile),
    index("customers_gstin_idx").on(t.businessId, t.gstin),
    index("customers_balance_idx").on(t.businessId, t.balance),
    index("customers_route_idx").on(t.businessId, t.routeId),
    index("customers_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    index("customers_business_name_trgm_idx").using("gin", sql`${t.businessName} gin_trgm_ops`),
    check("customers_credit_limit_chk", sql`${t.creditLimit} is null or ${t.creditLimit} >= 0`),
    check("customers_credit_days_chk", sql`${t.creditDays} >= 0`),
    check("customers_b2b_gstin_chk", sql`${t.customerType} = 'b2c' or ${t.gstin} is not null`),
  ],
);

/** Additional ship-to addresses; the ship-to state decides the place of supply for goods. */
export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: pk(),
    businessId: businessId(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    label: text().notNull(),
    addressLine1: text().notNull(),
    addressLine2: text(),
    city: text(),
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    pincode: varchar({ length: 6 }),
    isDefaultShipping: boolean().notNull().default(false),
    ...auditColumns,
  },
  (t) => [index("customer_addresses_customer_idx").on(t.customerId)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: pk(),
    businessId: businessId(),
    code: varchar({ length: 20 }).notNull(),
    name: text().notNull(),
    companyName: text(),
    gstRegistration: partyGstRegistration().notNull().default("regular"),
    mobile: varchar({ length: 15 }),
    email: text(),
    gstin: varchar({ length: 15 }),
    pan: varchar({ length: 10 }),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    pincode: varchar({ length: 6 }),
    creditDays: smallint().notNull().default(0),
    creditLimit: money(),
    openingBalance: money().notNull().default("0"),
    openingBalanceSide: balanceSide().notNull().default("credit"),
    openingBalanceDate: date({ mode: "string" }),
    /** Cached payable balance (credit positive), maintained like customers.balance. */
    balance: money().notNull().default("0"),
    bankAccountName: text(),
    bankAccountNumberEnc: text(),
    bankAccountLast4: varchar({ length: 4 }),
    bankIfsc: varchar({ length: 11 }),
    bankName: text(),
    upiId: text(),
    notes: text(),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
    ...softDelete,
    ...versioned,
  },
  (t) => [
    uniqueIndex("suppliers_code_uq").on(t.businessId, t.code).where(sql`${t.deletedAt} is null`),
    index("suppliers_gstin_idx").on(t.businessId, t.gstin),
    index("suppliers_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    check("suppliers_credit_limit_chk", sql`${t.creditLimit} is null or ${t.creditLimit} >= 0`),
  ],
);
