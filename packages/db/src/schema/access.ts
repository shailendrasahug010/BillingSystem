import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, smallint, text, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, pk, timestamps, tstz } from "./columns.js";
import { businesses, businessId, devices, users } from "./platform.js";

/** Catalogue of permission keys, synced from @vyapaar/core PERMISSION_CATALOG on deploy. */
export const permissions = pgTable("permissions", {
  key: varchar({ length: 60 }).primaryKey(),
  module: varchar({ length: 30 }).notNull(),
  description: text(),
});

/** Roles are per business and fully editable; system roles are seeded but can be changed. */
export const roles = pgTable(
  "roles",
  {
    id: pk(),
    businessId: businessId(),
    key: varchar({ length: 40 }).notNull(),
    name: text().notNull(),
    nameHi: text(),
    description: text(),
    isSystem: boolean().notNull().default(false),
    ...auditColumns,
  },
  (t) => [unique("roles_key_uq").on(t.businessId, t.key)],
);

/** Stores grants, including wildcards ("invoice.*", "*"). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grant: varchar({ length: 60 }).notNull(),
    createdAt: tstz().notNull().defaultNow(),
    createdBy: uuid(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.grant] })],
);

export const businessMembers = pgTable(
  "business_members",
  {
    id: pk(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    roleId: uuid()
      .notNull()
      .references(() => roles.id),
    isOwner: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    invitedBy: uuid(),
    ...timestamps,
  },
  (t) => [unique("business_members_uq").on(t.businessId, t.userId), index("business_members_user_idx").on(t.userId)],
);

/**
 * Rotating refresh tokens. Only a SHA-256 hash is stored. Re-use of a rotated
 * token revokes the whole family (token theft detection).
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid().notNull(),
    tokenHash: varchar({ length: 64 }).notNull(),
    deviceId: uuid().references(() => devices.id),
    ip: varchar({ length: 45 }),
    userAgent: text(),
    expiresAt: tstz().notNull(),
    rotatedAt: tstz(),
    revokedAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    unique("refresh_tokens_hash_uq").on(t.tokenHash),
    index("refresh_tokens_family_idx").on(t.familyId),
    index("refresh_tokens_active_idx").on(t.userId).where(sql`${t.revokedAt} is null`),
  ],
);

/** One-time passwords for mobile login / password reset (hash only, short expiry, attempt-limited). */
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: pk(),
    mobile: varchar({ length: 15 }).notNull(),
    purpose: varchar({ length: 20 }).notNull(),
    codeHash: varchar({ length: 64 }).notNull(),
    attempts: smallint().notNull().default(0),
    expiresAt: tstz().notNull(),
    consumedAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("otp_challenges_mobile_idx").on(t.mobile, t.createdAt)],
);
