import { financialYearOf, formatDocumentNumber, validateDocumentNumber } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { RequestCtx } from "../lib/context.js";
import { ApiError, badRequest } from "../lib/errors.js";

/**
 * Phones and counter PCs that bill offline. Each gets a short code (A1, A2 …)
 * and its own invoice series per financial year ("A1/26-27/0001"). GST allows
 * several series as long as each is consecutive and unique; the device hands
 * out its numbers itself while offline, so they never collide with the office
 * counter or another phone.
 */
export const DEVICE_INVOICE_PATTERN = "{DEVICE}/{FYS}/{SEQ:4}";

const CODES = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("").flatMap((l) => "123456789".split("").map((d) => `${l}${d}`));

/**
 * Registers a device (or confirms the one it already is). Only devices of
 * people who bill get a code and an invoice series; every device that keeps
 * a copy of the business is registered, so the owner can remove it. Each
 * registration renews the secret the device checks in with.
 */
export async function registerDevice(
  tx: Tx,
  ctx: RequestCtx,
  input: { name: string; platform: string; deviceId?: string | undefined },
  options: { withSeries: boolean; checkHash: string },
) {
  const d = schema.devices;
  const freeCode = async () => {
    const used = new Set((await tx.select({ code: d.seriesCode }).from(d).where(eq(d.businessId, ctx.businessId))).map((r) => r.code));
    return CODES.filter((c) => !used.has(c));
  };
  if (input.deviceId) {
    const [known] = await tx
      .select()
      .from(d)
      .where(and(eq(d.id, input.deviceId), eq(d.businessId, ctx.businessId), eq(d.userId, ctx.userId), isNull(d.revokedAt)));
    if (known) {
      const set = { lastSeenAt: sql`now()`, name: input.name, platform: input.platform, checkHash: options.checkHash, sessionId: ctx.sessionId };
      // Now allowed to bill: the device gets its code and series.
      if (options.withSeries && !known.seriesCode) {
        const [code] = await freeCode();
        if (!code) throw new ApiError(409, "DEVICE_LIMIT_REACHED");
        const [updated] = await tx.update(d).set({ ...set, seriesCode: code }).where(eq(d.id, known.id)).returning();
        return updated!;
      }
      const [updated] = await tx.update(d).set(set).where(eq(d.id, known.id)).returning();
      return updated!;
    }
  }
  if (!options.withSeries) {
    const [created] = await tx
      .insert(d)
      .values({ id: uuidv7(), businessId: ctx.businessId, userId: ctx.userId, name: input.name, platform: input.platform, seriesCode: null, lastSeenAt: sql`now()`, checkHash: options.checkHash, sessionId: ctx.sessionId })
      .returning();
    return created!;
  }
  for (const code of await freeCode()) {
    const [created] = await tx
      .insert(d)
      .values({ id: uuidv7(), businessId: ctx.businessId, userId: ctx.userId, name: input.name, platform: input.platform, seriesCode: code, lastSeenAt: sql`now()`, checkHash: options.checkHash, sessionId: ctx.sessionId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
  }
  throw new ApiError(409, "DEVICE_LIMIT_REACHED");
}

/** The device's invoice series for the financial year of `date` (made on first use). */
export async function deviceSeries(tx: Tx, businessId: string, device: { id: string; seriesCode: string | null }, date: string, fyStartMonth: number) {
  const s = schema.documentSeries;
  const fy = financialYearOf(date, fyStartMonth).label;
  const where = and(eq(s.businessId, businessId), eq(s.docType, "invoice"), eq(s.financialYear, fy), eq(s.deviceId, device.id));
  let [row] = await tx.select().from(s).where(where);
  if (!row) {
    await tx
      .insert(s)
      .values({ id: uuidv7(), businessId, docType: "invoice", name: `Device ${device.seriesCode}`, pattern: DEVICE_INVOICE_PATTERN, financialYear: fy, deviceId: device.id, isDefault: false })
      .onConflictDoNothing();
    [row] = await tx.select().from(s).where(where);
  }
  return row!;
}

/**
 * Checks the number a device gave an offline bill against its own series and
 * moves the series past it. The unique index on invoice numbers refuses a
 * number used twice.
 */
export async function offlineInvoiceNumber(tx: Tx, ctx: RequestCtx, offline: { deviceId: string; invoiceNumber: string }, date: string, fyStartMonth: number) {
  const d = schema.devices;
  const [device] = await tx.select().from(d).where(and(eq(d.id, offline.deviceId), eq(d.businessId, ctx.businessId)));
  if (!device) throw badRequest("REFERENCE_NOT_FOUND", {}, "offline.deviceId");
  if (device.revokedAt) throw new ApiError(403, "DEVICE_REVOKED");
  const series = await deviceSeries(tx, ctx.businessId, device, date, fyStartMonth);
  const seq = Number(/(\d+)$/.exec(offline.invoiceNumber)?.[1] ?? NaN);
  const expected = Number.isInteger(seq) && seq >= 1 ? formatDocumentNumber(series.pattern, { seq, date, financialYearStartMonth: fyStartMonth, deviceCode: device.seriesCode ?? "" }) : null;
  if (expected !== offline.invoiceNumber || validateDocumentNumber(offline.invoiceNumber).length) {
    throw badRequest("OFFLINE_NUMBER_INVALID", { number: offline.invoiceNumber }, "offline.invoiceNumber");
  }
  await tx
    .update(schema.documentSeries)
    .set({ nextNumber: sql`greatest(${schema.documentSeries.nextNumber}, ${seq + 1})` })
    .where(eq(schema.documentSeries.id, series.id));
  await tx.update(d).set({ lastSyncAt: sql`now()`, lastSeenAt: sql`now()` }).where(eq(d.id, device.id));
  return { number: offline.invoiceNumber, seriesId: series.id, financialYear: series.financialYear, device };
}
