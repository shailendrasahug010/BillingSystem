import {
  apportion,
  applyRoundOff,
  dec,
  type Dec,
  type DecimalInput,
  DEFAULT_ROUND_OFF,
  pct,
  roundAmount,
  type RoundOffConfig,
  sum,
  ZERO,
} from "../money/decimal.js";
import { ValidationError } from "../errors.js";
import { calculateTaxLine, type TaxLineInput, type TaxLineResult } from "../gst/line.js";
import type { ResolvedTax } from "../gst/rates.js";
import type { SupplyType } from "../gst/supply.js";

/**
 * One calculator for every GST document: sales invoice, sales order estimate,
 * purchase bill, credit note, debit note. The client runs it for instant totals
 * (and offline invoices); the server re-runs it on save and rejects the document
 * if the client's totals differ. Same code, same numbers, everywhere.
 */
export interface DocumentLineInput extends Omit<TaxLineInput, "apportionedDiscount"> {
  /** Stable client-side key for the line (UUID); used to map results back to UI rows. */
  key: string;
  hsnCode?: string | null;
  /** GST Unit Quantity Code for the HSN summary (NOS, KGS, BOX...). */
  uqc?: string | null;
}

export interface ChargeInput {
  key: string;
  label: string;
  amount: DecimalInput;
  /** Taxable charge (e.g. freight billed as part of the supply). Omit for a non-taxable charge. */
  tax?: ResolvedTax | null;
  hsnCode?: string | null;
}

export interface DocumentDiscount {
  /** Percent of the net line value (after line discounts). */
  percent?: DecimalInput;
  /** Flat amount. When both are given, percent is applied first. */
  amount?: DecimalInput;
}

export interface DocumentInput {
  lines: readonly DocumentLineInput[];
  supplyType: SupplyType;
  chargeTax: boolean;
  /** Export / SEZ supply under bond or LUT: no tax, rates kept (see TaxLineOptions.withoutPayment). */
  withoutPayment?: boolean;
  /** Pre-tax invoice discount, apportioned across lines so GST is charged on the reduced value. */
  documentDiscount?: DocumentDiscount | null;
  charges?: readonly ChargeInput[];
  roundOff?: RoundOffConfig;
  amountPaid?: DecimalInput;
}

export interface LineResult extends TaxLineResult {
  key: string;
  hsnCode: string | null;
  uqc: string | null;
  lineDiscount: Dec;
  documentDiscountShare: Dec;
}

export interface ChargeResult {
  key: string;
  label: string;
  taxable: Dec;
  cgst: Dec;
  sgst: Dec;
  igst: Dec;
  cess: Dec;
  gstRate: Dec;
  total: Dec;
}

export interface RateBreakup {
  gstRate: Dec;
  taxable: Dec;
  cgst: Dec;
  sgst: Dec;
  igst: Dec;
  cess: Dec;
}

export interface HsnSummaryRow {
  hsnCode: string;
  uqc: string | null;
  gstRate: Dec;
  qty: Dec;
  taxable: Dec;
  cgst: Dec;
  sgst: Dec;
  igst: Dec;
  cess: Dec;
  total: Dec;
}

export type PaymentStatus = "unpaid" | "partial" | "paid";

export interface DocumentTotals {
  lines: LineResult[];
  charges: ChargeResult[];
  lineCount: number;
  totalQty: Dec;
  grossTotal: Dec;
  discountTotal: Dec;
  taxableTotal: Dec;
  cgstTotal: Dec;
  sgstTotal: Dec;
  igstTotal: Dec;
  cessTotal: Dec;
  taxTotal: Dec;
  chargesTotal: Dec;
  totalBeforeRoundOff: Dec;
  roundOff: Dec;
  grandTotal: Dec;
  amountPaid: Dec;
  balanceDue: Dec;
  /** Amount received beyond the grand total (becomes an advance / on-account credit). */
  excessPaid: Dec;
  paymentStatus: PaymentStatus;
  rateBreakup: RateBreakup[];
  hsnSummary: HsnSummaryRow[];
}

export function paymentStatusFor(grandTotal: DecimalInput, amountPaid: DecimalInput): PaymentStatus {
  const total = dec(grandTotal);
  const paid = dec(amountPaid);
  if (paid.lte(0)) return total.lte(0) ? "paid" : "unpaid";
  return paid.gte(total) ? "paid" : "partial";
}

function lineNetBeforeDocumentDiscount(line: DocumentLineInput): Dec {
  const gross = roundAmount(dec(line.qty).times(dec(line.rate)));
  const percentPart = roundAmount(pct(gross, dec(line.discountPercent ?? 0)));
  return gross.minus(percentPart).minus(roundAmount(dec(line.discountAmount ?? 0)));
}

export function calculateDocument(input: DocumentInput): DocumentTotals {
  const { supplyType, chargeTax } = input;
  const withoutPayment = input.withoutPayment === true;
  const nets = input.lines.map(lineNetBeforeDocumentDiscount);
  const netTotal = sum(nets);

  let documentDiscount = ZERO;
  if (input.documentDiscount) {
    const percent = dec(input.documentDiscount.percent ?? 0);
    if (percent.isNegative() || percent.gt(100)) {
      throw new ValidationError("DISCOUNT_PERCENT_RANGE", "Discount percent must be between 0 and 100");
    }
    documentDiscount = roundAmount(pct(netTotal, percent)).plus(roundAmount(dec(input.documentDiscount.amount ?? 0)));
    if (documentDiscount.gt(netTotal)) {
      throw new ValidationError("DISCOUNT_EXCEEDS_AMOUNT", "Discount is more than the invoice amount", {
        discount: documentDiscount.toFixed(2),
        amount: netTotal.toFixed(2),
      });
    }
  }
  const shares = documentDiscount.isZero()
    ? nets.map(() => ZERO)
    : apportion(
        documentDiscount,
        nets.map((n) => (n.isNegative() ? ZERO : n)),
      );

  const lines: LineResult[] = input.lines.map((line, i) => {
    const share = shares[i] ?? ZERO;
    const result = calculateTaxLine({ ...line, apportionedDiscount: share }, { supplyType, chargeTax, withoutPayment });
    return {
      ...result,
      key: line.key,
      hsnCode: line.hsnCode ?? null,
      uqc: line.uqc ?? null,
      lineDiscount: result.discount.minus(share),
      documentDiscountShare: share,
    };
  });

  const charges: ChargeResult[] = (input.charges ?? []).map((charge) => {
    const amount = roundAmount(charge.amount);
    if (amount.isNegative()) throw new ValidationError("CHARGE_NEGATIVE", "Charge amount cannot be negative");
    if (!charge.tax || amount.isZero()) {
      return { key: charge.key, label: charge.label, taxable: amount, cgst: ZERO, sgst: ZERO, igst: ZERO, cess: ZERO, gstRate: ZERO, total: amount };
    }
    const r = calculateTaxLine({ qty: 1, rate: amount, tax: charge.tax }, { supplyType, chargeTax, withoutPayment });
    return { key: charge.key, label: charge.label, taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, cess: r.cess, gstRate: r.gstRate, total: r.total };
  });

  const taxedCharges = charges.filter((c) => c.gstRate.gt(0));
  const cgstTotal = sum([...lines.map((l) => l.cgst), ...charges.map((c) => c.cgst)]);
  const sgstTotal = sum([...lines.map((l) => l.sgst), ...charges.map((c) => c.sgst)]);
  const igstTotal = sum([...lines.map((l) => l.igst), ...charges.map((c) => c.igst)]);
  const cessTotal = sum([...lines.map((l) => l.cess), ...charges.map((c) => c.cess)]);
  const taxTotal = cgstTotal.plus(sgstTotal).plus(igstTotal).plus(cessTotal);
  const lineTaxable = sum(lines.map((l) => l.taxable));
  const taxedChargeTaxable = sum(taxedCharges.map((c) => c.taxable));
  const chargesTotal = sum(charges.map((c) => c.taxable));
  const totalBeforeRoundOff = lineTaxable.plus(chargesTotal).plus(taxTotal);
  const { rounded, roundOff } = applyRoundOff(totalBeforeRoundOff, input.roundOff ?? DEFAULT_ROUND_OFF);

  const amountPaid = roundAmount(input.amountPaid ?? 0);
  if (amountPaid.isNegative()) throw new ValidationError("PAID_NEGATIVE", "Amount paid cannot be negative");
  const balanceDue = rounded.minus(amountPaid);

  return {
    lines,
    charges,
    lineCount: lines.length,
    totalQty: sum(lines.map((l) => l.qty)),
    grossTotal: sum(lines.map((l) => l.gross)),
    discountTotal: sum(lines.map((l) => l.discount)),
    taxableTotal: lineTaxable.plus(taxedChargeTaxable),
    cgstTotal,
    sgstTotal,
    igstTotal,
    cessTotal,
    taxTotal,
    chargesTotal,
    totalBeforeRoundOff,
    roundOff,
    grandTotal: rounded,
    amountPaid,
    balanceDue: balanceDue.isNegative() ? ZERO : balanceDue,
    excessPaid: balanceDue.isNegative() ? balanceDue.negated() : ZERO,
    paymentStatus: paymentStatusFor(rounded, amountPaid),
    rateBreakup: buildRateBreakup(lines, taxedCharges),
    hsnSummary: buildHsnSummary(lines),
  };
}

function buildRateBreakup(lines: readonly LineResult[], charges: readonly ChargeResult[]): RateBreakup[] {
  const map = new Map<string, RateBreakup>();
  const add = (gstRate: Dec, taxable: Dec, cgst: Dec, sgst: Dec, igst: Dec, cess: Dec) => {
    const k = gstRate.toFixed(3);
    const row = map.get(k) ?? { gstRate, taxable: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, cess: ZERO };
    map.set(k, {
      gstRate,
      taxable: row.taxable.plus(taxable),
      cgst: row.cgst.plus(cgst),
      sgst: row.sgst.plus(sgst),
      igst: row.igst.plus(igst),
      cess: row.cess.plus(cess),
    });
  };
  for (const l of lines) add(l.gstRate, l.taxable, l.cgst, l.sgst, l.igst, l.cess);
  for (const c of charges) add(c.gstRate, c.taxable, c.cgst, c.sgst, c.igst, c.cess);
  return [...map.values()].sort((a, b) => a.gstRate.comparedTo(b.gstRate));
}

function buildHsnSummary(lines: readonly LineResult[]): HsnSummaryRow[] {
  const map = new Map<string, HsnSummaryRow>();
  for (const l of lines) {
    const hsn = l.hsnCode ?? "";
    const k = `${hsn}|${l.uqc ?? ""}|${l.gstRate.toFixed(3)}`;
    const row = map.get(k) ?? {
      hsnCode: hsn,
      uqc: l.uqc,
      gstRate: l.gstRate,
      qty: ZERO,
      taxable: ZERO,
      cgst: ZERO,
      sgst: ZERO,
      igst: ZERO,
      cess: ZERO,
      total: ZERO,
    };
    map.set(k, {
      ...row,
      qty: row.qty.plus(l.qtyBase),
      taxable: row.taxable.plus(l.taxable),
      cgst: row.cgst.plus(l.cgst),
      sgst: row.sgst.plus(l.sgst),
      igst: row.igst.plus(l.igst),
      cess: row.cess.plus(l.cess),
      total: row.total.plus(l.total),
    });
  }
  return [...map.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.gstRate.comparedTo(b.gstRate));
}

export interface TotalsMismatch {
  field: string;
  expected: string;
  received: string;
}

/**
 * Server-side guard: compare totals a client submitted (possibly computed offline)
 * against a fresh server calculation. Any difference rejects the save.
 */
export function compareTotals(
  expected: DocumentTotals,
  received: Partial<Record<"taxableTotal" | "taxTotal" | "roundOff" | "grandTotal", DecimalInput>>,
): TotalsMismatch[] {
  const mismatches: TotalsMismatch[] = [];
  for (const field of ["taxableTotal", "taxTotal", "roundOff", "grandTotal"] as const) {
    const value = received[field];
    if (value === undefined) continue;
    if (!roundAmount(value).eq(expected[field])) {
      mismatches.push({ field, expected: expected[field].toFixed(2), received: roundAmount(value).toFixed(2) });
    }
  }
  return mismatches;
}
