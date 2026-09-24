import { localeInfo, type LocaleCode } from "./registry.js";

/**
 * Indian formatting: lakh/crore digit grouping (₹12,34,567.00), dd/mm/yyyy dates.
 * Amounts arrive as strings or decimals from the API and are formatted, never
 * re-calculated, here.
 */
type NumericLike = string | number | { toString(): string };

function toNumber(value: NumericLike): number {
  return typeof value === "number" ? value : Number(value.toString());
}

const cache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    cache.set(key, f);
  }
  return f;
}

export function formatCurrency(value: NumericLike, locale: LocaleCode = "en", opts: { decimals?: 0 | 2 } = {}): string {
  const decimals = opts.decimals ?? 2;
  return nf(localeInfo(locale).intl, {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(toNumber(value));
}

const COMPACT_UNITS: Record<LocaleCode, { thousand: string; lakh: string; crore: string; space: string }> = {
  en: { thousand: "K", lakh: "L", crore: "Cr", space: "" },
  hi: { thousand: "हज़ार", lakh: "लाख", crore: "करोड़", space: " " },
};

/**
 * ₹56K, ₹5.9L, ₹1.2Cr (en) / ₹56 हज़ार, ₹5.9 लाख, ₹1.2 करोड़ (hi) — for KPI
 * cards and chart axes. Written by hand because Intl's en-IN compact form
 * abbreviates thousands as "T", which Indian business users do not use.
 */
export function formatCurrencyCompact(value: NumericLike, locale: LocaleCode = "en"): string {
  const n = toNumber(value);
  const abs = Math.abs(n);
  if (abs < 1000) return formatCurrency(n, locale, { decimals: 0 });
  const units = COMPACT_UNITS[locale] ?? COMPACT_UNITS.en;
  const [div, unit] = abs >= 1e7 ? [1e7, units.crore] : abs >= 1e5 ? [1e5, units.lakh] : [1e3, units.thousand];
  const scaled = n / div;
  const digits = Math.abs(scaled) >= 100 ? 0 : 1;
  const num = nf(localeInfo(locale).intl, { maximumFractionDigits: digits }).format(scaled);
  return `₹${num}${units.space}${unit}`;
}

export function formatNumber(value: NumericLike, locale: LocaleCode = "en", maxDecimals = 3): string {
  return nf(localeInfo(locale).intl, { maximumFractionDigits: maxDecimals }).format(toNumber(value));
}

/** 12,34,567.50 — fixed two decimals, no symbol: amount columns on invoices and statements. */
export function formatAmount(value: NumericLike, locale: LocaleCode = "en"): string {
  return nf(localeInfo(locale).intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(toNumber(value));
}

export function formatPercent(value: NumericLike, locale: LocaleCode = "en", maxDecimals = 2): string {
  return `${nf(localeInfo(locale).intl, { maximumFractionDigits: maxDecimals }).format(toNumber(value))}%`;
}

/** 24/09/2026 — the format Indian users expect on screens and invoices. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

/** 24 Sep 2026 / 24 सित॰ 2026 */
export function formatDateMedium(iso: string, locale: LocaleCode = "en"): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat(localeInfo(locale).intl, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatMonthShort(iso: string, locale: LocaleCode = "en"): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat(localeInfo(locale).intl, { month: "short", timeZone: "UTC" }).format(date);
}

export function formatWeekdayShort(iso: string, locale: LocaleCode = "en"): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat(localeInfo(locale).intl, { weekday: "short", timeZone: "UTC" }).format(date);
}
