import { useEffect } from "react";
import { useI18n } from "../app/i18n";
import { useToast } from "../components/ui/Toast";
import { LIVE } from "../data/source";

/** Below this much free room, work kept on the device (bills waiting to send) may fail to save. */
const LOW_BYTES = 50 * 1024 * 1024;
const WARNED = "digitalbahi.lowSpaceWarned";

/**
 * Asks the browser to keep this app's saved data even when the device runs
 * short of room. Without it, Chrome and Safari may clear a site's data under
 * storage pressure, and with it bills that have not reached the server yet.
 * Chrome grants it quietly for an installed or often-used app; Firefox may ask.
 */
export async function keepDataOnDevice(): Promise<boolean> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persist) return false;
  try {
    return (await storage.persisted()) || (await storage.persist());
  } catch {
    return false;
  }
}

/** Whether the device is nearly out of room for this app's data (unknown counts as fine). */
export async function lowOnSpace(): Promise<boolean> {
  try {
    const { quota, usage } = (await navigator.storage?.estimate?.()) ?? {};
    return quota !== undefined && usage !== undefined && quota - usage < LOW_BYTES;
  } catch {
    return false;
  }
}

/** Once the app is open: ask to keep its data, and warn (at most once a day) when room runs low. */
export function useDeviceStorage(): void {
  const { t } = useI18n();
  const toast = useToast();
  useEffect(() => {
    if (!LIVE) return;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 3000));
    idle(() => {
      void keepDataOnDevice();
      void lowOnSpace().then((low) => {
        if (!low) return;
        const today = new Date().toISOString().slice(0, 10);
        try {
          if (localStorage.getItem(WARNED) === today) return;
          localStorage.setItem(WARNED, today);
        } catch {
          // Storage blocked: warn anyway.
        }
        toast({ tone: "danger", title: t("offline.lowSpace.title"), body: t("offline.lowSpace.body") });
      });
    });
    // Once per app start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
