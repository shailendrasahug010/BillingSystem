import { DeviceBody } from "@vyapaar/contracts";
import { financialYearOf } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { DEVICE_INVOICE_PATTERN, deviceSeries, registerDevice } from "../../services/devices.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });

/** Devices that bill offline: registration (with the device's invoice series), list, revoke. */
export const devicesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /**
   * Registers this device (or confirms the one it already is) and returns its
   * invoice series for this financial year and the next number to use, so it
   * can number bills while offline.
   */
  r.post("/devices", { preHandler: guard(deps, "invoice.create"), schema: { tags: ["sync"], body: DeviceBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const device = await registerDevice(tx, ctx, request.body);
      const [b] = await tx.select({ fyStart: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const today = deps.clock.today(ctx.timeZone);
      const series = await deviceSeries(tx, ctx.businessId, device, today, b!.fyStart);
      return {
        id: device.id,
        name: device.name,
        seriesCode: device.seriesCode,
        pattern: DEVICE_INVOICE_PATTERN,
        financialYearStartMonth: b!.fyStart,
        series: { financialYear: financialYearOf(today, b!.fyStart).label, nextNumber: series.nextNumber },
      };
    });
  });

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
          offlineBills: sql<number>`(select count(*)::int from invoices i where i.device_id = "devices"."id")`,
        })
        .from(d)
        .innerJoin(schema.users, eq(schema.users.id, d.userId))
        .where(eq(d.businessId, request.ctx.businessId))
        .orderBy(asc(d.seriesCode));
      return { data: rows };
    }),
  );

  /** A lost or retired device: its unsynced offline bills will be refused. */
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
      await audit(tx, ctx, { action: "device.revoked", entityType: "device", entityId: device.id, entityLabel: `${device.seriesCode} ${device.name}` });
      return { id: device.id, revokedAt: device.revokedAt };
    });
  });
};
