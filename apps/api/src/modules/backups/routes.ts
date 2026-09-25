import { schema } from "@vyapaar/db";
import { desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { ApiError, badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { makeBackup, manifestOf, openBackup, restoreInto } from "../../services/backup.js";
import { MAX_OWNED_BUSINESSES } from "../identity/businesses.js";
import { listBusinesses, sessionResponse, setSessionBusiness } from "../identity/sessions.js";
import { channelsFor, ready } from "../messaging/routes.js";
import type { ApiModule } from "../types.js";

const Passphrase = z.string().min(8).max(200);
const DownloadBody = z.strictObject({ passphrase: Passphrase.optional() });
const EmailBody = z.strictObject({ passphrase: Passphrase, to: z.email().max(200).optional() });
const RestoreQuery = z.object({ dryRun: z.enum(["true", "false"]).optional() });

const MAX_RESTORE_BYTES = 200 * 1024 * 1024;
const MAX_EMAIL_BYTES = 20 * 1024 * 1024;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "firm";

/**
 * Backup & restore for the firm's owner: download the whole book (optionally
 * with a password), email a password-protected copy, see earlier backups, and
 * restore a backup as a NEW business (never over the current one).
 */
export const backupsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Backup files arrive as they are (no JSON wrapping, no base64).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_RESTORE_BYTES }, (_req, body, done) => done(null, body));

  const build = (ctx: RequestCtx, passphrase?: string) =>
    withTenant(deps.db, ctx, async (tx) => {
      const [b] = await tx.select({ name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const made = await makeBackup(tx, ctx.businessId, deps.clock.now(), passphrase);
      return { ...made, filename: `digital-bahi-${slug(b!.name)}-${deps.clock.today(ctx.timeZone)}.dbbackup` };
    });

  const record = (ctx: RequestCtx, kind: "download" | "email", made: { file: Buffer; sha256: string; manifest: { schema: string; counts: Record<string, number> } }, encrypted: boolean, error: string | null = null) =>
    withTenant(deps.db, ctx, async (tx) => {
      const now = deps.clock.now().toISOString();
      await tx.insert(schema.backups).values({
        id: uuidv7(),
        businessId: ctx.businessId,
        kind,
        status: error ? "failed" : "completed",
        sizeBytes: made.file.length,
        sha256: made.sha256,
        schemaVersion: made.manifest.schema,
        encrypted,
        startedAt: now,
        completedAt: now,
        error,
        requestedBy: ctx.userId,
      });
      const records = Object.values(made.manifest.counts).reduce((a, b) => a + b, 0);
      await audit(tx, ctx, { action: kind === "email" ? "backup.emailed" : "backup.downloaded", entityType: "backup", entityLabel: made.sha256.slice(0, 12), changes: { records, bytes: made.file.length, encrypted } });
    });

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
    const made = await build(ctx, request.body.passphrase);
    await record(ctx, "download", made, Boolean(request.body.passphrase));
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${made.filename}"`);
    reply.header("cache-control", "private, no-store");
    reply.header("x-backup-sha256", made.sha256);
    return reply.send(made.file);
  });

  /** A password-protected copy by email (the firm's email by default). */
  r.post("/backups/email", { preHandler: guard(deps, "backup.download"), schema: { tags: ["backup"], body: EmailBody } }, async (request) => {
    const ctx = request.ctx;
    const { channels, to, business } = await withTenant(deps.db, ctx, async (tx) => {
      const [b] = await tx.select({ email: schema.businesses.email, name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      return { channels: await channelsFor(deps, tx, ctx.businessId), to: request.body.to ?? b!.email, business: b! };
    });
    if (!ready(deps, channels, "email")) throw conflict("MESSAGING_NOT_CONFIGURED", { channel: "email" });
    if (!to) throw badRequest("MESSAGE_NO_RECIPIENT", { channel: "email", party: business.name }, "to");
    const made = await build(ctx, request.body.passphrase);
    if (made.file.length > MAX_EMAIL_BYTES) throw badRequest("BACKUP_TOO_LARGE_FOR_EMAIL", { mb: Math.ceil(made.file.length / 1048576) });
    const subject = `Digital Bahi backup · ${business.name} · ${deps.clock.today(ctx.timeZone)}`;
    const text = `The attached file is a password-protected backup of ${business.name}. Keep it safe. To restore it, open Digital Bahi → Backup & Restore → Restore, choose the file and type its password.`;
    const logged = await withTenant(deps.db, ctx, async (tx) => {
      const [row] = await tx
        .insert(schema.messages)
        .values({ id: uuidv7(), businessId: ctx.businessId, channel: "email", kind: "backup", recipient: to, subject, body: text, attachmentName: made.filename, createdBy: ctx.userId })
        .returning();
      return row!;
    });
    let error: string | null = null;
    let delivery: { provider: string; providerMessageId: string | null } | null = null;
    try {
      delivery = await deps.messenger.deliver(channels, { channel: "email", to, subject, text, attachment: { filename: made.filename, content: made.file, contentType: "application/octet-stream" }, template: null });
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
    }
    await withTenant(deps.db, ctx, (tx) =>
      tx
        .update(schema.messages)
        .set(error ? { status: "failed", error, attempts: 1 } : { status: "sent", provider: delivery!.provider, providerMessageId: delivery!.providerMessageId, sentAt: deps.clock.now().toISOString(), attempts: 1 })
        .where(eq(schema.messages.id, logged.id)),
    );
    await record(ctx, "email", made, true, error);
    if (error) throw new ApiError(502, "MESSAGE_SEND_FAILED", { reason: error });
    return { sentTo: to, filename: made.filename, sizeBytes: made.file.length, sha256: made.sha256 };
  });

  /**
   * Restores a backup file as a new business owned by the caller and moves
   * the session into it. With ?dryRun=true only reads the file and says what
   * is in it. The password (if the file has one) comes base64-encoded in the
   * X-Backup-Passphrase header, so it stays out of URLs and logs.
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
