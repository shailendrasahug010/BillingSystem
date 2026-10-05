import {
  createTranslator,
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
  formatDateMedium,
  formatNumber,
  isCatalogLoaded,
  isLocaleCode,
  loadCatalog,
  LOCALES,
  localeInfo,
  type LocaleCode,
  type Translator,
} from "@digitalbahi/i18n";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface I18nValue extends Translator {
  setLocale(locale: LocaleCode): void;
  money(value: number | string, decimals?: 0 | 2): string;
  compact(value: number | string): string;
  number(value: number | string, decimals?: number): string;
  date(iso: string): string;
  dateMedium(iso: string): string;
  /** A timestamp in the business time zone: "24 Sept, 10:42 am". */
  dateTime(iso: string): string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = "digitalbahi.locale";
/** Where the language was kept under the project's former working name: read until saved under the new key. */
const LEGACY_STORAGE_KEY = "vyapaar.locale";

function initialLocale(): LocaleCode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (isLocaleCode(stored)) return stored;
  } catch {
    /* storage unavailable: fall back to default */
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(initialLocale);
  // A language other than English comes in its own file: show the app once it is here.
  const [ready, setReady] = useState(() => isCatalogLoaded(locale));

  useEffect(() => {
    if (ready) return;
    loadCatalog(locale)
      .catch(() => setLocaleState("en"))
      .finally(() => setReady(true));
  }, [locale, ready]);

  // Bills can print in another language than the screen's: fetch the rest once the app is up.
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const rest = LOCALES.filter((l) => !isCatalogLoaded(l.code));
    if (!rest.length) return;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    idle(() => void Promise.all(rest.map((l) => loadCatalog(l.code).catch(() => undefined))).then(() => setExtra((n) => n + 1)));
  }, [ready]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeInfo(locale).dir;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, [locale]);

  const value = useMemo<I18nValue>(() => {
    // Made again when another catalogue arrives, so open bills in that language redraw.
    void extra;
    const translator = createTranslator(locale);
    return {
      ...translator,
      setLocale: (code) => {
        void loadCatalog(code)
          .then(() => setLocaleState(code))
          .catch(() => undefined);
      },
      money: (v, decimals = 2) => formatCurrency(v, locale, { decimals }),
      compact: (v) => formatCurrencyCompact(v, locale),
      number: (v, decimals = 3) => formatNumber(v, locale, decimals),
      date: (iso) => formatDate(iso),
      dateMedium: (iso) => formatDateMedium(iso, locale),
      dateTime: (iso) =>
        new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso)),
    };
  }, [locale, extra]);

  return <I18nContext.Provider value={value}>{ready ? children : null}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
