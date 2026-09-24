import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, index, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { money, percent, pk, qty, timestamps, tstz } from "./columns.js";
import { gstDirection, gstDocType, gstPeriodStatus, itcEligibility, partyGstRegistration, supplyType, taxability } from "./enums.js";
import { businessId, files } from "./platform.js";

/**
 * GST REGISTER — one row per taxable line of every posted GST document,
 * written in the same transaction that posts the document. It stores FACTS
 * (who, where, what, how much tax), not return classifications: whether a
 * row lands in B2CL or B2CS, which table of GSTR-1 or GSTR-3B, is decided by
 * the versioned return formatter for the period, using thresholds from
 * configuration. A rule change therefore never requires rewriting history.
 */
export const gstTransactions = pgTable(
  "gst_transactions",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    businessId: businessId(),
    direction: gstDirection().notNull(),
    docType: gstDocType().notNull(),
    docId: uuid().notNull(),
    docLineId: uuid(),
    docNumber: varchar({ length: 30 }).notNull(),
    docDate: date({ mode: "string" }).notNull(),
    /** Original invoice for credit/debit notes. */
    originalDocNumber: varchar({ length: 30 }),
    originalDocDate: date({ mode: "string" }),
    /** "YYYY-MM" return period the row belongs to. */
    returnPeriod: char({ length: 7 }).notNull(),
    partyName: text(),
    partyGstin: varchar({ length: 15 }),
    partyRegistration: partyGstRegistration().notNull(),
    partyStateCode: char({ length: 2 }),
    placeOfSupply: char({ length: 2 }).notNull(),
    supplyType: supplyType().notNull(),
    isReverseCharge: boolean().notNull().default(false),
    taxability: taxability().notNull(),
    hsnCode: varchar({ length: 8 }),
    uqc: varchar({ length: 3 }),
    qty: qty().notNull().default("0"),
    taxableValue: money().notNull(),
    gstRate: percent().notNull(),
    cgstAmount: money().notNull().default("0"),
    sgstAmount: money().notNull().default("0"),
    igstAmount: money().notNull().default("0"),
    cessAmount: money().notNull().default("0"),
    /** Whole-document value (needed for B2CL threshold tests and invoice-level return tables). */
    documentValue: money().notNull(),
    itcEligibility: itcEligibility(),
    /** Set when the source document is cancelled; formatters exclude or report as cancelled. */
    isCancelled: boolean().notNull().default(false),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index("gst_transactions_period_idx").on(t.businessId, t.returnPeriod, t.direction, t.docType),
    index("gst_transactions_doc_idx").on(t.docType, t.docId),
    index("gst_transactions_hsn_idx").on(t.businessId, t.returnPeriod, t.hsnCode),
    check("gst_transactions_period_chk", sql`${t.returnPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

/**
 * Return periods. Locking a period (after filing GSTR-1) blocks edits and
 * cancellations of documents dated in it; corrections then go through
 * credit/debit notes in an open period.
 */
export const gstReturnPeriods = pgTable(
  "gst_return_periods",
  {
    id: pk(),
    businessId: businessId(),
    returnType: varchar({ length: 12 }).notNull(),
    period: char({ length: 7 }).notNull(),
    status: gstPeriodStatus().notNull().default("open"),
    lockedAt: tstz(),
    lockedBy: uuid(),
    filedAt: tstz(),
    arn: varchar({ length: 30 }),
    notes: text(),
    ...timestamps,
  },
  (t) => [unique("gst_return_periods_uq").on(t.businessId, t.returnType, t.period)],
);

/** Every generated return / export file, with the formatter version that produced it. */
export const gstExports = pgTable(
  "gst_exports",
  {
    id: pk(),
    businessId: businessId(),
    returnType: varchar({ length: 12 }).notNull(),
    period: char({ length: 7 }).notNull(),
    /** e.g. "gstr1-json@2025.1", "gstr1-excel@1", "hsn-csv@1". */
    formatterVersion: varchar({ length: 40 }).notNull(),
    format: varchar({ length: 10 }).notNull(),
    fileId: uuid().references(() => files.id),
    summary: jsonb().notNull(),
    warnings: jsonb().notNull().default([]),
    generatedBy: uuid(),
    generatedAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("gst_exports_period_idx").on(t.businessId, t.returnType, t.period)],
);

/** Effective-dated GST configuration values (thresholds, HSN digit rules, e-invoice applicability). */
export const gstConfig = pgTable(
  "gst_config",
  {
    id: pk(),
    /** null = platform default shipped with the app; a business can override. */
    businessId: uuid(),
    key: varchar({ length: 60 }).notNull(),
    effectiveFrom: date({ mode: "string" }).notNull(),
    value: jsonb().notNull(),
    source: text(),
    ...timestamps,
  },
  (t) => [unique("gst_config_uq").on(t.businessId, t.key, t.effectiveFrom).nullsNotDistinct()],
);
