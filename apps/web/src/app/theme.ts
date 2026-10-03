import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
/** The accent colour (Settings → Appearance); "royal" is the Digital Bahi blue. */
export type AccentChoice = "royal" | "emerald" | "violet" | "saffron" | "teal";

export const ACCENTS: Array<{ key: AccentChoice; swatch: string; swatch2: string }> = [
  { key: "royal", swatch: "#1450b4", swatch2: "#2f8cf0" },
  { key: "emerald", swatch: "#047857", swatch2: "#10b981" },
  { key: "violet", swatch: "#6d28d9", swatch2: "#a855f7" },
  { key: "saffron", swatch: "#c2410c", swatch2: "#f59e0b" },
  { key: "teal", swatch: "#0e7490", swatch2: "#06b6d4" },
];

const KEY = "digitalbahi.theme";
const ACCENT_KEY = "digitalbahi.accent";
/** Where these were kept under the project's former working name: read until saved under the new key. */
const LEGACY_KEYS: Record<string, string> = { [KEY]: "vyapaar.theme", [ACCENT_KEY]: "vyapaar.accent" };
const listeners = new Set<() => void>();

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_KEYS[key]!);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    localStorage.removeItem(LEGACY_KEYS[key]!);
  } catch {
    /* ignore */
  }
}

export function readTheme(): ThemeChoice {
  return read<ThemeChoice>(KEY, ["system", "light", "dark"], "system");
}

export function readAccent(): AccentChoice {
  return read<AccentChoice>(ACCENT_KEY, ACCENTS.map((a) => a.key), "royal");
}

/** "system" removes the attribute so prefers-color-scheme decides. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  save(KEY, choice);
  listeners.forEach((l) => l());
}

/** Royal blue is the default (no attribute); the browser bar on phones takes the colour too. */
export function applyAccent(choice: AccentChoice): void {
  const root = document.documentElement;
  if (choice === "royal") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", choice);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ACCENTS.find((a) => a.key === choice)!.swatch);
  save(ACCENT_KEY, choice);
  listeners.forEach((l) => l());
}

/** Before the first paint, so the page never flashes in the wrong colours. */
export function initAppearance(): void {
  applyTheme(readTheme());
  applyAccent(readAccent());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
let snapshot = { theme: "system" as ThemeChoice, accent: "royal" as AccentChoice };
const current = () => {
  const theme = readTheme();
  const accent = readAccent();
  if (theme !== snapshot.theme || accent !== snapshot.accent) snapshot = { theme, accent };
  return snapshot;
};

/** The theme and accent as chosen now; follows changes made anywhere in the app. */
export function useAppearance(): { theme: ThemeChoice; accent: AccentChoice } {
  return useSyncExternalStore(subscribe, current, current);
}
