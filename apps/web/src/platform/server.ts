import { isNative } from "./native";

/**
 * The business's server the Android app talks to. The app carries the
 * screens; each business runs its own server, so its address is asked for
 * on first start and kept on the phone. In a browser the server is the site
 * itself ("").
 */
const KEY = "digitalbahi.server";
const listeners = new Set<() => void>();

export function serverOrigin(): string {
  if (!isNative()) return "";
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setServerOrigin(origin: string | null): void {
  try {
    if (origin) localStorage.setItem(KEY, origin);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: asked again next start.
  }
  listeners.forEach((l) => l());
}

export function onServerChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The app needs a server address before anything else. */
export const needsServer = () => isNative() && !serverOrigin();

export type ServerProblem = "invalid" | "insecure" | "unreachable" | "not_digitalbahi";

/**
 * What a person typed ("shop.example.in", "https://shop.example.in/app/")
 * as a server origin, checked by asking the server for its health. Only
 * https: the app's pages are secure, and so must the server be.
 */
export async function checkServer(input: string): Promise<{ origin: string } | { problem: ServerProblem }> {
  const typed = input.trim();
  if (!typed) return { problem: "invalid" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { problem: "invalid" };
  }
  if (url.protocol !== "https:") return { problem: "insecure" };
  const origin = url.origin;
  try {
    const res = await fetch(`${origin}/api/v1/health`, { headers: { "x-client": "native" }, credentials: "omit" });
    const body = (await res.json().catch(() => null)) as { status?: string; app?: string } | null;
    if (!res.ok || body?.app !== "digitalbahi") return { problem: "not_digitalbahi" };
  } catch {
    return { problem: "unreachable" };
  }
  return { origin };
}
