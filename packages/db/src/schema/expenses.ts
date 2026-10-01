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
    /** Seeded with the business (Rent, Electricity ...). */
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
    /** Number from the expense series. */
    expenseNumber: varchar({ length: 30 }),
    /** Date of the expense. */
    expenseDate: date({ mode: "string" }).notNull(),
    /** Expense category (Rent, Fuel ...). */
    categoryId: uuid()
      .notNull()
      .references(() => expenseCategories.id),
    /** Who was paid (shop, landlord, person). */
    paidTo: text(),
    /** The supplier, when paid to one. */
    supplierId: uuid().references(() => suppliers.id),
    /** Amount before GST. */
    amount: money().notNull(),
    // Optional GST on the expense bill (for input tax credit).
    /** GSTIN on the expense bill, needed to claim its GST as input credit. */
    vendorGstin: varchar({ length: 15 }),
    /** GST rate on the bill in percent. */
    gstRate: percent().notNull().default("0"),
    /** Central GST on the bill. */
    cgstAmount: money().notNull().default("0"),
    /** State / UT GST on the bill. */
    sgstAmount: money().notNull().default("0"),
    /** Integrated GST on the bill. */
    igstAmount: money().notNull().default("0"),
    /** Whether the GST can be claimed as input credit (not for composition or unregistered businesses). */
    itcEligibility: itcEligibility(),
    /** Amount paid: the amount plus its GST. */
    totalAmount: money().notNull(),
    /** Cash, UPI, bank transfer, cheque, card or other. */
    paymentMethod: paymentMethod().notNull(),
    /** Account the money was paid from. */
    paymentAccountId: uuid().references(() => paymentAccounts.id),
    /** Bill or payment reference. */
    referenceNumber: varchar({ length: 40 }),
    /** Reserved for a photo of the bill (not filled). */
    receiptFileId: uuid().references(() => files.id),
    notes: text(),
    /** Posted or cancelled. */
    status: documentStatus().notNull().default("posted"),
    /** Reserved for an approval step (not filled yet). */
    approvedBy: uuid(),
    /** When it was cancelled (kept, and left out of reports and GST). */
    cancelledAt: tstz(),
    /** User who cancelled it. */
    cancelledBy: uuid(),
    /** Why it was cancelled. */
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
