import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android app. It carries the web app's production build (apps/web/dist)
 * and talks to the business's own Digital Bahi server, whose address is
 * asked for on first start (each business runs its own).
 */
const config: CapacitorConfig = {
  appId: "in.digitalbahi.app",
  appName: "Digital Bahi",
  webDir: "../web/dist",
  // Pinch to zoom, as in a browser (the WebView turns it off unless asked).
  zoomEnabled: true,
  android: {
    // Pages come from https://localhost; the server is reached over https only.
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
