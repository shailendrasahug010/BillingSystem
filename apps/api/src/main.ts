import { todayIn } from "@digitalbahi/core";
import { checkSchema, createDb } from "@digitalbahi/db";
import { buildApp } from "./app.js";
import { uuidv7 } from "uuidv7";
import { createFieldCipher } from "./lib/crypto.js";
import { ErrorLog } from "./lib/errorLog.js";
import { rootMessage } from "./lib/errors.js";
import { loadConfig } from "./config.js";
import { ConsoleOtpSender, WebhookOtpSender } from "./lib/otp.js";
import { createTokenService } from "./lib/security.js";
import { startBackupScheduler } from "./services/backup-schedule.js";
import { startNightlyScheduler } from "./services/nightly-analytics.js";
import { startOutboxWorker } from "./services/outbox-worker.js";
import { startReminderScheduler } from "./services/reminders.js";
import { startRepeatBillScheduler } from "./services/repeat-bills.js";
import { LiveMessenger, LogMessenger } from "./services/messaging/transport.js";
import { pushSender } from "./services/push.js";

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
  // FCM with a service account; "log" (development) records pushes; "off" sends none.
  push: pushSender(config.push, (msg) => app.log.info(`${msg} (not sent)`)),
  errors,
});
if (config.errorLog.dir) app.log.info({ dir: config.errorLog.dir, webSourceMaps: config.errorLog.webSourceMapsDir }, "error log");

// Code started on a database it is ahead of fails on whatever it added ("function … does not exist",
// "relation … does not exist") on every request and job: say so once, with the fix, and stop.
const DEPLOY_HINT = 'run "pnpm db:deploy" (HOW-TO-RUN.md, "Steps"; the installed app does it at every start) and start the API again';
const schemaState = await checkSchema(pool).catch((e: unknown) => {
  app.log.warn({ err: rootMessage(e) }, "could not check that the database has this version's migrations");
  return null;
});
if (schemaState?.status === "behind" || schemaState?.status === "not_granted") {
  if (schemaState.status === "behind") {
    app.log.error({ missing: schemaState.missing }, `the database is behind this version of the API: ${schemaState.missing.length} migration(s) not applied; ${DEPLOY_HINT}`);
  } else {
    app.log.error(`this version's database step has not run (the API's database role may not read which migrations are applied); ${DEPLOY_HINT}`);
  }
  await app.close();
  await errors.flush();
  await pool.end();
  process.exit(1);
}
if (schemaState?.status === "ahead") app.log.warn("the database has migrations this version of the API does not know: an older version started on a newer database");

log = (msg, err) => app.log.warn({ err: err.message }, msg);
// Automatic backups (emailed on each firm's schedule).
const stopBackups = startBackupScheduler(app.deps, config.backupSchedulerSeconds, app.log);
// Purchase history a few seconds after each bill; the nightly rebuild, drift and balance checks.
const stopOutbox = startOutboxWorker(app.deps, config.outboxWorkerSeconds, app.log);
const stopNightly = startNightlyScheduler(app.deps, config.nightlyAnalytics.schedulerSeconds, app.log);
// Daily reminder checks (each rule after its hour, in each firm's time zone).
const stopReminders = startReminderScheduler(app.deps, config.reminderSchedulerSeconds, app.log);
// Repeat bills on their day (same cadence as the reminder checks).
const stopRepeatBills = startRepeatBillScheduler(app.deps, config.reminderSchedulerSeconds, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopBackups();
  stopOutbox();
  stopNightly();
  stopReminders();
  stopRepeatBills();
  await app.close();
  await errors.flush();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
