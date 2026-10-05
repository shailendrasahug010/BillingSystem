/**
 * A short buzz on phones (the Android app and mobile browsers); nothing where
 * the device has no vibration.
 */
export function buzz(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Not allowed here (no tap on the page yet): no buzz.
  }
}

/** A bill saved: two quick pulses. */
export const SAVED = [30, 60, 30];
/** A code read by the scanner: one short pulse. */
export const SCANNED = 40;
