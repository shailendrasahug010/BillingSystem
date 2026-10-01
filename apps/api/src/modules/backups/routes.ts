import { schema } from "@digitalbahi/db";
import { hasPermission } from "@digitalbahi/core";
import { desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { acceptFiles } from "../../lib/binary.js";
import { audit, diff } from "../../lib/audit.js";
import { withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, forbidden, unauthorized } from "../../lib/errors.js";
import { manifestOf, openBackup, restoreInto } from "../../services/backup.js";
import { buildBackup, emailBackup, recordBackup } from "../../services/backup-delivery.js";
import { nextBackupAt } from "../../services/backup-schedule.js";
import { verifyPassword } from "../../lib/security.js";
import { MAX_OWNED_BUSINESSES } from "../identity/businesses.js";
import { listBusinesses, sessionResponse, setSessionBusiness } from "../identity/sessions.js";
import { channelsFor, ready } from "../messaging/routes.js";
import type { ApiModule } from "../types.js";

const Passphrase = z.string().min(8).max(200);
const DownloadBody = z.strictObject({ passphrase: Passphrase.optional() });
const EmailBody = z.strictObject({ passphrase: Passphrase, to: z.email().max(200).optional() });
const RestoreQuery = z.object({ dryRun: z.enum(["true", "false"]).optional() });
const ScheduleBody = z.strictObject({
  frequency: z.enum(["off", "daily", "weekly"]),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6).default(0),
  /** Empty: the firm's own email. */
  to: z.union([z.email().max(200), z.literal("")]).nullable().optional(),
  /** Needed the first time; left out keeps the one saved. */
  passphrase: Passphrase.optional(),
});

const MAX_RESTORE_BYTES = 200 * 1024 * 1024;
/** Wrong account passwords before the account is locked for a while (as at sign-in). */
const MAX_REAUTH_FAILURES = 5;
const REAUTH_LOCK_MINUTES = 15;

type ScheduleRow = typeof schema.backupSchedules.$inferSelect;

function scheduleView(row: ScheduleRow | null, extra: { defaultTo: string | null; emailReady: boolean; by: string | null }) {
  let lastError: { code: string; params: Record<string, string | number> } | null = null;
  try {
    lastError = row?.lastError ? JSON.parse(row.lastError) : null;
  } catch {
    lastError = { code: "MESSAGE_SEND_FAILED", params: { reason: row!.lastError! } };
  }
  return {
    frequency: (row?.frequency ?? "off") as "off" | "daily" | "weekly",
    hour: row?.hour ?? 21,
    weekday: row?.weekday ?? 0,
    to: row?.emailTo ?? null,
    defaultTo: extra.defaultTo,
    hasPassword: Boolean(row?.passphrase),
    nextRunAt: row?.nextRunAt ?? null,
    lastRunAt: row?.lastRunAt ?? null,
    lastStatus: (row?.lastStatus ?? null) as "sent" | "failed" | null,
    lastError,
    emailReady: extra.emailReady,
    setUpBy: row?.configuredBy ? extra.by : null,
  };
}

/**
 * Backup & restore for the firm's owner: download the whole book (optionally
 * with a password), email a password-protected copy, see earlier backups, and
 * restore a backup as a NEW business (never over the current one).
 */
export const backupsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Backup files arrive as they are (no JSON wrapping, no base64).
  acceptFiles(app);

  r.get("/backups", { preHandler: guard(deps, "backup.create"), schema: { tags: ["backup"] } }, async (request) =>
    withTenant(deps.db, request.ctx, async (tx) => ({
      data: await tx
        .select({
          id: schema.backups.id,
          kind: schema.backups.kind,
          status: schema.backups.status,
          sizeBytes: schema.backups.sizeBytes,
          sha256: schema.backups.sha256,
          schemaVersion: schema.backups.schemaVersion,
          encrypted: schema.backups.encrypted,
          error: schema.backups.error,
          createdAt: schema.backups.createdAt,
          restoredAt: schema.backups.restoredAt,
          by: schema.users.name,
        })
        .from(schema.backups)
        .leftJoin(schema.users, eq(schema.users.id, schema.backups.requestedBy))
        .where(eq(schema.backups.businessId, request.ctx.businessId))
        .orderBy(desc(schema.backups.createdAt))
        .limit(50),
    })),
  );

  /** The whole firm as one file (POST so a password never appears in a URL). */
  r.post("/backups/download", { preHandler: guard(deps, "backup.download"), schema: { tags: ["backup"], body: DownloadBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const made = await buildBackup(deps, ctx, request.body.passphrase);
    await recordBackup(deps, ctx, "download", made, Boolean(request.body.passphrase));
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${made.filename}"`);
    reply.header("cache-control", "private, no-store");
    reply.header("x-backup-sha256", made.sha256);
    return reply.send(made.file);
  });

  /** A password-protected copy by email (the firm's email by default). */
  r.post("/backups/email", { preHandler: guard(deps, "backup.download"), schema: { tags: ["backup"], body: EmailBody } }, async (request) =>
    emailBackup(deps, request.ctx, { passphrase: request.body.passphrase, to: request.body.to ?? null, kind: "email" }),
  );

  /** Automatic backups: how often, when, to whom (never the password). */
  r.get("/backups/schedule", { preHandler: guard(deps, "backup.configure"), schema: { tags: ["backup"] } }, async (request) => {
    const ctx = request.ctx;
    const { row, business, channels, by } = await withTenant(deps.db, ctx, async (tx) => {
      const [row] = await tx.select().from(schema.backupSchedules).where(eq(schema.backupSchedules.businessId, ctx.businessId));
      const [business] = await tx.select({ email: schema.businesses.email }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const [by] = row?.configuredBy ? await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.configuredBy)) : [];
      return { row, business: business!, channels: await channelsFor(deps, tx, ctx.businessId), by };
    });
    return scheduleView(row ?? null, { defaultTo: business.email, emailReady: ready(deps, channels, "email"), by: by?.name ?? null });
  });

  /**
   * Turns automatic backups on or off. Needs backup.download as well: a
   * schedule sends the whole book by email, which is a download by another
   * route. The password is kept encrypted and only ever used to lock the file.
   */
  r.put("/backups/schedule", { preHandler: guard(deps, "backup.configure"), schema: { tags: ["backup"], body: ScheduleBody } }, async (request) => {
    const ctx = request.ctx;
    if (!hasPermission(ctx.grants, "backup.download")) throw forbidden("backup.download");
    const body = request.body;
    const to = body.to?.trim() || null;
    const saved = await withTenant(deps.db, ctx, async (tx) => {
      const [before] = await tx.select().from(schema.backupSchedules).where(eq(schema.backupSchedules.businessId, ctx.businessId));
      const [business] = await tx.select({ email: schema.businesses.email, name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      if (body.frequency !== "off") {
        if (!ready(deps, await channelsFor(deps, tx, ctx.businessId), "email")) throw conflict("MESSAGING_NOT_CONFIGURED", { channel: "email" });
        if (!to && !business!.email) throw badRequest("MESSAGE_NO_RECIPIENT", { channel: "email", party: business!.name }, "to");
        if (!body.passphrase && !before?.passphrase) throw badRequest("BACKUP_SCHEDULE_NO_PASSWORD", {}, "passphrase");
      }
      const now = deps.clock.now();
      const values = {
        frequency: body.frequency,
        hour: body.hour,
        weekday: body.weekday,
        emailTo: to,
        ...(body.passphrase ? { passphrase: deps.cipher.encrypt(body.passphrase) } : {}),
        nextRunAt: body.frequency === "off" ? null : nextBackupAt(now, { frequency: body.frequency, hour: body.hour, weekday: body.weekday }, ctx.timeZone).toISOString(),
        configuredBy: ctx.userId,
        updatedAt: now.toISOString(),
      };
      const [row] = await tx
        .insert(schema.backupSchedules)
        .values({ id: uuidv7(), businessId: ctx.businessId, ...values })
        .onConflictDoUpdate({ target: schema.backupSchedules.businessId, set: values })
        .returning();
      const changes = diff({ frequency: before?.frequency ?? "off", hour: before?.hour ?? 21, weekday: before?.weekday ?? 0, emailTo: before?.emailTo ?? null }, { frequency: row!.frequency, hour: row!.hour, weekday: row!.weekday, emailTo: row!.emailTo });
      await audit(tx, ctx, { action: "backup.schedule_changed", entityType: "backup", changes: { ...changes, ...(body.passphrase ? { password: "changed" } : {}) } });
      return { row: row!, defaultTo: business!.email };
    });
    return scheduleView(saved.row, { defaultTo: saved.defaultTo, emailReady: true, by: ctx.userName });
  });

  /**
   * Restores a backup file as a new business owned by the caller and moves
   * the session into it. With ?dryRun=true only reads the file and says what
   * is in it. The password (if the file has one) comes base64-encoded in the
   * X-Backup-Passphrase header, so it stays out of URLs and logs. The restore
   * itself also needs the person's own Digital Bahi password again
   * (X-Account-Password, base64): an unattended open session is not enough
   * to create a business from a file.
   */
  r.post(
    "/backups/restore",
    { preHandler: guard(deps, "backup.restore"), bodyLimit: MAX_RESTORE_BYTES, schema: { tags: ["backup"], querystring: RestoreQuery } },
    async (request, reply) => {
      const ctx = request.ctx;
      const file = request.body;
      if (!Buffer.isBuffer(file)) throw badRequest("BACKUP_NOT_RECOGNISED");
      const header = request.headers["x-backup-passphrase"];
      const passphrase = typeof header === "string" && header ? Buffer.from(header, "base64").toString("utf8") : undefined;
      const doc = openBackup(file, passphrase);
      const manifest = manifestOf(doc);
      if (request.query.dryRun === "true") return { manifest };

      const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.id, ctx.userId));
      if (!user?.isActive) throw unauthorized();
      const accountHeader = request.headers["x-account-password"];
      const accountPassword = typeof accountHeader === "string" && accountHeader ? Buffer.from(accountHeader, "base64").toString("utf8") : "";
      if (!accountPassword) throw badRequest("ACCOUNT_PASSWORD_REQUIRED", {}, "accountPassword");
      const at = deps.clock.now();
      if (user.lockedUntil && Date.parse(user.lockedUntil) > at.getTime()) {
        throw new ApiError(429, "ACCOUNT_LOCKED", { retryAfter: Math.ceil((Date.parse(user.lockedUntil) - at.getTime()) / 1000) });
      }
      if (!(await verifyPassword(user.passwordHash, accountPassword))) {
        await deps.db
          .update(schema.users)
          .set({
            failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
            lockedUntil: sql`case when ${schema.users.failedLoginCount} + 1 >= ${MAX_REAUTH_FAILURES}
              then ${new Date(at.getTime() + REAUTH_LOCK_MINUTES * 60_000).toISOString()}::timestamptz else ${schema.users.lockedUntil} end`,
          })
          .where(eq(schema.users.id, user.id));
        await withTenant(deps.db, ctx, (tx) => audit(tx, ctx, { action: "backup.restore_refused", entityType: "business", entityId: ctx.businessId, changes: { reason: "wrong account password" } }));
        throw badRequest("ACCOUNT_PASSWORD_WRONG", {}, "accountPassword");
      }
      if (user.failedLoginCount > 0) await deps.db.update(schema.users).set({ failedLoginCount: 0 }).where(eq(schema.users.id, user.id));
      const owned = (await listBusinesses(deps.db, user.id)).filter((b) => b.isOwner).length;
      if (owned >= MAX_OWNED_BUSINESSES) throw conflict("BUSINESS_LIMIT_REACHED", { max: MAX_OWNED_BUSINESSES });

      const newBusinessId = uuidv7();
      const now = deps.clock.now();
      const counts = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.business_id', ${newBusinessId}, true), set_config('app.user_id', ${user.id}, true)`);
        const restored = await restoreInto(tx, doc, {
          newBusinessId,
          userId: user.id,
          tradeNameSuffix: " (restored)",
          trialEndsAt: new Date(now.getTime() + deps.config.trialDays * 86_400_000).toISOString(),
        });
        let roleId = restored.adminRoleId;
        if (!roleId) {
          roleId = uuidv7();
          await tx.insert(schema.roles).values({ id: roleId, businessId: newBusinessId, key: "admin", name: "Admin", isSystem: true });
          await tx.insert(schema.rolePermissions).values({ roleId, grant: "*" });
        }
        await tx.insert(schema.businessMembers).values({ id: uuidv7(), businessId: newBusinessId, userId: user.id, roleId, isOwner: true });
        await tx.insert(schema.backups).values({
          id: uuidv7(),
          businessId: newBusinessId,
          kind: "restore",
          status: "completed",
          sizeBytes: file.length,
          sha256: createHash("sha256").update(file).digest("hex"),
          schemaVersion: manifest.schema,
          encrypted: file[5] === 1,
          completedAt: now.toISOString(),
          requestedBy: user.id,
          restoredAt: now.toISOString(),
          restoredBy: user.id,
        });
        await tx.update(schema.users).set({ lastBusinessId: newBusinessId }).where(eq(schema.users.id, user.id));
        const actor = { userId: user.id, userName: user.name, ip: request.ip, userAgent: request.headers["user-agent"] ?? null, requestId: request.id };
        await audit(tx, { ...actor, businessId: newBusinessId }, { action: "business.restored", entityType: "business", entityId: newBusinessId, entityLabel: manifest.business.tradeName ?? manifest.business.legalName, changes: { from: manifest.createdAt, schema: manifest.schema, rows: restored.counts } });
        await setSessionBusiness(tx, ctx.sessionId, newBusinessId);
        return restored.counts;
      });
      // Noted in the business the restore was started from, too.
      await withTenant(deps.db, ctx, (tx) => audit(tx, ctx, { action: "backup.restored_as_new", entityType: "business", entityId: newBusinessId, entityLabel: manifest.business.tradeName ?? manifest.business.legalName, changes: { from: manifest.createdAt } }));

      const businesses = await listBusinesses(deps.db, user.id);
      const business = businesses.find((b) => b.id === newBusinessId) ?? null;
      const session = await sessionResponse(deps, request, reply, { user, familyId: ctx.sessionId, business, businesses });
      return reply.code(201).send({ manifest, counts, session });
    },
  );
};
