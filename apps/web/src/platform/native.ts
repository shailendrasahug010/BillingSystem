import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Running inside the Android app (Capacitor): the app's bridge reaches its
 * native plugins (Bluetooth printing, the barcode scanner, the share sheet,
 * printing, secure storage, push). In a browser there is none and every
 * caller falls back to what the browser can do.
 */
export const isNative = () => Capacitor.isNativePlatform();

const plugins = new Map<string, unknown>();

/** A native plugin by name, in the app; null in a browser, or when this build of the app lacks it. */
export function nativePlugin<T>(name: string): T | null {
  if (!isNative() || !Capacitor.isPluginAvailable(name)) return null;
  if (!plugins.has(name)) plugins.set(name, registerPlugin(name));
  return plugins.get(name) as T;
}
