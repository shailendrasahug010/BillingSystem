import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, pk, softDelete, timestamps, tstz, versioned } from "./columns.js";
import { businessGstRegistration } from "./enums.js";

/** GST state / UT codes. Reference data seeded from @vyapaar/core GST_STATES. */
export const states = pgTable("states", {
  code: char({ length: 2 }).primaryKey(),
  name: text().notNull(),
  nameHi: text().notNull(),
  kind: varchar({ length: 10 }).notNull(),
  /** SGST or UTGST for intra-state supplies. */
  stateTaxComponent: varchar({ length: 5 }).notNull(),
  isLegacy: boolean().notNull().default(false),
});

/** A login identity. One user can belong to several businesses with different roles. */
export const users = pgTable(
  "users",
  {
    id: pk(),
    name: text().notNull(),
    mobile: varchar({ length: 15 }).notNull(),
    email: text(),
    /** argon2id hash. Never selected by default in API queries. */
    passwordHash: text(),
    preferredLocale: varchar({ length: 10 }).notNull().default("en"),
    /** Business opened by default at the next login. */
    lastBusinessId: uuid(),
    isActive: boolean().notNull().default(true),
    mfaSecretEnc: text(),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: tstz(),
    lastLoginAt: tstz(),
    passwordChangedAt: tstz(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_mobile_uq").on(t.mobile), uniqueIndex("users_email_uq").on(t.email)],
);

/**
 * The tenant: one legal entity / GSTIN. Every business row in every other table
 * carries business_id; the API scopes every query by it and Postgres row-level
 * security enforces the same rule as defence in depth.
 */
export const businesses = pgTable(
  "businesses",
  {
    id: pk(),
    legalName: text().notNull(),
    tradeName: text(),
    gstin: varchar({ length: 15 }),
    pan: varchar({ length: 10 }),
    gstRegistration: businessGstRegistration().notNull().default("regular"),
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    pincode: varchar({ length: 6 }),
    phone: varchar({ length: 15 }),
    email: text(),
    logoFileId: uuid(),
    /** 1-12; 4 = April (Indian FY). */
    financialYearStartMonth: smallint().notNull().default(4),
    timeZone: text().notNull().default("Asia/Kolkata"),
    currency: char({ length: 3 }).notNull().default("INR"),
    /** SaaS lifecycle: trial -> active; suspended/closed tenants cannot sign in. */
    status: varchar({ length: 12 }).notNull().default("trial"),
    plan: varchar({ length: 30 }).notNull().default("trial"),
    trialEndsAt: tstz(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    index("businesses_gstin_idx").on(t.gstin),
    check("businesses_fy_month_chk", sql`${t.financialYearStartMonth} between 1 and 12`),
    check("businesses_status_chk", sql`${t.status} in ('trial', 'active', 'suspended', 'closed')`),
  ],
);

export const businessId = () =>
  uuid()
    .notNull()
    .references(() => businesses.id, { onDelete: "restrict" });

/**
 * Configurable business rules as typed JSON values, one row per key, e.g.
 * stock.negative_policy = "warn", invoice.round_off = {"mode":"nearest","step":1},
 * credit.policy = {...}, gst.b2cl_threshold = [{from, amount}], orders.workflow = {...}.
 * Keys and value schemas are defined (and validated) in the API settings module.
 */
export const settings = pgTable(
  "settings",
  {
    businessId: businessId(),
    key: text().notNull(),
    value: jsonb().notNull(),
    updatedAt: tstz().notNull().defaultNow(),
    updatedBy: uuid(),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.key] })],
);

/** Godowns / branches holding stock. */
export const warehouses = pgTable(
  "warehouses",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    code: varchar({ length: 20 }).notNull(),
    addressLine1: text(),
    city: text(),
    stateCode: char({ length: 2 }).references(() => states.code),
    pincode: varchar({ length: 6 }),
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
    ...softDelete,
    ...versioned,
  },
  (t) => [
    unique("warehouses_code_uq").on(t.businessId, t.code),
    uniqueIndex("warehouses_one_default_uq").on(t.businessId).where(sql`${t.isDefault} and ${t.deletedAt} is null`),
  ],
);

/** Uploaded files (product images, receipts, logos, proof of delivery, backups). Bytes live in object storage. */
export const files = pgTable(
  "files",
  {
    id: pk(),
    businessId: businessId(),
    storageKey: text().notNull(),
    originalName: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    sha256: char({ length: 64 }).notNull(),
    /** What the file belongs to, for cleanup and access checks (e.g. "expense", "product"). */
    purpose: varchar({ length: 40 }).notNull(),
    uploadedBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
    ...softDelete,
  },
  (t) => [
    uniqueIndex("files_storage_key_uq").on(t.storageKey),
    check("files_size_chk", sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * Registered devices (phones, desktops). Needed for offline work: each device
 * gets a short series code so invoices numbered offline can never collide.
 */
export const devices = pgTable(
  "devices",
  {
    id: pk(),
    businessId: businessId(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    platform: varchar({ length: 20 }).notNull(),
    seriesCode: varchar({ length: 4 }),
    lastSyncAt: tstz(),
    lastSeenAt: tstz(),
    revokedAt: tstz(),
    ...timestamps,
  },
  (t) => [unique("devices_series_code_uq").on(t.businessId, t.seriesCode)],
);

/**
 * Number series per document type and financial year. The next number is
 * taken with UPDATE ... SET next_number = next_number + 1 RETURNING inside the
 * posting transaction: numbers are gap-free and never duplicated.
 */
export const documentSeries = pgTable(
  "document_series",
  {
    id: pk(),
    businessId: businessId(),
    /** invoice, sales_order, purchase, payment_in, payment_out, credit_note, debit_note, expense, packing, dispatch... */
    docType: varchar({ length: 30 }).notNull(),
    name: text().notNull(),
    /** e.g. "INV/{FYS}/{SEQ:5}" — see formatDocumentNumber in @vyapaar/core. */
    pattern: text().notNull(),
    financialYear: varchar({ length: 9 }).notNull(),
    nextNumber: integer().notNull().default(1),
    /** Set for per-device offline series. */
    deviceId: uuid().references(() => devices.id),
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    unique("document_series_uq").on(t.businessId, t.docType, t.financialYear, t.pattern, t.deviceId).nullsNotDistinct(),
    check("document_series_next_chk", sql`${t.nextNumber} >= 1`),
  ],
);
