import { sql } from "drizzle-orm";
import type { ApiModule } from "./types.js";

export const healthModule: ApiModule = async (app, deps) => {
  app.get("/health", { config: { rateLimit: false }, schema: { hide: true } }, async () => {
    await deps.db.execute(sql`select 1`);
    // `app` lets the Android app tell a Digital Bahi server from any other site at the address typed.
    return { status: "ok", app: "digitalbahi", time: deps.clock.now().toISOString() };
  });
};
