import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, smallint, text, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, pk, timestamps, tstz } from "./columns.js";
import { businesses, businessId, devices, users } from "./platform.js";

/** Catalogue of permission keys, synced from @digitalbahi/core PERMISSION_CATALOG on deploy. */
export const permissions = pgTable("permissions", {
  /** Permission key, e.g. invoice.create or report.view_sales. */
  key: varchar({ length: 60 }).primaryKey(),
  /** Module it belongs to, for grouping on the roles screen. */
  module: varchar({ length: 30 }).notNull(),
  description: text(),
});

/** Roles are per business and fully editable; system roles are seeded but can be changed. */
export const roles = pgTable(
  "roles",
  {
    id: pk(),
    businessId: businessId(),
    /** Stable key of the role in the business (admin, manager, sales ... for the seeded ones). */
    key: varchar({ length: 40 }).notNull(),
    name: text().notNull(),
    nameHi: text(),
    description: text(),
    /** Seeded with the business; it can be edited like any other role. */
    isSystem: boolean().notNull().default(false),
    ...auditColumns,
  },
  (t) => [unique("roles_key_uq").on(t.businessId, t.key)],
);

/** Stores grants, including wildcards ("invoice.*", "*"). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    /** The role. */
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** A permission key, or a wildcard: invoice.* (every invoice permission) or * (everything). */
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
    /** The person. */
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Their role in this business: decides what they may see and do. */
    roleId: uuid()
      .notNull()
      .references(() => roles.id),
    /** The owner of the business (who created it); cannot be removed or demoted by others. */
    isOwner: boolean().notNull().default(false),
    /** Removed members are deactivated (kept for history) and can no longer open the business. */
    isActive: boolean().notNull().default(true),
    /** User who added the member. */
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
    /** The person signed in. */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The sign-in (session) the token belongs to: every rotation keeps the family; reusing an old token revokes the whole family. */
    familyId: uuid().notNull(),
    /** Business the session is working in; kept per session so each device can be in a different business. */
    businessId: uuid().references(() => businesses.id),
    /** SHA-256 of the token; the token itself is never stored. */
    tokenHash: varchar({ length: 64 }).notNull(),
    /** The registered device of the session, when it has one. */
    deviceId: uuid().references(() => devices.id),
    /** IP address the token was issued to. */
    ip: varchar({ length: 45 }),
    /** Browser or app that signed in. */
    userAgent: text(),
    /** When the token stops working (30 days by default). */
    expiresAt: tstz().notNull(),
    /** When it was exchanged for a new token; using it again after that counts as theft. */
    rotatedAt: tstz(),
    /** When it was revoked (sign-out, theft detection, a removed device or member). */
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
    /** Mobile number the code was sent to. */
    mobile: varchar({ length: 15 }).notNull(),
    /** What the code is for: signup, login or reset. */
    purpose: varchar({ length: 20 }).notNull(),
    /** SHA-256 of the code; the code itself is never stored. */
    codeHash: varchar({ length: 64 }).notNull(),
    /** Wrong codes typed; the challenge stops working after the limit. */
    attempts: smallint().notNull().default(0),
    /** The code is valid for 5 minutes. */
    expiresAt: tstz().notNull(),
    /** When the code was used (a code works once). */
    consumedAt: tstz(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("otp_challenges_mobile_idx").on(t.mobile, t.createdAt)],
);
