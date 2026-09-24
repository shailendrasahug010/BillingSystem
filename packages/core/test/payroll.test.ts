import { describe, expect, it } from "vitest";
import { calculateSalarySlip, leaveDays, payableDays, type SalaryComponent } from "../src/index.js";

const c = (id: string, code: string, type: "earning" | "deduction", calcType: SalaryComponent["calcType"], sortOrder: number, extra: Partial<SalaryComponent> = {}): SalaryComponent => ({
  id,
  code,
  name: code,
  type,
  calcType,
  defaultValue: "0",
  defaultPercent: "0",
  isProrated: true,
  sortOrder,
  ...extra,
});
const COMPONENTS = [
  c("basic", "BASIC", "earning", "fixed", 0),
  c("hra", "HRA", "earning", "percent_of_basic", 1),
  c("conv", "CONV", "earning", "fixed", 2),
  c("incent", "INCENT", "earning", "manual", 3, { isProrated: false }),
  c("ot", "OT", "earning", "per_hour", 4, { isProrated: false }),
  c("pf", "PF", "deduction", "percent_of_basic", 6, { defaultPercent: "12" }),
  c("pt", "PT", "deduction", "manual", 8, { isProrated: false }),
];

describe("payroll", () => {
  it("counts payable days: unmarked days are present, absence and unpaid leave are not paid", () => {
    const days = payableDays({
      monthStart: "2026-09-01",
      monthEnd: "2026-09-30",
      joiningDate: "2025-01-01",
      exitDate: null,
      attendance: [
        { date: "2026-09-03", status: "absent" },
        { date: "2026-09-04", status: "half_day" },
        { date: "2026-09-06", status: "week_off" },
        { date: "2026-09-10", status: "leave" },
        { date: "2026-09-11", status: "leave" },
        { date: "2026-09-12", status: "present", overtimeHours: "3" },
        { date: "2026-09-13", status: "present", overtimeHours: "1.5" },
      ],
      unpaidLeave: new Map([["2026-09-11", "1"]]),
    });
    expect(days).toEqual({ workingDays: "30.000", paidDays: "27.500", unpaidDays: "2.500", unpaidLeaveDays: "1.000", absentDays: "1.500", overtimeHours: "4.500" });
  });

  it("does not pay days before joining or after leaving", () => {
    const d = payableDays({ monthStart: "2026-09-01", monthEnd: "2026-09-30", joiningDate: "2026-09-16", exitDate: null, attendance: [], unpaidLeave: new Map() });
    expect(d.paidDays).toBe("15.000");
    const e = payableDays({ monthStart: "2026-09-01", monthEnd: "2026-09-30", joiningDate: "2024-01-01", exitDate: "2026-09-10", attendance: [], unpaidLeave: new Map() });
    expect(e.paidDays).toBe("10.000");
    expect(leaveDays("2026-09-10", "2026-09-12", false)).toBe("3.000");
    expect(leaveDays("2026-09-10", "2026-09-10", true)).toBe("0.500");
  });

  it("prorates the structure, adds incentive and overtime, deducts PF, PT and an advance", () => {
    const slip = calculateSalarySlip({
      components: COMPONENTS,
      structure: {
        basic: "12000",
        overtimeRatePerHour: "80",
        lines: [
          { componentId: "hra", amount: "0", percent: "40" },
          { componentId: "conv", amount: "1500", percent: "0" },
          { componentId: "pf", amount: "0", percent: "0" },
          { componentId: "pt", amount: "200", percent: "0" },
        ],
      },
      workingDays: "30",
      paidDays: "27.5",
      overtimeHours: "4.5",
      manual: new Map([["incent", "750"]]),
      advances: [{ advanceId: "adv1", label: "Advance recovery", installment: "1000", outstanding: "600" }],
    });
    // Basic 12000 x 27.5/30 = 11000; HRA 40% = 4400; conveyance 1500 x 27.5/30 = 1375;
    // incentive 750; overtime 4.5 h x 80 = 360; PF 12% of 11000 = 1320; PT 200; advance 600 (what is left).
    expect(slip.lines.map((l) => [l.code, l.amount])).toEqual([
      ["BASIC", "11000.00"],
      ["HRA", "4400.00"],
      ["CONV", "1375.00"],
      ["INCENT", "750.00"],
      ["OT", "360.00"],
      ["PF", "1320.00"],
      ["PT", "200.00"],
      ["ADV", "600.00"],
    ]);
    expect(slip).toMatchObject({ grossEarnings: "17885.00", totalDeductions: "2120.00", netPay: "15765.00" });
  });

  it("never recovers an advance below zero net pay", () => {
    const slip = calculateSalarySlip({
      components: COMPONENTS,
      structure: { basic: "3000", overtimeRatePerHour: "0", lines: [] },
      workingDays: "30",
      paidDays: "3",
      overtimeHours: "0",
      advances: [{ advanceId: "adv1", label: "Loan", installment: "5000", outstanding: "20000" }],
    });
    expect(slip).toMatchObject({ grossEarnings: "300.00", totalDeductions: "300.00", netPay: "0.00" });
  });
});
