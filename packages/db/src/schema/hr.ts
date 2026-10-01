import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  time,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns, money, pk, qty, softDelete, tstz, versioned } from "./columns.js";
import { attendanceStatus, employeeStatus, leaveStatus } from "./enums.js";
import { businessId, files, states, users } from "./platform.js";

export const departments = pgTable(
  "departments",
  {
    id: pk(),
    businessId: businessId(),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [unique("departments_name_uq").on(t.businessId, t.name)],
);

/**
 * Employees (salespeople, warehouse staff, drivers, office). An employee may
 * have a login (user_id). Sensitive identifiers are stored encrypted
 * (application-level AES-GCM, key in a KMS/secret store) plus a masked copy
 * for display; Aadhaar is optional and only its last 4 digits are kept in clear.
 */
export const employees = pgTable(
  "employees",
  {
    id: pk(),
    businessId: businessId(),
    /** The business's own code for the employee (E001 ...), unique in the business. */
    employeeCode: varchar({ length: 20 }).notNull(),
    name: text().notNull(),
    mobile: varchar({ length: 15 }).notNull(),
    email: text(),
    addressLine1: text(),
    city: text(),
    /** State of the employee's address. */
    stateCode: char({ length: 2 }).references(() => states.code),
    pincode: varchar({ length: 6 }),
    /** First working day. */
    joiningDate: date({ mode: "string" }).notNull(),
    /** Last working day, once the employee has left. */
    exitDate: date({ mode: "string" }),
    /** Department the employee works in. */
    departmentId: uuid().references(() => departments.id),
    /** Job title (Salesman, Driver, Accountant ...). */
    designation: text(),
    /** Active, on notice, resigned or terminated (employees are kept, never deleted). */
    status: employeeStatus().notNull().default("active"),
    /** Monthly CTC for display; the structure used by payroll lives in employee_salary_structures. */
    monthlySalary: money().notNull().default("0"),
    /** Name on the salary bank account. */
    bankAccountName: text(),
    /** Salary bank account number, encrypted (AES-256-GCM); shown in full only with employee.view_sensitive. */
    bankAccountNumberEnc: text(),
    /** Last 4 digits of the account number, for display. */
    bankAccountLast4: varchar({ length: 4 }),
    /** IFSC of the bank branch. */
    bankIfsc: varchar({ length: 11 }),
    /** PAN, encrypted. */
    panEnc: text(),
    /** PAN with the middle hidden (AB XXXXX 34K), for display. */
    panMasked: varchar({ length: 10 }),
    /** Aadhaar number, encrypted (optional). */
    aadhaarEnc: text(),
    /** Last 4 digits of Aadhaar, for display. */
    aadhaarLast4: varchar({ length: 4 }),
    /** Who to call in an emergency. */
    emergencyContactName: text(),
    /** Their phone number. */
    emergencyContactPhone: varchar({ length: 15 }),
    /** Statutory: PF member (UAN), in the pension scheme, ESI insurance number, and gender for professional tax slabs. */
    pfMember: boolean().notNull().default(true),
    /** In the Employees' Pension Scheme: the employer's PF share is split into EPS 8.33% and EPF; otherwise it all goes to EPF. */
    epsMember: boolean().notNull().default(true),
    /** Universal Account Number for PF (12 digits), needed in the EPFO ECR file. */
    uan: varchar({ length: 12 }),
    /** ESI insurance number, for the ESIC monthly contribution sheet. */
    esiNumber: varchar({ length: 17 }),
    /** male, female or other: some states' professional tax has separate slabs for women. */
    gender: varchar({ length: 6 }),
    /** The employee's sign-in account, when they use the app. */
    userId: uuid().references(() => users.id),
    /** Photo of the employee. */
    photoFileId: uuid().references(() => files.id),
    notes: text(),
    ...auditColumns,
    ...softDelete,
    ...versioned,
  },
  (t) => [
    unique("employees_code_uq").on(t.businessId, t.employeeCode),
    index("employees_status_idx").on(t.businessId, t.status),
    check("employees_salary_chk", sql`${t.monthlySalary} >= 0`),
    check("employees_exit_chk", sql`${t.exitDate} is null or ${t.exitDate} >= ${t.joiningDate}`),
    check("employees_gender_chk", sql`${t.gender} is null or ${t.gender} in ('male', 'female', 'other')`),
  ],
);

export const attendance = pgTable(
  "attendance",
  {
    id: pk(),
    businessId: businessId(),
    /** The employee. */
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    /** The working day. */
    date: date({ mode: "string" }).notNull(),
    /** Present, absent, half day, leave, holiday or week off: payroll counts paid days from it. */
    status: attendanceStatus().notNull(),
    /** Time the employee arrived. */
    checkIn: time(),
    /** Time the employee left. */
    checkOut: time(),
    /** Overtime worked that day, paid at the structure's overtime rate. */
    overtimeHours: qty().notNull().default("0"),
    note: text(),
    ...auditColumns,
  },
  (t) => [unique("attendance_day_uq").on(t.employeeId, t.date), index("attendance_business_date_idx").on(t.businessId, t.date)],
);

/** Configurable leave types (Casual, Sick, Paid, Unpaid, Other...). */
export const leaveTypes = pgTable(
  "leave_types",
  {
    id: pk(),
    businessId: businessId(),
    /** Short code (CL, SL, PL ...). */
    code: varchar({ length: 10 }).notNull(),
    name: text().notNull(),
    nameHi: text(),
    /** Paid leave keeps the salary; unpaid leave is deducted in payroll. */
    isPaid: boolean().notNull().default(true),
    /** Days given each leave year. */
    annualQuota: qty().notNull().default("0"),
    /** Whether unused days move to the next year. */
    allowCarryForward: boolean().notNull().default(false),
    /** Most days that can move to the next year. */
    maxCarryForward: qty().notNull().default("0"),
    /** Whether half a day can be taken. */
    allowHalfDay: boolean().notNull().default(true),
    isActive: boolean().notNull().default(true),
    ...auditColumns,
  },
  (t) => [unique("leave_types_code_uq").on(t.businessId, t.code)],
);

export const leaveBalances = pgTable(
  "leave_balances",
  {
    id: pk(),
    businessId: businessId(),
    /** The employee. */
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    /** The leave type. */
    leaveTypeId: uuid()
      .notNull()
      .references(() => leaveTypes.id),
    /** Leave year, e.g. 2026 (or FY start year, per settings). */
    year: smallint().notNull(),
    /** Days brought forward from the previous year. */
    opening: qty().notNull().default("0"),
    /** Days given this year (the type's annual quota). */
    accrued: qty().notNull().default("0"),
    /** Days taken in approved requests. Available = opening + accrued + adjusted - used. */
    used: qty().notNull().default("0"),
    /** Manual correction in days (positive or negative). */
    adjusted: qty().notNull().default("0"),
    ...auditColumns,
  },
  (t) => [unique("leave_balances_uq").on(t.employeeId, t.leaveTypeId, t.year)],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: pk(),
    businessId: businessId(),
    /** The employee asking for leave. */
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    /** The type of leave. */
    leaveTypeId: uuid()
      .notNull()
      .references(() => leaveTypes.id),
    /** First day of leave. */
    fromDate: date({ mode: "string" }).notNull(),
    /** Last day of leave. */
    toDate: date({ mode: "string" }).notNull(),
    /** Half a day only (from_date = to_date). */
    halfDay: boolean().notNull().default(false),
    /** Days of leave counted against the balance. */
    days: qty().notNull(),
    /** Why the leave is wanted. */
    reason: text(),
    /** Pending, approved, rejected or cancelled. */
    status: leaveStatus().notNull().default("pending"),
    /** User who approved or rejected it. */
    decidedBy: uuid(),
    /** When it was decided. */
    decidedAt: tstz(),
    /** Note given with the decision. */
    decisionNote: text(),
    ...auditColumns,
  },
  (t) => [
    index("leave_requests_employee_idx").on(t.employeeId, t.fromDate),
    index("leave_requests_pending_idx").on(t.businessId).where(sql`${t.status} = 'pending'`),
    check("leave_requests_dates_chk", sql`${t.toDate} >= ${t.fromDate}`),
    check("leave_requests_days_chk", sql`${t.days} > 0`),
  ],
);
