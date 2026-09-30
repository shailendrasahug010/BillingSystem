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
    employeeCode: varchar({ length: 20 }).notNull(),
    name: text().notNull(),
    mobile: varchar({ length: 15 }).notNull(),
    email: text(),
    addressLine1: text(),
    city: text(),
    stateCode: char({ length: 2 }).references(() => states.code),
    pincode: varchar({ length: 6 }),
    joiningDate: date({ mode: "string" }).notNull(),
    exitDate: date({ mode: "string" }),
    departmentId: uuid().references(() => departments.id),
    designation: text(),
    status: employeeStatus().notNull().default("active"),
    /** Monthly CTC for display; the structure used by payroll lives in employee_salary_structures. */
    monthlySalary: money().notNull().default("0"),
    bankAccountName: text(),
    bankAccountNumberEnc: text(),
    bankAccountLast4: varchar({ length: 4 }),
    bankIfsc: varchar({ length: 11 }),
    panEnc: text(),
    panMasked: varchar({ length: 10 }),
    aadhaarEnc: text(),
    aadhaarLast4: varchar({ length: 4 }),
    emergencyContactName: text(),
    emergencyContactPhone: varchar({ length: 15 }),
    /** Statutory: PF member (UAN), in the pension scheme, ESI insurance number, and gender for professional tax slabs. */
    pfMember: boolean().notNull().default(true),
    epsMember: boolean().notNull().default(true),
    uan: varchar({ length: 12 }),
    esiNumber: varchar({ length: 17 }),
    gender: varchar({ length: 6 }),
    userId: uuid().references(() => users.id),
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
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    date: date({ mode: "string" }).notNull(),
    status: attendanceStatus().notNull(),
    checkIn: time(),
    checkOut: time(),
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
    code: varchar({ length: 10 }).notNull(),
    name: text().notNull(),
    nameHi: text(),
    isPaid: boolean().notNull().default(true),
    annualQuota: qty().notNull().default("0"),
    allowCarryForward: boolean().notNull().default(false),
    maxCarryForward: qty().notNull().default("0"),
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
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    leaveTypeId: uuid()
      .notNull()
      .references(() => leaveTypes.id),
    /** Leave year, e.g. 2026 (or FY start year, per settings). */
    year: smallint().notNull(),
    opening: qty().notNull().default("0"),
    accrued: qty().notNull().default("0"),
    used: qty().notNull().default("0"),
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
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    leaveTypeId: uuid()
      .notNull()
      .references(() => leaveTypes.id),
    fromDate: date({ mode: "string" }).notNull(),
    toDate: date({ mode: "string" }).notNull(),
    halfDay: boolean().notNull().default(false),
    days: qty().notNull(),
    reason: text(),
    status: leaveStatus().notNull().default("pending"),
    decidedBy: uuid(),
    decidedAt: tstz(),
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
