import { goBack } from "../app/router";
import { isNative, nativePlugin } from "./native";

interface AppPlugin {
  addListener(event: "backButton", listener: (e: { canGoBack: boolean }) => void): Promise<unknown>;
  exitApp(): Promise<void>;
}
interface WebPrint {
  print(o: { name: string }): Promise<void>;
}

/**
 * The Android app's own behaviour, set once at start: printing goes through
 * Android (a web view's window.print does nothing), and the back button
 * closes what is open, then goes back a screen, then leaves the app.
 */
export function startNativeApp(): void {
  if (!isNative()) return;
  const printing = nativePlugin<WebPrint>("WebPrint");
  if (printing) window.print = () => void printing.print({ name: document.title || "Digital Bahi" }).catch(() => undefined);
  const app = nativePlugin<AppPlugin>("App");
  void app?.addListener("backButton", () => {
    // An open dialog or sheet closes as with Escape.
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return;
    }
    if (!goBack()) void app.exitApp();
  });
  // Read by the emulator check in CI (the console goes to Android's log).
  console.info("digitalbahi: app ready");
}
