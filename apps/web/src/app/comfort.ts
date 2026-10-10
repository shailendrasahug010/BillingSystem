import { useSyncExternalStore } from "react";

/**
 * Easier use on this device (the "Aa" button in the top bar):
 * - text size: the whole app a size or two bigger, for older eyes and small phones;
 * - simple menu: only the everyday screens, per person (a counter PC is
 *   shared), with "Show full menu" a click away and search still finding everything;
 * - less motion: screens, rows and figures appear at once instead of sliding and counting
 *   up, for whoever finds the movement tiring (the device's own "reduce motion" does the same).
 */
export type TextSize = "normal" | "large" | "larger";
export const TEXT_SIZES: Array<{ key: TextSize; label: string; zoom: number }> = [
  { key: "normal", label: "A", zoom: 1 },
  { key: "large", label: "A+", zoom: 1.12 },
  { key: "larger", label: "A++", zoom: 1.25 },
];

const SIZE_KEY = "digitalbahi.textSize";
const SIMPLE_KEY = "digitalbahi.simpleMenu";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A private window: kept until the page closes.
  }
}

export function readTextSize(): TextSize {
  const v = read(SIZE_KEY);
  return TEXT_SIZES.some((s) => s.key === v) ? (v as TextSize) : "normal";
}

/**
 * Scales everything (the screens are laid out in pixels), as the browser's own zoom does.
 * A zoom scales vh and dvh too, so --app-zoom lets heights tied to the screen (the side menu,
 * dialogs, long tables) divide it back out and still fit (app.css, --app-vh).
 */
export function applyTextSize(size: TextSize): void {
  const zoom = TEXT_SIZES.find((s) => s.key === size)!.zoom;
  const root = document.documentElement;
  root.style.zoom = zoom === 1 ? "" : String(zoom);
  if (zoom === 1) root.style.removeProperty("--app-zoom");
  else root.style.setProperty("--app-zoom", String(zoom));
  write(SIZE_KEY, size === "normal" ? null : size);
  changed();
}

/** Before the first paint, with the theme. */
export function initTextSize(): void {
  applyTextSize(readTextSize());
  applyLessMotion(readLessMotion());
}

const MOTION_KEY = "digitalbahi.lessMotion";
export const readLessMotion = () => read(MOTION_KEY) === "1";

/** Less motion on this device: animations end at once (app.css, :root[data-motion="less"]). */
export function applyLessMotion(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-motion", "less");
  else document.documentElement.removeAttribute("data-motion");
  write(MOTION_KEY, on ? "1" : null);
  changed();
}

/** Whether movement should be kept to a minimum: the device asks for it, or the Aa sheet does. */
export function prefersLessMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-motion") === "less") return true;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const simpleKey = (userId: string | null | undefined) => `${SIMPLE_KEY}.${userId ?? "demo"}`;
export const readSimpleMenu = (userId: string | null | undefined) => read(simpleKey(userId)) === "1";
export function setSimpleMenu(userId: string | null | undefined, on: boolean): void {
  write(simpleKey(userId), on ? "1" : null);
  changed();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useTextSize = () => useSyncExternalStore(subscribe, readTextSize, readTextSize);
export const useLessMotion = () => useSyncExternalStore(subscribe, readLessMotion, readLessMotion);
export function useSimpleMenu(userId: string | null | undefined): boolean {
  const get = () => readSimpleMenu(userId);
  return useSyncExternalStore(subscribe, get, get);
}
