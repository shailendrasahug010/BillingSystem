import { integer, numeric, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Column conventions shared by every table (column names are snake_case via
 * Drizzle `casing: "snake_case"`).
 *
 *  - Primary keys are UUIDs. The application generates UUIDv7 (time-ordered,
 *    index friendly, and creatable on an offline device); the DB default is a
 *    safety net. Append-only server-side ledgers use bigint identity instead.
 *  - Money is NUMERIC(15,2), unit rates NUMERIC(15,4), quantities NUMERIC(15,3),
 *    percentages NUMERIC(7,3). Never floating point.
 *  - created_by / updated_by are informational (no FK: users are deactivated, never deleted).
 *  - `version` supports optimistic locking and offline-sync conflict detection.
 */
export const pk = () => uuid().primaryKey().defaultRandom();

export const money = () => numeric({ precision: 15, scale: 2 });
export const rate = () => numeric({ precision: 15, scale: 4 });
export const qty = () => numeric({ precision: 15, scale: 3 });
export const percent = () => numeric({ precision: 7, scale: 3 });

export const tstz = () => timestamp({ withTimezone: true, mode: "string" });

export const timestamps = {
  createdAt: tstz().notNull().defaultNow(),
  updatedAt: tstz().notNull().defaultNow(),
};

export const auditColumns = {
  ...timestamps,
  createdBy: uuid(),
  updatedBy: uuid(),
};

export const softDelete = {
  deletedAt: tstz(),
  deletedBy: uuid(),
};

export const versioned = {
  version: integer().notNull().default(1),
};
