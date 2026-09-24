import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgTable, text, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, percent, pk, softDelete, tstz, versioned } from "./columns.js";
import { documentStatus, itcEligibility, paymentMethod } from "./enums.js";
import { suppliers } from "./parties.js";
import { paymentAccounts } from "./payments.js";
import { businessId, files } from "./platform.js";

/** Rent, Electricity, Salary, Transport, Fuel, Office, Maintenance, Marketing, Other — editable. */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    nameHi: text(),
    isSystem: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [unique("expense_categories_name_uq").on(t.businessId, t.name)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: pk(),
    businessId: businessId(),
    expenseNumber: varchar({ length: 30 }),
    expenseDate: date({ mode: "string" }).notNull(),
    categoryId: uuid()
      .notNull()
      .references(() => expenseCategories.id),
    paidTo: text(),
    supplierId: uuid().references(() => suppliers.id),
    /** Amount before GST. */
    amount: money().notNull(),
    // Optional GST on the expense bill (for input tax credit).
    vendorGstin: varchar({ length: 15 }),
    gstRate: percent().notNull().default("0"),
    cgstAmount: money().notNull().default("0"),
    sgstAmount: money().notNull().default("0"),
    igstAmount: money().notNull().default("0"),
    itcEligibility: itcEligibility(),
    totalAmount: money().notNull(),
    paymentMethod: paymentMethod().notNull(),
    paymentAccountId: uuid().references(() => paymentAccounts.id),
    referenceNumber: varchar({ length: 40 }),
    receiptFileId: uuid().references(() => files.id),
    notes: text(),
    status: documentStatus().notNull().default("posted"),
    approvedBy: uuid(),
    cancelledAt: tstz(),
    cancelledBy: uuid(),
    cancelReason: text(),
    /** Idempotency key from the client (a retried save returns the same expense). */
    clientId: uuid(),
    ...auditColumns,
    ...softDelete,
    ...versioned,
  },
  (t) => [
    index("expenses_date_idx").on(t.businessId, t.expenseDate),
    index("expenses_category_idx").on(t.businessId, t.categoryId, t.expenseDate),
    uniqueIndex("expenses_number_uq").on(t.businessId, t.expenseNumber).where(sql`${t.expenseNumber} is not null`),
    uniqueIndex("expenses_client_id_uq").on(t.businessId, t.clientId).where(sql`${t.clientId} is not null`),
    check("expenses_amount_chk", sql`${t.amount} > 0 and ${t.totalAmount} >= ${t.amount}`),
  ],
);
