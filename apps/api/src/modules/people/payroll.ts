import { PayrollPayBody, PayrollRunBody, SlipInputsBody } from "@vyapaar/contracts";
import {
  addDays,
  calculateSalarySlip,
  dec,
  esiCovered,
  esiPeriodStart,
  monthBounds,
  payableDays,
  pfEmployerCharges,
  PT_RULES,
  sum,
  type AttendanceStatus,
  type PtRule,
  type SalaryComponent,
  type StatutoryInput,
  type StatutoryResult,
} from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { formatDate } from "@vyapaar/i18n";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordEmployeePayment } from "../../services/payments.js";
import { getSettings } from "../../services/settings.js";
import { toCsv } from "../reports/reports.js";
import type { ApiModule } from "../types.js";
import { structureOn } from "./employees.js";

const IdParams = z.object({ id: z.uuid() });
const SlipParams = z.object({ id: z.uuid(), slipId: z.uuid() });
const runs = schema.payrollRuns;
const slips = schema.salarySlips;
const lines = schema.salarySlipLines;

type Run = typeof runs.$inferSelect;
type Employee = typeof schema.employees.$inferSelect;

async function components(tx: Tx, businessId: string): Promise<SalaryComponent[]> {
  const rows = await tx.select().from(schema.salaryComponents).where(and(eq(schema.salaryComponents.businessId, businessId), eq(schema.salaryComponents.isActive, true)));
  return rows.map((c) => ({ id: c.id, code: c.code, name: c.name, type: c.type, calcType: c.calcType, defaultValue: c.defaultValue, defaultPercent: c.defaultPercent, isProrated: c.isProrated, sortOrder: c.sortOrder }));
}

/** The business's PF / ESI / PT settings, with the professional tax state and its slabs worked out. */
async function statutorySetup(tx: Tx, businessId: string) {
  const settings = (await getSettings(tx, businessId, ["payroll.statutory"] as const))["payroll.statutory"];
  const [biz] = await tx.select({ stateCode: schema.businesses.stateCode }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const ptState = settings.pt.stateCode ?? biz!.stateCode;
  const ptRule: PtRule | null = settings.pt.rule ?? PT_RULES[ptState] ?? null;
  return { ...settings, ptState, ptRule };
}
type Statutory = Awaited<ReturnType<typeof statutorySetup>>;

/** What the law asks of this employee this month (see StatutoryInput); undefined when nothing is worked out by law. */
async function statutoryFor(tx: Tx, stat: Statutory, employee: Employee, month: string, monthlyGross: string): Promise<StatutoryInput | undefined> {
  if (!stat.pf.enabled && !stat.esi.enabled && !stat.pt.enabled) return undefined;
  let esi: { covered: true } | null = null;
  if (stat.esi.enabled) {
    // Covered for the whole contribution period if the pay at its start (or on joining) was within the limit.
    const start = esiPeriodStart(month);
    const from = employee.joiningDate > start ? employee.joiningDate : start;
    const atStart = await structureOn(tx, employee.id, from);
    if (esiCovered(atStart?.monthlyGross ?? monthlyGross)) esi = { covered: true };
  }
  return {
    month,
    ...(stat.pf.enabled ? { pf: employee.pfMember ? { restrictToCeiling: stat.pf.restrictToCeiling, wagesRule: stat.pf.wagesRule, epsMember: employee.epsMember } : null } : {}),
    ...(stat.esi.enabled ? { esi } : {}),
    ...(stat.pt.enabled ? { pt: stat.ptRule ? { rule: stat.ptRule, female: employee.gender === "female" } : null } : {}),
  };
}

/** The slip's statutory figures as stored: professional tax with the state it was worked out for. */
function storedStatutory(st: StatutoryResult, ptState: string): NonNullable<(typeof slips.$inferInsert)["statutory"]> {
  const { pt, ...rest } = st;
  return { ...rest, ...(pt ? { pt: { amount: pt.amount, stateCode: ptState } } : {}) };
}

/** Employees paid for (part of) the month. */
async function employeesOf(tx: Tx, businessId: string, start: string, end: string): Promise<Employee[]> {
  const e = schema.employees;
  return tx
    .select()
    .from(e)
    .where(and(eq(e.businessId, businessId), isNull(e.deletedAt), lte(e.joiningDate, end), sql`(${e.exitDate} is null or ${e.exitDate} >= ${start})`))
    .orderBy(asc(e.name));
}

/**
 * (Re)computes one employee's slip in a draft run from attendance, approved
 * unpaid leave, the salary structure in force at month end and open
 * advances. Manual amounts already on the slip are kept unless replaced.
 */
async function computeSlip(
  tx: Tx,
  ctx: RequestCtx,
  run: Run,
  employee: Employee,
  comps: SalaryComponent[],
  stat: Statutory,
  opts: { manual?: ReadonlyMap<string, string>; overtimeHours?: string } = {},
): Promise<"computed" | "no_structure"> {
  const { start, end } = monthBounds(run.periodMonth.slice(0, 7));
  const structure = await structureOn(tx, employee.id, end);
  const [existing] = await tx.select().from(slips).where(and(eq(slips.payrollRunId, run.id), eq(slips.employeeId, employee.id)));
  if (!structure) {
    if (existing) await tx.delete(slips).where(eq(slips.id, existing.id));
    return "no_structure";
  }
  let manual = opts.manual;
  if (!manual && existing) {
    const manualIds = new Set(comps.filter((c) => c.calcType === "manual").map((c) => c.id));
    const kept = await tx.select({ componentId: lines.componentId, amount: lines.amount }).from(lines).where(eq(lines.salarySlipId, existing.id));
    manual = new Map(kept.filter((l) => l.componentId && manualIds.has(l.componentId)).map((l) => [l.componentId!, l.amount]));
  }
  const marks = await tx
    .select({ date: schema.attendance.date, status: schema.attendance.status, overtimeHours: schema.attendance.overtimeHours })
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employeeId, employee.id), sql`${schema.attendance.date} between ${start} and ${end}`));
  const unpaidLeave = new Map<string, string>();
  const leaves = await tx.execute<{ from_date: string; to_date: string; half_day: boolean }>(sql`
    select r.from_date::text, r.to_date::text, r.half_day from leave_requests r join leave_types t on t.id = r.leave_type_id
    where r.employee_id = ${employee.id} and r.status = 'approved' and not t.is_paid and r.from_date <= ${end} and r.to_date >= ${start}`);
  for (const l of leaves.rows) for (let d = l.from_date; d <= l.to_date; d = addDays(d, 1)) if (d >= start && d <= end) unpaidLeave.set(d, l.half_day ? "0.5" : "1");
  const days = payableDays({
    monthStart: start,
    monthEnd: end,
    joiningDate: employee.joiningDate,
    exitDate: employee.exitDate,
    attendance: marks.map((m) => ({ date: m.date, status: m.status as AttendanceStatus, overtimeHours: m.overtimeHours })),
    unpaidLeave,
  });
  const overtime = opts.overtimeHours ?? days.overtimeHours;
  const advances = await tx
    .select()
    .from(schema.employeeAdvances)
    .where(and(eq(schema.employeeAdvances.employeeId, employee.id), eq(schema.employeeAdvances.isClosed, false), lte(schema.employeeAdvances.issuedOn, end)))
    .orderBy(asc(schema.employeeAdvances.issuedOn));
  const statutory = await statutoryFor(tx, stat, employee, run.periodMonth.slice(0, 7), structure.monthlyGross);
  const slip = calculateSalarySlip({
    ...(statutory ? { statutory } : {}),
    components: comps,
    structure: { basic: structure.basic, overtimeRatePerHour: structure.overtimeRatePerHour, lines: structure.lines },
    workingDays: days.workingDays,
    paidDays: days.paidDays,
    overtimeHours: overtime,
    ...(manual ? { manual } : {}),
    advances: advances.map((a) => ({
      advanceId: a.id,
      label: a.type === "loan" ? "Loan recovery" : "Advance recovery",
      installment: a.installmentAmount,
      outstanding: dec(a.amount).minus(a.recoveredAmount).toFixed(2),
    })),
  });
  // The slip keeps its id across recalculations; only its figures and lines change.
  const id = existing?.id ?? uuidv7();
  const figures = {
    workingDays: days.workingDays,
    paidDays: days.paidDays,
    unpaidLeaveDays: days.unpaidDays,
    overtimeHours: dec(overtime).toFixed(3),
    grossEarnings: slip.grossEarnings,
    totalDeductions: slip.totalDeductions,
    netPay: slip.netPay,
    statutory: slip.statutory && Object.keys(slip.statutory).length ? storedStatutory(slip.statutory, stat.ptState) : null,
    updatedBy: ctx.userId,
  };
  if (existing) {
    await tx.delete(lines).where(eq(lines.salarySlipId, id));
    await tx.update(slips).set(figures).where(eq(slips.id, id));
  } else {
    await tx.insert(slips).values({ id, businessId: ctx.businessId, payrollRunId: run.id, employeeId: employee.id, ...figures, createdBy: ctx.userId });
  }
  if (slip.lines.length) {
    await tx.insert(lines).values(
      slip.lines.map((l, i) => ({ businessId: ctx.businessId, salarySlipId: id, componentId: l.componentId, advanceId: l.advanceId, label: l.label, type: l.type, amount: l.amount, sortOrder: i })),
    );
  }
  return "computed";
}

async function refreshTotals(tx: Tx, runId: string, userId: string) {
  const [t] = (
    await tx.execute<{ gross: string; deductions: string; net: string }>(sql`
      select coalesce(sum(gross_earnings), 0)::text as gross, coalesce(sum(total_deductions), 0)::text as deductions, coalesce(sum(net_pay), 0)::text as net
      from salary_slips where payroll_run_id = ${runId}`)
  ).rows;
  await tx.update(runs).set({ totalGross: t!.gross, totalDeductions: t!.deductions, totalNet: t!.net, updatedBy: userId }).where(eq(runs.id, runId));
}

async function runDetail(tx: Tx, ctx: RequestCtx, id: string) {
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.businessId, ctx.businessId)));
  if (!run) throw notFound("payroll_run");
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.employee_id as "employeeId", e.employee_code as "employeeCode", e.name as "employeeName", e.designation,
           s.working_days::text as "workingDays", s.paid_days::text as "paidDays", s.unpaid_leave_days::text as "unpaidDays", s.overtime_hours::text as "overtimeHours",
           s.gross_earnings::text as "grossEarnings", s.total_deductions::text as "totalDeductions", s.net_pay::text as "netPay",
           s.paid_at as "paidAt", p.payment_number as "paymentNumber"
    from salary_slips s join employees e on e.id = s.employee_id left join payments p on p.id = s.payment_id
    where s.payroll_run_id = ${id} order by e.name`);
  const { start, end } = monthBounds(run.periodMonth.slice(0, 7));
  const withSlip = new Set(rows.rows.map((s) => s.employeeId));
  const skipped = (await employeesOf(tx, ctx.businessId, start, end)).filter((e) => !withSlip.has(e.id)).map((e) => ({ id: e.id, employeeCode: e.employeeCode, name: e.name }));
  const { businessId: _b, ...rest } = run;
  return { ...rest, month: run.periodMonth.slice(0, 7), slips: rows.rows, skipped };
}

const rupees = (v: string | number) => dec(v).toDecimalPlaces(0).toFixed(0);

/**
 * The month's PF, ESI and professional tax: each covered employee's figures
 * and what the business pays (the PF challan by account, ESI and PT totals),
 * with the numbers still missing for the filings.
 */
async function statutorySummary(tx: Tx, ctx: RequestCtx, id: string) {
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.businessId, ctx.businessId)));
  if (!run) throw notFound("payroll_run");
  const stat = await statutorySetup(tx, ctx.businessId);
  const rows = await tx
    .select({ slip: slips, e: schema.employees })
    .from(slips)
    .innerJoin(schema.employees, eq(schema.employees.id, slips.employeeId))
    .where(eq(slips.payrollRunId, id))
    .orderBy(asc(schema.employees.name));
  const who = (r: (typeof rows)[number]) => ({ employeeId: r.e.id, employeeCode: r.e.employeeCode, name: r.e.name });
  const { start, end } = monthBounds(run.periodMonth.slice(0, 7));
  const pfMembers = rows.flatMap((r) =>
    r.slip.statutory?.pf
      ? [{ ...who(r), uan: r.e.uan, grossWages: rupees(r.slip.grossEarnings), ncpDays: rupees(r.slip.unpaidLeaveDays), ...r.slip.statutory.pf }]
      : [],
  );
  const esiMembers = rows.flatMap((r) =>
    r.slip.statutory?.esi
      ? [
          {
            ...who(r),
            esiNumber: r.e.esiNumber,
            days: rupees(r.slip.paidDays),
            ...r.slip.statutory.esi,
            // Left during the month: the reason (2, left service) and the last day go with the return.
            leftOn: r.e.exitDate && r.e.exitDate >= start && r.e.exitDate <= end ? r.e.exitDate : null,
          },
        ]
      : [],
  );
  const ptRows = rows.flatMap((r) => (r.slip.statutory?.pt ? [{ ...who(r), gross: r.slip.grossEarnings, amount: r.slip.statutory.pt.amount }] : []));
  const total = (xs: ReadonlyArray<Record<string, unknown>>, k: string) => sum(xs.map((x) => String(x[k] ?? 0))).toFixed(0);
  const charges = pfEmployerCharges(pfMembers);
  const pf = {
    employee: total(pfMembers, "employee"),
    employerEpf: total(pfMembers, "employerEpf"),
    employerEps: total(pfMembers, "employerEps"),
    epfWages: total(pfMembers, "epfWages"),
    epsWages: total(pfMembers, "epsWages"),
    edliWages: total(pfMembers, "edliWages"),
    ...charges,
  };
  // The PF challan by account: 1 (both shares to EPF), 2 (admin), 10 (pension), 21 (EDLI), 22 (EDLI admin, nil).
  const accounts = { ac1: dec(pf.employee).plus(pf.employerEpf).toFixed(0), ac2: pf.adminCharges, ac10: pf.employerEps, ac21: pf.edli, ac22: "0" };
  const esi = { wages: sum(esiMembers.map((m) => m.wages)).toFixed(2), employee: total(esiMembers, "employee"), employer: total(esiMembers, "employer") };
  return {
    month: run.periodMonth.slice(0, 7),
    status: run.status,
    settings: {
      pf: { enabled: stat.pf.enabled, establishmentCode: stat.pf.establishmentCode, restrictToCeiling: stat.pf.restrictToCeiling, wagesRule: stat.pf.wagesRule },
      esi: { enabled: stat.esi.enabled, employerCode: stat.esi.employerCode },
      pt: { enabled: stat.pt.enabled, stateCode: stat.ptState, hasSlabs: stat.ptRule !== null },
    },
    pf: { members: pfMembers, totals: { ...pf, ...accounts, total: sum(Object.values(accounts)).toFixed(0) } },
    esi: { members: esiMembers, totals: { ...esi, total: dec(esi.employee).plus(esi.employer).toFixed(0) } },
    pt: { stateCode: stat.ptState, rows: ptRows, total: total(ptRows, "amount") },
    missing: [
      ...pfMembers.filter((m) => !m.uan).map((m) => ({ employeeId: m.employeeId, name: m.name, what: "uan" as const })),
      ...esiMembers.filter((m) => !m.esiNumber).map((m) => ({ employeeId: m.employeeId, name: m.name, what: "esiNumber" as const })),
    ],
  };
}

/** EPFO's electronic challan-cum-return (ECR 2.0): one line per member with a UAN, fields joined by #~#, whole rupees. */
function ecrText(summary: Awaited<ReturnType<typeof statutorySummary>>): string {
  return summary.pf.members
    .filter((m) => m.uan)
    .map((m) => [m.uan, m.name.toUpperCase(), m.grossWages, m.epfWages, m.epsWages, m.edliWages, m.employee, m.employerEps, m.employerEpf, m.ncpDays, "0"].join("#~#"))
    .join("\n");
}

export const payrollModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);
  const lockRun = async (tx: Tx, ctx: RequestCtx, id: string) => {
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.businessId, ctx.businessId))).for("update");
    if (!run) throw notFound("payroll_run");
    return run;
  };

  r.get("/payroll/runs", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"] } }, async (request) => ({
    data: await tenant(request.ctx, async (tx) =>
      (
        await tx
          .select({
            id: runs.id,
            periodMonth: runs.periodMonth,
            status: runs.status,
            totalGross: runs.totalGross,
            totalDeductions: runs.totalDeductions,
            totalNet: runs.totalNet,
            finalizedAt: runs.finalizedAt,
            employees: sql<number>`(select count(*)::int from salary_slips s where s.payroll_run_id = "payroll_runs"."id")`,
            paid: sql<number>`(select count(*)::int from salary_slips s where s.payroll_run_id = "payroll_runs"."id" and s.payment_id is not null)`,
          })
          .from(runs)
          .where(eq(runs.businessId, request.ctx.businessId))
          .orderBy(desc(runs.periodMonth))
      ).map((x) => ({ ...x, month: x.periodMonth.slice(0, 7) })),
    ),
  }));

  /** Start a month's payroll: a draft slip for everyone employed in the month who has a salary structure. */
  r.post("/payroll/runs", { preHandler: guard(deps, "payroll.run"), schema: { tags: ["payroll"], body: PayrollRunBody } }, async (request, reply) => {
    const ctx = request.ctx;
    const month = request.body.month;
    if (month > deps.clock.today(ctx.timeZone).slice(0, 7)) throw badRequest("PAYROLL_MONTH_IN_FUTURE", {}, "month");
    const detail = await tenant(ctx, async (tx) => {
      const [existing] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.businessId, ctx.businessId), eq(runs.periodMonth, `${month}-01`)));
      if (existing) throw conflict("PAYROLL_RUN_EXISTS", { id: existing.id });
      const id = uuidv7();
      const [run] = await tx.insert(runs).values({ id, businessId: ctx.businessId, periodMonth: `${month}-01`, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
      const { start, end } = monthBounds(month);
      const comps = await components(tx, ctx.businessId);
      const stat = await statutorySetup(tx, ctx.businessId);
      for (const e of await employeesOf(tx, ctx.businessId, start, end)) await computeSlip(tx, ctx, run!, e, comps, stat);
      await refreshTotals(tx, id, ctx.userId);
      await audit(tx, ctx, { action: "payroll.run_created", entityType: "payroll_run", entityId: id, entityLabel: month });
      return runDetail(tx, ctx, id);
    });
    return reply.code(201).send(detail);
  });

  r.get("/payroll/runs/:id", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => runDetail(tx, request.ctx, request.params.id)),
  );

  /** Recompute every slip of a draft run (after attendance, leave or salary changes); manual amounts stay. */
  r.post("/payroll/runs/:id/recalculate", { preHandler: guard(deps, "payroll.run"), schema: { tags: ["payroll"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const run = await lockRun(tx, ctx, request.params.id);
      if (run.status !== "draft") throw conflict("PAYROLL_NOT_DRAFT", { status: run.status });
      const { start, end } = monthBounds(run.periodMonth.slice(0, 7));
      const comps = await components(tx, ctx.businessId);
      const stat = await statutorySetup(tx, ctx.businessId);
      for (const e of await employeesOf(tx, ctx.businessId, start, end)) await computeSlip(tx, ctx, run, e, comps, stat);
      await refreshTotals(tx, run.id, ctx.userId);
      await audit(tx, ctx, { action: "payroll.recalculated", entityType: "payroll_run", entityId: run.id, entityLabel: run.periodMonth.slice(0, 7) });
      return runDetail(tx, ctx, run.id);
    });
  });

  /** This month's incentive, bonus, TDS and other manual amounts for one slip (and overtime, if corrected). */
  r.patch("/payroll/runs/:id/slips/:slipId", { preHandler: guard(deps, "payroll.run"), schema: { tags: ["payroll"], params: SlipParams, body: SlipInputsBody } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const run = await lockRun(tx, ctx, request.params.id);
      if (run.status !== "draft") throw conflict("PAYROLL_NOT_DRAFT", { status: run.status });
      const [slip] = await tx.select().from(slips).where(and(eq(slips.id, request.params.slipId), eq(slips.payrollRunId, run.id)));
      if (!slip) throw notFound("salary_slip");
      const comps = await components(tx, ctx.businessId);
      const manualIds = new Set(comps.filter((c) => c.calcType === "manual").map((c) => c.id));
      for (const [i, m] of request.body.manual.entries()) if (!manualIds.has(m.componentId)) throw badRequest("NOT_A_MANUAL_COMPONENT", {}, `manual[${i}].componentId`);
      const [employee] = await tx.select().from(schema.employees).where(eq(schema.employees.id, slip.employeeId));
      const current = await tx.select({ componentId: lines.componentId, amount: lines.amount }).from(lines).where(eq(lines.salarySlipId, slip.id));
      const manual = new Map(current.filter((l) => l.componentId && manualIds.has(l.componentId)).map((l) => [l.componentId!, l.amount]));
      for (const m of request.body.manual) manual.set(m.componentId, m.amount);
      await computeSlip(tx, ctx, run, employee!, comps, await statutorySetup(tx, ctx.businessId), { manual, ...(request.body.overtimeHours ? { overtimeHours: request.body.overtimeHours } : {}) });
      await refreshTotals(tx, run.id, ctx.userId);
      await audit(tx, ctx, { action: "payroll.slip_adjusted", entityType: "payroll_run", entityId: run.id, entityLabel: `${run.periodMonth.slice(0, 7)} ${employee!.name}`, changes: { manual: request.body.manual, overtimeHours: request.body.overtimeHours ?? null } });
      return runDetail(tx, ctx, run.id);
    });
  });

  /** Freeze the slips; advance and loan recoveries are applied now. */
  r.post("/payroll/runs/:id/finalize", { preHandler: guard(deps, "payroll.finalize"), schema: { tags: ["payroll"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const run = await lockRun(tx, ctx, request.params.id);
      if (run.status !== "draft") throw conflict("PAYROLL_NOT_DRAFT", { status: run.status });
      const recoveries = await tx.execute<{ advance_id: string; amount: string }>(sql`
        select l.advance_id, sum(l.amount)::text as amount from salary_slip_lines l join salary_slips s on s.id = l.salary_slip_id
        where s.payroll_run_id = ${run.id} and l.advance_id is not null group by l.advance_id`);
      for (const rec of recoveries.rows) {
        const [a] = await tx.select().from(schema.employeeAdvances).where(eq(schema.employeeAdvances.id, rec.advance_id)).for("update");
        const recovered = dec(a!.recoveredAmount).plus(rec.amount);
        await tx
          .update(schema.employeeAdvances)
          .set({ recoveredAmount: recovered.toFixed(2), isClosed: recovered.gte(a!.amount), version: a!.version + 1, updatedBy: ctx.userId })
          .where(eq(schema.employeeAdvances.id, a!.id));
      }
      await tx.update(runs).set({ status: "finalized", finalizedAt: deps.clock.now().toISOString(), finalizedBy: ctx.userId, version: run.version + 1, updatedBy: ctx.userId }).where(eq(runs.id, run.id));
      await audit(tx, ctx, { action: "payroll.finalized", entityType: "payroll_run", entityId: run.id, entityLabel: run.periodMonth.slice(0, 7), changes: { totalNet: run.totalNet, recoveries: recoveries.rows.length } });
      return runDetail(tx, ctx, run.id);
    });
  });

  r.delete("/payroll/runs/:id", { preHandler: guard(deps, "payroll.run"), schema: { tags: ["payroll"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    await tenant(ctx, async (tx) => {
      const run = await lockRun(tx, ctx, request.params.id);
      if (run.status !== "draft") throw conflict("PAYROLL_NOT_DRAFT", { status: run.status });
      await tx.delete(runs).where(eq(runs.id, run.id));
      await audit(tx, ctx, { action: "payroll.run_deleted", entityType: "payroll_run", entityId: run.id, entityLabel: run.periodMonth.slice(0, 7) });
    });
    return reply.code(204).send();
  });

  /** Pay the finalized slips (all unpaid, or the chosen ones): one payment per employee. */
  r.post("/payroll/runs/:id/pay", { preHandler: guard(deps, "payroll.pay"), schema: { tags: ["payroll"], params: IdParams, body: PayrollPayBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return tenant(ctx, async (tx) => {
      const run = await lockRun(tx, ctx, request.params.id);
      if (run.status === "draft") throw conflict("PAYROLL_NOT_FINALIZED");
      if (run.status === "paid") throw conflict("PAYROLL_ALREADY_PAID");
      const today = deps.clock.today(ctx.timeZone);
      const date = body.paidOn ?? today;
      if (date > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "paidOn");
      const [business] = await tx.select({ m: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
      const due = await tx
        .select({ slip: slips, name: schema.employees.name })
        .from(slips)
        .innerJoin(schema.employees, eq(schema.employees.id, slips.employeeId))
        .where(and(eq(slips.payrollRunId, run.id), isNull(slips.paymentId), ...(body.slipIds ? [inArray(slips.id, body.slipIds)] : [])))
        .for("update", { of: slips });
      if (!due.length) throw conflict("NOTHING_TO_PAY");
      const now = deps.clock.now().toISOString();
      const month = run.periodMonth.slice(0, 7);
      for (const { slip, name } of due) {
        if (dec(slip.netPay).lte(0)) {
          await tx.update(slips).set({ paidAt: now, updatedBy: ctx.userId }).where(eq(slips.id, slip.id));
          continue;
        }
        const payment = await recordEmployeePayment(tx, ctx, business!.m, {
          employeeId: slip.employeeId,
          employeeName: name,
          date,
          amount: slip.netPay,
          method: body.method,
          paymentAccountId: body.paymentAccountId ?? null,
          referenceNumber: body.referenceNumber ?? null,
          notes: `Salary ${month}`,
        });
        await tx.update(slips).set({ paymentId: payment.id, paidAt: now, updatedBy: ctx.userId }).where(eq(slips.id, slip.id));
      }
      const [left] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from salary_slips where payroll_run_id = ${run.id} and paid_at is null`)).rows;
      if (left!.n === 0) await tx.update(runs).set({ status: "paid", version: run.version + 1, updatedBy: ctx.userId }).where(eq(runs.id, run.id));
      await audit(tx, ctx, { action: "payroll.paid", entityType: "payroll_run", entityId: run.id, entityLabel: month, changes: { slips: due.length, method: body.method } });
      return runDetail(tx, ctx, run.id);
    });
  });

  r.get("/payroll/runs/:id/statutory", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"], params: IdParams } }, async (request) =>
    tenant(request.ctx, (tx) => statutorySummary(tx, request.ctx, request.params.id)),
  );

  /** The month's filings: the PF ECR text file, the ESI monthly contribution sheet and the professional tax list. */
  r.get(
    "/payroll/runs/:id/statutory/:file",
    { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"], params: IdParams.extend({ file: z.enum(["ecr", "esi", "pt"]) }) } },
    async (request, reply) => {
      const ctx = request.ctx;
      const summary = await tenant(ctx, (tx) => statutorySummary(tx, ctx, request.params.id));
      const [y, m] = summary.month.split("-");
      await tenant(ctx, (tx) => audit(tx, ctx, { action: "payroll.statutory_downloaded", entityType: "payroll_run", entityId: request.params.id, entityLabel: `${summary.month} ${request.params.file}` }));
      if (request.params.file === "ecr") {
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.header("content-disposition", `attachment; filename="ECR_${m}${y}.txt"`);
        return ecrText(summary);
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      if (request.params.file === "esi") {
        reply.header("content-disposition", `attachment; filename="ESI_${m}${y}.csv"`);
        return toCsv(
          [
            { key: "ip", label: "IP Number" },
            { key: "name", label: "IP Name" },
            { key: "days", label: "No of Days for which wages paid/payable during the month" },
            { key: "wages", label: "Total Monthly Wages" },
            { key: "reason", label: "Reason Code for Zero workings days" },
            { key: "last", label: "Last Working Day" },
          ],
          summary.esi.members.map((x) => ({ ip: x.esiNumber ?? "", name: x.name, days: x.days, wages: rupees(x.wages), reason: x.leftOn ? "2" : "", last: x.leftOn ? formatDate(x.leftOn) : "" })),
        );
      }
      reply.header("content-disposition", `attachment; filename="PT_${summary.pt.stateCode}_${m}${y}.csv"`);
      return toCsv(
        [
          { key: "employeeCode", label: "Employee code" },
          { key: "name", label: "Name" },
          { key: "gross", label: "Gross salary" },
          { key: "amount", label: "Professional tax" },
        ],
        summary.pt.rows,
      );
    },
  );

  /** One salary slip with its lines, for viewing and printing. */
  r.get("/payroll/slips/:id", { preHandler: guard(deps, "payroll.view"), schema: { tags: ["payroll"], params: IdParams } }, async (request) => {
    const ctx = request.ctx;
    return tenant(ctx, async (tx) => {
      const [row] = await tx
        .select({ slip: slips, run: runs, e: schema.employees, department: sql<string | null>`(select d.name from departments d where d.id = ${schema.employees.departmentId})` })
        .from(slips)
        .innerJoin(runs, eq(runs.id, slips.payrollRunId))
        .innerJoin(schema.employees, eq(schema.employees.id, slips.employeeId))
        .where(and(eq(slips.id, request.params.id), eq(slips.businessId, ctx.businessId)));
      if (!row) throw notFound("salary_slip");
      const slipLines = await tx
        .select({ label: lines.label, type: lines.type, amount: lines.amount, componentId: lines.componentId, advanceId: lines.advanceId, nameHi: schema.salaryComponents.nameHi, code: schema.salaryComponents.code })
        .from(lines)
        .leftJoin(schema.salaryComponents, eq(schema.salaryComponents.id, lines.componentId))
        .where(eq(lines.salarySlipId, row.slip.id))
        .orderBy(asc(lines.sortOrder));
      const payment = row.slip.paymentId
        ? (await tx.select({ number: schema.payments.paymentNumber, date: schema.payments.paymentDate, method: schema.payments.method }).from(schema.payments).where(eq(schema.payments.id, row.slip.paymentId)))[0]
        : null;
      const { businessId: _b, ...slip } = row.slip;
      return {
        ...slip,
        month: row.run.periodMonth.slice(0, 7),
        runStatus: row.run.status,
        employee: {
          id: row.e.id,
          employeeCode: row.e.employeeCode,
          name: row.e.name,
          designation: row.e.designation,
          department: row.department,
          joiningDate: row.e.joiningDate,
          bankAccountLast4: row.e.bankAccountLast4,
          bankIfsc: row.e.bankIfsc,
          panMasked: row.e.panMasked,
          uan: row.e.uan,
          esiNumber: row.e.esiNumber,
        },
        lines: slipLines,
        payment,
      };
    });
  });
};
