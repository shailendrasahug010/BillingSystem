import { REPORT_VIEW_REPORTS, ReportViewBody, ReportViewPatch, type ReportViewReportKey, type ReportViewSettings } from "@vyapaar/contracts";
import type { Permission } from "@vyapaar/core";
import { schema } from "@vyapaar/db";
import { and, eq, or, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import type { ApiModule } from "../types.js";

/** Views one person may keep in a business. */
export const MAX_REPORT_VIEWS = 50;

const REPORT_PERMISSIONS = [...new Set(Object.values(REPORT_VIEW_REPORTS).map((r) => r.permission))] as Permission[];

const mayOpen = (ctx: RequestCtx, report: string) => {
  const def = REPORT_VIEW_REPORTS[report as ReportViewReportKey];
  return def !== undefined && can(ctx, def.permission as Permission);
};

/** Only the grouping and filters the report has; a custom period with its dates, a preset without. */
function checkSettings(report: ReportViewReportKey, s: ReportViewSettings): ReportViewSettings {
  const def = REPORT_VIEW_REPORTS[report];
  const filters: readonly string[] = def.filters;
  const groups: readonly string[] = def.groups;
  const bad = (field: string) => badRequest("REPORT_VIEW_SETTINGS_INVALID", { field }, `settings.${field}`);
  if (s.groupBy !== undefined && !groups.includes(s.groupBy)) throw bad("groupBy");
  for (const f of ["party", "basis", "movement"] as const) if (s[f] !== undefined && !filters.includes(f)) throw bad(f);
  if (!filters.includes("period")) {
    if (s.period !== undefined || s.from !== undefined || s.to !== undefined) throw bad("period");
    return s;
  }
  const { from, to, ...rest } = s;
  return s.period === "custom" ? { ...rest, from, to } : rest;
}

const ViewParams = z.object({ id: z.uuid() });

/**
 * Saved report views: the Reports screen's tab, period, grouping and filters
 * under a name. Each person's own views, plus those others shared with the
 * team for the reports this person's role opens. Only the person who saved a
 * view changes or deletes it; others can save a copy of their own.
 */
export const reportViewsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const v = schema.reportViews;

  r.get("/report-views", { preHandler: guard(deps), schema: { tags: ["reports"] } }, async (request) => {
    const ctx = request.ctx;
    if (!REPORT_PERMISSIONS.some((p) => can(ctx, p))) throw forbidden(REPORT_PERMISSIONS[0]);
    return withTenant(deps.db, ctx, async (tx) => {
      const rows = await tx
        .select({ id: v.id, name: v.name, report: v.report, settings: v.settings, shared: v.shared, userId: v.userId, ownerName: schema.users.name, updatedAt: v.updatedAt })
        .from(v)
        .innerJoin(schema.users, eq(schema.users.id, v.userId))
        .where(and(eq(v.businessId, ctx.businessId), or(eq(v.userId, ctx.userId), eq(v.shared, true))))
        .orderBy(sql`${v.userId} <> ${ctx.userId}`, sql`lower(${v.name})`);
      return {
        data: rows
          .filter((row) => mayOpen(ctx, row.report))
          .map(({ userId, ...row }) => ({ ...row, mine: userId === ctx.userId, ownerName: userId === ctx.userId ? null : row.ownerName })),
      };
    });
  });

  r.post("/report-views", { preHandler: guard(deps), schema: { tags: ["reports"], body: ReportViewBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    if (!mayOpen(ctx, body.report)) throw forbidden(REPORT_VIEW_REPORTS[body.report].permission);
    const settings = checkSettings(body.report, body.settings);
    const created = await withTenant(deps.db, ctx, async (tx) => {
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(v)
        .where(and(eq(v.businessId, ctx.businessId), eq(v.userId, ctx.userId)));
      if ((count?.n ?? 0) >= MAX_REPORT_VIEWS) throw conflict("REPORT_VIEW_LIMIT", { max: MAX_REPORT_VIEWS });
      const [row] = await tx.insert(v).values({ businessId: ctx.businessId, userId: ctx.userId, name: body.name, report: body.report, settings, shared: body.shared }).returning();
      await audit(tx, ctx, { action: "report_view.saved", entityType: "report_view", entityId: row!.id, entityLabel: row!.name, changes: { report: body.report, settings, shared: body.shared } });
      return row!;
    });
    reply.code(201);
    return { id: created.id, name: created.name, report: created.report, settings: created.settings, shared: created.shared, mine: true, ownerName: null, updatedAt: created.updatedAt };
  });

  r.patch("/report-views/:id", { preHandler: guard(deps), schema: { tags: ["reports"], params: ViewParams, body: ReportViewPatch } }, async (request) => {
    const ctx = request.ctx;
    const patch = request.body;
    return withTenant(deps.db, ctx, async (tx) => {
      const [view] = await tx.select().from(v).where(and(eq(v.id, request.params.id), eq(v.businessId, ctx.businessId)));
      if (!view || (view.userId !== ctx.userId && !view.shared)) throw notFound("report_view");
      if (view.userId !== ctx.userId) throw forbidden();
      if (!mayOpen(ctx, view.report)) throw forbidden(REPORT_VIEW_REPORTS[view.report as ReportViewReportKey].permission);
      const set = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.settings !== undefined ? { settings: checkSettings(view.report as ReportViewReportKey, patch.settings) } : {}),
        ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
        updatedAt: sql`now()`,
      };
      const [row] = await tx.update(v).set(set).where(eq(v.id, view.id)).returning();
      const changes = Object.fromEntries(
        (["name", "settings", "shared"] as const).flatMap((k) => (k in set && JSON.stringify(view[k]) !== JSON.stringify(row![k]) ? [[k, [view[k], row![k]]]] : [])),
      );
      if (Object.keys(changes).length) await audit(tx, ctx, { action: "report_view.updated", entityType: "report_view", entityId: view.id, entityLabel: row!.name, changes });
      return { id: row!.id, name: row!.name, report: row!.report, settings: row!.settings, shared: row!.shared, mine: true, ownerName: null, updatedAt: row!.updatedAt };
    });
  });

  r.delete("/report-views/:id", { preHandler: guard(deps), schema: { tags: ["reports"], params: ViewParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await withTenant(deps.db, ctx, async (tx) => {
      const [view] = await tx.select().from(v).where(and(eq(v.id, request.params.id), eq(v.businessId, ctx.businessId)));
      if (!view || (view.userId !== ctx.userId && !view.shared)) throw notFound("report_view");
      if (view.userId !== ctx.userId) throw forbidden();
      await tx.delete(v).where(eq(v.id, view.id));
      await audit(tx, ctx, { action: "report_view.deleted", entityType: "report_view", entityId: view.id, entityLabel: view.name, changes: { report: view.report, settings: view.settings, shared: view.shared } });
    });
    reply.code(204);
  });
};
