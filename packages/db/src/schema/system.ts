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
    businessId: uuid(),
    userId: uuid(),
    userName: text(),
    /** e.g. invoice.updated, invoice.cancelled, stock.adjusted, role.permissions_changed, login.failed */
    action: varchar({ length: 60 }).notNull(),
    entityType: varchar({ length: 40 }),
    entityId: uuid(),
    /** Human label, e.g. "INV/26-27/10023". */
    entityLabel: text(),
    changes: jsonb(),
    ip: varchar({ length: 45 }),
    userAgent: text(),
    deviceId: uuid(),
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
    permission: varchar({ length: 60 }),
    type: varchar({ length: 40 }).notNull(),
    severity: notificationSeverity().notNull().default("info"),
    titleKey: varchar({ length: 80 }).notNull(),
    bodyKey: varchar({ length: 80 }),
    params: jsonb().notNull().default({}),
    entityType: varchar({ length: 40 }),
    entityId: uuid(),
    /** Prevents the same reminder being created twice (e.g. "low_stock:<product>:<date>"). */
    dedupeKey: varchar({ length: 120 }),
    readAt: tstz(),
    dismissedAt: tstz(),
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
    config: jsonb().notNull().default({}),
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
    businessId: uuid().notNull(),
    eventType: varchar({ length: 60 }).notNull(),
    aggregateType: varchar({ length: 40 }).notNull(),
    aggregateId: uuid().notNull(),
    payload: jsonb().notNull(),
    attempts: smallint().notNull().default(0),
    lastError: text(),
    availableAt: tstz().notNull().defaultNow(),
    processedAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("outbox_events_pending_idx").on(t.availableAt).where(sql`${t.processedAt} is null`)],
);

/**
 * Server-side log of mutations received from offline devices. The client's
 * mutation id is the primary key, so replaying the same queue twice is a no-op
 * (idempotent sync).
 */
export const syncMutations = pgTable(
  "sync_mutations",
  {
    id: uuid().primaryKey(),
    businessId: businessId(),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id),
    userId: uuid().notNull(),
    mutationType: varchar({ length: 40 }).notNull(),
    entityId: uuid(),
    baseVersion: integer(),
    payloadHash: varchar({ length: 64 }).notNull(),
    status: syncMutationStatus().notNull(),
    result: jsonb(),
    clientCreatedAt: tstz().notNull(),
    receivedAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("sync_mutations_device_idx").on(t.deviceId, t.receivedAt)],
);

export const backups = pgTable(
  "backups",
  {
    id: pk(),
    businessId: businessId(),
    kind: varchar({ length: 10 }).notNull(),
    status: jobStatus().notNull().default("queued"),
    fileId: uuid().references(() => files.id),
    sizeBytes: bigint({ mode: "number" }),
    sha256: varchar({ length: 64 }),
    /** Schema migration version at backup time: restore refuses incompatible backups. */
    schemaVersion: varchar({ length: 40 }),
    encrypted: boolean().notNull().default(true),
    startedAt: tstz(),
    completedAt: tstz(),
    error: text(),
    requestedBy: uuid(),
    restoredAt: tstz(),
    restoredBy: uuid(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("backups_business_idx").on(t.businessId, t.createdAt)],
);
