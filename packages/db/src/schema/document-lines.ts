import { boolean, char, jsonb, smallint, text, uuid, varchar } from "drizzle-orm/pg-core";
import { money, percent, qty, rate } from "./columns.js";
import { supplyType, taxability } from "./enums.js";

/**
 * Shared column sets for every GST document (sales order, invoice, purchase,
 * credit/debit note). Lines store a SNAPSHOT of what was charged — product
 * name, HSN, rate, the resolved tax rule and every tax amount — so reports and
 * reprints never depend on today's product master or today's tax rates.
 */
export const taxLineColumns = () => ({
  lineNo: smallint().notNull(),
  productId: uuid().notNull(),
  productName: text().notNull(),
  hsnCode: varchar({ length: 8 }),
  uqc: varchar({ length: 3 }),
  unitId: uuid().notNull(),
  /** Selling/purchase unit -> base unit. */
  conversionFactor: qty().notNull().default("1"),
  qty: qty().notNull(),
  /** Scheme quantity given free (e.g. 10+1); moves stock, carries no value. */
  freeQty: qty().notNull().default("0"),
  /** qty x conversion factor: what the stock ledger moves. */
  qtyBase: qty().notNull(),
  rate: rate().notNull(),
  rateIncludesTax: boolean().notNull().default(false),
  grossAmount: money().notNull(),
  discountPercent: percent().notNull().default("0"),
  discountAmount: money().notNull().default("0"),
  documentDiscountShare: money().notNull().default("0"),
  taxableValue: money().notNull(),
  taxability: taxability().notNull().default("taxable"),
  taxCategoryId: uuid(),
  taxRateId: uuid(),
  gstRate: percent().notNull().default("0"),
  cgstRate: percent().notNull().default("0"),
  cgstAmount: money().notNull().default("0"),
  sgstRate: percent().notNull().default("0"),
  sgstAmount: money().notNull().default("0"),
  igstRate: percent().notNull().default("0"),
  igstAmount: money().notNull().default("0"),
  cessRate: percent().notNull().default("0"),
  cessAmount: money().notNull().default("0"),
  lineTotal: money().notNull(),
});

export const documentTotalsColumns = () => ({
  grossTotal: money().notNull().default("0"),
  discountTotal: money().notNull().default("0"),
  documentDiscountPercent: percent().notNull().default("0"),
  documentDiscountAmount: money().notNull().default("0"),
  taxableTotal: money().notNull().default("0"),
  cgstTotal: money().notNull().default("0"),
  sgstTotal: money().notNull().default("0"),
  igstTotal: money().notNull().default("0"),
  cessTotal: money().notNull().default("0"),
  /** Freight, packing etc.: [{key,label,taxable,gstRate,cgst,sgst,igst,cess,total}]. */
  charges: jsonb().notNull().default([]),
  chargesTotal: money().notNull().default("0"),
  roundOff: money().notNull().default("0"),
  grandTotal: money().notNull().default("0"),
});

/** Party + place-of-supply snapshot taken when the document is posted. */
export const gstPartySnapshotColumns = () => ({
  partyName: text().notNull(),
  partyGstin: varchar({ length: 15 }),
  partyStateCode: char({ length: 2 }),
  billingAddress: jsonb(),
  shippingAddress: jsonb(),
  placeOfSupply: char({ length: 2 }).notNull(),
  supplyType: supplyType().notNull(),
  isReverseCharge: boolean().notNull().default(false),
  /** Version of the calculation engine used (e.g. "gst-line@1"). */
  taxEngineVersion: varchar({ length: 20 }).notNull(),
});
