import { schema } from "@digitalbahi/db";
import { and, eq, or, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { parseCashfreeWebhook, parseRazorpayWebhook, verifyCashfreeWebhook, verifyRazorpayWebhook, type GatewayName, type WebhookNotice } from "../../services/gateways/index.js";
import { gatewayKeys, loadGateway, refreshLink } from "../../services/payment-links.js";
import type { ApiModule } from "../types.js";

const Key = z.object({ key: z.string().min(16).max(40).regex(/^[A-Za-z0-9_-]+$/) });
const isUuid = (v: string | null): v is string => v !== null && z.uuid().safeParse(v).success;

/**
 * Where the business's gateway reports payments: /webhooks/payments/<key>,
 * shown in Settings → Online payments. Razorpay signs with the webhook
 * secret typed in its dashboard (X-Razorpay-Signature), Cashfree with the
 * secret key (x-webhook-signature over x-webhook-timestamp and the body).
 * A signed event only says which link to look at: the link's payments are
 * then read from the gateway itself, so a replayed or altered event cannot
 * record a payment that was not made. Unsigned or wrongly signed calls
 * change nothing.
 */
export const paymentWebhookModule: ApiModule = async (app, deps) => {
  await app.register(async (hooks) => {
    // The signature covers the exact bytes sent, so the body is kept raw here.
    hooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const limit = { rateLimit: { max: 3000, timeWindow: "1 minute" } };

    hooks.post("/webhooks/payments/:key", { config: limit, schema: { hide: true } }, async (request, reply) => {
      const params = Key.safeParse(request.params);
      const raw = request.body;
      if (!params.success || !Buffer.isBuffer(raw)) throw new ApiError(403, "FORBIDDEN");
      const found = await deps.db.transaction(async (tx) => {
        const res = await tx.execute<{ business_id: string; time_zone: string }>(sql`select business_id, time_zone from payment_gateway_business(${params.data.key})`);
        const business = res.rows[0];
        if (!business) return null;
        await tx.execute(sql`select set_config('app.business_id', ${business.business_id}, true), set_config('app.user_id', '', true)`);
        const keys = gatewayKeys(deps, await loadGateway(tx, business.business_id));
        if (!keys) return null;
        let body: unknown;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return null;
        }
        let notice: WebhookNotice | null;
        if (keys.provider === "razorpay") {
          const signature = String(request.headers["x-razorpay-signature"] ?? "");
          if (!keys.webhookSecret || !signature || !verifyRazorpayWebhook(raw, signature, keys.webhookSecret)) return null;
          notice = parseRazorpayWebhook(body);
        } else {
          const signature = String(request.headers["x-webhook-signature"] ?? "");
          const timestamp = String(request.headers["x-webhook-timestamp"] ?? "");
          if (!signature || !timestamp || !verifyCashfreeWebhook(raw, timestamp, signature, keys.keySecret)) return null;
          notice = parseCashfreeWebhook(body);
        }
        const gs = schema.paymentGatewaySettings;
        await tx.update(gs).set({ lastWebhookAt: deps.clock.now().toISOString() }).where(eq(gs.businessId, business.business_id));
        if (!notice) return { hit: null };
        const l = schema.paymentLinks;
        const byLink = notice.providerLinkId ? eq(l.providerLinkId, notice.providerLinkId) : undefined;
        const byReference = isUuid(notice.referenceId) ? eq(l.id, notice.referenceId) : undefined;
        if (!byLink && !byReference) return { hit: null };
        const [link] = await tx
          .select({ id: l.id, providerLinkId: l.providerLinkId, provider: l.provider })
          .from(l)
          .where(and(eq(l.businessId, business.business_id), eq(l.provider, keys.provider), or(byLink, byReference)));
        // A link made elsewhere with the same gateway account: not ours to record.
        if (!link) return { hit: null };
        return { hit: { scope: { businessId: business.business_id, timeZone: business.time_zone }, link, notice } };
      });
      if (!found) throw new ApiError(403, "FORBIDDEN");
      if (found.hit) {
        const { scope, link, notice } = found.hit;
        // The stand-in gateway learns of the payment from the event itself.
        if (deps.gateways.remember && notice.state) deps.gateways.remember(link.provider as GatewayName, link.providerLinkId, notice.state);
        try {
          await refreshLink(deps, scope, link.id);
        } catch (e) {
          // The gateway sends the event again later; the link is also checked on its own.
          if (!(e instanceof ApiError)) deps.errors.record(e, { reference: uuidv7(), source: "job", job: "online payment reported by the gateway", details: { businessId: scope.businessId, link: link.id } });
          return reply.code(503).send({ ok: false });
        }
      }
      return reply.code(200).send({ ok: true });
    });
  });
};
