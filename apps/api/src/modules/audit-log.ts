import { AuditLogQuery } from "@vyapaar/contracts";
import { addDays } from "@vyapaar/core";
import { schema } from "@vyapaar/db";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { guard } from "../lib/access.js";
import { withTenant } from "../lib/db.js";
import { badRequest } from "../lib/errors.js";
import { decodeCursor, page } from "../lib/pagination.js";
import type { ApiModule } from "./types.js";

/** Who changed what and when. Read-only: the table itself rejects updates and deletes. */
export const auditLogModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/audit-logs", { preHandler: guard(deps, "audit.view"), schema: { tags: ["audit"], querystring: AuditLogQuery } }, async (request) => {
    const q = request.query;
    const ctx = request.ctx;
    const cursor = decodeCursor(q.cursor);
    const a = schema.auditLogs;
    // Dates are business-calendar days; the log stores instants, so compare in the business time zone.
    const tzDay = (d: string) => new Date(`${d}T00:00:00${offsetOf(ctx.timeZone)}`).toISOString();
    const where: SQL[] = [eq(a.businessId, ctx.businessId)];
    if (q.entityType) where.push(eq(a.entityType, q.entityType));
    if (q.entityId) where.push(eq(a.entityId, q.entityId));
    if (q.userId) where.push(eq(a.userId, q.userId));
    if (q.action) where.push(eq(a.action, q.action));
    if (q.from) where.push(gte(a.createdAt, tzDay(q.from)));
    if (q.to) where.push(lt(a.createdAt, tzDay(addDays(q.to, 1))));
    if (cursor) {
      const id = Number(cursor.id);
      if (!Number.isSafeInteger(id)) throw badRequest("INVALID_CURSOR", {}, "cursor");
      where.push(lt(a.id, id));
    }
    const rows = await withTenant(deps.db, ctx, (tx) =>
      tx
        .select()
        .from(a)
        .where(and(...where))
        .orderBy(desc(a.id))
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (row) => ({ v: null, id: String(row.id) }));
  });
};

/** "+05:30" for Asia/Kolkata. India has no DST, but this stays correct for any zone at that instant. */
function offsetOf(timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  const m = part?.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1]! : "Z";
}
