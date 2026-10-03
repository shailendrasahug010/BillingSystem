import { schema } from "@digitalbahi/db";
import { createTranslator, isLocaleCode } from "@digitalbahi/i18n";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { withTenant } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { liveSession, sendPushes, type PlannedPush } from "../../services/push-delivery.js";
import type { ApiModule } from "../types.js";

/**
 * Push messages to phones (Phase 5.2). The Android app registers its Firebase
 * Cloud Messaging token at each start, for the business it is working in and
 * the sign-in it has, and removes it when signing out; new notifications for
 * the person then also arrive as pushes (push-delivery.ts). A sign-in that
 * ends, or moves to another business, stops them by itself.
 */

const TokenBody = z.strictObject({
  /** The registration token the app got from Firebase. */
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(["android", "ios", "web"]),
  /** The app's language: pushes are written in it. */
  locale: z.enum(["en", "hi"]).optional(),
  /** The phone's registered device (offline work), when it has one. */
  deviceId: z.uuid().optional(),
});

const RemoveBody = z.strictObject({ token: z.string().trim().min(20).max(4096) });

export const pushModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Registers (or refreshes) this phone for the person's notifications in this business: `{id, push}`, push false when the server sends none. */
  r.post("/push/tokens", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"], body: TokenBody } }, async (request) => {
    const ctx = request.ctx;
    const b = request.body;
    const id = await withTenant(deps.db, ctx, async (tx) => {
      if (b.deviceId) {
        const d = schema.devices;
        const [device] = await tx
          .select({ id: d.id })
          .from(d)
          .where(and(eq(d.id, b.deviceId), eq(d.businessId, ctx.businessId), eq(d.userId, ctx.userId), isNull(d.revokedAt)));
        if (!device) throw badRequest("DEVICE_NOT_FOUND", {}, "deviceId");
      }
      const t = schema.pushTokens;
      const now = deps.clock.now().toISOString();
      const values = { userId: ctx.userId, sessionId: ctx.sessionId, deviceId: b.deviceId ?? null, platform: b.platform, locale: b.locale ?? "en", lastSeenAt: now };
      // One row per business and token: a phone handed to someone else (signed in again) moves to them.
      const [row] = await tx
        .insert(t)
        .values({ businessId: ctx.businessId, token: b.token, ...values })
        .onConflictDoUpdate({ target: [t.businessId, t.token], set: values })
        .returning({ id: t.id });
      return row!.id;
    });
    return { id, push: deps.push.driver !== "off" };
  });

  /** Signing out on the phone: no more pushes to it in this business (204, also when it was not registered). */
  r.delete("/push/tokens", { preHandler: guard(deps), schema: { tags: ["notifications"], body: RemoveBody } }, async (request, reply) => {
    const ctx = request.ctx;
    await withTenant(deps.db, ctx, (tx) => tx.delete(schema.pushTokens).where(and(eq(schema.pushTokens.businessId, ctx.businessId), eq(schema.pushTokens.token, request.body.token))));
    return reply.code(204).send();
  });

  /** A test push to the person's own phones in this business, now: `{phones, sent, failed, removed}`. */
  r.post("/push/test", { preHandler: guard(deps, "notification.view"), schema: { tags: ["notifications"] } }, async (request) => {
    const ctx = request.ctx;
    const planned = await withTenant(deps.db, ctx, async (tx) => {
      const [business] = await tx
        .select({ name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, ctx.businessId));
      const phones = await tx.execute<{ id: string; token: string; locale: string }>(sql`
        select pt.id, pt.token, pt.locale from push_tokens pt
        where pt.business_id = ${ctx.businessId} and pt.user_id = ${ctx.userId} and ${liveSession("pt")}`);
      return phones.rows.map((p): PlannedPush => {
        const { t } = createTranslator(isLocaleCode(p.locale) ? p.locale : "en");
        return {
          notificationId: "",
          tokenId: p.id,
          message: { token: p.token, title: t("notifications.push.testTitle"), body: t("notifications.push.testBody", { business: business?.name ?? "" }), tag: "test", urgent: true, data: { businessId: ctx.businessId, type: "test" } },
        };
      });
    });
    const run = await sendPushes(deps, ctx.businessId, planned);
    return { phones: planned.length, ...run };
  });
};
