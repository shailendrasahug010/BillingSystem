import { useSyncExternalStore } from "react";

/**
 * Installing the web app (Chrome / Edge on Windows, Mac, Linux and Android
 * offer it; iPhone uses Safari's Share -> Add to Home Screen) and picking up
 * a new version. The service worker is only registered in production builds.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installEvent: InstallPromptEvent | null = null;
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setupPwa(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    emit();
  });
  if (!import.meta.env.PROD || import.meta.env.MODE === "singlefile" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const track = (w: ServiceWorker | null) => {
          if (!w) return;
          const check = () => {
            // "installed" with a page already controlled = an update waiting for the user.
            if (w.state === "installed" && navigator.serviceWorker.controller) {
              waiting = w;
              emit();
            }
          };
          check();
          w.addEventListener("statechange", check);
        };
        track(reg.waiting);
        reg.addEventListener("updatefound", () => track(reg.installing));
        // Look for a new version when the app comes back to the front.
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void reg.update().catch(() => undefined));
      })
      .catch(() => undefined);
  });
}

/** True while the browser offers to install the app. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribe, () => installEvent !== null, () => false);
}

export async function installApp(): Promise<void> {
  const e = installEvent;
  if (!e) return;
  await e.prompt();
  await e.userChoice.catch(() => undefined);
  installEvent = null;
  emit();
}

/** True when a new version is downloaded and waiting. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribe, () => waiting !== null, () => false);
}

/** Switch to the waiting version and reload once it has taken over. */
export function applyUpdate(): void {
  const w = waiting;
  if (!w) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  w.postMessage("SKIP_WAITING");
}
