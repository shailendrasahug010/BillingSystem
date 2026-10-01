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
    /** outward (sales: GSTR-1, GSTR-3B 3.1) or inward (purchases and expenses: input credit). */
    direction: gstDirection().notNull(),
    /** invoice, credit_note, debit_note, purchase, purchase_credit_note, purchase_debit_note or expense. */
    docType: gstDocType().notNull(),
    /** Id of the source document. */
    docId: uuid().notNull(),
    /** Id of the source document's line. */
    docLineId: uuid(),
    /** Number of the document as it goes into the return. */
    docNumber: varchar({ length: 30 }).notNull(),
    /** Date of the document. */
    docDate: date({ mode: "string" }).notNull(),
    /** Original invoice for credit/debit notes. */
    originalDocNumber: varchar({ length: 30 }),
    /** Date of that original invoice. */
    originalDocDate: date({ mode: "string" }),
    /** "YYYY-MM" return period the row belongs to. */
    returnPeriod: char({ length: 7 }).notNull(),
    /** Party's name on the document. */
    partyName: text(),
    /** Party's GSTIN (empty for unregistered parties): B2B rows have one. */
    partyGstin: varchar({ length: 15 }),
    /** Party's GST status (regular, composition, consumer, SEZ, overseas ...). */
    partyRegistration: partyGstRegistration().notNull(),
    /** Party's state. */
    partyStateCode: char({ length: 2 }),
    /** Place of supply (GST state code; 96 for exports). */
    placeOfSupply: char({ length: 2 }).notNull(),
    /** Intra-state, inter-state or export / SEZ. */
    supplyType: supplyType().notNull(),
    /** Tax payable by the recipient under reverse charge (GSTR-3B 3.1(d) for purchases). */
    isReverseCharge: boolean().notNull().default(false),
    /** Taxable, nil-rated, exempt or non-GST. */
    taxability: taxability().notNull(),
    /** HSN / SAC code, for the HSN summary. */
    hsnCode: varchar({ length: 8 }),
    /** Unit quantity code, for the HSN summary. */
    uqc: varchar({ length: 3 }),
    /** Quantity in that unit, for the HSN summary. */
    qty: qty().notNull().default("0"),
    /** Taxable value of the line. */
    taxableValue: money().notNull(),
    /** GST rate in percent. */
    gstRate: percent().notNull(),
    /** Central GST. */
    cgstAmount: money().notNull().default("0"),
    /** State / UT GST. */
    sgstAmount: money().notNull().default("0"),
    /** Integrated GST. */
    igstAmount: money().notNull().default("0"),
    /** Compensation cess. */
    cessAmount: money().notNull().default("0"),
    /** Whole-document value (needed for B2CL threshold tests and invoice-level return tables). */
    documentValue: money().notNull(),
    /** For inward rows: whether the credit can be claimed (GSTR-3B table 4). */
    itcEligibility: itcEligibility(),
    /** Set when the source document is cancelled; formatters exclude or report as cancelled. */
    isCancelled: boolean().notNull().default(false),
    /** Export / supply to SEZ (EXPWP, EXPWOP, SEZWP, SEZWOP): reported in their own GSTR-1 tables and GSTR-3B 3.1(b). */
    zeroRatedType: varchar({ length: 6 }),
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
    /** GSTR1 or GSTR3B. */
    returnType: varchar({ length: 12 }).notNull(),
    /** Return period, YYYY-MM. */
    period: char({ length: 7 }).notNull(),
    /** open, locked (documents dated in it can no longer change their tax) or filed. */
    status: gstPeriodStatus().notNull().default("open"),
    /** When the period was locked. */
    lockedAt: tstz(),
    /** User who locked it. */
    lockedBy: uuid(),
    /** When the filing was recorded. */
    filedAt: tstz(),
    /** Acknowledgement reference number of the filed return. */
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
    /** Return the file is for (GSTR1, GSTR3B ...). */
    returnType: varchar({ length: 12 }).notNull(),
    /** Return period, YYYY-MM. */
    period: char({ length: 7 }).notNull(),
    /** e.g. "gstr1-json@2025.1", "gstr1-excel@1", "hsn-csv@1". */
    formatterVersion: varchar({ length: 40 }).notNull(),
    /** File format: json (for the GST offline tool / portal) or csv. */
    format: varchar({ length: 10 }).notNull(),
    /** The file, when it was kept (downloads are made on the fly and not kept). */
    fileId: uuid().references(() => files.id),
    /** Totals of the file (counts and values per table), as JSON. */
    summary: jsonb().notNull(),
    /** Problems found that should be fixed before filing, as JSON. */
    warnings: jsonb().notNull().default([]),
    /** User who downloaded it. */
    generatedBy: uuid(),
    /** When it was made. */
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
    /** Setting name: b2cl_invoice_threshold, hsn_min_digits, einvoice_turnover_threshold, eway_bill_value_threshold, invoice_number_rules ... */
    key: varchar({ length: 60 }).notNull(),
    /** First date the value applies (the document date decides). */
    effectiveFrom: date({ mode: "string" }).notNull(),
    /** The value as JSON (e.g. {"amount": 100000}). */
    value: jsonb().notNull(),
    /** Where the value comes from (notification or circular), for checking. */
    source: text(),
    ...timestamps,
  },
  (t) => [unique("gst_config_uq").on(t.businessId, t.key, t.effectiveFrom).nullsNotDistinct()],
);
