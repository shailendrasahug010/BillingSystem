import { sql } from "drizzle-orm";
import { boolean, check, date, index, jsonb, pgTable, smallint, text, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns, money, percent, pk, qty, tstz, versioned } from "./columns.js";
import { advanceType, payrollStatus, salaryCalcType, salaryComponentType } from "./enums.js";
import { employees } from "./hr.js";
import { payments } from "./payments.js";
import { businessId } from "./platform.js";

/** Configurable earnings / deductions: Basic, HRA, Conveyance, Incentive, PF, ESI, Professional Tax, TDS... */
export const salaryComponents = pgTable(
  "salary_components",
  {
    id: pk(),
    businessId: businessId(),
    /** Short code (BASIC, HRA, PF ...), unique in the business. */
    code: varchar({ length: 12 }).notNull(),
    name: text().notNull(),
    nameHi: text(),
    /** earning or deduction. */
    type: salaryComponentType().notNull(),
    /** How the amount is worked out: fixed, percent of basic, per day, per hour or typed each month (manual). */
    calcType: salaryCalcType().notNull().default("fixed"),
    /** Amount used when a structure does not give one (fixed, per day or per hour). */
    defaultValue: money().notNull().default("0"),
    /** Percent of basic used when a structure does not give one. */
    defaultPercent: percent().notNull().default("0"),
    /** Reduced proportionally for unpaid leave / absence. */
    isProrated: boolean().notNull().default(true),
    sortOrder: smallint().notNull().default(0),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [unique("salary_components_code_uq").on(t.businessId, t.code)],
);

/** An employee's salary structure from a date; a raise is a new row, history is kept. */
export const employeeSalaryStructures = pgTable(
  "employee_salary_structures",
  {
    id: pk(),
    businessId: businessId(),
    /** The employee. */
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    /** First day the structure applies; the latest one on or before a month is used. */
    effectiveFrom: date({ mode: "string" }).notNull(),
    /** Monthly basic pay. */
    basic: money().notNull(),
    /** Monthly gross pay (all earnings) for a full month. */
    monthlyGross: money().notNull(),
    /** Pay per overtime hour. */
    overtimeRatePerHour: money().notNull().default("0"),
    notes: text(),
    ...auditColumns,
  },
  (t) => [unique("employee_salary_structures_uq").on(t.employeeId, t.effectiveFrom)],
);

export const employeeSalaryStructureComponents = pgTable(
  "employee_salary_structure_components",
  {
    id: pk(),
    businessId: businessId(),
    /** The salary structure. */
    structureId: uuid()
      .notNull()
      .references(() => employeeSalaryStructures.id, { onDelete: "cascade" }),
    /** The salary component. */
    componentId: uuid()
      .notNull()
      .references(() => salaryComponents.id),
    /** Monthly amount of the component (fixed ones). */
    amount: money().notNull().default("0"),
    /** Percent of basic (percent-of-basic ones). */
    percent: percent().notNull().default("0"),
  },
  (t) => [unique("employee_salary_structure_components_uq").on(t.structureId, t.componentId)],
);

/** Salary advances and loans recovered through payroll. */
export const employeeAdvances = pgTable(
  "employee_advances",
  {
    id: pk(),
    businessId: businessId(),
    /** The employee. */
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    /** advance or loan; both are recovered from salary in instalments, under their own label on the slip. */
    type: advanceType().notNull(),
    /** Amount given. */
    amount: money().notNull(),
    /** Date it was given. */
    issuedOn: date({ mode: "string" }).notNull(),
    /** Amount recovered from each month's salary. */
    installmentAmount: money().notNull(),
    /** Recovered so far (when payroll is finalized). */
    recoveredAmount: money().notNull().default("0"),
    /** The payment by which the money was given. */
    paymentId: uuid().references(() => payments.id),
    /** Fully recovered. */
    isClosed: boolean().notNull().default(false),
    notes: text(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [
    index("employee_advances_open_idx").on(t.employeeId).where(sql`not ${t.isClosed}`),
    check("employee_advances_amount_chk", sql`${t.amount} > 0 and ${t.recoveredAmount} <= ${t.amount}`),
  ],
);

/** A month's payroll: draft (editable) -> finalized (slips frozen) -> paid. */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: pk(),
    businessId: businessId(),
    /** First day of the month. */
    periodMonth: date({ mode: "string" }).notNull(),
    /** Draft (editable), finalized (slips frozen, recoveries applied), paid or cancelled. */
    status: payrollStatus().notNull().default("draft"),
    /** Sum of the slips' gross earnings. */
    totalGross: money().notNull().default("0"),
    /** Sum of the slips' deductions. */
    totalDeductions: money().notNull().default("0"),
    /** Sum of the slips' net pay. */
    totalNet: money().notNull().default("0"),
    /** When the run was finalized. */
    finalizedAt: tstz(),
    /** User who finalized it. */
    finalizedBy: uuid(),
    ...auditColumns,
    ...versioned,
  },
  (t) => [unique("payroll_runs_period_uq").on(t.businessId, t.periodMonth)],
);

/** Salary slip ("Salaries") for one employee in one payroll run. */
export const salarySlips = pgTable(
  "salary_slips",
  {
    id: pk(),
    businessId: businessId(),
    /** The month's payroll run. */
    payrollRunId: uuid()
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    /** The employee. */
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    /** Days in the month (calendar-month basis). */
    workingDays: qty().notNull(),
    /** Days paid: every day except absence, half of half days, unpaid leave, and days before joining or after leaving. */
    paidDays: qty().notNull(),
    /** Approved unpaid leave in the month. */
    unpaidLeaveDays: qty().notNull().default("0"),
    /** Overtime hours from attendance. */
    overtimeHours: qty().notNull().default("0"),
    /** All earnings on the slip. */
    grossEarnings: money().notNull(),
    /** All deductions (PF, ESI, professional tax, TDS, advance recovery ...). */
    totalDeductions: money().notNull(),
    /** Gross earnings - total deductions (checked by the database). */
    netPay: money().notNull(),
    /**
     * PF, ESI and professional tax as worked out by law, with the wages they were
     * worked out on and the employer's shares (for the challans); null when not.
     */
    statutory: jsonb().$type<{
      pf?: { wages: string; epfWages: string; epsWages: string; edliWages: string; employee: string; employerEps: string; employerEpf: string };
      esi?: { wages: string; employee: string; employer: string };
      pt?: { amount: string; stateCode: string };
    }>(),
    /** The payment by which the salary was paid. */
    paymentId: uuid().references(() => payments.id),
    /** When the salary was paid. */
    paidAt: tstz(),
    ...auditColumns,
  },
  (t) => [
    unique("salary_slips_uq").on(t.payrollRunId, t.employeeId),
    index("salary_slips_employee_idx").on(t.employeeId),
    check("salary_slips_net_chk", sql`${t.netPay} = ${t.grossEarnings} - ${t.totalDeductions}`),
  ],
);

/** Slip lines: basic, allowances, incentive, overtime, bonus / leave deduction, advance & loan recovery... */
export const salarySlipLines = pgTable(
  "salary_slip_lines",
  {
    id: pk(),
    businessId: businessId(),
    /** The salary slip. */
    salarySlipId: uuid()
      .notNull()
      .references(() => salarySlips.id, { onDelete: "cascade" }),
    /** The salary component, for component lines. */
    componentId: uuid().references(() => salaryComponents.id),
    /** The advance or loan, for recovery lines. */
    advanceId: uuid().references(() => employeeAdvances.id),
    /** Line text printed on the slip. */
    label: text().notNull(),
    /** earning or deduction. */
    type: salaryComponentType().notNull(),
    /** Amount of the line. */
    amount: money().notNull(),
    sortOrder: smallint().notNull().default(0),
  },
  (t) => [index("salary_slip_lines_slip_idx").on(t.salarySlipId), check("salary_slip_lines_amount_chk", sql`${t.amount} >= 0`)],
);
