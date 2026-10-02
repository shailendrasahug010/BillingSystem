/**
 * Running inside the Android app (Capacitor): the app puts its bridge on
 * `window.Capacitor`, with the native plugins (Bluetooth printing, the
 * barcode camera, sharing files, push). In a browser there is none and
 * every caller falls back to what the browser can do.
 */
interface CapacitorBridge {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
  Plugins?: Record<string, unknown>;
}

const bridge = () => (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;

export const isNative = () => Boolean(bridge()?.isNativePlatform?.());

/** A native plugin by name, in the app; null in a browser or when the app lacks it. */
export function nativePlugin<T>(name: string): T | null {
  if (!isNative()) return null;
  return (bridge()?.Plugins?.[name] as T | undefined) ?? null;
}
