import { addDays } from "../dates.js";
import { dec, type Dec, roundAmount, ZERO } from "../money/decimal.js";

/**
 * Monthly salary for one employee. Pure and deterministic: the payroll run
 * gathers attendance, leave, the salary structure and open advances, and
 * this module turns them into slip lines. Amounts are rounded to paise per
 * line; the slip total is the sum of its lines.
 */

export type ComponentType = "earning" | "deduction";
export type CalcType = "fixed" | "percent_of_basic" | "per_day" | "per_hour" | "manual";

export interface SalaryComponent {
  id: string;
  code: string;
  name: string;
  type: ComponentType;
  calcType: CalcType;
  defaultValue: string;
  defaultPercent: string;
  /** Reduced in proportion to unpaid days. */
  isProrated: boolean;
  sortOrder: number;
}

export interface StructureLine {
  componentId: string;
  amount: string;
  percent: string;
}

export interface SalaryStructure {
  /** Monthly basic for a full month. */
  basic: string;
  overtimeRatePerHour: string;
  /** Components other than basic that apply to this employee. */
  lines: readonly StructureLine[];
}

export interface AdvanceDue {
  advanceId: string;
  label: string;
  installment: string;
  outstanding: string;
}

export interface SlipLine {
  componentId: string | null;
  advanceId: string | null;
  code: string;
  label: string;
  type: ComponentType;
  amount: string;
  sortOrder: number;
}

export interface SlipInput {
  components: readonly SalaryComponent[];
  structure: SalaryStructure;
  workingDays: string;
  paidDays: string;
  overtimeHours: string;
  /** Amounts for "manual" components this month (incentive, bonus, TDS...), by component id. */
  manual?: ReadonlyMap<string, string>;
  advances?: readonly AdvanceDue[];
}

export interface SlipResult {
  lines: SlipLine[];
  grossEarnings: string;
  totalDeductions: string;
  netPay: string;
}

export function calculateSalarySlip(input: SlipInput): SlipResult {
  const working = dec(input.workingDays);
  const paid = dec(input.paidDays);
  const factor = working.gt(0) ? paid.dividedBy(working) : ZERO;
  const byId = new Map(input.structure.lines.map((l) => [l.componentId, l]));
  const lines: SlipLine[] = [];
  const push = (c: SalaryComponent, amount: Dec) => {
    const a = roundAmount(amount);
    if (a.gt(0)) lines.push({ componentId: c.id, advanceId: null, code: c.code, label: c.name, type: c.type, amount: a.toFixed(2), sortOrder: c.sortOrder });
  };

  const basicComponent = input.components.find((c) => c.code === "BASIC");
  const basicFull = dec(input.structure.basic);
  const basicEarned = roundAmount(basicComponent?.isProrated === false ? basicFull : basicFull.times(factor));
  if (basicComponent) push(basicComponent, basicEarned);

  for (const c of [...input.components].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (c.code === "BASIC") continue;
    const line = byId.get(c.id);
    const manual = input.manual?.get(c.id);
    switch (c.calcType) {
      case "fixed":
        if (line) push(c, dec(line.amount).times(c.isProrated ? factor : 1));
        break;
      case "percent_of_basic":
        if (line) push(c, basicEarned.times(dec(line.percent).gt(0) ? line.percent : c.defaultPercent).dividedBy(100));
        break;
      case "per_day":
        if (line) push(c, dec(line.amount).times(paid));
        break;
      case "per_hour":
        push(c, dec(input.overtimeHours).times(dec(line?.amount ?? 0).gt(0) ? line!.amount : input.structure.overtimeRatePerHour));
        break;
      case "manual":
        push(c, dec(manual ?? (line ? line.amount : 0)));
        break;
    }
  }

  const gross = lines.filter((l) => l.type === "earning").reduce((s, l) => s.plus(l.amount), ZERO);
  let deductions = lines.filter((l) => l.type === "deduction").reduce((s, l) => s.plus(l.amount), ZERO);
  // Advance / loan recovery never takes the net pay below zero.
  for (const a of input.advances ?? []) {
    const room = gross.minus(deductions);
    const take = roundAmount(Dec_min(Dec_min(dec(a.installment), dec(a.outstanding)), room));
    if (take.lte(0)) continue;
    lines.push({ componentId: null, advanceId: a.advanceId, code: "ADV", label: a.label, type: "deduction", amount: take.toFixed(2), sortOrder: 1000 + lines.length });
    deductions = deductions.plus(take);
  }
  return { lines, grossEarnings: gross.toFixed(2), totalDeductions: deductions.toFixed(2), netPay: gross.minus(deductions).toFixed(2) };
}
const Dec_min = (a: Dec, b: Dec) => (a.lt(b) ? a : b);

export type AttendanceStatus = "present" | "absent" | "half_day" | "leave" | "holiday" | "week_off";

export interface DaysInput {
  /** First and last day of the month (YYYY-MM-DD). */
  monthStart: string;
  monthEnd: string;
  joiningDate: string;
  exitDate: string | null;
  /** Marked days only; an unmarked day counts as present. */
  attendance: ReadonlyArray<{ date: string; status: AttendanceStatus; overtimeHours?: string }>;
  /** Days of approved unpaid leave in the month: date -> 1 or 0.5. */
  unpaidLeave: ReadonlyMap<string, string>;
}

export interface DaysResult {
  workingDays: string;
  paidDays: string;
  unpaidDays: string;
  unpaidLeaveDays: string;
  absentDays: string;
  overtimeHours: string;
}

/**
 * Payable days on the calendar-month basis: every day of the month is paid
 * (weekly offs and holidays included) except absence, half of a half day,
 * approved unpaid leave, and days before joining or after leaving.
 */
export function payableDays(input: DaysInput): DaysResult {
  const marks = new Map(input.attendance.map((a) => [a.date, a]));
  let working = ZERO;
  let unpaid = ZERO;
  let unpaidLeave = ZERO;
  let absent = ZERO;
  let overtime = ZERO;
  for (let d = input.monthStart; d <= input.monthEnd; d = addDays(d, 1)) {
    working = working.plus(1);
    if (d < input.joiningDate || (input.exitDate && d > input.exitDate)) {
      unpaid = unpaid.plus(1);
      continue;
    }
    const mark = marks.get(d);
    overtime = overtime.plus(dec(mark?.overtimeHours ?? 0));
    const leave = input.unpaidLeave.get(d);
    if (leave) {
      unpaid = unpaid.plus(leave);
      unpaidLeave = unpaidLeave.plus(leave);
      // An unpaid half-day leave on a half day already counts; nothing more to deduct.
      continue;
    }
    if (mark?.status === "absent") {
      unpaid = unpaid.plus(1);
      absent = absent.plus(1);
    } else if (mark?.status === "half_day") {
      unpaid = unpaid.plus(0.5);
      absent = absent.plus(0.5);
    }
  }
  return {
    workingDays: working.toFixed(3),
    paidDays: working.minus(unpaid).toFixed(3),
    unpaidDays: unpaid.toFixed(3),
    unpaidLeaveDays: unpaidLeave.toFixed(3),
    absentDays: absent.toFixed(3),
    overtimeHours: overtime.toFixed(3),
  };
}

/** Calendar days of a leave from `from` to `to` (inclusive); a half day counts 0.5. */
export function leaveDays(from: string, to: string, halfDay: boolean): string {
  if (halfDay) return "0.500";
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) n += 1;
  return dec(n).toFixed(3);
}
