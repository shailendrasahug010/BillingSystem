import { date, index, pgTable, text, unique, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, pk } from "./columns.js";
import { businessId } from "./platform.js";

/**
 * Income tax the business deducted at source (TDS on purchase bills) paid
 * to the government: one challan per month's deductions, with the bank's
 * BSR code and the challan's serial number as the quarterly TDS return asks.
 * The bills it paid point to it (purchases.tds_challan_id).
 */
export const tdsChallans = pgTable(
  "tds_challans",
  {
    id: pk(),
    businessId: businessId(),
    /** Month whose deductions it pays ("2026-09"). */
    periodMonth: varchar({ length: 7 }).notNull(),
    /** Date the tax was paid. */
    depositDate: date({ mode: "string" }).notNull(),
    /** The bank branch's BSR code on the challan (7 digits). */
    bsrCode: varchar({ length: 7 }).notNull(),
    /** The challan's serial number (5 digits). */
    challanSerial: varchar({ length: 5 }).notNull(),
    /** Tax paid: the TDS of the bills it covers. */
    taxAmount: money().notNull(),
    /** Interest paid for paying late. */
    interest: money().notNull().default("0"),
    /** Fee paid for filing the return late. */
    lateFee: money().notNull().default("0"),
    notes: text(),
    ...auditColumns,
  },
  (t) => [unique("tds_challans_uq").on(t.businessId, t.depositDate, t.bsrCode, t.challanSerial), index("tds_challans_period_idx").on(t.businessId, t.periodMonth)],
);
