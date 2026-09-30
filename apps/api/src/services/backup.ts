import { schema, schemaVersion, type Tx } from "@vyapaar/db";
import { and, eq, inArray } from "drizzle-orm";
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { uuidv7 } from "uuidv7";
import { badRequest } from "../lib/errors.js";

/**
 * A firm's whole book in one file, and back into a NEW business.
 *
 * Backup: every row of every table that belongs to the business (masters,
 * documents, ledgers, stock, GST, payroll, settings, roles, audit log, stored
 * files), as JSON, gzipped, optionally encrypted with a password (AES-256-GCM,
 * key from scrypt). Left out: sign-in sessions, memberships, devices,
 * notifications, people's saved report views, queued jobs and the secrets
 * of WhatsApp / email set-up.
 *
 * Restore never overwrites: it creates a new business owned by the person
 * restoring, gives every row a new id and rewrites every reference with the
 * foreign keys Drizzle knows about. A reference that does not point to a row
 * inside the backup is dropped (or the backup refused), so a file can never
 * link the new business to anyone else's data.
 */

const FORMAT = "digital-bahi-backup";
const VERSION = 1;
const MAGIC = Buffer.from("DBBK");
const MAX_JSON_BYTES = 1024 * 1024 * 1024;

/** Tables with business rows that are not part of a backup. */
const LEFT_OUT = new Set(["businesses", "business_members", "refresh_tokens", "otp_challenges", "sync_mutations", "notifications", "outbox_events", "backups", "backup_schedules", "devices", "report_views"]);
/** Global tables a restored row may point to as they are. */
const GLOBAL = new Set(["states", "permissions"]);

interface ColumnInfo {
  key: string;
  column: PgColumn;
  sqlType: string;
  notNull: boolean;
  skip: boolean;
  /** Table this column points to (foreign key). */
  references: string | null;
}

interface TableInfo {
  name: string;
  table: PgTable;
  columns: Map<string, ColumnInfo>;
  /** Single uuid primary key, if any (its values get new ids). */
  idKey: string | null;
  hasBusiness: boolean;
}

let catalogue: Map<string, TableInfo> | null = null;

/** Every table in the schema with its columns and foreign keys (from Drizzle's metadata). */
function tables(): Map<string, TableInfo> {
  if (catalogue) return catalogue;
  const all = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable);
  const out = new Map<string, TableInfo>();
  for (const table of all) {
    const c = getTableConfig(table);
    const refs = new Map<string, string>();
    for (const fk of c.foreignKeys) {
      const r = fk.reference();
      if (r.columns.length === 1) refs.set(r.columns[0]!.name, getTableConfig(r.foreignTable).name);
    }
    const columns = new Map<string, ColumnInfo>();
    for (const col of c.columns) {
      // Identity and generated columns are filled in by the database.
      const generated = Boolean((col as { generated?: unknown }).generated) || Boolean((col as { generatedIdentity?: unknown }).generatedIdentity);
      columns.set(col.name, { key: col.name, column: col, sqlType: col.getSQLType(), notNull: col.notNull, skip: generated, references: refs.get(col.name) ?? null });
    }
    const pk = c.columns.filter((col) => col.primary);
    const idKey = pk.length === 1 && pk[0]!.getSQLType() === "uuid" ? pk[0]!.name : null;
    out.set(c.name, { name: c.name, table, columns, idKey, hasBusiness: columns.has("businessId") });
  }
  catalogue = out;
  return out;
}

/** The tables a backup carries, parents before children. */
function backupTables(): TableInfo[] {
  const all = tables();
  const chosen = [...all.values()].filter((t) => (t.hasBusiness && !LEFT_OUT.has(t.name)) || t.name === "role_permissions");
  const names = new Set(chosen.map((t) => t.name));
  const order: TableInfo[] = [];
  const done = new Set<string>();
  const visit = (t: TableInfo, path: Set<string>) => {
    if (done.has(t.name)) return;
    if (path.has(t.name)) throw new Error(`Foreign keys form a cycle at ${t.name}`);
    path.add(t.name);
    for (const c of t.columns.values()) if (c.references && c.references !== t.name && names.has(c.references)) visit(all.get(c.references)!, path);
    path.delete(t.name);
    done.add(t.name);
    order.push(t);
  };
  for (const t of chosen) visit(t, new Set());
  return order;
}

export interface BackupManifest {
  format: typeof FORMAT;
  version: number;
  schema: string;
  createdAt: string;
  business: { legalName: string; tradeName: string | null; gstin: string | null; stateCode: string };
  counts: Record<string, number>;
}

interface BackupDocument extends BackupManifest {
  businessRow: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
}

const toJsonValue = (v: unknown) => (Buffer.isBuffer(v) ? { $b64: v.toString("base64") } : v);

/** Reads the business's rows (inside its tenant transaction) and packs them. */
export async function makeBackup(tx: Tx, businessId: string, now: Date, passphrase?: string): Promise<{ file: Buffer; manifest: BackupManifest; sha256: string }> {
  const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const data: BackupDocument["tables"] = {};
  const counts: Record<string, number> = {};
  let roleIds: string[] = [];
  for (const info of backupTables()) {
    const t = info.table as PgTable & Record<string, PgColumn>;
    let rows: Array<Record<string, unknown>>;
    if (info.name === "role_permissions") {
      rows = roleIds.length ? await tx.select().from(schema.rolePermissions).where(inArray(schema.rolePermissions.roleId, roleIds)) : [];
    } else {
      rows = await tx.select().from(t).where(eq(t.businessId!, businessId));
    }
    if (info.name === "roles") roleIds = rows.map((r) => r.id as string);
    // Secrets stay out; the status callback key belongs to this business's address alone.
    if (info.name === "messaging_settings") rows = rows.map((r) => ({ ...r, whatsappSecret: null, smtpPassword: null, whatsappAppSecret: null, whatsappStatusKey: null }));
    data[info.name] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJsonValue(v)])));
    counts[info.name] = rows.length;
  }
  const manifest: BackupManifest = {
    format: FORMAT,
    version: VERSION,
    schema: schemaVersion(),
    createdAt: now.toISOString(),
    business: { legalName: business!.legalName, tradeName: business!.tradeName, gstin: business!.gstin, stateCode: business!.stateCode },
    counts,
  };
  const doc: BackupDocument = { ...manifest, businessRow: Object.fromEntries(Object.entries(business!).map(([k, v]) => [k, toJsonValue(v)])), tables: data };
  const packed = gzipSync(Buffer.from(JSON.stringify(doc)));
  const file = passphrase ? Buffer.concat([MAGIC, Buffer.from([VERSION, 1]), encrypt(packed, passphrase)]) : Buffer.concat([MAGIC, Buffer.from([VERSION, 0]), packed]);
  return { file, manifest, sha256: createHash("sha256").update(file).digest("hex") };
}

function key(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFC"), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(data: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), body]);
}

/** Opens a backup file; refuses anything that is not one, or a password that does not fit. */
export function openBackup(file: Buffer, passphrase?: string): BackupDocument {
  if (file.length < 6 || !file.subarray(0, 4).equals(MAGIC)) throw badRequest("BACKUP_NOT_RECOGNISED");
  if (file[4]! > VERSION) throw badRequest("BACKUP_TOO_NEW");
  let packed = file.subarray(6);
  if (file[5] === 1) {
    if (!passphrase) throw badRequest("BACKUP_PASSWORD_REQUIRED", {}, "passphrase");
    if (packed.length < 44) throw badRequest("BACKUP_NOT_RECOGNISED");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key(passphrase, packed.subarray(0, 16)), packed.subarray(16, 28));
      decipher.setAuthTag(packed.subarray(28, 44));
      packed = Buffer.concat([decipher.update(packed.subarray(44)), decipher.final()]);
    } catch {
      throw badRequest("BACKUP_PASSWORD_WRONG", {}, "passphrase");
    }
  }
  let doc: BackupDocument;
  try {
    doc = JSON.parse(gunzipSync(packed, { maxOutputLength: MAX_JSON_BYTES }).toString("utf8")) as BackupDocument;
  } catch {
    throw badRequest("BACKUP_NOT_RECOGNISED");
  }
  if (doc?.format !== FORMAT || typeof doc.tables !== "object" || !doc.businessRow) throw badRequest("BACKUP_NOT_RECOGNISED");
  if (doc.version > VERSION) throw badRequest("BACKUP_TOO_NEW");
  const known = new Map(backupTables().map((t) => [t.name, t]));
  for (const [name, rows] of Object.entries(doc.tables)) {
    const info = known.get(name);
    if (!info || !Array.isArray(rows)) throw badRequest("BACKUP_TOO_NEW", { table: name });
    for (const row of rows) for (const k of Object.keys(row)) if (!info.columns.has(k)) throw badRequest("BACKUP_TOO_NEW", { table: name, column: k });
  }
  return doc;
}

export const manifestOf = (doc: BackupDocument): BackupManifest => ({ format: doc.format, version: doc.version, schema: doc.schema, createdAt: doc.createdAt, business: doc.business, counts: doc.counts });

/**
 * Writes the backup into a new business (the caller has created nothing yet;
 * the transaction's app.business_id must already be `newBusinessId`).
 * Returns the ids the owner's membership needs.
 */
export async function restoreInto(tx: Tx, doc: BackupDocument, input: { newBusinessId: string; userId: string; tradeNameSuffix: string; trialEndsAt: string }): Promise<{ adminRoleId: string | null; counts: Record<string, number> }> {
  const all = tables();
  const order = backupTables();
  const inBackup = new Set(order.map((t) => t.name));
  const ids = new Map<string, string>();
  const oldBusinessId = String(doc.businessRow.id);
  ids.set(oldBusinessId, input.newBusinessId);
  for (const info of order) if (info.idKey) for (const row of doc.tables[info.name] ?? []) ids.set(String(row[info.idKey]), uuidv7());

  const convert = (info: TableInfo, row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(row)) {
      const col = info.columns.get(k)!;
      if (col.skip) continue;
      let v: unknown = raw && typeof raw === "object" && "$b64" in (raw as object) ? Buffer.from(String((raw as { $b64: string }).$b64), "base64") : raw;
      if (k === "businessId") v = input.newBusinessId;
      else if (col.references && v !== null && v !== undefined) {
        const target = col.references;
        if (GLOBAL.has(target)) {
          // States and permission keys are the same everywhere.
        } else if (target === "users") {
          v = v === input.userId ? v : col.notNull ? input.userId : null;
        } else if (inBackup.has(target) || target === "businesses") {
          const mapped = ids.get(String(v));
          if (!mapped && col.notNull) throw badRequest("BACKUP_INCONSISTENT", { table: info.name, column: k });
          v = mapped ?? null;
        } else {
          if (col.notNull) throw badRequest("BACKUP_INCONSISTENT", { table: info.name, column: k });
          v = null;
        }
      } else if (col.sqlType === "uuid" && typeof v === "string") {
        v = ids.get(v) ?? v;
      }
      out[k] = v;
    }
    if (info.name === "files") out.storageKey = `db/${String(out.id)}`;
    return out;
  };

  // The business itself: same details, marked as restored, on a fresh trial.
  const b = doc.businessRow;
  const businessColumns = all.get("businesses")!.columns;
  const businessRow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (businessColumns.has(k) && !businessColumns.get(k)!.skip && k !== "createdAt" && k !== "updatedAt") businessRow[k] = v;
  await tx.insert(schema.businesses).values({
    ...(businessRow as typeof schema.businesses.$inferInsert),
    id: input.newBusinessId,
    tradeName: `${String(b.tradeName ?? b.legalName)}${input.tradeNameSuffix}`,
    logoFileId: b.logoFileId ? (ids.get(String(b.logoFileId)) ?? null) : null,
    status: "trial",
    plan: "trial",
    trialEndsAt: input.trialEndsAt,
    createdBy: input.userId,
    updatedBy: input.userId,
  });

  const counts: Record<string, number> = {};
  for (const info of order) {
    let rows = (doc.tables[info.name] ?? []).map((r) => convert(info, r));
    // A table pointing at itself (category parents): parents first.
    const selfKeys = [...info.columns.values()].filter((c) => c.references === info.name).map((c) => c.key);
    if (selfKeys.length && info.idKey) {
      const pending = new Map(rows.map((r) => [String(r[info.idKey!]), r]));
      const sorted: typeof rows = [];
      const placed = new Set<string>();
      while (pending.size) {
        let moved = false;
        for (const [id, r] of pending) {
          if (selfKeys.every((k) => r[k] === null || r[k] === undefined || placed.has(String(r[k])) || !pending.has(String(r[k])))) {
            sorted.push(r);
            placed.add(id);
            pending.delete(id);
            moved = true;
          }
        }
        if (!moved) throw badRequest("BACKUP_INCONSISTENT", { table: info.name });
      }
      rows = sorted;
    }
    for (let i = 0; i < rows.length; i += 500) await tx.insert(info.table).values(rows.slice(i, i + 500) as never);
    counts[info.name] = rows.length;
  }
  const [admin] = await tx
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.businessId, input.newBusinessId), eq(schema.roles.key, "admin")));
  return { adminRoleId: admin?.id ?? null, counts };
}
