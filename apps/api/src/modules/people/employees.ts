import { AdvanceBody, AttendanceBody, AttendanceMonthQuery, DepartmentBody, EmployeeBody, EmployeeExitBody, EmployeeListQuery, EmployeePatch, SalaryStructureBody } from "@vyapaar/contracts";
import { dec, monthBounds, normalizeIndianMobile, toAmountString } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit, diff } from "../../lib/audit.js";
import type { AppDeps, RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { nextMasterCode } from "../../services/numbering.js";
import { assertOwned } from "../../services/owned.js";
import { recordEmployeePayment } from "../../services/payments.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const emp = schema.employees;
const departmentName = sql<string | null>`(select d.name from departments d where d.id = "employees"."department_id")`;

type EmployeeInput = z.output<typeof EmployeeBody>;

/** Sensitive fields are stored encrypted with a masked copy for display. */
function sealed(deps: AppDeps, body: Partial<EmployeeInput>) {
  const out: Record<string, unknown> = {};
  if (body.bankAccountNumber) Object.assign(out, { bankAccountNumberEnc: deps.cipher.encrypt(body.bankAccountNumber), bankAccountLast4: body.bankAccountNumber.slice(-4) });
  if (body.pan) Object.assign(out, { panEnc: deps.cipher.encrypt(body.pan), panMasked: `${body.pan.slice(0, 2)}XXXXX${body.pan.slice(7)}` });
  if (body.aadhaar) Object.assign(out, { aadhaarEnc: deps.cipher.encrypt(body.aadhaar), aadhaarLast4: body.aadhaar.slice(-4) });
  return out;
}

function plain(body: Partial<EmployeeInput>) {
  const { bankAccountNumber: _a, pan: _p, aadhaar: _h, employeeCode: _c, mobile, emergencyContactPhone, ...rest } = body;
  return {
    ...rest,
    ...(mobile ? { mobile: normalizeIndianMobile(mobile) ?? mobile } : {}),
    ...(emergencyContactPhone ? { emergencyContactPhone: normalizeIndianMobile(emergencyContactPhone) ?? emergencyContactPhone } : {}),
  };
}

export async function employeeDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [row] = await tx.select({ e: emp, departmentName }).from(emp).where(and(eq(emp.id, id), eq(emp.businessId, ctx.businessId)));
  if (!row || row.e.deletedAt) throw notFound("employee");
  const { businessId: _b, bankAccountNumberEnc: _1, panEnc: _2, aadhaarEnc: _3, deletedAt: _4, deletedBy: _5, ...rest } = row.e;
  return { ...rest, monthlySalary: can(ctx, "payroll.view") ? rest.monthlySalary : null, departmentName: row.departmentName };
}

/** The structure in force on `date` with its component lines. */
export async function structureOn(tx: Tx, employeeId: string, date: string) {
  const s = schema.employeeSalaryStructures;
  const [row] = await tx.select().from(s).where(and(eq(s.employeeId, employeeId), lte(s.effectiveFrom, date))).orderBy(desc(s.effectiveFrom)).limit(1);
  if (!row) return null;
  const lines = await tx
    .select({ componentId: schema.employeeSalaryStructureComponents.componentId, amount: schema.employeeSalaryStructureComponents.amount, percent: schema.employeeSalaryStructureComponents.percent })
    .from(schema.employeeSalaryStructureComponents)
    .where(eq(schema.employeeSalaryStructureComponents.structureId, row.id));
  return { ...row, lines };
}

export const employeesModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const fyStartOf = async (tx: Tx, businessId: string) => (await tx.select({ m: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, businessId)))[0]!.m;

  // ---------------------------------------------------------------- departments
  r.get("/departments", { preHandler: guard(deps, "employee.view"), schema: { tags: ["employees"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx.select({ id: schema.departments.id, name: schema.departments.name, isActive: schema.departments.isActive }).from(schema.departments).where(eq(schema.departments.businessId, request.ctx.businessId)).orderBy(schema.departments.name),
    ),
  }));

  r.post("/departments", { preHandler: guard(deps, "employee.create"), schema: { tags: ["employees"], body: DepartmentBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const row = await tenant(ctx, async (tx) => {
      const [d] = await tx.insert(schema.departments).values({ id: uuidv7(), businessId: ctx.businessId, name: request.body.name, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
      await audit(tx, ctx, { action: "department.created", entityType: "department", entityId: d!.id, entityLabel: d!.name });
      return d!;
    });
    return reply.code(201).send({ id: row.id, name: row.name, isActive: row.isActive });
  });

  // ---------------------------------------------------------------- employees
  r.get("/employees", { preHandler: guard(deps, "employee.view"), schema: { tags: ["employees"], querystring: EmployeeListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const where: SQL[] = [eq(emp.businessId, ctx.businessId), sql`${emp.deletedAt} is null`];
    if (q.status === "current") where.push(inArray(emp.status, ["active", "on_notice"]));
    else if (q.status !== "all") where.push(eq(emp.status, q.status));
    if (q.departmentId) where.push(eq(emp.departmentId, q.departmentId));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(sql`(${emp.name} ilike ${like} or ${emp.employeeCode} ilike ${like} or ${emp.mobile} like ${like} or ${emp.designation} ilike ${like})`);
    }
    if (cursor) where.push(sql`(${emp.name}, ${emp.id}) > (${String(cursor.v)}, ${cursor.id}::uuid)`);
    const showSalary = can(ctx, "payroll.view");
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: emp.id,
          employeeCode: emp.employeeCode,
          name: emp.name,
          mobile: emp.mobile,
          designation: emp.designation,
          departmentId: emp.departmentId,
          departmentName,
          joiningDate: emp.joiningDate,
          exitDate: emp.exitDate,
          status: emp.status,
          monthlySalary: showSalary ? emp.monthlySalary : sql<null>`null`,
        })
        .from(emp)
        .where(and(...where))
        .orderBy(asc(emp.name), asc(emp.id))
        .limit(q.limit + 1),
    );
    return page(rows, q.limit, (x) => ({ v: x.name, id: x.id }));
  });

  r.post("/employees", { preHandler: guard(deps, "employee.create"), schema: { tags: ["employees"], body: EmployeeBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    const detail = await tenant(ctx, async (tx) => {
      await assertOwned(tx, schema.departments, ctx.businessId, body.departmentId, "departmentId");
      const today = deps.clock.today(ctx.timeZone);
      const code =
        body.employeeCode ??
        (await nextMasterCode(tx, ctx.businessId, "employee", today, async (c) => Boolean((await tx.select({ id: emp.id }).from(emp).where(and(eq(emp.businessId, ctx.businessId), eq(emp.employeeCode, c))))[0])));
      const id = uuidv7();
      await tx.insert(emp).values({
        id,
        businessId: ctx.businessId,
        employeeCode: code,
        ...plain(body),
        mobile: normalizeIndianMobile(body.mobile) ?? body.mobile,
        joiningDate: body.joiningDate,
        name: body.name,
        ...sealed(deps, body),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      await audit(tx, ctx, { action: "employee.created", entityType: "employee", entityId: id, entityLabel: `${code} ${body.name}` });
      return employeeDetail(tx, ctx, id);
    });
    return reply.code(201).send(detail);
  });

  r.get("/employees/:id", { preHandler: guard(deps, "employee.view"), schema: { tags: ["employees"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => employeeDetail(tx, request.ctx, request.params.id)),
  );

  /** Full bank account, PAN and Aadhaar (for salary transfers and statutory filings). */
  r.get("/employees/:id/sensitive", { preHandler: guard(deps, "employee.view_sensitive"), schema: { tags: ["employees"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [e] = await tx.select().from(emp).where(and(eq(emp.id, request.params.id), eq(emp.businessId, ctx.businessId)));
      if (!e) throw notFound("employee");
      await audit(tx, ctx, { action: "employee.sensitive_viewed", entityType: "employee", entityId: e.id, entityLabel: e.name });
      const open = (v: string | null) => (v ? deps.cipher.decrypt(v) : null);
      return { bankAccountName: e.bankAccountName, bankAccountNumber: open(e.bankAccountNumberEnc), bankIfsc: e.bankIfsc, pan: open(e.panEnc), aadhaar: open(e.aadhaarEnc) };
    });
  });

  r.patch("/employees/:id", { preHandler: guard(deps, "employee.update"), schema: { tags: ["employees"], params: IdParams, body: EmployeePatch } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return tenant(ctx, async (tx) => {
      const [before] = await tx.select().from(emp).where(and(eq(emp.id, request.params.id), eq(emp.businessId, ctx.businessId))).for("update");
      if (!before || before.deletedAt) throw notFound("employee");
      await assertOwned(tx, schema.departments, ctx.businessId, body.departmentId, "departmentId");
      const changes = { ...plain(body), ...(body.employeeCode ? { employeeCode: body.employeeCode } : {}), ...(body.status ? { status: body.status } : {}) };
      await tx.update(emp).set({ ...changes, ...sealed(deps, body), updatedBy: ctx.userId, version: before.version + 1 }).where(eq(emp.id, before.id));
      const masked = { ...(body.bankAccountNumber ? { bankAccount: "changed" } : {}), ...(body.pan ? { pan: "changed" } : {}), ...(body.aadhaar ? { aadhaar: "changed" } : {}) };
      await audit(tx, ctx, { action: "employee.updated", entityType: "employee", entityId: before.id, entityLabel: before.name, changes: { ...diff(before, changes), ...masked } });
      return employeeDetail(tx, ctx, before.id);
    });
  });

  r.post("/employees/:id/exit", { preHandler: guard(deps, "employee.update"), schema: { tags: ["employees"], params: IdParams, body: EmployeeExitBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [e] = await tx.select().from(emp).where(and(eq(emp.id, request.params.id), eq(emp.businessId, ctx.businessId))).for("update");
      if (!e || e.deletedAt) throw notFound("employee");
      if (e.exitDate) throw conflict("EMPLOYEE_ALREADY_EXITED");
      if (request.body.exitDate < e.joiningDate) throw badRequest("EXIT_BEFORE_JOINING", {}, "exitDate");
      await tx.update(emp).set({ exitDate: request.body.exitDate, status: request.body.status, updatedBy: ctx.userId, version: e.version + 1 }).where(eq(emp.id, e.id));
      await audit(tx, ctx, { action: "employee.exited", entityType: "employee", entityId: e.id, entityLabel: e.name, changes: { exitDate: request.body.exitDate, status: request.body.status, reason: request.body.reason ?? null } });
      return employeeDetail(tx, ctx, e.id);
    });
  });

  // ---------------------------------------------------------------- salary structure
  r.get("/salary-components", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"] } }, async (request) => ({
    data: await tenant(request.ctx, (tx) =>
      tx
        .select({
          id: schema.salaryComponents.id,
          code: schema.salaryComponents.code,
          name: schema.salaryComponents.name,
          nameHi: schema.salaryComponents.nameHi,
          type: schema.salaryComponents.type,
          calcType: schema.salaryComponents.calcType,
          defaultValue: schema.salaryComponents.defaultValue,
          defaultPercent: schema.salaryComponents.defaultPercent,
          isProrated: schema.salaryComponents.isProrated,
          sortOrder: schema.salaryComponents.sortOrder,
        })
        .from(schema.salaryComponents)
        .where(and(eq(schema.salaryComponents.businessId, request.ctx.businessId), eq(schema.salaryComponents.isActive, true)))
        .orderBy(schema.salaryComponents.sortOrder),
    ),
  }));

  r.get("/employees/:id/salary", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      await employeeDetail(tx, ctx, request.params.id);
      const s = schema.employeeSalaryStructures;
      const history = await tx.select().from(s).where(and(eq(s.employeeId, request.params.id), eq(s.businessId, ctx.businessId))).orderBy(desc(s.effectiveFrom));
      const current = await structureOn(tx, request.params.id, deps.clock.today(ctx.timeZone));
      return { current, history: history.map(({ businessId: _b, ...x }) => x) };
    });
  });

  /** A new structure from a date (a raise is a new row; history is kept). */
  r.put("/employees/:id/salary", { preHandler: guard(deps, "payroll.run"), schema: { tags: ["payroll"], params: IdParams, body: SalaryStructureBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return tenant(ctx, async (tx) => {
      const e = await employeeDetail(tx, ctx, request.params.id);
      const components = await tx.select().from(schema.salaryComponents).where(eq(schema.salaryComponents.businessId, ctx.businessId));
      const byId = new Map(components.map((c) => [c.id, c]));
      for (const [i, l] of body.components.entries()) if (!byId.has(l.componentId)) throw badRequest("REFERENCE_NOT_FOUND", {}, `components[${i}].componentId`);
      // Monthly gross for display: basic + fixed and percent-of-basic earnings.
      const gross = body.components.reduce((sum, l) => {
        const c = byId.get(l.componentId)!;
        if (c.type !== "earning" || c.code === "BASIC") return sum;
        if (c.calcType === "fixed") return sum.plus(l.amount);
        if (c.calcType === "percent_of_basic") return sum.plus(dec(body.basic).times(l.percent).dividedBy(100));
        return sum;
      }, dec(body.basic));
      const s = schema.employeeSalaryStructures;
      const [existing] = await tx.select({ id: s.id }).from(s).where(and(eq(s.employeeId, e.id), eq(s.effectiveFrom, body.effectiveFrom)));
      const id = existing?.id ?? uuidv7();
      const values = { basic: body.basic, monthlyGross: toAmountString(gross), overtimeRatePerHour: body.overtimeRatePerHour, notes: body.notes ?? null, updatedBy: ctx.userId };
      if (existing) {
        await tx.update(s).set(values).where(eq(s.id, id));
        await tx.delete(schema.employeeSalaryStructureComponents).where(eq(schema.employeeSalaryStructureComponents.structureId, id));
      } else {
        await tx.insert(s).values({ id, businessId: ctx.businessId, employeeId: e.id, effectiveFrom: body.effectiveFrom, ...values, createdBy: ctx.userId });
      }
      if (body.components.length) {
        await tx.insert(schema.employeeSalaryStructureComponents).values(body.components.map((l) => ({ businessId: ctx.businessId, structureId: id, componentId: l.componentId, amount: l.amount, percent: l.percent })));
      }
      await tx.update(emp).set({ monthlySalary: toAmountString(gross), updatedBy: ctx.userId }).where(eq(emp.id, e.id));
      await audit(tx, ctx, { action: "salary_structure.saved", entityType: "employee", entityId: e.id, entityLabel: e.name, changes: { effectiveFrom: body.effectiveFrom, basic: body.basic, monthlyGross: toAmountString(gross) } });
      return structureOn(tx, e.id, body.effectiveFrom);
    });
  });

  // ---------------------------------------------------------------- attendance
  /** Everyone employed on the day, with what is marked and any approved leave. */
  r.get("/attendance", { preHandler: guard(deps, "employee.view"), schema: { tags: ["employees"], querystring: z.object({ date: z.iso.date() }) } }, async (request) => {
    const ctx = request.ctx;
    const date = request.query.date;
    return tenant(ctx, async (tx) => {
      const rows = await tx.execute<{ id: string; employee_code: string; name: string; designation: string | null; status: string | null; check_in: string | null; check_out: string | null; overtime_hours: string | null; note: string | null; leave_type: string | null; half_day: boolean | null }>(sql`
        select e.id, e.employee_code, e.name, e.designation, a.status::text, to_char(a.check_in, 'HH24:MI') as check_in, to_char(a.check_out, 'HH24:MI') as check_out,
               a.overtime_hours::text, a.note, lt.code as leave_type, lr.half_day
        from employees e
        left join attendance a on a.employee_id = e.id and a.date = ${date}
        left join leave_requests lr on lr.employee_id = e.id and lr.status = 'approved' and ${date}::date between lr.from_date and lr.to_date
        left join leave_types lt on lt.id = lr.leave_type_id
        where e.business_id = ${ctx.businessId} and e.deleted_at is null and e.joining_date <= ${date} and (e.exit_date is null or e.exit_date >= ${date})
        order by e.name`);
      return {
        date,
        data: rows.rows.map((x) => ({
          employeeId: x.id,
          employeeCode: x.employee_code,
          name: x.name,
          designation: x.designation,
          status: x.status,
          checkIn: x.check_in,
          checkOut: x.check_out,
          overtimeHours: x.overtime_hours ?? "0.000",
          note: x.note,
          leave: x.leave_type ? { type: x.leave_type, halfDay: Boolean(x.half_day) } : null,
        })),
      };
    });
  });

  r.put("/attendance", { preHandler: guard(deps, "employee.update"), schema: { tags: ["employees"], body: AttendanceBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    if (body.date > deps.clock.today(ctx.timeZone)) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "date");
    return tenant(ctx, async (tx) => {
      const ids = [...new Set(body.entries.map((x) => x.employeeId))];
      const found = await tx.select({ id: emp.id }).from(emp).where(and(eq(emp.businessId, ctx.businessId), inArray(emp.id, ids)));
      if (found.length !== ids.length) throw badRequest("REFERENCE_NOT_FOUND", {}, "entries");
      const a = schema.attendance;
      for (const x of body.entries) {
        const values = { status: x.status, checkIn: x.checkIn ?? null, checkOut: x.checkOut ?? null, overtimeHours: x.overtimeHours, note: x.note ?? null, updatedBy: ctx.userId };
        await tx
          .insert(a)
          .values({ id: uuidv7(), businessId: ctx.businessId, employeeId: x.employeeId, date: body.date, ...values, createdBy: ctx.userId })
          .onConflictDoUpdate({ target: [a.employeeId, a.date], set: values });
      }
      await audit(tx, ctx, { action: "attendance.marked", entityType: "attendance", entityLabel: body.date, changes: { entries: body.entries.length } });
      return { date: body.date, saved: body.entries.length };
    });
  });

  /** Month register: every day's mark per employee and the counts payroll uses. */
  r.get("/attendance/month", { preHandler: guard(deps, "employee.view"), schema: { tags: ["employees"], querystring: AttendanceMonthQuery } }, async (request) => {
    const ctx = request.ctx;
    const { start, end } = monthBounds(request.query.month);
    return tenant(ctx, async (tx) => {
      const employees = await tx
        .select({ id: emp.id, employeeCode: emp.employeeCode, name: emp.name, joiningDate: emp.joiningDate, exitDate: emp.exitDate })
        .from(emp)
        .where(and(eq(emp.businessId, ctx.businessId), sql`${emp.deletedAt} is null`, lte(emp.joiningDate, end), sql`(${emp.exitDate} is null or ${emp.exitDate} >= ${start})`))
        .orderBy(asc(emp.name));
      const marks = await tx
        .select({ employeeId: schema.attendance.employeeId, date: schema.attendance.date, status: schema.attendance.status, overtimeHours: schema.attendance.overtimeHours })
        .from(schema.attendance)
        .where(and(eq(schema.attendance.businessId, ctx.businessId), sql`${schema.attendance.date} between ${start} and ${end}`));
      return {
        month: request.query.month,
        from: start,
        to: end,
        data: employees.map((e) => {
          const mine = marks.filter((m) => m.employeeId === e.id);
          const count = (s: string) => mine.filter((m) => m.status === s).length;
          return {
            ...e,
            days: Object.fromEntries(mine.map((m) => [m.date, m.status])),
            counts: { present: count("present"), absent: count("absent"), halfDay: count("half_day"), leave: count("leave"), holiday: count("holiday"), weekOff: count("week_off") },
            overtimeHours: mine.reduce((s, m) => s.plus(m.overtimeHours), dec(0)).toFixed(3),
          };
        }),
      };
    });
  });

  // ---------------------------------------------------------------- advances and loans
  r.get("/employees/:id/advances", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    const a = schema.employeeAdvances;
    const rows = await tenant(ctx, (tx) =>
      tx
        .select({
          id: a.id,
          type: a.type,
          amount: a.amount,
          issuedOn: a.issuedOn,
          installmentAmount: a.installmentAmount,
          recoveredAmount: a.recoveredAmount,
          isClosed: a.isClosed,
          notes: a.notes,
          paymentNumber: sql<string | null>`(select p.payment_number from payments p where p.id = "employee_advances"."payment_id")`,
        })
        .from(a)
        .where(and(eq(a.businessId, ctx.businessId), eq(a.employeeId, request.params.id)))
        .orderBy(desc(a.issuedOn)),
    );
    return { data: rows };
  });

  /** Pay an advance or loan now; payroll recovers it in instalments. */
  r.post("/employees/:id/advances", { preHandler: guard(deps, "payroll.pay"), schema: { tags: ["payroll"], params: IdParams, body: AdvanceBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const body = request.body;
    if (dec(body.installmentAmount).lte(0) || dec(body.installmentAmount).gt(body.amount)) throw badRequest("INSTALLMENT_INVALID", {}, "installmentAmount");
    const res = await tenant(ctx, async (tx) => {
      const e = await employeeDetail(tx, ctx, request.params.id);
      if (!can(ctx, "payroll.view")) throw forbidden("payroll.view");
      const date = body.issuedOn ?? deps.clock.today(ctx.timeZone);
      if (date > deps.clock.today(ctx.timeZone)) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "issuedOn");
      const payment = await recordEmployeePayment(tx, ctx, await fyStartOf(tx, ctx.businessId), {
        employeeId: e.id,
        employeeName: e.name,
        date,
        amount: body.amount,
        method: body.method,
        paymentAccountId: body.paymentAccountId ?? null,
        notes: body.type === "loan" ? "Loan" : "Salary advance",
      });
      const id = uuidv7();
      await tx.insert(schema.employeeAdvances).values({
        id,
        businessId: ctx.businessId,
        employeeId: e.id,
        type: body.type,
        amount: body.amount,
        issuedOn: date,
        installmentAmount: body.installmentAmount,
        paymentId: payment.id,
        notes: body.notes ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      await audit(tx, ctx, { action: `employee.${body.type}_given`, entityType: "employee", entityId: e.id, entityLabel: e.name, changes: { amount: body.amount, installment: body.installmentAmount, payment: payment.paymentNumber } });
      return { id, paymentNumber: payment.paymentNumber };
    });
    return reply.code(201).send(res);
  });
};
