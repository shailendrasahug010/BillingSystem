import {
  createTranslator,
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
  formatDateMedium,
  formatNumber,
  isLocaleCode,
  localeInfo,
  type LocaleCode,
  type Translator,
} from "@vyapaar/i18n";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface I18nValue extends Translator {
  setLocale(locale: LocaleCode): void;
  money(value: number | string, decimals?: 0 | 2): string;
  compact(value: number | string): string;
  number(value: number | string, decimals?: number): string;
  date(iso: string): string;
  dateMedium(iso: string): string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = "vyapaar.locale";

function initialLocale(): LocaleCode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocaleCode(stored)) return stored;
  } catch {
    /* storage unavailable: fall back to default */
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeInfo(locale).dir;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
  }, [locale]);

  const value = useMemo<I18nValue>(() => {
    const translator = createTranslator(locale);
    return {
      ...translator,
      setLocale: setLocaleState,
      money: (v, decimals = 2) => formatCurrency(v, locale, { decimals }),
      compact: (v) => formatCurrencyCompact(v, locale),
      number: (v, decimals = 3) => formatNumber(v, locale, decimals),
      date: (iso) => formatDate(iso),
      dateMedium: (iso) => formatDateMedium(iso, locale),
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
