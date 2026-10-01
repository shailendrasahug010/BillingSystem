import { DeviceBody } from "@digitalbahi/contracts";
import { financialYearOf } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { getSetting } from "../../services/settings.js";
import { revokeFamily } from "../identity/sessions.js";
import { DEVICE_INVOICE_PATTERN, deviceSeries, registerDevice } from "../../services/devices.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const CheckBody = z.strictObject({ deviceId: z.uuid(), secret: z.string().min(20).max(100) });
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * Devices that keep a copy of the business: registration (with an invoice
 * series for those who bill offline), list, removal, and the check a removed
 * device makes to wipe itself.
 */
export const devicesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /**
   * Registers this device (or confirms the one it already is). Returns the
   * invoice series and next number for people who bill (so it can number
   * bills offline), a fresh secret to check in with (to learn if the owner
   * removes it), and how many days it may go without connecting.
   */
  r.post("/devices", { preHandler: guard(deps), schema: { tags: ["sync"], body: DeviceBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const secret = randomBytes(32).toString("base64url");
    const out = await tenant(ctx, async (tx) => {
      const device = await registerDevice(tx, ctx, request.body, { withSeries: can(ctx, "invoice.create"), checkHash: hashSecret(secret) });
      const [b] = await tx.select({ fyStart: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const today = deps.clock.today(ctx.timeZone);
      const series = device.seriesCode ? await deviceSeries(tx, ctx.businessId, device, today, b!.fyStart) : null;
      return {
        id: device.id,
        name: device.name,
        seriesCode: device.seriesCode,
        pattern: DEVICE_INVOICE_PATTERN,
        financialYearStartMonth: b!.fyStart,
        series: series ? { financialYear: financialYearOf(today, b!.fyStart).label, nextNumber: series.nextNumber } : null,
        checkSecret: secret,
        wipeAfterDays: await getSetting(tx, ctx.businessId, "offline.wipe_after_days"),
      };
    });
    return reply.header("cache-control", "no-store").send(out);
  });

  /**
   * A device checking in with its secret, signed in or not: "removed" tells a
   * device the owner took away to delete its copy and the work waiting on it.
   * Anything that does not match says "unknown", whatever the reason.
   */
  r.post(
    "/devices/check",
    { config: { rateLimit: { max: deps.config.rateLimit.authMax, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } }, schema: { tags: ["sync"], body: CheckBody } },
    async (request) => {
      const res = await deps.db.execute<{ status: string }>(sql`select device_check(${request.body.deviceId}::uuid, ${hashSecret(request.body.secret)}) as status`);
      return { status: res.rows[0]?.status ?? "unknown" };
    },
  );

  r.get("/devices", { preHandler: guard(deps, "settings.view"), schema: { tags: ["sync"] } }, async (request) =>
    tenant(request.ctx, async (tx) => {
      const d = schema.devices;
      const rows = await tx
        .select({
          id: d.id,
          name: d.name,
          platform: d.platform,
          seriesCode: d.seriesCode,
          userName: schema.users.name,
          lastSeenAt: d.lastSeenAt,
          lastSyncAt: d.lastSyncAt,
          revokedAt: d.revokedAt,
          wipedAt: d.wipedAt,
          offlineBills: sql<number>`(select count(*)::int from invoices i where i.device_id = "devices"."id")`,
        })
        .from(d)
        .innerJoin(schema.users, eq(schema.users.id, d.userId))
        .where(eq(d.businessId, request.ctx.businessId))
        .orderBy(asc(d.seriesCode));
      return { data: rows };
    }),
  );

  /** A lost or retired device: its unsynced offline bills will be refused, and it wipes its copy the next time it connects. */
  r.post("/devices/:id/revoke", { preHandler: guard(deps, "settings.update"), schema: { tags: ["sync"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const d = schema.devices;
      const [device] = await tx
        .update(d)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(d.id, request.params.id), eq(d.businessId, ctx.businessId), isNull(d.revokedAt)))
        .returning();
      if (!device) throw notFound("device");
      // Its sign-in ends too: a lost phone cannot carry on online either.
      if (device.sessionId) await revokeFamily(tx, device.sessionId, new Date(deps.clock.now()));
      await audit(tx, ctx, { action: "device.revoked", entityType: "device", entityId: device.id, entityLabel: [device.seriesCode, device.name].filter(Boolean).join(" ") });
      return { id: device.id, revokedAt: device.revokedAt };
    });
  });
};
