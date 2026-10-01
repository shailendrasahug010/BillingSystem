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
  /** Position of the line on the document (1, 2, 3 ...). */
  lineNo: smallint().notNull(),
  /** The product sold or bought; its name, HSN and tax are copied onto the line, so later changes to the product do not alter the document. */
  productId: uuid().notNull(),
  /** Product name as printed on the document (snapshot). */
  productName: text().notNull(),
  /** HSN / SAC code printed on the document (snapshot); GST returns summarise by it. */
  hsnCode: varchar({ length: 8 }),
  /** GST unit quantity code of the line's unit (NOS, BOX, KGS ...), as reported in the HSN summary. */
  uqc: varchar({ length: 3 }),
  /** The unit the quantity is in (piece, strip, box ...). */
  unitId: uuid().notNull(),
  /** Selling/purchase unit -> base unit. */
  conversionFactor: qty().notNull().default("1"),
  /** Quantity in the line's unit. */
  qty: qty().notNull(),
  /** Scheme quantity given free (e.g. 10+1); moves stock, carries no value. */
  freeQty: qty().notNull().default("0"),
  /** qty x conversion factor: what the stock ledger moves. */
  qtyBase: qty().notNull(),
  /** Price per unit of the line's unit. */
  rate: rate().notNull(),
  /** Whether `rate` already includes GST (tax-inclusive pricing); the taxable value is then worked back from it. */
  rateIncludesTax: boolean().notNull().default(false),
  /** qty x rate, before any discount. */
  grossAmount: money().notNull(),
  /** The line's own discount in percent of the gross amount. */
  discountPercent: percent().notNull().default("0"),
  /** The line's own discount in rupees (its percent part plus any flat amount), not counting its share of the document discount. */
  discountAmount: money().notNull().default("0"),
  /** This line's share of the discount given on the whole document, spread over the lines in proportion to their net amounts. */
  documentDiscountShare: money().notNull().default("0"),
  /** Value GST is charged on: gross less both discounts (taken out of a tax-inclusive rate). */
  taxableValue: money().notNull(),
  /** Whether the line is taxable, nil-rated, exempt or non-GST (decides the GSTR-1 table it goes to). */
  taxability: taxability().notNull().default("taxable"),
  /** Tax category the rate was resolved from (snapshot; no foreign key). */
  taxCategoryId: uuid(),
  /** The dated tax rule that applied on the document date (snapshot; no foreign key). */
  taxRateId: uuid(),
  /** Total GST rate in percent (CGST + SGST, or IGST). */
  gstRate: percent().notNull().default("0"),
  /** Central GST rate in percent (intra-state supply). */
  cgstRate: percent().notNull().default("0"),
  /** Central GST charged on the line. */
  cgstAmount: money().notNull().default("0"),
  /** State or Union-territory GST rate in percent (intra-state supply). */
  sgstRate: percent().notNull().default("0"),
  /** State or Union-territory GST charged on the line. */
  sgstAmount: money().notNull().default("0"),
  /** Integrated GST rate in percent (inter-state supply, exports and SEZ). */
  igstRate: percent().notNull().default("0"),
  /** Integrated GST charged on the line. */
  igstAmount: money().notNull().default("0"),
  /** Compensation cess rate in percent (tobacco, aerated drinks ...). */
  cessRate: percent().notNull().default("0"),
  /** Compensation cess charged on the line (percent part plus any amount per unit). */
  cessAmount: money().notNull().default("0"),
  /** Taxable value plus all GST and cess on the line. */
  lineTotal: money().notNull(),
});

export const documentTotalsColumns = () => ({
  /** Sum of the lines' gross amounts (qty x rate). */
  grossTotal: money().notNull().default("0"),
  /** All discounts on the lines, including their shares of the document discount. */
  discountTotal: money().notNull().default("0"),
  /** Discount on the whole document, in percent of the lines' net total. */
  documentDiscountPercent: percent().notNull().default("0"),
  /** Discount on the whole document, in rupees (spread over the lines as `document_discount_share`). */
  documentDiscountAmount: money().notNull().default("0"),
  /** Total taxable value: the lines' plus taxed charges'. */
  taxableTotal: money().notNull().default("0"),
  /** Total central GST on lines and charges. */
  cgstTotal: money().notNull().default("0"),
  /** Total state / UT GST on lines and charges. */
  sgstTotal: money().notNull().default("0"),
  /** Total integrated GST on lines and charges. */
  igstTotal: money().notNull().default("0"),
  /** Total compensation cess. */
  cessTotal: money().notNull().default("0"),
  /** Freight, packing etc.: [{key,label,taxable,gstRate,cgst,sgst,igst,cess,total}]. */
  charges: jsonb().notNull().default([]),
  /** Freight, packing and other charges before their GST. */
  chargesTotal: money().notNull().default("0"),
  /** Amount added or taken off to round the grand total (to the rupee by default). */
  roundOff: money().notNull().default("0"),
  /** What the party pays: taxable value + charges + GST and cess + round-off. */
  grandTotal: money().notNull().default("0"),
});

/** Party + place-of-supply snapshot taken when the document is posted. */
export const gstPartySnapshotColumns = () => ({
  /** Party's name as printed on the document (snapshot). */
  partyName: text().notNull(),
  /** Party's GSTIN when the document was posted; empty for unregistered parties. */
  partyGstin: varchar({ length: 15 }),
  /** Party's GST state code when the document was posted. */
  partyStateCode: char({ length: 2 }),
  /** Billing address printed on the document (snapshot: line1, line2, city, pincode, state). */
  billingAddress: jsonb(),
  /** Delivery address printed on the document, when different from billing (snapshot). */
  shippingAddress: jsonb(),
  /** GST state code of the place of supply (96 for exports): decides CGST + SGST or IGST. */
  placeOfSupply: char({ length: 2 }).notNull(),
  /** Intra-state (CGST + SGST), inter-state (IGST) or export / SEZ. */
  supplyType: supplyType().notNull(),
  /** Reverse charge: the recipient pays this GST to the government instead of the supplier. */
  isReverseCharge: boolean().notNull().default(false),
  /** Version of the calculation engine used (e.g. "gst-line@1"). */
  taxEngineVersion: varchar({ length: 20 }).notNull(),
});
