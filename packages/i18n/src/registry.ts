import en from "./locales/en.json" with { type: "json" };
import hi from "./locales/hi.json" with { type: "json" };

/**
 * Supported languages. Adding a language (Marathi, Gujarati, Tamil...) means:
 *   1. add `locales/<code>.json` (the parity test lists every missing key),
 *   2. add an entry here,
 *   3. optionally register number words for invoices in @vyapaar/core.
 * No component code changes.
 */
export interface LocaleInfo {
  code: string;
  /** Name shown in the language switcher, in the language itself. */
  nativeName: string;
  englishName: string;
  /** BCP-47 tag used for Intl number/date formatting. */
  intl: string;
  dir: "ltr" | "rtl";
  /** Scripts with tall ascenders/descenders (Devanagari matras) need more line height. */
  lineHeight: number;
}

export const LOCALES = [
  { code: "en", nativeName: "English", englishName: "English", intl: "en-IN", dir: "ltr", lineHeight: 1.5 },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi", intl: "hi-IN", dir: "ltr", lineHeight: 1.65 },
] as const satisfies readonly LocaleInfo[];

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALE: LocaleCode = "en";

/** English is the source catalogue; every other catalogue must have the same keys. */
export type Catalog = typeof en;

export const CATALOGS: Record<LocaleCode, Catalog> = { en, hi };

export function isLocaleCode(value: string | null | undefined): value is LocaleCode {
  return LOCALES.some((l) => l.code === value);
}

export function localeInfo(code: LocaleCode): LocaleInfo {
  return LOCALES.find((l) => l.code === code)!;
}
