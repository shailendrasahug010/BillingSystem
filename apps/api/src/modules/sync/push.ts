import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import type { ApiModule } from "../types.js";

/**
 * Work done offline sent in one request (Phase 5.3): on a weak connection one
 * round trip carries what would take dozens. Each item goes through the same
 * route it would on its own (validation, permissions, its Idempotency-Key, so
 * an item sent before and answered into the void is answered again, not
 * done twice), in order, as the person who sent the batch; the answer lists
 * each item's status and body. An item can act on the record an earlier item
 * made (cancel or return against a bill made offline: `target` is that
 * item's id) and wait for one (`after`: work for a new customer waits for
 * the customer). A server error or rate limit stops the batch there: the
 * rest come back untried, to be sent again later.
 */

const KINDS = {
  invoice: { method: "POST", path: () => "/invoices" },
  payment: { method: "POST", path: () => "/payments" },
  order: { method: "POST", path: () => "/sales-orders" },
  customer: { method: "POST", path: () => "/customers" },
  "customer-edit": { method: "PATCH", path: (t: string) => `/customers/${t}` },
  purchase: { method: "POST", path: () => "/purchases" },
  expense: { method: "POST", path: () => "/expenses" },
  "collection-note": { method: "POST", path: () => "/collections/notes" },
  "sale-return": { method: "POST", path: (t: string) => `/invoices/${t}/returns` },
  "purchase-return": { method: "POST", path: (t: string) => `/purchases/${t}/returns` },
  "sale-price-note": { method: "POST", path: (t: string) => `/invoices/${t}/price-notes` },
  "purchase-price-note": { method: "POST", path: (t: string) => `/purchases/${t}/price-notes` },
  "invoice-cancel": { method: "POST", path: (t: string) => `/invoices/${t}/cancel` },
} as const;
type Kind = keyof typeof KINDS;
const NEEDS_TARGET = new Set<Kind>(["customer-edit", "sale-return", "purchase-return", "sale-price-note", "purchase-price-note", "invoice-cancel"]);

const Item = z.strictObject({
  /** The work's id on the device: its Idempotency-Key (and a new customer's id). */
  id: z.uuid(),
  kind: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]),
  /** The record it acts on: its id, or the id of an earlier item in this batch whose record it is. */
  target: z.uuid().optional(),
  /** A customer change: the version it was made on (If-Match). */
  version: z.number().int().min(0).optional(),
  /** Sent only if the earlier item with this id went through. */
  after: z.uuid().optional(),
  body: z.record(z.string(), z.unknown()),
});

const PushBody = z.strictObject({ items: z.array(Item).min(1).max(50) });

export interface PushResult {
  id: string;
  /** The HTTP status the item got; 0 when it was not tried (an earlier failure, or what it waits for did not go through). */
  status: number;
  body: unknown;
}

export const syncPushModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/sync/push", { preHandler: guard(deps), schema: { tags: ["sync"], body: PushBody } }, async (request) => {
    const results: PushResult[] = [];
    const done = new Map<string, PushResult>();
    let stopped = false;
    for (const item of request.body.items) {
      const waitsFor = item.after ? done.get(item.after) : undefined;
      if (stopped || (waitsFor && (waitsFor.status < 200 || waitsFor.status >= 300))) {
        results.push({ id: item.id, status: 0, body: null });
        continue;
      }
      let target = item.target;
      const earlier = target ? done.get(target) : undefined;
      if (earlier) {
        const made = (earlier.body as { id?: unknown } | null)?.id;
        if (earlier.status < 200 || earlier.status >= 300 || typeof made !== "string") {
          results.push({ id: item.id, status: 0, body: null });
          continue;
        }
        target = made;
      }
      if (NEEDS_TARGET.has(item.kind) && !target) {
        const result = { id: item.id, status: 400, body: { error: { code: "VALIDATION_FAILED", params: {}, field: "target", requestId: request.id } } };
        results.push(result);
        done.set(item.id, result);
        continue;
      }
      const route = KINDS[item.kind];
      const res = await app.inject({
        method: route.method,
        url: `/api/v1${route.path(target ?? "")}`,
        headers: {
          "content-type": "application/json",
          "idempotency-key": item.id,
          ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
          ...(typeof request.headers["x-client"] === "string" ? { "x-client": request.headers["x-client"] } : {}),
          ...(typeof request.headers["accept-language"] === "string" ? { "accept-language": request.headers["accept-language"] } : {}),
          ...(typeof request.headers["user-agent"] === "string" ? { "user-agent": request.headers["user-agent"] } : {}),
          // The person's address in the audit log, not the server's own.
          "x-forwarded-for": request.ip,
          ...(item.kind === "customer-edit" && item.version !== undefined ? { "if-match": String(item.version) } : {}),
        },
        payload: JSON.stringify(item.body),
      });
      let body: unknown = null;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        body = null;
      }
      const result = { id: item.id, status: res.statusCode, body };
      results.push(result);
      done.set(item.id, result);
      // The server or the rate limit: what follows is not tried now.
      if (res.statusCode >= 500 || res.statusCode === 429) stopped = true;
    }
    return { results };
  });
};
