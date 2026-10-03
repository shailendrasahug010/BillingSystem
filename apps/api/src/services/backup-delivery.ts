import { schema } from "@digitalbahi/db";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { audit, type AuditActor } from "../lib/audit.js";
import type { AppDeps } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import { ApiError, badRequest, conflict } from "../lib/errors.js";
import { channelsFor, ready } from "./messaging/queue.js";
import { makeBackup } from "./backup.js";

/** Who a backup is made for: a person on the Backup screen, or the scheduler on their behalf. */
export type BackupActor = AuditActor & { timeZone: string };
export type BackupKind = "download" | "email" | "auto";
type Made = Awaited<ReturnType<typeof buildBackup>>;

const MAX_EMAIL_BYTES = 20 * 1024 * 1024;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "firm";

/** The whole business as one file, named after the firm and the day. */
export const buildBackup = (deps: AppDeps, actor: BackupActor, passphrase?: string) =>
  withTenant(deps.db, actor, async (tx) => {
    const [b] = await tx.select({ name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` }).from(schema.businesses).where(eq(schema.businesses.id, actor.businessId));
    const made = await makeBackup(tx, actor.businessId, deps.clock.now(), passphrase);
    return { ...made, filename: `digital-bahi-${slug(b!.name)}-${deps.clock.today(actor.timeZone)}.dbbackup` };
  });

/** A row in the backup history plus the audit entry. */
export const recordBackup = (deps: AppDeps, actor: BackupActor, kind: BackupKind, made: Made, encrypted: boolean, error: string | null = null) =>
  withTenant(deps.db, actor, async (tx) => {
    const now = deps.clock.now().toISOString();
    await tx.insert(schema.backups).values({
      id: uuidv7(),
      businessId: actor.businessId,
      kind,
      status: error ? "failed" : "completed",
      sizeBytes: made.file.length,
      sha256: made.sha256,
      schemaVersion: made.manifest.schema,
      encrypted,
      startedAt: now,
      completedAt: now,
      error,
      requestedBy: actor.userId,
    });
    const records = Object.values(made.manifest.counts).reduce((a, b) => a + b, 0);
    const action = kind === "download" ? "backup.downloaded" : kind === "email" ? "backup.emailed" : "backup.auto_emailed";
    await audit(tx, actor, { action, entityType: "backup", entityLabel: made.sha256.slice(0, 12), changes: { records, bytes: made.file.length, encrypted, ...(error ? { error } : {}) } });
  });

/**
 * Emails a password-protected copy (to the firm's own email unless `to` is
 * given), logs it with the other messages and in the backup history. Throws
 * an ApiError when email is not set up, there is no address, the file is too
 * big for email or the mail server refuses it.
 */
export async function emailBackup(deps: AppDeps, actor: BackupActor, opts: { passphrase: string; to?: string | null; kind: "email" | "auto" }) {
  const { channels, to, business } = await withTenant(deps.db, actor, async (tx) => {
    const [b] = await tx.select({ email: schema.businesses.email, name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` }).from(schema.businesses).where(eq(schema.businesses.id, actor.businessId));
    return { channels: await channelsFor(deps, tx, actor.businessId), to: opts.to || b!.email, business: b! };
  });
  if (!ready(deps, channels, "email")) throw conflict("MESSAGING_NOT_CONFIGURED", { channel: "email" });
  if (!to) throw badRequest("MESSAGE_NO_RECIPIENT", { channel: "email", party: business.name }, "to");
  const made = await buildBackup(deps, actor, opts.passphrase);
  if (made.file.length > MAX_EMAIL_BYTES) {
    const mb = Math.ceil(made.file.length / 1048576);
    if (opts.kind === "auto") await recordBackup(deps, actor, opts.kind, made, true, `BACKUP_TOO_LARGE_FOR_EMAIL (${mb} MB)`);
    throw badRequest("BACKUP_TOO_LARGE_FOR_EMAIL", { mb });
  }
  const day = deps.clock.today(actor.timeZone);
  const subject = `Digital Bahi ${opts.kind === "auto" ? "automatic backup" : "backup"} · ${business.name} · ${day}`;
  const text = `The attached file is a password-protected backup of ${business.name}. Keep it safe. To restore it, open Digital Bahi → Backup & Restore → Restore, choose the file and type its password.`;
  const logged = await withTenant(deps.db, actor, async (tx) => {
    const [row] = await tx
      .insert(schema.messages)
      .values({ id: uuidv7(), businessId: actor.businessId, channel: "email", kind: "backup", recipient: to, subject, body: text, attachmentName: made.filename, createdBy: actor.userId })
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
  await withTenant(deps.db, actor, (tx) =>
    tx
      .update(schema.messages)
      .set(error ? { status: "failed", error, attempts: 1 } : { status: "sent", provider: delivery!.provider, providerMessageId: delivery!.providerMessageId, sentAt: deps.clock.now().toISOString(), attempts: 1 })
      .where(eq(schema.messages.id, logged.id)),
  );
  await recordBackup(deps, actor, opts.kind, made, true, error);
  if (error) throw new ApiError(502, "MESSAGE_SEND_FAILED", { reason: error });
  return { sentTo: to, filename: made.filename, sizeBytes: made.file.length, sha256: made.sha256 };
}
