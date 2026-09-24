import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts. Bindings use `event.code` (physical key) so they work
 * with Hindi/other keyboard layouts and on macOS where Alt+letter types a
 * symbol. Browser-reserved combos are avoided: Ctrl+P (print) and Ctrl+C
 * (copy) stay with the browser; Purchase and Collection use Alt+P / Alt+C.
 * Tally-style F-keys are offered as an alternative preset for accountants.
 */
export interface Shortcut {
  id: string;
  /** e.g. "mod+k", "alt+p", "f2", "escape", "mod+enter" (mod = Ctrl, or Cmd on macOS). */
  keys: string;
  /** Allow while typing in an input (for save / escape style shortcuts). */
  allowInInputs?: boolean;
  handler: (event: KeyboardEvent) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function matches(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split("+");
  const key = parts.at(-1)!;
  const want = { mod: parts.includes("mod"), alt: parts.includes("alt"), shift: parts.includes("shift") };
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (want.mod !== mod || want.alt !== event.altKey || want.shift !== event.shiftKey) return false;
  const code = event.code.toLowerCase();
  if (/^[a-z]$/.test(key)) return code === `key${key}`;
  if (/^[0-9]$/.test(key)) return code === `digit${key}` || code === `numpad${key}`;
  if (key === "enter") return code === "enter" || code === "numpadenter";
  if (key === "/") return code === "slash";
  if (key === "?") return code === "slash" && event.shiftKey;
  return code === key || event.key.toLowerCase() === key;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function useShortcuts(shortcuts: Shortcut[], enabled = true): void {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      for (const s of ref.current) {
        if (!matches(event, s.keys)) continue;
        if (isTyping(event.target) && !s.allowInInputs) continue;
        event.preventDefault();
        s.handler(event);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Label for display, e.g. "Ctrl K" / "⌘ K". */
export function shortcutLabel(keys: string): string[] {
  return keys.split("+").map((k) => {
    switch (k) {
      case "mod":
        return isMac ? "⌘" : "Ctrl";
      case "alt":
        return isMac ? "⌥" : "Alt";
      case "shift":
        return "⇧";
      case "enter":
        return "Enter";
      case "escape":
        return "Esc";
      default:
        return k.toUpperCase();
    }
  });
}

export const GLOBAL_SHORTCUTS = {
  search: "mod+k",
  newInvoice: "mod+i",
  newOrder: "alt+o",
  purchase: "alt+p",
  collection: "alt+c",
  help: "?",
} as const;

export const INVOICE_SHORTCUTS = {
  focusProduct: "f2",
  focusCustomer: "f3",
  save: "mod+enter",
} as const;
