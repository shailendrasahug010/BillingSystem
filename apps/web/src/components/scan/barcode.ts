import { nativePlugin } from "../../platform/native";

/**
 * Reading barcodes with the camera. The browser's own reader where it has one
 * (Chrome on Android, macOS); elsewhere (Windows, Linux, iPhone) the ZXing
 * reader, compiled to WebAssembly and shipped with the app, so it works
 * offline too. In the Android app, Google's ML Kit scanner of the phone.
 */

/** Product codes on packs (EAN, UPC), on labels (Code 128, Code 39, ITF) and QR codes. */
export const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"] as const;

export interface Detected {
  rawValue: string;
  format: string;
}
export interface Detector {
  detect(source: CanvasImageSource): Promise<Detected[]>;
}
interface DetectorClass {
  new (o: { formats: string[] }): Detector;
  getSupportedFormats?(): Promise<string[]>;
}

let made: Promise<Detector> | null = null;

/** A barcode reader for camera frames (made once). */
export function barcodeDetector(): Promise<Detector> {
  made ??= (async () => {
    const own = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    if (own) {
      const supported = await own.getSupportedFormats?.().catch(() => [] as string[]);
      const formats = FORMATS.filter((f) => supported?.includes(f));
      if (formats.length) return new own({ formats });
    }
    // The reader shipped with the app: its WebAssembly comes from this site (cached for offline use).
    const [{ BarcodeDetector, setZXingModuleOverrides }, { default: wasm }] = await Promise.all([import("barcode-detector/ponyfill"), import("zxing-wasm/reader/zxing_reader.wasm?url")]);
    setZXingModuleOverrides({ locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasm : prefix + path) });
    return new BarcodeDetector({ formats: [...FORMATS] }) as unknown as Detector;
  })();
  made.catch(() => {
    made = null;
  });
  return made;
}

interface NativeScanner {
  scan(o?: { formats?: string[] }): Promise<{ barcodes: Array<{ rawValue: string; format?: string }> }>;
  isSupported?(): Promise<{ supported: boolean }>;
}

/** The phone's own scanner in the Android app (ML Kit), if there is one. */
export const nativeScanner = () => nativePlugin<NativeScanner>("BarcodeScanner");

/** Scans one code with the phone's scanner (Android app): null when closed without one. */
export async function scanWithPhone(): Promise<string | null> {
  const scanner = nativeScanner();
  if (!scanner) return null;
  const { barcodes } = await scanner.scan();
  return barcodes[0]?.rawValue ?? null;
}

/** A short beep and a buzz when a code is read. */
export function beep(): void {
  try {
    navigator.vibrate?.(40);
    const Ctx = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1760;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => void ctx.close();
  } catch {
    // No sound is fine.
  }
}
