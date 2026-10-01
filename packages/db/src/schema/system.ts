import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, smallint, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./columns.js";
import { jobStatus, notificationSeverity, syncMutationStatus } from "./enums.js";
import { businessId, devices, files, users } from "./platform.js";

/**
 * AUDIT LOG — append-only (trigger + revoked privileges). Written by the API's
 * service layer inside the same transaction as the change it describes.
 * `changes` = {"field": [old, new]} for updates; full snapshot for creates/deletes.
 * Partition by month (created_at) once it grows past tens of millions of rows.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The business the action was in (empty for sign-in events before a business is chosen). */
    businessId: uuid(),
    /** Who did it. */
    userId: uuid(),
    /** Their name at the time (kept even if the user is renamed). */
    userName: text(),
    /** e.g. invoice.updated, invoice.cancelled, stock.adjusted, role.permissions_changed, login.failed */
    action: varchar({ length: 60 }).notNull(),
    /** Kind of record changed (invoice, customer, role ...). */
    entityType: varchar({ length: 40 }),
    /** Id of the record changed. */
    entityId: uuid(),
    /** Human label, e.g. "INV/26-27/10023". */
    entityLabel: text(),
    /** What changed: {"field": [old, new]} for edits, the whole record for creates and deletes. */
    changes: jsonb(),
    /** IP address of the request. */
    ip: varchar({ length: 45 }),
    /** Browser or app of the request. */
    userAgent: text(),
    /** Registered device, when known. */
    deviceId: uuid(),
    /** Id of the API request (matches the server log). */
    requestId: varchar({ length: 40 }),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.businessId, t.entityType, t.entityId, t.createdAt),
    index("audit_logs_time_idx").on(t.businessId, t.createdAt),
    index("audit_logs_user_idx").on(t.businessId, t.userId, t.createdAt),
  ],
);

/**
 * In-app notifications. Stored as a translation key + params (never rendered
 * text), so each user sees them in their own language.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    businessId: businessId(),
    /** null = everyone with `permission`. */
    userId: uuid().references(() => users.id),
    /** Shown to everyone whose role has this permission (when user_id is empty). */
    permission: varchar({ length: 60 }),
    /** What it is about (payment_due, low_stock ...). */
    type: varchar({ length: 40 }).notNull(),
    /** info, success, warning or critical. */
    severity: notificationSeverity().notNull().default("info"),
    /** Translation key of the title (each person sees it in their own language). */
    titleKey: varchar({ length: 80 }).notNull(),
    /** Translation key of the text. */
    bodyKey: varchar({ length: 80 }),
    /** Values put into the title and text (names, amounts, dates), as JSON. */
    params: jsonb().notNull().default({}),
    /** Kind of record it is about, to open it. */
    entityType: varchar({ length: 40 }),
    /** Id of that record. */
    entityId: uuid(),
    /** Prevents the same reminder being created twice (e.g. "low_stock:<product>:<date>"). */
    dedupeKey: varchar({ length: 120 }),
    /** When it was read. */
    readAt: tstz(),
    /** When it was dismissed. */
    dismissedAt: tstz(),
    /** Channels it went out on besides the app (push, whatsapp, sms, email). */
    deliveredChannels: varchar({ length: 20 }).array(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.businessId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
    index("notifications_unread_idx").on(t.businessId, t.userId, t.createdAt).where(sql`${t.readAt} is null`),
  ],
);

/** Which reminders run and how (thresholds, lead days, channels). */
export const reminderRules = pgTable(
  "reminder_rules",
  {
    id: pk(),
    businessId: businessId(),
    /** customer_payment_due, supplier_payment_due, low_stock, expiring_stock, pending_orders, to_pack, to_dispatch, leave_request, salary_due */
    type: varchar({ length: 40 }).notNull(),
    /** The rule's settings as JSON (days before due, thresholds, time of day ...). */
    config: jsonb().notNull().default({}),
    /** Where the reminders go: in_app, push, whatsapp, sms, email. */
    channels: varchar({ length: 20 }).array().notNull().default(sql`'{in_app}'::varchar[]`),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("reminder_rules_type_uq").on(t.businessId, t.type)],
);

/**
 * Transactional outbox: domain events written in the business transaction and
 * processed asynchronously (purchase-history stats, report summaries, search
 * index, notifications, webhooks). Guarantees nothing is lost if a worker is down.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The business the event happened in. */
    businessId: uuid().notNull(),
    /** What happened: invoice.posted, invoice.cancelled, payment.received, credit_note.posted, purchase.posted ... */
    eventType: varchar({ length: 60 }).notNull(),
    /** Kind of record (invoice, payment ...). */
    aggregateType: varchar({ length: 40 }).notNull(),
    /** Id of the record. */
    aggregateId: uuid().notNull(),
    /** Details the handlers need, as JSON. */
    payload: jsonb().notNull(),
    /** Times a handler tried and failed. */
    attempts: smallint().notNull().default(0),
    /** The last failure, for the error log. */
    lastError: text(),
    /** Not handed to a worker before this time (retries wait longer each time). */
    availableAt: tstz().notNull().defaultNow(),
    /** When it was handled; empty while waiting. */
    processedAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index("outbox_events_pending_idx").on(t.availableAt).where(sql`${t.processedAt} is null`),
    // The worker takes one business's waiting events in order.
    index("outbox_events_business_pending_idx").on(t.businessId, t.id).where(sql`${t.processedAt} is null`),
  ],
);

/**
 * Server-side log of mutations received from offline devices. The client's
 * mutation id is the primary key, so replaying the same queue twice is a no-op
 * (idempotent sync). Kept for the planned /sync/push protocol: offline work is
 * sent today through the ordinary endpoints with an Idempotency-Key, and this
 * table is not written.
 */
export const syncMutations = pgTable(
  "sync_mutations",
  {
    id: uuid().primaryKey(),
    businessId: businessId(),
    /** Device that sent it. */
    deviceId: uuid()
      .notNull()
      .references(() => devices.id),
    /** Person who made it. */
    userId: uuid().notNull(),
    /** Kind of change (invoice.create, payment.create ...). */
    mutationType: varchar({ length: 40 }).notNull(),
    /** Record the change is about. */
    entityId: uuid(),
    /** Version of the record the device had (for conflict detection). */
    baseVersion: integer(),
    /** SHA-256 of what was sent, to tell a replay from a different change. */
    payloadHash: varchar({ length: 64 }).notNull(),
    /** applied, rejected or conflict. */
    status: syncMutationStatus().notNull(),
    /** What the server answered, returned again on a replay. */
    result: jsonb(),
    /** When the change was made on the device. */
    clientCreatedAt: tstz().notNull(),
    /** When the server received it. */
    receivedAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("sync_mutations_device_idx").on(t.deviceId, t.receivedAt)],
);

export const backups = pgTable(
  "backups",
  {
    id: pk(),
    businessId: businessId(),
    /** download (the owner downloaded it), email, auto (scheduled email) or restore (a file restored as this business). */
    kind: varchar({ length: 10 }).notNull(),
    /** queued, running, completed or failed. */
    status: jobStatus().notNull().default("queued"),
    /** The backup file, when kept on the server. */
    fileId: uuid().references(() => files.id),
    /** Size of the backup file. */
    sizeBytes: bigint({ mode: "number" }),
    /** SHA-256 of the file, to check a copy. */
    sha256: varchar({ length: 64 }),
    /** Schema migration version at backup time: restore refuses incompatible backups. */
    schemaVersion: varchar({ length: 40 }),
    /** Protected with a password (AES-256-GCM). */
    encrypted: boolean().notNull().default(true),
    /** When making it started. */
    startedAt: tstz(),
    /** When it finished. */
    completedAt: tstz(),
    /** Why it failed. */
    error: text(),
    /** User who made it. */
    requestedBy: uuid(),
    /** When a file was restored. */
    restoredAt: tstz(),
    /** User who restored it. */
    restoredBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("backups_business_idx").on(t.businessId, t.createdAt)],
);

/**
 * Automatic backups: a password-protected copy emailed on a schedule, one
 * row per business. The password is encrypted with the API's field cipher and
 * never returned. `next_run_at` is when the scheduler next sends a copy.
 */
export const backupSchedules = pgTable(
  "backup_schedules",
  {
    id: pk(),
    businessId: businessId().unique("backup_schedules_business_uq"),
    /** off | daily | weekly */
    frequency: varchar({ length: 10 }).notNull().default("off"),
    /** 0 = Sunday … 6 = Saturday (weekly only). */
    weekday: smallint().notNull().default(0),
    /** Hour of the day in the business's time zone. */
    hour: smallint().notNull().default(21),
    /** Empty: the business's own email. */
    emailTo: text(),
    /** Password the copies are protected with, encrypted; never shown again. */
    passphrase: text(),
    /** When the next copy goes out. */
    nextRunAt: tstz(),
    /** When the last copy was tried. */
    lastRunAt: tstz(),
    /** sent or failed. */
    lastStatus: varchar({ length: 10 }),
    /** Why the last copy failed (e.g. the mail server refused it). */
    lastError: text(),
    /** Whose name the automatic backups go out under (the person who set it up). */
    configuredBy: uuid(),
    ...timestamps,
  },
  (t) => [index("backup_schedules_due_idx").on(t.nextRunAt)],
);

/**
 * SAVED REPORT VIEWS — a report's tab and settings (period, grouping, filters)
 * kept under a name to open again. Private to the person who saved it unless
 * shared with the team; others see a shared view only for a report their role
 * opens. A period like "this month" is kept as that, not as dates.
 */
export const reportViews = pgTable(
  "report_views",
  {
    id: pk(),
    businessId: businessId(),
    /** Person who saved the view. */
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Name of the view (unique per person, ignoring case). */
    name: varchar({ length: 60 }).notNull(),
    /** sales | collections | purchases | outstanding | profit | pnl | products */
    report: varchar({ length: 20 }).notNull(),
    /** The report's tab, period, grouping and filters, as JSON. */
    settings: jsonb().notNull().default({}),
    /** Shown to the team (to roles that may open the report), not only to its owner. */
    shared: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("report_views_name_uq").on(t.businessId, t.userId, sql`lower(${t.name})`), index("report_views_shared_idx").on(t.businessId, t.shared)],
);
