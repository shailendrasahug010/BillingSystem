import { todayIn } from "@vyapaar/core";
import { createDb } from "@vyapaar/db";
import { buildApp } from "./app.js";
import { uuidv7 } from "uuidv7";
import { createFieldCipher } from "./lib/crypto.js";
import { ErrorLog } from "./lib/errorLog.js";
import { loadConfig } from "./config.js";
import { ConsoleOtpSender, WebhookOtpSender } from "./lib/otp.js";
import { createTokenService } from "./lib/security.js";
import { startBackupScheduler } from "./services/backup-schedule.js";
import { LiveMessenger, LogMessenger } from "./services/messaging/transport.js";

const config = loadConfig();
const errors = new ErrorLog(config.errorLog);
let log: ((msg: string, err: Error) => void) | null = null;
const { db, pool } = createDb(config.databaseUrl, {
  max: config.databasePoolMax,
  onError: (err) => {
    errors.record(err, { reference: uuidv7(), source: "database", details: { note: "an idle database connection was lost; the pool replaces it" } });
    if (log) log("idle database connection lost; it will be replaced", err);
    else console.error(err.message);
  },
});

// Failures nothing else caught: written to the error log; an uncaught exception ends the process
// (it may be in a broken state), and the container restarts it.
process.on("unhandledRejection", (reason) => {
  const entry = errors.record(reason, { reference: uuidv7(), source: "process", details: { note: "a promise failed and nothing handled it" } });
  console.error(`unhandled rejection (error log reference ${entry.reference}):`, reason);
});
process.on("uncaughtException", (err) => {
  const entry = errors.record(err, { reference: uuidv7(), source: "process", details: { note: "an exception nothing caught; the API stopped" } });
  console.error(`uncaught exception (error log reference ${entry.reference}):`, err);
  void errors.flush().finally(() => process.exit(1));
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
  errors,
});
if (config.errorLog.dir) app.log.info({ dir: config.errorLog.dir, webSourceMaps: config.errorLog.webSourceMapsDir }, "error log");

log = (msg, err) => app.log.warn({ err: err.message }, msg);
// Automatic backups (emailed on each firm's schedule).
const stopBackups = startBackupScheduler(app.deps, config.backupSchedulerSeconds, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopBackups();
  await app.close();
  await errors.flush();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
