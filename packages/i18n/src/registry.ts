import en from "./locales/en.json" with { type: "json" };

/**
 * Supported languages. Adding a language (Marathi, Gujarati, Tamil...) means:
 *   1. add `locales/<code>.json` (the parity test lists every missing key),
 *   2. add an entry here,
 *   3. optionally register number words for invoices in @digitalbahi/core.
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

/**
 * The catalogues, by language. English is always here; the others are added
 * by `loadCatalog` (the web app fetches one only when it is chosen) or, on the
 * server, all at once by the package entry. Until then a language reads English.
 */
export const CATALOGS: Record<LocaleCode, Catalog> = { en, hi: en };
const loaded = new Set<LocaleCode>(["en"]);

export function registerCatalog(code: LocaleCode, catalog: Catalog): void {
  CATALOGS[code] = catalog;
  loaded.add(code);
}

export function isCatalogLoaded(code: LocaleCode): boolean {
  return loaded.has(code);
}

type Loader = () => Promise<{ default: unknown }>;
let loaders: Partial<Record<LocaleCode, Loader>> = {};

/** How each language's catalogue is fetched (the browser entry sets this; the server has them all). */
export function setCatalogLoaders(next: Partial<Record<LocaleCode, Loader>>): void {
  loaders = next;
}

/** Fetches a language's catalogue (once); resolves when `t` speaks it. */
export async function loadCatalog(code: LocaleCode): Promise<void> {
  if (loaded.has(code)) return;
  const load = loaders[code];
  if (!load) throw new Error(`no catalogue for ${code}`);
  registerCatalog(code, (await load()).default as Catalog);
}

export function isLocaleCode(value: string | null | undefined): value is LocaleCode {
  return LOCALES.some((l) => l.code === value);
}

export function localeInfo(code: LocaleCode): LocaleInfo {
  return LOCALES.find((l) => l.code === code)!;
}
