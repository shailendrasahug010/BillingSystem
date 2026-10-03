import { sql } from "drizzle-orm";
import { check, date, index, numeric, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { tstz } from "./columns.js";
import { customers, salesRoutes } from "./parties.js";
import { businessId, users } from "./platform.js";

/**
 * A salesperson's call on a customer on their beat (Phase 5.4) when it left
 * no document: they checked in, or found no order and said why. Bills,
 * orders, payments and visit notes made for the customer that day count as
 * visits by themselves; this row records the calls that would otherwise
 * leave no trace. The id is made on the phone (the request's Idempotency-Key),
 * so a visit recorded offline and sent twice is kept once.
 */
export const customerVisits = pgTable(
  "customer_visits",
  {
    /** Made on the phone (the request's Idempotency-Key), so the visit is kept once however often it is sent. */
    id: uuid().primaryKey(),
    businessId: businessId(),
    /** The customer called on. */
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** The route it was on (empty for a call off the day's beat). */
    routeId: uuid().references(() => salesRoutes.id),
    /** Who called. */
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** The business day of the call. */
    visitDate: date({ mode: "string" }).notNull(),
    /** visited (checked in) or no_order (nothing bought, with a reason). */
    outcome: varchar({ length: 12 }).notNull(),
    /** Why there was no order: shop_closed, owner_absent, stock_enough, no_money, rate_issue or other. */
    reason: varchar({ length: 20 }),
    /** What the salesperson noted (when to come back, what the shop said). */
    note: text(),
    /** Where the phone was, when the person allowed it. */
    latitude: numeric({ precision: 9, scale: 6 }),
    /** With the latitude. */
    longitude: numeric({ precision: 9, scale: 6 }),
    /** When it happened on the phone (it may reach the server later). */
    visitedAt: tstz().notNull(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index("customer_visits_day_idx").on(t.businessId, t.visitDate, t.userId),
    index("customer_visits_customer_idx").on(t.businessId, t.customerId, t.visitDate),
    check("customer_visits_outcome_chk", sql`${t.outcome} in ('visited', 'no_order')`),
    check("customer_visits_reason_chk", sql`${t.outcome} <> 'no_order' or ${t.reason} is not null`),
  ],
);
