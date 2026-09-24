import {
  dec,
  type Dec,
  type DecimalInput,
  HUNDRED,
  pct,
  roundAmount,
  ZERO,
} from "../money/decimal.js";
import { ValidationError } from "../errors.js";
import type { ResolvedTax } from "./rates.js";
import type { SupplyType } from "./supply.js";

/**
 * Bumped whenever the calculation method changes. Every posted document line
 * stores the version it was computed with, so historical documents can always
 * be explained and re-verified.
 */
export const TAX_ENGINE_VERSION = "gst-line@1";

export interface TaxLineInput {
  /** Quantity in the selling unit (e.g. 2 BOX). */
  qty: DecimalInput;
  /** Price per selling unit. */
  rate: DecimalInput;
  /** When true, `rate` is tax-inclusive (MRP-style); taxable value is back-calculated. */
  rateIncludesTax?: boolean;
  /** Line discount percent, applied first. */
  discountPercent?: DecimalInput;
  /** Flat line discount in rupees, applied after the percent discount. */
  discountAmount?: DecimalInput;
  /** Share of an invoice-level discount apportioned to this line (set by the document calculator). */
  apportionedDiscount?: DecimalInput;
  /** Selling unit -> base unit conversion (1 BOX = 24 PCS); used for per-unit cess. */
  conversionFactor?: DecimalInput;
  tax: ResolvedTax;
}

export interface TaxLineResult {
  qty: Dec;
  qtyBase: Dec;
  rate: Dec;
  /** qty x rate as entered (inclusive of tax when rateIncludesTax). */
  gross: Dec;
  discount: Dec;
  taxable: Dec;
  gstRate: Dec;
  cgstRate: Dec;
  sgstRate: Dec;
  igstRate: Dec;
  cessRate: Dec;
  cgst: Dec;
  sgst: Dec;
  igst: Dec;
  cess: Dec;
  taxTotal: Dec;
  total: Dec;
}

export interface TaxLineOptions {
  supplyType: SupplyType;
  /** False for Bill of Supply (composition / unregistered supplier): no tax is charged. */
  chargeTax: boolean;
}

/**
 * Calculates one document line.
 *
 * Exclusive pricing: taxable = qty x rate - discounts; each tax component is
 * computed on the taxable value and rounded to paise independently (CGST and
 * SGST are therefore always equal).
 *
 * Inclusive pricing: taxable = round(net / (1 + rate%)); components are then
 * computed on that taxable value exactly as above. The line total can differ
 * from the inclusive price by a paisa or two; the invoice round-off absorbs it.
 */
export function calculateTaxLine(input: TaxLineInput, options: TaxLineOptions): TaxLineResult {
  const qty = dec(input.qty);
  const rate = dec(input.rate);
  if (qty.lte(0)) throw new ValidationError("QTY_NOT_POSITIVE", "Quantity must be greater than zero");
  if (rate.isNegative()) throw new ValidationError("RATE_NEGATIVE", "Rate cannot be negative");

  const discountPercent = dec(input.discountPercent ?? 0);
  if (discountPercent.isNegative() || discountPercent.gt(100)) {
    throw new ValidationError("DISCOUNT_PERCENT_RANGE", "Discount percent must be between 0 and 100");
  }
  const flatDiscount = dec(input.discountAmount ?? 0);
  const apportioned = dec(input.apportionedDiscount ?? 0);
  if (flatDiscount.isNegative() || apportioned.isNegative()) {
    throw new ValidationError("DISCOUNT_NEGATIVE", "Discount cannot be negative");
  }

  const gross = roundAmount(qty.times(rate));
  const discount = roundAmount(pct(gross, discountPercent)).plus(roundAmount(flatDiscount)).plus(apportioned);
  if (discount.gt(gross)) {
    throw new ValidationError("DISCOUNT_EXCEEDS_AMOUNT", "Discount is more than the line amount", {
      discount: discount.toFixed(2),
      amount: gross.toFixed(2),
    });
  }
  const net = gross.minus(discount);
  const qtyBase = qty.times(dec(input.conversionFactor ?? 1));

  const tax = options.chargeTax && input.tax.kind === "taxable" ? input.tax : null;
  const gstRate = tax ? tax.gstRate : ZERO;
  const cessRate = tax ? tax.cessRate : ZERO;
  const specificCess = tax ? roundAmount(qtyBase.times(tax.cessPerUnit)) : ZERO;

  let taxable: Dec;
  if (input.rateIncludesTax && tax) {
    const divisor = HUNDRED.plus(gstRate).plus(cessRate).dividedBy(HUNDRED);
    taxable = roundAmount(net.minus(specificCess).dividedBy(divisor));
    if (taxable.isNegative()) taxable = ZERO;
  } else {
    taxable = net;
  }

  const intra = options.supplyType === "intra_state";
  const halfRate = gstRate.dividedBy(2);
  const cgstRate = intra ? halfRate : ZERO;
  const sgstRate = intra ? halfRate : ZERO;
  const igstRate = intra ? ZERO : gstRate;
  const cgst = roundAmount(pct(taxable, cgstRate));
  const sgst = roundAmount(pct(taxable, sgstRate));
  const igst = roundAmount(pct(taxable, igstRate));
  const cess = roundAmount(pct(taxable, cessRate)).plus(specificCess);
  const taxTotal = cgst.plus(sgst).plus(igst).plus(cess);

  return {
    qty,
    qtyBase,
    rate,
    gross,
    discount,
    taxable,
    gstRate,
    cgstRate,
    sgstRate,
    igstRate,
    cessRate,
    cgst,
    sgst,
    igst,
    cess,
    taxTotal,
    total: taxable.plus(taxTotal),
  };
}
