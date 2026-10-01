import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
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

/** GST state / UT codes. Reference data seeded from @digitalbahi/core GST_STATES. */
export const states = pgTable("states", {
  /** GST state code (01 Jammu and Kashmir ... 37 Andhra Pradesh, 38 Ladakh, 97 Other Territory); the first two digits of a GSTIN. */
  code: char({ length: 2 }).primaryKey(),
  name: text().notNull(),
  nameHi: text().notNull(),
  /** state, ut (Union territory) or special (codes such as 96 Foreign country and 97 Other Territory). */
  kind: varchar({ length: 10 }).notNull(),
  /** SGST or UTGST for intra-state supplies. */
  stateTaxComponent: varchar({ length: 5 }).notNull(),
  /** An old code no longer given to new registrations (25 Daman and Diu, 28 Andhra Pradesh before 2014), kept for old documents. */
  isLegacy: boolean().notNull().default(false),
});

/** A login identity. One user can belong to several businesses with different roles. */
export const users = pgTable(
  "users",
  {
    id: pk(),
    name: text().notNull(),
    /** Mobile number used to sign in and receive OTPs; unique across all users. */
    mobile: varchar({ length: 15 }).notNull(),
    /** Email address (optional, unique when given). */
    email: text(),
    /** Optional user ID to sign in with (lower case), set when a business adds its staff. */
    username: varchar({ length: 30 }),
    /** argon2id hash. Never selected by default in API queries. */
    passwordHash: text(),
    /** Language of the app and of messages to this person: en or hi. */
    preferredLocale: varchar({ length: 10 }).notNull().default("en"),
    /** Business opened by default at the next login. */
    lastBusinessId: uuid(),
    isActive: boolean().notNull().default(true),
    /** Reserved for two-factor sign-in (not used yet). */
    mfaSecretEnc: text(),
    /** Wrong passwords in a row; at 5 the account is locked for 15 minutes. Reset by a successful sign-in. */
    failedLoginCount: integer().notNull().default(0),
    /** Sign-in is refused until this time after too many wrong passwords. */
    lockedUntil: tstz(),
    /** Last successful sign-in. */
    lastLoginAt: tstz(),
    /** When the password was last set or changed. */
    passwordChangedAt: tstz(),
    /**
     * Locks the copy of the business kept on this person's devices for offline
     * work (field-encrypted; handed only to a signed-in session).
     */
    deviceKey: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_mobile_uq").on(t.mobile), uniqueIndex("users_email_uq").on(t.email), uniqueIndex("users_username_uq").on(t.username)],
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
    /** Legal name as registered for GST (printed on documents). */
    legalName: text().notNull(),
    /** Trade name, when the firm trades under another name. */
    tradeName: text(),
    gstin: varchar({ length: 15 }),
    pan: varchar({ length: 10 }),
    /** Regular, composition or unregistered: decides whether it charges GST and can claim input credit. */
    gstRegistration: businessGstRegistration().notNull().default("regular"),
    /** State of the principal place of business: decides intra- or inter-state supply. */
    stateCode: char({ length: 2 })
      .notNull()
      .references(() => states.code),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    pincode: varchar({ length: 6 }),
    /** Phone number printed on documents. */
    phone: varchar({ length: 15 }),
    /** Email printed on documents and used as the reply-to address for its emails. */
    email: text(),
    /** The firm's logo (in `files`), printed on its documents. */
    logoFileId: uuid(),
    /** 1-12; 4 = April (Indian FY). */
    financialYearStartMonth: smallint().notNull().default(4),
    /** Time zone for the business's dates and schedules (IANA name). */
    timeZone: text().notNull().default("Asia/Kolkata"),
    /** Currency of its amounts (ISO 4217); INR. */
    currency: char({ length: 3 }).notNull().default("INR"),
    /** SaaS lifecycle: trial -> active; suspended/closed tenants cannot sign in. */
    status: varchar({ length: 12 }).notNull().default("trial"),
    /** Subscription plan of the SaaS (trial while on trial). */
    plan: varchar({ length: 30 }).notNull().default("trial"),
    /** When the trial ends. */
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
    /** Setting name, e.g. stock.negative_policy or invoice.terms. */
    key: text().notNull(),
    /** The setting's value as JSON, checked against the setting's schema in the API. */
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
    /** Short code of the godown, unique in the business. */
    code: varchar({ length: 20 }).notNull(),
    addressLine1: text(),
    city: text(),
    /** State the godown is in. */
    stateCode: char({ length: 2 }).references(() => states.code),
    pincode: varchar({ length: 6 }),
    /** The main godown, used when a document does not name one (one per business). */
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

/** Raw bytes in PostgreSQL (small files only). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * Uploaded files (product images, receipts, logos, proof of delivery, backups).
 * Small files such as the firm's logo keep their bytes in `content`, so they
 * are part of the ordinary database backup; larger ones go to object storage
 * under `storageKey`.
 */
export const files = pgTable(
  "files",
  {
    id: pk(),
    businessId: businessId(),
    /** Where the bytes are: `db/<file id>` when they are kept in `content`, otherwise a key in object storage. */
    storageKey: text().notNull(),
    /** The bytes, for small files kept in the database (such as a logo). */
    content: bytea(),
    /** File name as uploaded. */
    originalName: text().notNull(),
    /** Content type, e.g. image/png or application/pdf. */
    mimeType: text().notNull(),
    /** Size in bytes. */
    sizeBytes: bigint({ mode: "number" }).notNull(),
    /** SHA-256 of the bytes (hex), to recognise the same file uploaded twice. */
    sha256: char({ length: 64 }).notNull(),
    /** What the file belongs to, for cleanup and access checks (e.g. "expense", "product"). */
    purpose: varchar({ length: 40 }).notNull(),
    /** User who uploaded it. */
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
    /** The person using the device. */
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Name shown in Settings -> Devices (browser and system, e.g. Chrome on Android). */
    name: text().notNull(),
    /** web, android, ios, windows, mac or linux. */
    platform: varchar({ length: 20 }).notNull(),
    /** The device's code for its offline bill series (A1, A2 ...): bills made offline are numbered A1/26-27/0001 and never collide. */
    seriesCode: varchar({ length: 4 }),
    /** When the device last sent work it did offline. */
    lastSyncAt: tstz(),
    /** When the device last checked in. */
    lastSeenAt: tstz(),
    /** When the device was removed: it is signed out, its unsynced bills are refused and it deletes its copy. */
    revokedAt: tstz(),
    /** SHA-256 of the secret the device checks in with (renewed at each registration), so a removed device learns it must wipe itself. */
    checkHash: text(),
    /** When a removed device was told to delete its copy (it did so on hearing it). */
    wipedAt: tstz(),
    /** The sign-in (refresh token family) the device last registered with: removing the device ends it. */
    sessionId: uuid(),
    /** Work waiting on the device to be sent, as it last reported (bills, payments, orders, changes …). */
    queueWaiting: integer().notNull().default(0),
    /** Of that, bills. */
    queueBills: integer().notNull().default(0),
    /** Work the server refused that waits on the device for someone to fix or remove. */
    queueRefused: integer().notNull().default(0),
    /** When the oldest waiting work was done. */
    queueOldestAt: tstz(),
    /** When the device last reported its waiting work (it can only while online). */
    queueReportedAt: tstz(),
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
    /** e.g. "INV/{FYS}/{SEQ:5}" — see formatDocumentNumber in @digitalbahi/core. */
    pattern: text().notNull(),
    /** Financial year the series numbers, e.g. 2026-27; numbering starts again each year. */
    financialYear: varchar({ length: 9 }).notNull(),
    /** The number the next document will get. */
    nextNumber: integer().notNull().default(1),
    /** Set for per-device offline series. */
    deviceId: uuid().references(() => devices.id),
    /** The series used for this document type unless another is chosen. */
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    unique("document_series_uq").on(t.businessId, t.docType, t.financialYear, t.pattern, t.deviceId).nullsNotDistinct(),
    check("document_series_next_chk", sql`${t.nextNumber} >= 1`),
  ],
);
