import { LeaveBalanceQuery, LeaveDecisionBody, LeaveListQuery, LeaveRequestBody, LeaveTypePatch } from "@digitalbahi/contracts";
import { addDays, dec, leaveDays } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const lr = schema.leaveRequests;
const lb = schema.leaveBalances;

/** The year's balance row, created with the type's annual quota the first time it is needed. */
async function balanceRow(tx: Tx, ctx: RequestCtx, employeeId: string, type: typeof schema.leaveTypes.$inferSelect, year: number) {
  await tx
    .insert(lb)
    .values({ id: uuidv7(), businessId: ctx.businessId, employeeId, leaveTypeId: type.id, year, accrued: type.annualQuota, createdBy: ctx.userId, updatedBy: ctx.userId })
    .onConflictDoNothing();
  const [row] = await tx.select().from(lb).where(and(eq(lb.employeeId, employeeId), eq(lb.leaveTypeId, type.id), eq(lb.year, year))).for("update");
  return row!;
}

const available = (b: typeof lb.$inferSelect) => dec(b.opening).plus(b.accrued).plus(b.adjusted).minus(b.used);

async function pendingDays(tx: Tx, employeeId: string, leaveTypeId: string, year: number, exceptId?: string) {
  const [row] = (
    await tx.execute<{ days: string }>(sql`
      select coalesce(sum(days), 0)::text as days from leave_requests
      where employee_id = ${employeeId} and leave_type_id = ${leaveTypeId} and status = 'pending'
        and extract(year from from_date) = ${year} ${exceptId ? sql`and id <> ${exceptId}` : sql``}`)
  ).rows;
  return dec(row!.days);
}

async function requestDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select r.id, r.employee_id as "employeeId", e.name as "employeeName", e.employee_code as "employeeCode",
           r.leave_type_id as "leaveTypeId", t.code as "leaveTypeCode", t.name as "leaveTypeName", t.name_hi as "leaveTypeNameHi", t.is_paid as "isPaid",
           r.from_date::text as "fromDate", r.to_date::text as "toDate", r.half_day as "halfDay", r.days::text as days, r.reason, r.status::text as status,
           r.decided_at as "decidedAt", r.decision_note as "decisionNote", r.created_at as "createdAt"
    from leave_requests r join employees e on e.id = r.employee_id join leave_types t on t.id = r.leave_type_id
    where r.id = ${id} and r.business_id = ${ctx.businessId}`);
  if (!rows.rows[0]) throw notFound("leave_request");
  return rows.rows[0];
}

export const leaveModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  r.get("/leave-types", { preHandler: guard(deps, "leave.view"), schema: { tags: ["leave"] } }, async (request) => ({
    data: await tenant(request.ctx, async (tx) =>
      (await tx.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.businessId, request.ctx.businessId)).orderBy(schema.leaveTypes.code)).map(({ businessId: _b, ...x }) => x),
    ),
  }));

  r.patch("/leave-types/:id", { preHandler: guard(deps, "leave.configure"), schema: { tags: ["leave"], params: IdParams, body: LeaveTypePatch } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const t = schema.leaveTypes;
      const [before] = await tx.select().from(t).where(and(eq(t.id, request.params.id), eq(t.businessId, ctx.businessId))).for("update");
      if (!before) throw notFound("leave_type");
      const [after] = await tx.update(t).set({ ...request.body, updatedBy: ctx.userId }).where(eq(t.id, before.id)).returning();
      await audit(tx, ctx, { action: "leave_type.updated", entityType: "leave_type", entityId: before.id, entityLabel: before.code, changes: diff(before, request.body) });
      const { businessId: _b, ...rest } = after!;
      return rest;
    });
  });

  /** Balances per employee and leave type for a calendar year. */
  r.get("/leave/balances", { preHandler: guard(deps, "leave.view"), schema: { tags: ["leave"], querystring: LeaveBalanceQuery } }, async (request) => {
    const ctx = request.ctx;
    const year = request.query.year ?? Number(deps.clock.today(ctx.timeZone).slice(0, 4));
    const rows = await tenant(ctx, (tx) =>
      tx.execute<{ employee_id: string; employee_name: string; leave_type_id: string; code: string; name: string; name_hi: string | null; is_paid: boolean; entitled: string; used: string; pending: string }>(sql`
        select e.id as employee_id, e.name as employee_name, t.id as leave_type_id, t.code, t.name, t.name_hi, t.is_paid,
               coalesce(b.opening + b.accrued + b.adjusted, t.annual_quota)::text as entitled,
               coalesce(b.used, 0)::text as used,
               (select coalesce(sum(r.days), 0) from leave_requests r where r.employee_id = e.id and r.leave_type_id = t.id and r.status = 'pending' and extract(year from r.from_date) = ${year})::text as pending
        from employees e
        cross join leave_types t
        left join leave_balances b on b.employee_id = e.id and b.leave_type_id = t.id and b.year = ${year}
        where e.business_id = ${ctx.businessId} and t.business_id = ${ctx.businessId} and t.is_active and e.deleted_at is null
          and e.status in ('active', 'on_notice') ${request.query.employeeId ? sql`and e.id = ${request.query.employeeId}` : sql``}
        order by e.name, t.code`),
    );
    return {
      year,
      data: rows.rows.map((x) => ({
        employeeId: x.employee_id,
        employeeName: x.employee_name,
        leaveTypeId: x.leave_type_id,
        code: x.code,
        name: x.name,
        nameHi: x.name_hi,
        isPaid: x.is_paid,
        entitled: dec(x.entitled).toFixed(3),
        used: dec(x.used).toFixed(3),
        pending: dec(x.pending).toFixed(3),
        available: dec(x.entitled).minus(x.used).toFixed(3),
      })),
    };
  });

  r.get("/leave/requests", { preHandler: guard(deps, "leave.view"), schema: { tags: ["leave"], querystring: LeaveListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [sql`r.business_id = ${ctx.businessId}`];
    if (q.status !== "all") where.push(sql`r.status = ${q.status}`);
    if (q.employeeId) where.push(sql`r.employee_id = ${q.employeeId}`);
    if (q.q) where.push(sql`e.name ilike ${`%${q.q.replace(/[\\%_]/g, "\\$&")}%`}`);
    if (cursor) where.push(sql`(r.from_date, r.id) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`);
    const rows = await tenant(ctx, (tx) =>
      tx.execute<{ id: string; fromDate: string }>(sql`
        select r.id, r.employee_id as "employeeId", e.name as "employeeName", e.employee_code as "employeeCode",
               t.code as "leaveTypeCode", t.name as "leaveTypeName", t.name_hi as "leaveTypeNameHi", t.is_paid as "isPaid",
               r.from_date::text as "fromDate", r.to_date::text as "toDate", r.half_day as "halfDay", r.days::text as days, r.reason, r.status::text as status,
               r.decision_note as "decisionNote", r.created_at as "createdAt"
        from leave_requests r join employees e on e.id = r.employee_id join leave_types t on t.id = r.leave_type_id
        where ${sql.join(where, sql` and `)}
        order by r.from_date desc, r.id desc limit ${q.limit + 1}`),
    );
    return page(rows.rows, q.limit, (x) => ({ v: x.fromDate, id: x.id }));
  });

  r.post("/leave/requests", { preHandler: guard(deps, "leave.apply"), schema: { tags: ["leave"], body: LeaveRequestBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    if (body.toDate < body.fromDate) throw badRequest("INVALID_PERIOD", {}, "toDate");
    if (body.fromDate.slice(0, 4) !== body.toDate.slice(0, 4)) throw badRequest("LEAVE_SPANS_YEARS", {}, "toDate");
    if (body.halfDay && body.fromDate !== body.toDate) throw badRequest("HALF_DAY_ONE_DATE", {}, "halfDay");
    const detail = await tenant(ctx, async (tx) => {
      const [e] = await tx.select().from(schema.employees).where(and(eq(schema.employees.id, body.employeeId), eq(schema.employees.businessId, ctx.businessId))).for("update");
      if (!e || e.deletedAt) throw badRequest("REFERENCE_NOT_FOUND", {}, "employeeId");
      if (body.fromDate < e.joiningDate || (e.exitDate && body.toDate > e.exitDate)) throw badRequest("LEAVE_OUTSIDE_EMPLOYMENT", {}, "fromDate");
      const [type] = await tx.select().from(schema.leaveTypes).where(and(eq(schema.leaveTypes.id, body.leaveTypeId), eq(schema.leaveTypes.businessId, ctx.businessId)));
      if (!type || !type.isActive) throw badRequest("REFERENCE_NOT_FOUND", {}, "leaveTypeId");
      if (body.halfDay && !type.allowHalfDay) throw badRequest("HALF_DAY_NOT_ALLOWED", {}, "halfDay");
      const [overlap] = await tx
        .select({ id: lr.id })
        .from(lr)
        .where(and(eq(lr.employeeId, e.id), inArray(lr.status, ["pending", "approved"]), sql`${lr.fromDate} <= ${body.toDate} and ${lr.toDate} >= ${body.fromDate}`));
      if (overlap) throw conflict("LEAVE_OVERLAP");
      const days = leaveDays(body.fromDate, body.toDate, body.halfDay);
      const year = Number(body.fromDate.slice(0, 4));
      if (type.isPaid && dec(type.annualQuota).gt(0)) {
        const bal = await balanceRow(tx, ctx, e.id, type, year);
        const left = available(bal).minus(await pendingDays(tx, e.id, type.id, year));
        if (left.lt(days)) throw conflict("LEAVE_BALANCE_INSUFFICIENT", { available: left.toFixed(1), requested: dec(days).toFixed(1) });
      }
      const id = uuidv7();
      await tx.insert(lr).values({ id, businessId: ctx.businessId, employeeId: e.id, leaveTypeId: type.id, fromDate: body.fromDate, toDate: body.toDate, halfDay: body.halfDay, days, reason: body.reason ?? null, createdBy: ctx.userId, updatedBy: ctx.userId });
      await audit(tx, ctx, { action: "leave.applied", entityType: "leave_request", entityId: id, entityLabel: `${e.name} ${type.code}`, changes: { from: body.fromDate, to: body.toDate, days } });
      return requestDetail(tx, ctx, id);
    });
    return reply.code(201).send(detail);
  });

  /** Approve (balance used, days marked as leave in attendance) or reject. */
  r.post("/leave/requests/:id/decide", { preHandler: guard(deps, "leave.approve"), schema: { tags: ["leave"], params: IdParams, body: LeaveDecisionBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [req] = await tx.select().from(lr).where(and(eq(lr.id, request.params.id), eq(lr.businessId, ctx.businessId))).for("update");
      if (!req) throw notFound("leave_request");
      if (req.status !== "pending") throw conflict("LEAVE_NOT_PENDING", { status: req.status });
      const now = deps.clock.now().toISOString();
      if (request.body.decision === "approve") {
        const [type] = await tx.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, req.leaveTypeId));
        const year = Number(req.fromDate.slice(0, 4));
        const bal = await balanceRow(tx, ctx, req.employeeId, type!, year);
        if (type!.isPaid && dec(type!.annualQuota).gt(0) && available(bal).lt(req.days)) throw conflict("LEAVE_BALANCE_INSUFFICIENT", { available: available(bal).toFixed(1), requested: dec(req.days).toFixed(1) });
        await tx.update(lb).set({ used: dec(bal.used).plus(req.days).toFixed(3), updatedBy: ctx.userId }).where(eq(lb.id, bal.id));
        const a = schema.attendance;
        for (let d = req.fromDate; d <= req.toDate; d = addDays(d, 1)) {
          const note = `${type!.code}${req.halfDay ? " ½" : ""}`;
          await tx
            .insert(a)
            .values({ id: uuidv7(), businessId: ctx.businessId, employeeId: req.employeeId, date: d, status: "leave", note, createdBy: ctx.userId, updatedBy: ctx.userId })
            .onConflictDoUpdate({ target: [a.employeeId, a.date], set: { status: "leave", note, updatedBy: ctx.userId } });
        }
      }
      await tx
        .update(lr)
        .set({ status: request.body.decision === "approve" ? "approved" : "rejected", decidedBy: ctx.userId, decidedAt: now, decisionNote: request.body.note ?? null, updatedBy: ctx.userId })
        .where(eq(lr.id, req.id));
      await audit(tx, ctx, { action: request.body.decision === "approve" ? "leave.approved" : "leave.rejected", entityType: "leave_request", entityId: req.id, changes: { days: req.days, note: request.body.note ?? null } });
      return requestDetail(tx, ctx, req.id);
    });
  });

  /** Withdraw a request; an approved one gives its days back and clears the attendance marks. */
  r.post("/leave/requests/:id/cancel", { preHandler: guard(deps, "leave.apply"), schema: { tags: ["leave"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [req] = await tx.select().from(lr).where(and(eq(lr.id, request.params.id), eq(lr.businessId, ctx.businessId))).for("update");
      if (!req) throw notFound("leave_request");
      if (req.status !== "pending" && req.status !== "approved") throw conflict("LEAVE_NOT_PENDING", { status: req.status });
      if (req.status === "approved") {
        if (!can(ctx, "leave.approve")) throw forbidden("leave.approve");
        const [bal] = await tx.select().from(lb).where(and(eq(lb.employeeId, req.employeeId), eq(lb.leaveTypeId, req.leaveTypeId), eq(lb.year, Number(req.fromDate.slice(0, 4))))).for("update");
        if (bal) await tx.update(lb).set({ used: dec(bal.used).minus(req.days).toFixed(3), updatedBy: ctx.userId }).where(eq(lb.id, bal.id));
        await tx
          .delete(schema.attendance)
          .where(and(eq(schema.attendance.employeeId, req.employeeId), eq(schema.attendance.status, "leave"), sql`${schema.attendance.date} between ${req.fromDate} and ${req.toDate}`));
      }
      await tx.update(lr).set({ status: "cancelled", updatedBy: ctx.userId }).where(eq(lr.id, req.id));
      await audit(tx, ctx, { action: "leave.cancelled", entityType: "leave_request", entityId: req.id, changes: { was: req.status, days: req.days } });
      return requestDetail(tx, ctx, req.id);
    });
  });
};
