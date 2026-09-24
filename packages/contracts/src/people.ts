import { z } from "zod";
import { Code, Id, IsoDate, Mobile, Money, PageQuery, Pan, PaymentMethod, Percent, Pincode, Qty, StateCode } from "./common.js";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "YYYY-MM" });
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "HH:MM" });
const text = (max: number) => z.string().trim().max(max);

const EmployeeFields = {
  employeeCode: Code.optional(),
  name: z.string().trim().min(2).max(120),
  mobile: Mobile,
  email: z.email().max(160).optional(),
  addressLine1: text(200).optional(),
  city: text(80).optional(),
  stateCode: StateCode.optional(),
  pincode: Pincode.optional(),
  joiningDate: IsoDate,
  departmentId: Id.optional(),
  designation: text(80).optional(),
  monthlySalary: Money.optional(),
  bankAccountName: text(120).optional(),
  /** Stored encrypted; only the last four digits are shown. */
  bankAccountNumber: z.string().trim().regex(/^\d{6,18}$/).optional(),
  bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
  pan: Pan.optional(),
  /** Stored encrypted; only the last four digits are shown. */
  aadhaar: z.string().trim().regex(/^\d{12}$/).optional(),
  emergencyContactName: text(120).optional(),
  emergencyContactPhone: Mobile.optional(),
  notes: text(1000).optional(),
};

export const EmployeeBody = z.strictObject(EmployeeFields);
export const EmployeePatch = EmployeeBody.partial().extend({ status: z.enum(["active", "on_notice"]).optional() });
export const EmployeeExitBody = z.strictObject({ exitDate: IsoDate, status: z.enum(["resigned", "terminated"]), reason: text(300).optional() });
export const EmployeeListQuery = PageQuery.extend({
  status: z.enum(["current", "active", "on_notice", "resigned", "terminated", "all"]).default("current"),
  departmentId: z.uuid().optional(),
});
export const DepartmentBody = z.strictObject({ name: z.string().trim().min(1).max(60) });

export const SalaryStructureBody = z.strictObject({
  effectiveFrom: IsoDate,
  basic: Money,
  overtimeRatePerHour: Money.default("0"),
  components: z
    .array(z.strictObject({ componentId: Id, amount: Money.default("0"), percent: Percent.default("0") }))
    .max(30)
    .default([]),
  notes: text(300).optional(),
});

export const AttendanceStatus = z.enum(["present", "absent", "half_day", "leave", "holiday", "week_off"]);
export const AttendanceBody = z.strictObject({
  date: IsoDate,
  entries: z
    .array(
      z.strictObject({
        employeeId: Id,
        status: AttendanceStatus,
        checkIn: Time.optional(),
        checkOut: Time.optional(),
        overtimeHours: Qty.default("0"),
        note: text(200).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export const AttendanceMonthQuery = z.object({ month: Month });

export const LeaveTypePatch = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  nameHi: text(60).nullable().optional(),
  isPaid: z.boolean().optional(),
  annualQuota: Qty.optional(),
  allowHalfDay: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export const LeaveRequestBody = z.strictObject({
  employeeId: Id,
  leaveTypeId: Id,
  fromDate: IsoDate,
  toDate: IsoDate,
  halfDay: z.boolean().default(false),
  reason: text(300).optional(),
});
export const LeaveDecisionBody = z.strictObject({ decision: z.enum(["approve", "reject"]), note: text(300).optional() });
export const LeaveListQuery = PageQuery.extend({
  status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("pending"),
  employeeId: z.uuid().optional(),
});
export const LeaveBalanceQuery = z.object({ employeeId: z.uuid().optional(), year: z.coerce.number().int().min(2000).max(2100).optional() });

export const PayrollRunBody = z.strictObject({ month: Month });
export const SlipInputsBody = z.strictObject({
  /** This month's amounts for manual components (incentive, bonus, ESI, professional tax, TDS...). */
  manual: z.array(z.strictObject({ componentId: Id, amount: Money })).max(20).default([]),
  overtimeHours: Qty.optional(),
});
export const PayrollPayBody = z.strictObject({
  method: PaymentMethod,
  paymentAccountId: Id.optional(),
  paidOn: IsoDate.optional(),
  referenceNumber: text(40).optional(),
  slipIds: z.array(Id).max(500).optional(),
});
export const AdvanceBody = z.strictObject({
  type: z.enum(["advance", "loan"]),
  amount: Money,
  issuedOn: IsoDate.optional(),
  installmentAmount: Money,
  method: PaymentMethod,
  paymentAccountId: Id.optional(),
  notes: text(300).optional(),
});
