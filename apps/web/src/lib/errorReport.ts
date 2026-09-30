import { ApiError, currentAccessToken } from "./api";

/**
 * Errors the app meets in the browser — a screen that crashed, a promise that
 * failed and nothing handled — are sent to the API's error log with the
 * screen the person was on, so they can be found at their source file and
 * line (the server maps the built code back with the build's private source
 * maps; the development server's code is mapped here). The person is shown a
 * reference to quote; the log has everything else.
 *
 * Not sent: API refusals and failures (the API logs its own), aborted
 * requests, and noise from browser extensions.
 */

declare const __APP_BUILD__: string;

let screen = "";
const seen = new Map<string, number>();
let sent = 0;

/** The screen the person is on, noted with each error. */
export function setErrorScreen(name: string): void {
  screen = name;
}

/** A reference for the person to quote (a UUID, as the server's). */
export function newReference(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const b = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function worthReporting(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = String((error as Error | undefined)?.message ?? error ?? "");
  if (/ResizeObserver loop|^Script error\.?$/.test(message)) return false;
  return !/(chrome|moz|safari(-web)?)-extension:/.test(String((error as Error | undefined)?.stack ?? ""));
}

async function send(e: Error, kind: "error" | "unhandledrejection" | "render", reference: string, componentStack?: string) {
  let stack = e.stack;
  let mapped = false;
  if (import.meta.env.DEV && stack) {
    try {
      stack = await (await import("./devStack")).mapDevStack(stack);
      mapped = true;
    } catch {
      // Sent as the browser gave it.
    }
  }
  const token = currentAccessToken();
  await fetch("/api/v1/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      kind,
      name: e.name.slice(0, 100),
      message: e.message.slice(0, 2000),
      ...(stack ? { stack: stack.slice(0, 16_000), mapped } : {}),
      ...(componentStack ? { componentStack: componentStack.slice(0, 8000) } : {}),
      ...(screen ? { screen: screen.slice(0, 100) } : {}),
      page: `${location.origin}${location.pathname}`.slice(0, 500),
      appVersion: typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev",
      reference,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Sends an error to the error log (at most 3 of the same, 30 a visit) and
 * returns the reference to show, or null for errors that are not faults.
 */
export function reportError(error: unknown, kind: "error" | "unhandledrejection" | "render", extra: { componentStack?: string } = {}): string | null {
  if (!worthReporting(error)) return null;
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error) ?? String(error));
  const reference = newReference();
  const key = `${e.message}\n${e.stack?.split("\n")[1] ?? ""}`;
  const count = seen.get(key) ?? 0;
  if (count < 3 && sent < 30) {
    seen.set(key, count + 1);
    sent++;
    void send(e, kind, reference, extra.componentStack);
  }
  return reference;
}

/** Catches what nothing else did: errors thrown outside React and promises nobody waited on. */
export function installErrorReporting(): void {
  window.addEventListener("error", (ev) => {
    if (ev.error || ev.message) reportError(ev.error ?? new Error(ev.message), "error");
  });
  window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason, "unhandledrejection"));
}
