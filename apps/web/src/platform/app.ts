import { goBack } from "../app/router";
import { isNative, nativePlugin } from "./native";

interface AppPlugin {
  addListener(event: "backButton", listener: (e: { canGoBack: boolean }) => void): Promise<unknown>;
  exitApp(): Promise<void>;
}
interface WebPrint {
  print(o: { name: string }): Promise<void>;
}

/** Shows "Press Back again to close the app" for so many ms; set by the app's shell (it has the messages). */
let exitHint: ((ms: number) => void) | null = null;
export function setExitHint(show: ((ms: number) => void) | null): void {
  exitHint = show;
}

/** How long after the first Back on the first screen a second one closes the app. */
const EXIT_WINDOW = 2_000;
let firstBackAt = 0;

/**
 * The Android app's own behaviour, set once at start: printing goes through
 * Android (a web view's window.print does nothing), and the back button
 * closes what is open, then steps back in the screen or goes back a screen,
 * then leaves the app: on a second press, as one press alone is easily made
 * by mistake (without the shell's messages, as on the sign-in screen, at once).
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
    if (goBack()) return;
    const now = Date.now();
    if (!exitHint || now - firstBackAt < EXIT_WINDOW) {
      void app.exitApp();
      return;
    }
    firstBackAt = now;
    exitHint(EXIT_WINDOW);
  });
  // Read by the emulator check in CI (the console goes to Android's log).
  console.info("digitalbahi: app ready");
}
