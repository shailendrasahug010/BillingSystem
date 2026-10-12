import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, money, pk, softDelete, tstz, versioned } from "./columns.js";
import { balanceSide, customerType, partyGstRegistration } from "./enums.js";
import { employees } from "./hr.js";
import { businessId, states } from "./platform.js";

/** Rate lists (selling price lists): Price A / B / C, or Retail, Wholesale, Distributor... Each customer buys on one. */
export const priceLevels = pgTable(
  "price_levels",
  {
    id: pk(),
    businessId: businessId(),
    /** Name of the price list (Price A, Retail ...), unique in the business. */
    name: text().notNull(),
    /** The list used for customers who have none of their own (one per business). */
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
    /** Salesperson who covers the route. */
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
    /** The business's own customer code (C0001 ...), unique among its current customers. */
    code: varchar({ length: 20 }).notNull(),
    /** Name of the shop or person, as printed on bills. */
    name: text().notNull(),
    /** Registered business name when it differs from the shop name. */
    businessName: text(),
    /** b2b (registered, with a GSTIN) or b2c: decides the GSTR-1 table its bills go to. */
    customerType: customerType().notNull().default("b2c"),
    /** The customer's GST status: regular, composition, unregistered, consumer, SEZ unit, overseas (export) or deemed export. */
    gstRegistration: partyGstRegistration().notNull().default("consumer"),
    mobile: varchar({ length: 15 }),
    altMobile: varchar({ length: 15 }),
    email: text(),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    /** State of the customer's address: the default place of supply. */
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
    /** Price list the customer buys on (Price A / B / C). */
    priceLevelId: uuid().references(() => priceLevels.id),
    /** Customer category (kirana, wholesaler, medical ...). */
    categoryId: uuid().references(() => customerCategories.id),
    /** Beat (route) the customer is on, for salespeople and collection lists. */
    routeId: uuid().references(() => salesRoutes.id),
    /** Place on the route: the order the salesperson visits in (empty: after the numbered ones, by name). */
    routeSequence: integer(),
    /** Salesperson in charge of the customer. */
    salesRepId: uuid().references(() => employees.id),
    /** Amount owed when the customer was brought into the app. */
    openingBalance: money().notNull().default("0"),
    /** debit: the customer owed us; credit: we owed the customer (an advance). */
    openingBalanceSide: balanceSide().notNull().default("debit"),
    /** Date of the opening balance (the start of using the app). */
    openingBalanceDate: date({ mode: "string" }),
    /**
     * Cached receivable balance (debit positive). Maintained in the same
     * transaction as every party_ledger_entries insert; the nightly analytics
     * job checks it equals the ledger sum and reports any difference. Lets the
     * list of 5,000 customers sort by outstanding without aggregating the ledger.
     */
    balance: money().notNull().default("0"),
    notes: text(),
    /** Language of the messages sent to the customer (en or hi); null: the business's language for documents. */
    messageLocale: varchar({ length: 5 }),
    /** No automatic or bulk payment reminders to this customer (asked for, or replied STOP). */
    remindersOptOut: boolean().notNull().default(false),
    /** When the customer stopped payment reminders. */
    remindersOptOutAt: tstz(),
    /** How: staff (on the customer's page) or reply (they wrote STOP on WhatsApp). */
    remindersOptOutBy: varchar({ length: 10 }),
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
    /** The customer. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Name of the address (Godown 2, Branch ...). */
    label: text().notNull(),
    addressLine1: text().notNull(),
    addressLine2: text(),
    city: text(),
    /** State of this address: the place of supply when goods are delivered here. */
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    pincode: varchar({ length: 6 }),
    /** The address bills deliver to unless another is chosen. */
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
    /** The business's own supplier code (S0001 ...), unique among its current suppliers. */
    code: varchar({ length: 20 }).notNull(),
    /** Supplier's name. */
    name: text().notNull(),
    /** Company the supplier represents or distributes for, when different. */
    companyName: text(),
    /** The supplier's GST status: decides reverse charge and input credit on their bills. */
    gstRegistration: partyGstRegistration().notNull().default("regular"),
    mobile: varchar({ length: 15 }),
    email: text(),
    gstin: varchar({ length: 15 }),
    pan: varchar({ length: 10 }),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    /** State of the supplier: decides intra- or inter-state purchase. */
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    pincode: varchar({ length: 6 }),
    /** Days of credit the supplier gives: drives purchase due dates. */
    creditDays: smallint().notNull().default(0),
    /** Most the business may owe the supplier (empty: no limit). */
    creditLimit: money(),
    /** Amount owed when the supplier was brought into the app. */
    openingBalance: money().notNull().default("0"),
    /** credit: we owed the supplier; debit: the supplier owed us (an advance). */
    openingBalanceSide: balanceSide().notNull().default("credit"),
    /** Date of the opening balance. */
    openingBalanceDate: date({ mode: "string" }),
    /** Cached payable balance (credit positive), maintained and checked nightly like customers.balance. */
    balance: money().notNull().default("0"),
    /** Name on the supplier's bank account, for payments. */
    bankAccountName: text(),
    /** Supplier's bank account number, encrypted (AES-256-GCM). */
    bankAccountNumberEnc: text(),
    /** Last 4 digits of the account number, for display. */
    bankAccountLast4: varchar({ length: 4 }),
    /** IFSC of the supplier's bank branch. */
    bankIfsc: varchar({ length: 11 }),
    /** Supplier's bank. */
    bankName: text(),
    /** Supplier's UPI ID for payments. */
    upiId: text(),
    /** No TDS on purchases from this supplier (a nil or lower deduction certificate, or a seller not liable). */
    tdsExempt: boolean().notNull().default(false),
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
