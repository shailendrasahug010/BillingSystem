import { dec, type Dec, type DecimalInput, pct, roundAmount, ZERO } from "../money/decimal.js";
import { panFromGstin } from "../validation/identifiers.js";

/**
 * Income-tax deducted at source on trade. From 1 April 2026 the Income-tax
 * Act, 2025 has every TDS in section 393 (TDS on buying goods is 393(1),
 * table item 8(ii)); papers and people still use the 1961 Act's numbers
 * (194Q), so both are shown. A tax year runs April to March.
 */

/** What the tax was deducted on: buying goods (old 194Q), contract work (194C), commission (194H), professional fees (194J), rent (194I), anything else. */
export type TdsSection = "goods" | "contract" | "commission" | "professional" | "rent" | "other";
export const TDS_SECTIONS: readonly TdsSection[] = ["goods", "contract", "commission", "professional", "rent", "other"];

/** The 1961 Act's section number of each (what customers' payment advices and Form 26AS of past years say). */
export const TDS_OLD_SECTION: Record<TdsSection, string | null> = {
  goods: "194Q",
  contract: "194C",
  commission: "194H",
  professional: "194J",
  rent: "194I",
  other: null,
};

/** "TDS 194Q" for a ledger line or a receipt (the 1961 Act's number people know); "TDS" alone for "other". */
export function tdsLabel(section: string | null | undefined): string {
  const old = section && section in TDS_OLD_SECTION ? TDS_OLD_SECTION[section as TdsSection] : null;
  return old ? `TDS ${old}` : "TDS";
}

export interface PurchaseTdsRule {
  /** Percent, with the seller's PAN. */
  rate: DecimalInput;
  /** Percent, without it. */
  noPanRate: DecimalInput;
  /** The year's purchases from one seller that are free of it. */
  threshold: DecimalInput;
}

/** 0.1% on what a year's purchases from one seller pass ₹50 lakh by; 5% when the seller has no PAN. */
export const PURCHASE_TDS: PurchaseTdsRule = { rate: "0.1", noPanRate: "5", threshold: "5000000" };

export interface PurchaseTds {
  /** The part of the bill's value the tax is on (what takes the year past the threshold). */
  base: Dec;
  /** Percent applied. */
  rate: Dec;
  /** The tax, to the rupee. */
  amount: Dec;
}

/**
 * TDS a buyer deducts on a purchase bill (393(1), old 194Q): on the part of
 * the bill's value before GST that takes the tax year's purchases from the
 * seller past the threshold. ₹45 lakh bought before and a ₹10 lakh bill:
 * ₹5 lakh is over, ₹500 at 0.1%. Rounded to the rupee.
 */
export function purchaseTds(input: { boughtBefore: DecimalInput; billValue: DecimalInput; hasPan: boolean }, rule: PurchaseTdsRule = PURCHASE_TDS): PurchaseTds {
  const before = dec(input.boughtBefore);
  const value = dec(input.billValue);
  const threshold = dec(rule.threshold);
  const over = (x: Dec) => (x.gt(threshold) ? x.minus(threshold) : ZERO);
  const base = value.gt(0) ? over(before.plus(value)).minus(over(before.gt(0) ? before : ZERO)) : ZERO;
  const rate = dec(input.hasPan ? rule.rate : rule.noPanRate);
  return { base: roundAmount(base), rate, amount: pct(base, rate).toDecimalPlaces(0) };
}

/** A party's PAN: as entered, else the one inside its GSTIN; null when neither gives a well-formed one. */
export function partyPan(p: { pan?: string | null; gstin?: string | null }): string | null {
  const pan = (p.pan ?? "").trim().toUpperCase() || (p.gstin && p.gstin.trim().length === 15 ? panFromGstin(p.gstin) : "");
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The tax year (April to March) a date falls in, as "2026-27", with its first and last day. */
export function taxYearOf(date: string): { label: string; from: string; to: string } {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return { label: `${start}-${pad((start + 1) % 100)}`, from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** The quarter of the tax year a date falls in (Q1 April–June … Q4 January–March): the TDS return's period. */
export function taxQuarterOf(date: string): { quarter: 1 | 2 | 3 | 4; year: string; from: string; to: string } {
  const m = Number(date.slice(5, 7));
  const year = taxYearOf(date);
  const quarter = (m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4) as 1 | 2 | 3 | 4;
  const startMonth = [4, 7, 10, 1][quarter - 1]!;
  const y = quarter === 4 ? Number(year.to.slice(0, 4)) : Number(year.from.slice(0, 4));
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return { quarter, year: year.label, from: `${y}-${pad(startMonth)}-01`, to: `${y}-${pad(endMonth)}-${pad(lastDay)}` };
}

/** TDS deducted in a month ("2026-09") is paid to the government by the 7th of the next month; March's by 30 April. */
export function tdsDueDate(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (m === 3) return `${y}-04-30`;
  return m === 12 ? `${y + 1}-01-07` : `${y}-${pad(m + 1)}-07`;
}
