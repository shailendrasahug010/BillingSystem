import { hasPermission } from "@digitalbahi/core";
import { uuidv7 } from "uuidv7";
import { schema } from "@digitalbahi/db";
import { and, eq, lte, ne, sql } from "drizzle-orm";
import { loadAccess } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import type { AppDeps } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import { ApiError, rootMessage } from "../lib/errors.js";
import { emailBackup, folderBackup, type BackupActor } from "./backup-delivery.js";

export type BackupFrequency = "off" | "daily" | "weekly";
export interface ScheduleTiming {
  frequency: "daily" | "weekly";
  /** Hour of the day, 0–23, in the business's time zone. */
  hour: number;
  /** 0 = Sunday … 6 = Saturday; weekly only. */
  weekday: number;
}

/** Businesses handled per run; the rest wait for the next one. */
const BATCH = 20;
const DAY_MS = 86_400_000;

/** How far the time zone's wall clock is ahead of UTC at an instant, in ms. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/** The first `hour`:00 in the time zone after `now` (on the weekday, for weekly). */
export function nextBackupAt(now: Date, timing: ScheduleTiming, timeZone: string): Date {
  const local = new Date(now.getTime() + zoneOffset(now.getTime(), timeZone));
  let wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), timing.hour);
  for (let i = 0; i < 9; i++, wall += DAY_MS) {
    if (timing.frequency === "weekly" && new Date(wall).getUTCDay() !== timing.weekday) continue;
    const at = wall - zoneOffset(wall - zoneOffset(wall, timeZone), timeZone);
    if (at > now.getTime()) return new Date(at);
  }
  throw new Error("no next backup time");
}

/** What went wrong, kept for the Backup screen: an error code and its values. */
const failure = (e: unknown) => JSON.stringify(e instanceof ApiError ? { code: e.code, params: e.params } : { code: "MESSAGE_SEND_FAILED", params: { reason: (e as Error).message.slice(0, 300) } });

/**
 * Sends the automatic backups that are due: each business's schedule is
 * claimed (its next time moved on) before the file is made, so two API
 * instances never both send it, and a failure waits for the next turn instead
 * of retrying in a loop. The copy goes out as the person who set it up; if
 * they have since lost access to backups the schedule is switched off, so a
 * former employee's address never keeps receiving the firm's books.
 */
export async function runDueBackups(deps: AppDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.clock.now();
  const due = await deps.db.execute<{ business_id: string; user_id: string }>(sql`select business_id, user_id from due_backup_schedules(${now.toISOString()}::timestamptz, ${BATCH})`);
  let sent = 0;
  let failed = 0;
  for (const { business_id: businessId, user_id: userId } of due.rows) {
    const scope = { businessId, userId };
    const claimed = await withTenant(deps.db, scope, async (tx) => {
      const [row] = await tx
        .select({ schedule: schema.backupSchedules, timeZone: schema.businesses.timeZone })
        .from(schema.backupSchedules)
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.backupSchedules.businessId))
        .where(and(eq(schema.backupSchedules.businessId, businessId), ne(schema.backupSchedules.frequency, "off"), lte(schema.backupSchedules.nextRunAt, now.toISOString())))
        .for("update", { of: schema.backupSchedules, skipLocked: true });
      if (!row) return null;
      const s = row.schedule;
      const nextRunAt = nextBackupAt(now, { frequency: s.frequency as ScheduleTiming["frequency"], hour: s.hour, weekday: s.weekday }, row.timeZone).toISOString();
      await tx.update(schema.backupSchedules).set({ nextRunAt, lastRunAt: now.toISOString(), updatedAt: now.toISOString() }).where(eq(schema.backupSchedules.id, s.id));
      return { ...s, timeZone: row.timeZone };
    });
    if (!claimed) continue;

    const access = await loadAccess(deps.db, userId, businessId, now.getTime());
    const actor: BackupActor = { businessId, userId, userName: access?.userName ?? "Automatic backup", ip: null, userAgent: "Digital Bahi automatic backup", requestId: null, timeZone: claimed.timeZone };
    let error: string | null = null;
    let stop = false;
    if (!access || !hasPermission(access.grants, "backup.download")) {
      error = JSON.stringify({ code: "BACKUP_SCHEDULE_NO_ACCESS", params: {} });
      stop = true;
    } else if (!claimed.passphrase) {
      error = JSON.stringify({ code: "BACKUP_SCHEDULE_NO_PASSWORD", params: {} });
      stop = true;
    } else {
      const passphrase = deps.cipher.decrypt(claimed.passphrase);
      const folder = deps.config.backupFolder;
      try {
        // With a backup folder (one computer), the copy goes there; email too when it is set up.
        if (folder) await folderBackup(deps, actor, passphrase);
        try {
          await emailBackup(deps, actor, { passphrase, to: claimed.emailTo, kind: "auto" });
        } catch (e) {
          const noEmail = e instanceof ApiError && (e.code === "MESSAGING_NOT_CONFIGURED" || e.code === "MESSAGE_NO_RECIPIENT");
          if (!(folder && noEmail)) throw e;
        }
      } catch (e) {
        error = failure(e);
        // Not a refusal the Backup screen explains (mail server down, a bug): into the error log too.
        if (!(e instanceof ApiError) || e.status >= 500) {
          deps.errors.record(e, { reference: uuidv7(), source: "job", job: "automatic backup (emailed copy)", user: { id: userId, name: actor.userName, businessId } });
        }
      }
    }
    await withTenant(deps.db, scope, async (tx) => {
      await tx
        .update(schema.backupSchedules)
        .set({ lastStatus: error ? "failed" : "sent", lastError: error, ...(stop ? { frequency: "off", nextRunAt: null } : {}), updatedAt: deps.clock.now().toISOString() })
        .where(eq(schema.backupSchedules.id, claimed.id));
      if (stop) await audit(tx, actor, { action: "backup.schedule_stopped", entityType: "backup", changes: { reason: JSON.parse(error!).code } });
    });
    if (error) failed++;
    else sent++;
  }
  return { sent, failed };
}

/** Looks for due backups every `seconds`; returns a function that stops it. */
export function startBackupScheduler(deps: AppDeps, seconds: number, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): () => void {
  if (seconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runDueBackups(deps);
      if (done.sent || done.failed) log.info(done, "automatic backups");
    } catch (e) {
      log.warn({ err: rootMessage(e) }, "automatic backups could not run");
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "automatic backups (looking for due backups)" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
