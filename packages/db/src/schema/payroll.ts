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
    code: varchar({ length: 12 }).notNull(),
    name: text().notNull(),
    nameHi: text(),
    type: salaryComponentType().notNull(),
    calcType: salaryCalcType().notNull().default("fixed"),
    defaultValue: money().notNull().default("0"),
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
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    effectiveFrom: date({ mode: "string" }).notNull(),
    basic: money().notNull(),
    monthlyGross: money().notNull(),
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
    structureId: uuid()
      .notNull()
      .references(() => employeeSalaryStructures.id, { onDelete: "cascade" }),
    componentId: uuid()
      .notNull()
      .references(() => salaryComponents.id),
    amount: money().notNull().default("0"),
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
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    type: advanceType().notNull(),
    amount: money().notNull(),
    issuedOn: date({ mode: "string" }).notNull(),
    installmentAmount: money().notNull(),
    recoveredAmount: money().notNull().default("0"),
    paymentId: uuid().references(() => payments.id),
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
    status: payrollStatus().notNull().default("draft"),
    totalGross: money().notNull().default("0"),
    totalDeductions: money().notNull().default("0"),
    totalNet: money().notNull().default("0"),
    finalizedAt: tstz(),
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
    payrollRunId: uuid()
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    workingDays: qty().notNull(),
    paidDays: qty().notNull(),
    unpaidLeaveDays: qty().notNull().default("0"),
    overtimeHours: qty().notNull().default("0"),
    grossEarnings: money().notNull(),
    totalDeductions: money().notNull(),
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
    paymentId: uuid().references(() => payments.id),
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
    salarySlipId: uuid()
      .notNull()
      .references(() => salarySlips.id, { onDelete: "cascade" }),
    componentId: uuid().references(() => salaryComponents.id),
    advanceId: uuid().references(() => employeeAdvances.id),
    label: text().notNull(),
    type: salaryComponentType().notNull(),
    amount: money().notNull(),
    sortOrder: smallint().notNull().default(0),
  },
  (t) => [index("salary_slip_lines_slip_idx").on(t.salarySlipId), check("salary_slip_lines_amount_chk", sql`${t.amount} >= 0`)],
);
