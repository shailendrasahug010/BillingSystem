import { formatCurrency, formatDate, formatNumber, formatPercent } from "./format.js";
import { CATALOGS, DEFAULT_LOCALE, localeInfo, type Catalog, type LocaleCode } from "./registry.js";

/**
 * A small, dependency-free translator. The JSON follows i18next conventions
 * ({{name}} interpolation, _zero/_one/_other plural suffixes, {{value, currency}}
 * formatting) so the catalogues can be moved to i18next/ICU tooling later
 * without rewriting them.
 *
 * Keys are type-checked: t("invoice.grandTotal") compiles, t("invoice.grandTotl") does not.
 */
type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
type StripPlural<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K;

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? StripPlural<`${Prefix}${K}`> : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = Leaves<Catalog>;

export type TranslationParams = Record<string, string | number | null | undefined>;

export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

function lookup(catalog: unknown, path: string): string | undefined {
  let node: unknown = catalog;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,\s*(\w+))?\s*\}\}/g;

export function interpolate(template: string, params: TranslationParams, locale: LocaleCode): string {
  return template.replace(PLACEHOLDER, (match, name: string, format?: string) => {
    const value = params[name];
    if (value === undefined || value === null) return match;
    switch (format) {
      case "currency":
        return formatCurrency(value, locale);
      case "number":
        return formatNumber(value, locale);
      case "percent":
        return formatPercent(value, locale);
      case "date":
        return formatDate(String(value));
      default:
        return String(value);
    }
  });
}

export interface Translator {
  locale: LocaleCode;
  t: Translate;
  /** True if the key exists in the active locale (after plural resolution). */
  has(key: string): boolean;
}

export function createTranslator(locale: LocaleCode = DEFAULT_LOCALE): Translator {
  const catalog = CATALOGS[locale];
  const fallback = CATALOGS[DEFAULT_LOCALE];
  const plural = new Intl.PluralRules(localeInfo(locale).intl);

  const resolve = (key: string, params?: TranslationParams): string | undefined => {
    const count = params?.count;
    if (typeof count === "number") {
      const category = plural.select(count);
      // "_zero" for exactly nothing ("today" rather than "0 days ago"), in any language.
      const zero = count === 0 ? (lookup(catalog, `${key}_zero`) ?? lookup(fallback, `${key}_zero`)) : undefined;
      const found =
        zero ??
        lookup(catalog, `${key}_${category}`) ??
        lookup(catalog, `${key}_other`) ??
        lookup(fallback, `${key}_${category}`) ??
        lookup(fallback, `${key}_other`);
      if (found) return found;
    }
    return lookup(catalog, key) ?? lookup(fallback, key);
  };

  return {
    locale,
    t: (key, params = {}) => {
      const template = resolve(key, params);
      // A missing key shows the key itself: visible in QA, never a blank label.
      return template === undefined ? key : interpolate(template, params, locale);
    },
    has: (key) => resolve(key) !== undefined || resolve(key, { count: 2 }) !== undefined,
  };
}

/** Translate a DomainError-like object ({ code, params }) from @digitalbahi/core. */
export function translateError(
  translator: Translator,
  error: { code?: string; params?: TranslationParams } | null | undefined,
): string {
  const key = error?.code ? `errors.${error.code}` : "errors.generic";
  if (!translator.has(key)) return translator.t("errors.generic");
  return translator.t(key as TranslationKey, error?.params ?? {});
}
