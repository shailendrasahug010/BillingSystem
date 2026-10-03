import { BusinessLogoBody, BusinessProfilePatch, patchOf, SeriesPatch, SETTING_SCHEMAS, SettingBody, WarehouseBody } from "@digitalbahi/contracts";
import { stateCodeFromGstin, validateGstin, validatePan, validateSeriesPattern } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard, invalidateAccess } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { getSettings, isSettingKey, SETTING_DEFAULTS } from "../../services/settings.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });

const MAX_LOGO_BYTES = 300 * 1024;
/** First bytes of each accepted image type, so the declared type is what the file really is. */
const IMAGE_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** Retires a logo file: hidden from reads and its bytes dropped (the row stays for the audit trail). */
async function retireFile(tx: Tx, ctx: RequestCtx, fileId: string, now: string) {
  await tx.update(schema.files).set({ deletedAt: now, deletedBy: ctx.userId, content: null }).where(and(eq(schema.files.id, fileId), eq(schema.files.businessId, ctx.businessId)));
}
const KeyParams = z.object({ key: z.string().max(60) });

export const businessModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  // ---------------------------------------------------------------- business profile
  r.get("/business", { preHandler: guard(deps, "settings.view"), schema: { tags: ["business"] } }, async (request) =>
    tenant(request.ctx, async (tx) => {
      const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, request.ctx.businessId));
      return b!;
    }),
  );

  r.patch("/business", { preHandler: guard(deps, "settings.update"), schema: { tags: ["business"], body: BusinessProfilePatch } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return tenant(ctx, async (tx) => {
      const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId)).for("update");
      const next = { ...b!, ...body };
      if (next.gstin) {
        const issues = validateGstin(next.gstin);
        if (issues.length) throw badRequest("INVALID_GSTIN", { issue: issues[0]! }, "gstin");
        if (stateCodeFromGstin(next.gstin) !== next.stateCode) throw badRequest("GSTIN_STATE_MISMATCH", { gstinState: stateCodeFromGstin(next.gstin) }, "gstin");
      }
      if (body.pan && validatePan(body.pan).length) throw badRequest("INVALID_PAN", {}, "pan");
      if (body.stateCode) {
        const [st] = await tx.select().from(schema.states).where(eq(schema.states.code, body.stateCode));
        if (!st) throw badRequest("INVALID_STATE_CODE", {}, "stateCode");
      }
      const changes = diff(b!, body);
      if (!Object.keys(changes).length) return b!;
      const [updated] = await tx
        .update(schema.businesses)
        .set({ ...body, updatedBy: ctx.userId, version: b!.version + 1 })
        .where(eq(schema.businesses.id, ctx.businessId))
        .returning();
      await audit(tx, ctx, { action: "business.updated", entityType: "business", entityId: ctx.businessId, entityLabel: updated!.legalName, changes });
      invalidateAccess(ctx.businessId);
      return updated!;
    });
  });

  // ---------------------------------------------------------------- firm logo
  /** The firm's logo, printed on bills and shown in the app. Anyone in the business can read it. */
  r.get("/business/logo", { preHandler: guard(deps), schema: { tags: ["business"] } }, async (request) =>
    tenant(request.ctx, async (tx) => {
      const [row] = await tx
        .select({ id: schema.files.id, mimeType: schema.files.mimeType, content: schema.files.content })
        .from(schema.files)
        .innerJoin(schema.businesses, eq(schema.businesses.logoFileId, schema.files.id))
        .where(and(eq(schema.businesses.id, request.ctx.businessId), isNull(schema.files.deletedAt)));
      if (!row?.content) throw notFound("logo");
      return { id: row.id, mimeType: row.mimeType, dataUrl: `data:${row.mimeType};base64,${row.content.toString("base64")}` };
    }),
  );

  r.put("/business/logo", { preHandler: guard(deps, "settings.update"), bodyLimit: 600_000, schema: { tags: ["business"], body: BusinessLogoBody } }, async (request) => {
    const ctx = request.ctx;
    const [, mimeType, data] = /^data:(image\/[a-z]+);base64,(.*)$/.exec(request.body.image)!;
    const bytes = Buffer.from(data!, "base64");
    if (bytes.length > MAX_LOGO_BYTES) throw badRequest("IMAGE_TOO_LARGE", { maxKb: MAX_LOGO_BYTES / 1024 }, "image");
    if (!IMAGE_SIGNATURES[mimeType!]?.(bytes)) throw badRequest("INVALID_IMAGE", {}, "image");
    return tenant(ctx, async (tx) => {
      const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId)).for("update");
      const now = deps.clock.now().toISOString();
      const id = uuidv7();
      await tx.insert(schema.files).values({
        id,
        businessId: ctx.businessId,
        storageKey: `db/${id}`,
        content: bytes,
        originalName: "logo",
        mimeType: mimeType!,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        purpose: "business_logo",
        uploadedBy: ctx.userId,
      });
      if (b!.logoFileId) await retireFile(tx, ctx, b!.logoFileId, now);
      await tx
        .update(schema.businesses)
        .set({ logoFileId: id, updatedBy: ctx.userId, version: b!.version + 1 })
        .where(eq(schema.businesses.id, ctx.businessId));
      await audit(tx, ctx, { action: "business.logo_updated", entityType: "business", entityId: ctx.businessId, entityLabel: b!.legalName, changes: { sizeKb: Math.ceil(bytes.length / 1024), mimeType } });
      return { logoFileId: id };
    });
  });

  r.delete("/business/logo", { preHandler: guard(deps, "settings.update"), schema: { tags: ["business"] } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId)).for("update");
      if (!b!.logoFileId) return;
      await retireFile(tx, ctx, b!.logoFileId, deps.clock.now().toISOString());
      await tx
        .update(schema.businesses)
        .set({ logoFileId: null, updatedBy: ctx.userId, version: b!.version + 1 })
        .where(eq(schema.businesses.id, ctx.businessId));
      await audit(tx, ctx, { action: "business.logo_removed", entityType: "business", entityId: ctx.businessId, entityLabel: b!.legalName });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- settings (typed business rules)
  r.get("/settings", { preHandler: guard(deps, "settings.view"), schema: { tags: ["business"] } }, async (request) =>
    tenant(request.ctx, (tx) => getSettings(tx, request.ctx.businessId, Object.keys(SETTING_DEFAULTS) as (keyof typeof SETTING_DEFAULTS)[])),
  );

  r.put(
    "/settings/:key",
    { preHandler: guard(deps, "settings.update"), schema: { tags: ["business"], params: KeyParams, body: SettingBody } },
    async (request) => {
      const ctx = request.ctx;
      const key = request.params.key;
      if (!isSettingKey(key)) throw badRequest("UNKNOWN_SETTING", { key }, "key");
      const parsed = SETTING_SCHEMAS[key].safeParse(request.body.value);
      if (!parsed.success) throw badRequest("INVALID_SETTING_VALUE", { key }, "value");
      return tenant(ctx, async (tx) => {
        // The bill's unit letters and the unit new lines start in name units of this business.
        const unitIds = key === "invoice.unit_letters" && parsed.data ? Object.keys(parsed.data) : key === "invoice.default_unit" && parsed.data && parsed.data !== "own" ? [parsed.data as string] : null;
        if (unitIds) {
          const ids = unitIds;
          const found = ids.length ? await tx.select({ id: schema.units.id }).from(schema.units).where(and(eq(schema.units.businessId, ctx.businessId), inArray(schema.units.id, ids))) : [];
          if (found.length !== ids.length) throw badRequest("INVALID_SETTING_VALUE", { key }, "value");
        }
        const [before] = await tx
          .select({ value: schema.settings.value })
          .from(schema.settings)
          .where(and(eq(schema.settings.businessId, ctx.businessId), eq(schema.settings.key, key)));
        // Cleared (null, e.g. no LUT any more): the stored row goes and the default, none, applies.
        if (parsed.data === null) await tx.delete(schema.settings).where(and(eq(schema.settings.businessId, ctx.businessId), eq(schema.settings.key, key)));
        else
          await tx
            .insert(schema.settings)
            .values({ businessId: ctx.businessId, key, value: parsed.data, updatedBy: ctx.userId })
            .onConflictDoUpdate({
              target: [schema.settings.businessId, schema.settings.key],
              set: { value: parsed.data, updatedBy: ctx.userId, updatedAt: deps.clock.now().toISOString() },
            });
        await audit(tx, ctx, { action: "setting.changed", entityType: "setting", entityLabel: key, changes: { [key]: [before?.value ?? null, parsed.data] } });
        // Weights set by hand stay: the nightly tuning stops.
        if (key === "suggestions.weights") {
          await tx
            .insert(schema.settings)
            .values({ businessId: ctx.businessId, key: "suggestions.auto_tune", value: false, updatedBy: ctx.userId })
            .onConflictDoUpdate({ target: [schema.settings.businessId, schema.settings.key], set: { value: false, updatedBy: ctx.userId, updatedAt: deps.clock.now().toISOString() } });
        }
        return { key, value: parsed.data };
      });
    },
  );

  // ---------------------------------------------------------------- number series
  // Offline devices' own series ("A1/26-27/0001") are fixed and listed with the devices instead.
  r.get("/document-series", { preHandler: guard(deps, "settings.view"), schema: { tags: ["business"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx
        .select()
        .from(schema.documentSeries)
        .where(and(eq(schema.documentSeries.businessId, request.ctx.businessId), isNull(schema.documentSeries.deviceId)))
        .orderBy(asc(schema.documentSeries.docType), asc(schema.documentSeries.financialYear)),
    ),
  }));

  r.patch(
    "/document-series/:id",
    { preHandler: guard(deps, "settings.update"), schema: { tags: ["business"], params: IdParams, body: SeriesPatch } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [series] = await tx
          .select()
          .from(schema.documentSeries)
          .where(and(eq(schema.documentSeries.id, request.params.id), eq(schema.documentSeries.businessId, ctx.businessId), isNull(schema.documentSeries.deviceId)))
          .for("update");
        if (!series) throw notFound("document_series");
        if (request.body.pattern) {
          if (!/\{SEQ(:\d+)?\}/.test(request.body.pattern)) throw badRequest("SERIES_PATTERN_NEEDS_SEQ", {}, "pattern");
          const issues = validateSeriesPattern(request.body.pattern, { date: deps.clock.today(ctx.timeZone) });
          if (issues.length) throw badRequest("INVALID_SERIES_PATTERN", { issue: issues[0]! }, "pattern");
        }
        const [updated] = await tx
          .update(schema.documentSeries)
          .set({ ...request.body, updatedBy: ctx.userId })
          .where(eq(schema.documentSeries.id, series.id))
          .returning();
        await audit(tx, ctx, { action: "series.updated", entityType: "document_series", entityId: series.id, entityLabel: series.name, changes: diff(series, request.body) });
        return updated!;
      });
    },
  );

  // ---------------------------------------------------------------- warehouses (godowns)
  r.get("/warehouses", { preHandler: guard(deps, "product.view"), schema: { tags: ["business"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx
        .select()
        .from(schema.warehouses)
        .where(and(eq(schema.warehouses.businessId, request.ctx.businessId), isNull(schema.warehouses.deletedAt)))
        .orderBy(asc(schema.warehouses.name)),
    ),
  }));

  const clearDefaultWarehouse = (tx: Tx, businessId: string, exceptId: string) =>
    tx
      .update(schema.warehouses)
      .set({ isDefault: false })
      .where(and(eq(schema.warehouses.businessId, businessId), ne(schema.warehouses.id, exceptId), eq(schema.warehouses.isDefault, true)));

  r.post("/warehouses", { preHandler: guard(deps, "settings.update"), schema: { tags: ["business"], body: WarehouseBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const created = await tenant(ctx, async (tx) => {
      const id = uuidv7();
      if (request.body.isDefault) await clearDefaultWarehouse(tx, ctx.businessId, id);
      const [row] = await tx
        .insert(schema.warehouses)
        .values({ ...request.body, id, code: request.body.code.toUpperCase(), businessId: ctx.businessId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      await audit(tx, ctx, { action: "warehouse.created", entityType: "warehouse", entityId: id, entityLabel: row!.name });
      return row!;
    });
    return reply.code(201).send(created);
  });

  r.patch(
    "/warehouses/:id",
    { preHandler: guard(deps, "settings.update"), schema: { tags: ["business"], params: IdParams, body: patchOf(WarehouseBody.extend({ isActive: z.boolean() })) } },
    async (request) => {
      const ctx = request.ctx;
      return tenant(ctx, async (tx) => {
        const [wh] = await tx
          .select()
          .from(schema.warehouses)
          .where(and(eq(schema.warehouses.id, request.params.id), eq(schema.warehouses.businessId, ctx.businessId), isNull(schema.warehouses.deletedAt)));
        if (!wh) throw notFound("warehouse");
        if (request.body.isDefault) await clearDefaultWarehouse(tx, ctx.businessId, wh.id);
        if (request.body.isDefault === false && wh.isDefault) throw badRequest("DEFAULT_WAREHOUSE_REQUIRED", {}, "isDefault");
        const patch = { ...request.body, ...(request.body.code ? { code: request.body.code.toUpperCase() } : {}) };
        const [row] = await tx
          .update(schema.warehouses)
          .set({ ...patch, updatedBy: ctx.userId, version: wh.version + 1 })
          .where(eq(schema.warehouses.id, wh.id))
          .returning();
        await audit(tx, ctx, { action: "warehouse.updated", entityType: "warehouse", entityId: wh.id, entityLabel: row!.name, changes: diff(wh, patch) });
        return row!;
      });
    },
  );
};
