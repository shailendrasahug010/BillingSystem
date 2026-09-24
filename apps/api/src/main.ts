import { todayIn } from "@vyapaar/core";
import { createDb } from "@vyapaar/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ConsoleOtpSender, WebhookOtpSender } from "./lib/otp.js";
import { createTokenService } from "./lib/security.js";

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl, { max: config.databasePoolMax });
const tokens = await createTokenService(config);
const app = await buildApp({
  config,
  db,
  tokens,
  // Production requires a gateway (checked in loadConfig); development logs the code.
  otp: config.otpWebhook ? new WebhookOtpSender(config.otpWebhook) : new ConsoleOtpSender((msg) => app.log.info(msg)),
  clock: { now: () => new Date(), today: (tz) => todayIn(tz ?? "Asia/Kolkata") },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
