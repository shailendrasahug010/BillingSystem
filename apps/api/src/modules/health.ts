import { sql } from "drizzle-orm";
import os from "node:os";
import { authenticate } from "../lib/access.js";
import type { ApiModule } from "./types.js";

/** This computer's addresses on the Wi-Fi or cable network, home routers' 192.168.x.x first. */
export function lanAddresses(): string[] {
  const rank = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
      .map((a) => a!.address),
  )].sort((a, b) => rank(a) - rank(b));
}

export const healthModule: ApiModule = async (app, deps) => {
  app.get("/health", { config: { rateLimit: false }, schema: { hide: true } }, async () => {
    await deps.db.execute(sql`select 1`);
    // `app` lets the Android app tell a Digital Bahi server from any other site at the address typed.
    return { status: "ok", app: "digitalbahi", time: deps.clock.now().toISOString() };
  });

  /**
   * Where a phone on the same Wi-Fi opens this server: for the "Open on
   * phone" QR code when the app itself is open at localhost. Empty when the
   * server only answers this computer (started without phone mode) or does
   * not serve the app itself (development, where Vite serves it).
   */
  app.get("/phone-address", { preHandler: authenticate(deps), schema: { hide: true } }, async () => {
    const open = (deps.config.host === "0.0.0.0" || deps.config.host === "::") && Boolean(deps.config.webDir);
    return { urls: open ? lanAddresses().map((ip) => `http://${ip}:${deps.config.port}`) : [] };
  });
};
