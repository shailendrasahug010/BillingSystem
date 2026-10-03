import { createTranslator, type LocaleCode } from "@digitalbahi/i18n";
import { api } from "../lib/api";
import { nativePlugin } from "./native";

/**
 * Push notifications in the Android app (Firebase Cloud Messaging through
 * Capacitor's plugin). Once signed in to a business the phone asks to show
 * notifications, registers its token with the server for that business, and
 * a tapped notification opens its record. Signing out removes the token.
 */

interface Listener {
  remove(): Promise<void>;
}
type PushData = { notificationId?: string; businessId?: string; type?: string; entityType?: string; entityId?: string };
interface PushPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  createChannel(c: { id: string; name: string; description?: string; importance?: 1 | 2 | 3 | 4 | 5; visibility?: -1 | 0 | 1; vibration?: boolean }): Promise<void>;
  addListener(event: "registration", cb: (t: { value: string }) => void): Promise<Listener>;
  addListener(event: "pushNotificationActionPerformed", cb: (a: { notification: { data?: PushData } }) => void): Promise<Listener>;
  removeAllListeners(): Promise<void>;
}
interface BahiApp {
  config(): Promise<{ push: boolean; version: string }>;
}

let token: string | null = null;
let registeredFor: string | null = null;

/** Registers this phone for the person's notifications in a business; `onOpen` gets a tapped notification. */
export async function startPush(businessId: string, locale: LocaleCode, onOpen: (data: PushData) => void): Promise<void> {
  const push = nativePlugin<PushPlugin>("PushNotifications");
  // Without the business's Firebase project in this build, asking for a token would stop the app.
  const built = await nativePlugin<BahiApp>("BahiApp")
    ?.config()
    .catch(() => null);
  if (!push || !built?.push || registeredFor === businessId) return;
  registeredFor = businessId;
  const { t } = createTranslator(locale);
  await push.removeAllListeners();
  // What needs action now (payments due, orders waiting) and the rest; private on the lock screen.
  await push.createChannel({ id: "alerts", name: t("push.channels.alerts"), description: t("push.channels.alertsHint"), importance: 4, visibility: 0, vibration: true }).catch(() => undefined);
  await push.createChannel({ id: "updates", name: t("push.channels.updates"), description: t("push.channels.updatesHint"), importance: 3, visibility: 0 }).catch(() => undefined);
  await push.addListener("registration", ({ value }) => {
    token = value;
    void api.post("/push/tokens", { token: value, platform: "android", locale }).catch(() => undefined);
  });
  await push.addListener("pushNotificationActionPerformed", ({ notification }) => onOpen(notification.data ?? {}));
  let permission = await push.checkPermissions();
  if (permission.receive.startsWith("prompt")) permission = await push.requestPermissions();
  if (permission.receive !== "granted") return;
  await push.register().catch(() => undefined);
}

/** Before signing out: this phone no longer gets the person's notifications. */
export async function stopPush(): Promise<void> {
  const push = nativePlugin<PushPlugin>("PushNotifications");
  const was = token;
  token = null;
  registeredFor = null;
  if (!push) return;
  if (was) await api.delete("/push/tokens", { token: was }).catch(() => undefined);
  await push.removeAllListeners().catch(() => undefined);
  await push.unregister().catch(() => undefined);
}
