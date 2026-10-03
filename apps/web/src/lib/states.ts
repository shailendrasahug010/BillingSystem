import { findState, GST_STATES, type GstState } from "@digitalbahi/core";

/** A state's name in the app's language, without its GST code ("Madhya Pradesh"). */
export function stateName(code: string | null | undefined, locale: string): string {
  const s = findState(code);
  return s ? (locale === "hi" ? s.nameHi : s.name) : (code ?? "");
}

/**
 * States and UTs for a dropdown, by name: current codes only, and without the
 * "Foreign Country" / "Other Territory" entries unless asked for.
 */
export function stateOptions(locale: string, { special = true }: { special?: boolean } = {}): Array<{ code: string; name: string }> {
  const name = (s: GstState) => (locale === "hi" ? s.nameHi : s.name);
  return GST_STATES.filter((s) => !s.legacy && (special || s.kind !== "special"))
    .map((s) => ({ code: s.code, name: name(s) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale === "hi" ? "hi" : "en"));
}
