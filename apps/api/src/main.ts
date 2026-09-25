import { todayIn } from "@vyapaar/core";
import { createDb } from "@vyapaar/db";
import { buildApp } from "./app.js";
import { createFieldCipher } from "./lib/crypto.js";
import { loadConfig } from "./config.js";
import { ConsoleOtpSender, WebhookOtpSender } from "./lib/otp.js";
import { createTokenService } from "./lib/security.js";
import { LiveMessenger, LogMessenger } from "./services/messaging/transport.js";

const config = loadConfig();
let log: ((msg: string, err: Error) => void) | null = null;
const { db, pool } = createDb(config.databaseUrl, {
  max: config.databasePoolMax,
  onError: (err) => (log ? log("idle database connection lost; it will be replaced", err) : console.error(err.message)),
});
const tokens = await createTokenService(config);
const app = await buildApp({
  config,
  db,
  tokens,
  // Production requires a gateway (checked in loadConfig); development logs the code.
  otp: config.otpWebhook ? new WebhookOtpSender(config.otpWebhook) : new ConsoleOtpSender((msg) => app.log.info(msg)),
  clock: { now: () => new Date(), today: (tz) => todayIn(tz ?? "Asia/Kolkata") },
  cipher: createFieldCipher(config.dataEncryptionKey, config.env),
  // "log" (development) records messages instead of sending them.
  messenger: config.messaging.driver === "live" ? new LiveMessenger(config.messaging.whatsappApiBase) : new LogMessenger((msg) => app.log.info(`message (not sent): ${msg}`)),
});

log = (msg, err) => app.log.warn({ err: err.message }, msg);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
