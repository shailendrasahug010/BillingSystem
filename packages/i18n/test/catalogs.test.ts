import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOGS,
  createTranslator,
  formatCurrency,
  formatCurrencyCompact,
  formatAmount,
  formatDate,
  LOCALES,
  translateError,
  type LocaleCode,
} from "../src/index.js";

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [ck, cv] of flatten(v, key)) out.set(ck, cv);
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]!).sort();
}

/** Keys with plural suffixes collapse to their base so languages with different plural categories compare fairly. */
function baseKeys(map: Map<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, text] of map) {
    const base = key.replace(PLURAL_SUFFIX, "");
    const set = out.get(base) ?? new Set<string>();
    for (const p of placeholders(text)) set.add(p);
    out.set(base, set);
  }
  return out;
}

const source = baseKeys(flatten(CATALOGS.en));

describe.each(LOCALES.filter((l) => l.code !== "en").map((l) => l.code as LocaleCode))("catalogue %s", (code) => {
  const target = baseKeys(flatten(CATALOGS[code]));

  it("has every English key", () => {
    const missing = [...source.keys()].filter((k) => !target.has(k));
    expect(missing).toEqual([]);
  });

  it("has no keys that English does not have", () => {
    const extra = [...target.keys()].filter((k) => !source.has(k));
    expect(extra).toEqual([]);
  });

  it("uses the same placeholders as English", () => {
    const mismatched = [...source.entries()]
      .filter(([k, set]) => target.has(k) && [...set].sort().join() !== [...target.get(k)!].sort().join())
      .map(([k]) => k);
    expect(mismatched).toEqual([]);
  });

  it("has no empty strings", () => {
    const empty = [...flatten(CATALOGS[code]).entries()].filter(([, v]) => !v.trim()).map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

describe("translator", () => {
  it("interpolates and pluralises per locale", () => {
    const en = createTranslator("en");
    const hi = createTranslator("hi");
    expect(en.t("common.items", { count: 1 })).toBe("1 item");
    expect(en.t("common.items", { count: 3 })).toBe("3 items");
    expect(hi.t("common.daysAgo", { count: 6 })).toBe("6 दिन पहले");
    expect(en.t("suggestions.reason.due", { intervalDays: 7, daysSince: 6 })).toBe(
      "Usually every 7 days · last bought 6 days ago",
    );
    expect(hi.t("suggestions.reason.due", { intervalDays: 7, daysSince: 6 })).toBe(
      "आमतौर पर हर 7 दिन में · पिछली बार 6 दिन पहले",
    );
    expect(hi.t("dashboard.actions.createInvoice")).toBe("इनवॉइस बनाएँ");
  });

  it("formats currency placeholders the Indian way", () => {
    const en = createTranslator("en");
    expect(en.t("credit.credit_limit_exceeded", { limit: "100000", excess: "12500.5" })).toBe(
      "Credit limit ₹1,00,000.00 will be exceeded by ₹12,500.50",
    );
  });

  it("translates domain errors by code", () => {
    const hi = createTranslator("hi");
    expect(
      translateError(hi, { code: "INSUFFICIENT_STOCK", params: { product: "Parle-G", available: 8, requested: 10 } }),
    ).toBe("Parle-G का केवल 8 स्टॉक है (10 चाहिए)।");
    expect(translateError(hi, { code: "SOMETHING_NEW" })).toBe(CATALOGS.hi.errors.generic);
  });
});

describe("formatting", () => {
  it("uses lakh/crore grouping", () => {
    expect(formatCurrency("1234567.5")).toBe("₹12,34,567.50");
    expect(formatCurrency(1234567.5, "hi")).toBe("₹12,34,567.50");
    expect(formatCurrencyCompact(1234567)).toBe("₹12.3L");
    expect(formatCurrencyCompact(56012)).toBe("₹56K");
    expect(formatCurrencyCompact(123456789)).toBe("₹12.3Cr");
    expect(formatCurrencyCompact(590000, "hi")).toBe("₹5.9 लाख");
    expect(formatCurrencyCompact(950)).toBe("₹950");
    expect(formatDate("2026-09-24")).toBe("24/09/2026");
    expect(formatAmount(1536)).toBe("1,536.00");
    expect(formatAmount("123456.5")).toBe("1,23,456.50");
  });
});

describe("every domain error in @digitalbahi/core is translated", () => {
  const coreSrc = join(import.meta.dirname, "../../core/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) files.push(path);
    }
  };
  walk(coreSrc);
  const codes = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:Error\(|super\()\s*"([A-Z][A-Z_]+)"/g)) codes.add(m[1]!);
  }

  it("found the error codes", () => {
    expect(codes.size).toBeGreaterThan(10);
  });

  it.each(LOCALES.map((l) => l.code as LocaleCode))("%s has a message for each code", (code) => {
    const errors = CATALOGS[code].errors as Record<string, string>;
    expect([...codes].filter((c) => !errors[c])).toEqual([]);
  });
});

describe("every API error code is translated", () => {
  const apiSrc = join(import.meta.dirname, "../../../apps/api/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) files.push(path);
    }
  };
  walk(apiSrc);
  const codes = new Set<string>();
  const pattern = /(?:ApiError\(\d+,\s*|badRequest\(|conflict\(|unauthorized\(|code(?::| =) )"([A-Z][A-Z0-9_]+)"/g;
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(pattern)) codes.add(m[1]!);
  }

  it("found the error codes", () => {
    expect(codes.size).toBeGreaterThan(30);
  });

  it.each(LOCALES.map((l) => l.code as LocaleCode))("%s has a message for each code", (code) => {
    const errors = CATALOGS[code].errors as Record<string, string>;
    expect([...codes].filter((c) => !errors[c])).toEqual([]);
  });
});
