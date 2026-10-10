import { PaymentGatewayBody, PaymentLinkBody, PaymentLinkListQuery } from "@digitalbahi/contracts";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { GatewayError } from "../../services/gateways/index.js";
import {
  cancelPaymentLink,
  createPaymentLink,
  gatewayApiError,
  gatewayKeys,
  gatewayView,
  linkActor,
  linksSetup,
  linkView,
  loadGateway,
  refreshLink,
  selectLinks,
} from "../../services/payment-links.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });

/**
 * Online payments: the business's payment gateway (Settings) and the payment
 * links made with it. Payments reach the API by the gateway's webhook
 * (webhook.ts) or by the API checking open links (services/payment-links.ts).
 */
export const gatewaysModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const gs = schema.paymentGatewaySettings;

  r.get("/payment-gateway", { preHandler: guard(deps, "settings.view"), schema: { tags: ["payments"] } }, async (request) =>
    tenant(request.ctx, async (tx) => gatewayView(deps, await loadGateway(tx, request.ctx.businessId))),
  );

  /** Chooses the gateway and saves its keys; keys the gateway refuses are not saved. */
  r.put("/payment-gateway", { preHandler: guard(deps, "settings.update"), schema: { tags: ["payments"], body: PaymentGatewayBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    const before = await tenant(ctx, (tx) => loadGateway(tx, ctx.businessId));
    if (body.provider !== "none") {
      // The keys as they will be: typed now, else the saved ones.
      const keyId = body.keyId !== undefined ? body.keyId : (before?.keyId ?? null);
      const keySecret = body.keySecret !== undefined ? body.keySecret : before?.keySecret ? deps.cipher.decrypt(before.keySecret) : null;
      if (!keyId) throw badRequest("GATEWAY_KEYS_REQUIRED", {}, "keyId");
      if (!keySecret) throw badRequest("GATEWAY_KEYS_REQUIRED", {}, "keySecret");
      const changed = body.provider !== before?.provider || body.environment !== before?.environment || body.keyId !== undefined || body.keySecret !== undefined;
      if (changed) {
        try {
          await deps.gateways.client(body.provider).check({ provider: body.provider, environment: body.environment, keyId, keySecret, webhookSecret: null });
        } catch (e) {
          // Wrong keys are refused; a gateway that cannot be reached just now does not stop the saving.
          if (e instanceof GatewayError && e.code === "GATEWAY_AUTH_FAILED") throw gatewayApiError(e);
        }
      }
    }
    return tenant(ctx, async (tx) => {
      if (body.paymentAccountId) {
        const pa = schema.paymentAccounts;
        const [account] = await tx
          .select({ id: pa.id })
          .from(pa)
          .where(and(eq(pa.id, body.paymentAccountId), eq(pa.businessId, ctx.businessId), eq(pa.isActive, true)));
        if (!account) throw badRequest("REFERENCE_NOT_FOUND", {}, "paymentAccountId");
      }
      const seal = (v: string | null) => (v === null ? null : deps.cipher.encrypt(v));
      const values = {
        provider: body.provider,
        environment: body.environment,
        ...(body.keyId !== undefined ? { keyId: body.keyId } : {}),
        ...(body.keySecret !== undefined ? { keySecret: seal(body.keySecret) } : {}),
        ...(body.webhookSecret !== undefined ? { webhookSecret: seal(body.webhookSecret) } : {}),
        ...(body.paymentAccountId !== undefined ? { paymentAccountId: body.paymentAccountId } : {}),
        ...(body.upiOnly !== undefined ? { upiOnly: body.upiOnly } : {}),
        ...(body.linkExpiryDays !== undefined ? { linkExpiryDays: body.linkExpiryDays } : {}),
        ...(body.linksInReminders !== undefined ? { linksInReminders: body.linksInReminders } : {}),
        updatedBy: ctx.userId,
      };
      await tx
        .insert(gs)
        // The address the gateway reports payments to: made once, kept when the keys change.
        .values({ id: uuidv7(), businessId: ctx.businessId, ...values, webhookKey: randomBytes(18).toString("base64url"), createdBy: ctx.userId })
        // (A set-up restored from a backup comes without one: it gets its own.)
        .onConflictDoUpdate({ target: gs.businessId, set: { ...values, webhookKey: sql`coalesce(${gs.webhookKey}, ${randomBytes(18).toString("base64url")})`, updatedAt: sql`now()` } });
      // Which settings changed, never the keys themselves.
      await audit(tx, ctx, { action: "payment_gateway.updated", entityType: "setting", entityLabel: "payment_gateway", changes: { provider: body.provider, environment: body.environment, fields: Object.keys(body) } });
      return gatewayView(deps, await loadGateway(tx, ctx.businessId));
    });
  });

  /** Asks the gateway whether it takes the saved keys. */
  r.post("/payment-gateway/test", { preHandler: guard(deps, "settings.update"), schema: { tags: ["payments"] } }, async (request) => {
    const keys = await tenant(request.ctx, async (tx) => gatewayKeys(deps, await loadGateway(tx, request.ctx.businessId)));
    if (!keys) throw conflict("PAYMENT_GATEWAY_NOT_SET_UP");
    try {
      await deps.gateways.client(keys.provider).check(keys);
    } catch (e) {
      throw gatewayApiError(e);
    }
    return { ok: true, provider: keys.provider, environment: keys.environment };
  });

  /** Whether links can be made (for the buttons that make them). */
  r.get("/payment-links/setup", { preHandler: guard(deps, "payment.collect"), schema: { tags: ["payments"] } }, async (request) =>
    tenant(request.ctx, async (tx) => linksSetup(await loadGateway(tx, request.ctx.businessId))),
  );

  /** A link for a bill or what a customer owes (the open one for the same thing, if there is one). */
  r.post("/payment-links", { preHandler: guard(deps, "payment.collect"), schema: { tags: ["payments"], body: PaymentLinkBody } }, async (request, reply) => {
    const { link, reused } = await createPaymentLink(deps, linkActor(request.ctx), { ...request.body, source: "staff" });
    return reply.code(reused ? 200 : 201).send(link);
  });

  r.get("/payment-links", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], querystring: PaymentLinkListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const l = schema.paymentLinks;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [eq(l.businessId, ctx.businessId)];
    if (q.customerId) where.push(eq(l.customerId, q.customerId));
    if (q.invoiceId) where.push(eq(l.invoiceId, q.invoiceId));
    if (q.status === "open") where.push(inArray(l.status, ["created", "partly_paid"]));
    else if (q.status !== "all") where.push(eq(l.status, q.status));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(sql`(${schema.customers.name} ilike ${like} or ${schema.customers.businessName} ilike ${like} or ${schema.invoices.invoiceNumber} ilike ${like})`);
    }
    if (cursor) where.push(sql`(${l.createdAt}, ${l.id}) < (${String(cursor.v)}::timestamptz, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) => selectLinks(tx, and(...where)!, q.limit + 1));
    return page(rows, q.limit, (x) => ({ v: x.createdAt, id: x.id }));
  });

  r.get("/payment-links/:id", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => linkView(tx, request.ctx.businessId, request.params.id)),
  );

  /** Asks the gateway how the link stands now (the screen showing it asks every few seconds). */
  r.post("/payment-links/:id/refresh", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    const done = await refreshLink(deps, { businessId: ctx.businessId, timeZone: ctx.timeZone }, request.params.id, { minAgeSeconds: 4 });
    if (!done) throw notFound("payment_link");
    return tenant(ctx, (tx) => linkView(tx, ctx.businessId, request.params.id));
  });

  r.post("/payment-links/:id/cancel", { preHandler: guard(deps, "payment.collect"), schema: { tags: ["payments"], params: IdParams } }, async (request) =>
    cancelPaymentLink(deps, request.ctx, request.params.id),
  );
};
