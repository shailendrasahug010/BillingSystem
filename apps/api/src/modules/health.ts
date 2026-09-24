import { sql } from "drizzle-orm";
import type { ApiModule } from "./types.js";

export const healthModule: ApiModule = async (app, deps) => {
  app.get("/health", { config: { rateLimit: false }, schema: { hide: true } }, async () => {
    await deps.db.execute(sql`select 1`);
    return { status: "ok", time: deps.clock.now().toISOString() };
  });
};
