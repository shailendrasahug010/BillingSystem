import { describe, expect, it } from "vitest";
import {
  calculateSalarySlip,
  esiContribution,
  esiCovered,
  esiPeriodStart,
  pfEmployerCharges,
  professionalTax,
  providentFund,
  PT_RULES,
  type SalaryComponent,
} from "../src/index.js";

const pay = (basic: number, hra = 0, conv = 0, extra: Array<[string, number]> = []) => [
  { code: "BASIC", amount: String(basic) },
  ...(hra ? [{ code: "HRA", amount: String(hra) }] : []),
  ...(conv ? [{ code: "CONV", amount: String(conv) }] : []),
  ...extra.map(([code, amount]) => ({ code, amount: String(amount) })),
];
const PF = { restrictToCeiling: true, wagesRule: "codes" as const, epsMember: true };

describe("provident fund", () => {
  it("takes 12% of basic below the ceiling; the employer's 12% splits into EPS 8.33% and EPF", () => {
    expect(providentFund(pay(12000, 4800, 1600), PF)).toEqual({ wages: "12000", epfWages: "12000", epsWages: "12000", edliWages: "12000", employee: "1440", employerEps: "1000", employerEpf: "440" });
  });

  it("counts allowances above half the pay as PF wages under the labour codes, not before them", () => {
    // Basic 8,000 of a 20,000 pay: the allowances (12,000) are more than half, so wages are 10,000.
    expect(providentFund(pay(8000, 8000, 4000), PF)).toMatchObject({ wages: "10000", employee: "1200" });
    expect(providentFund(pay(8000, 8000, 4000), { ...PF, wagesRule: "basic_da" })).toMatchObject({ wages: "8000", employee: "960" });
    // Overtime and bonus are pay too.
    expect(providentFund(pay(6000, 0, 0, [["OT", 3000], ["BONUS", 3000]]), PF)).toMatchObject({ wages: "6000", employee: "720" });
  });

  it("stops at ₹15,000 unless the employer pays on full wages; EPS is capped at ₹1,250 either way", () => {
    expect(providentFund(pay(25000), PF)).toMatchObject({ wages: "25000", epfWages: "15000", employee: "1800", employerEps: "1250", employerEpf: "550", edliWages: "15000" });
    expect(providentFund(pay(25000), { ...PF, restrictToCeiling: false })).toMatchObject({ epfWages: "25000", employee: "3000", employerEps: "1250", employerEpf: "1750", epsWages: "15000" });
  });

  it("puts all of the employer's share in EPF for a member outside the pension scheme", () => {
    expect(providentFund(pay(25000), { ...PF, epsMember: false })).toMatchObject({ epsWages: "0", employerEps: "0", employerEpf: "1800" });
  });

  it("works out EDLI and admin charges on the month's wages, admin at least ₹500", () => {
    expect(pfEmployerCharges([{ epfWages: "12000", edliWages: "12000" }, { epfWages: "15000", edliWages: "15000" }])).toEqual({ edli: "135", adminCharges: "500" });
    expect(pfEmployerCharges(Array.from({ length: 10 }, () => ({ epfWages: "15000", edliWages: "15000" })))).toEqual({ edli: "750", adminCharges: "750" });
    expect(pfEmployerCharges([])).toEqual({ edli: "0", adminCharges: "0" });
  });
});

describe("ESI", () => {
  it("takes 0.75% and 3.25% of the pay, rounded up to the rupee, leaving out the bonus", () => {
    expect(esiContribution(pay(12000, 4800, 1600), "30")).toEqual({ wages: "18400.00", employee: "138", employer: "598" });
    expect(esiContribution(pay(15555), "30")).toMatchObject({ employee: "117", employer: "506" });
    expect(esiContribution(pay(12000, 0, 0, [["BONUS", 5000], ["OT", 400]]), "30")).toMatchObject({ wages: "12400.00", employee: "93", employer: "403" });
  });

  it("asks nothing of an employee earning ₹176 a day or less; the employer still pays", () => {
    expect(esiContribution(pay(5000), "30")).toEqual({ wages: "5000.00", employee: "0", employer: "163" });
  });

  it("decides coverage per contribution period, April–September and October–March", () => {
    expect(["2026-04", "2026-09", "2026-10", "2027-02", "2026-03"].map(esiPeriodStart)).toEqual(["2026-04-01", "2026-04-01", "2026-10-01", "2026-10-01", "2025-10-01"]);
    expect(esiCovered("21000")).toBe(true);
    expect(esiCovered("21000.01")).toBe(false);
  });
});

describe("professional tax", () => {
  it("Maharashtra: ₹175 / ₹200 a month, ₹300 in February; women up to ₹25,000 pay nothing", () => {
    const mh = PT_RULES["27"]!;
    expect([7500, 9000, 18400].map((g) => professionalTax(mh, g, "2026-09"))).toEqual([0, 175, 200]);
    expect(professionalTax(mh, 18400, "2027-02")).toBe(300);
    expect(professionalTax(mh, 18400, "2026-09", true)).toBe(0);
    expect(professionalTax(mh, 30000, "2027-02", true)).toBe(300);
  });

  it("Madhya Pradesh: slabs on the yearly pay, the balance in March", () => {
    const mp = PT_RULES["23"]!;
    expect([18400, 20000, 30000, 40000].map((g) => professionalTax(mp, g, "2026-09"))).toEqual([0, 125, 166, 208]);
    expect(professionalTax(mp, 30000, "2027-03")).toBe(174);
    expect(professionalTax(mp, 40000, "2027-03")).toBe(212);
  });

  it("Karnataka: from ₹25,000 a month", () => {
    const ka = PT_RULES["29"]!;
    expect([24999, 25000].map((g) => professionalTax(ka, g, "2026-09"))).toEqual([0, 200]);
    expect(professionalTax(ka, 25000, "2027-02")).toBe(300);
  });
});

const c = (id: string, code: string, type: "earning" | "deduction", calcType: SalaryComponent["calcType"], sortOrder: number, extra: Partial<SalaryComponent> = {}): SalaryComponent => ({
  id,
  code,
  name: code === "PF" ? "Provident Fund" : code,
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
  c("pf", "PF", "deduction", "percent_of_basic", 6),
  c("esi", "ESI", "deduction", "manual", 7),
  c("pt", "PT", "deduction", "manual", 8, { isProrated: false }),
  c("tds", "TDS", "deduction", "manual", 9, { isProrated: false }),
];
const structure = {
  basic: "12000",
  overtimeRatePerHour: "0",
  lines: [
    { componentId: "hra", amount: "0", percent: "40" },
    { componentId: "conv", amount: "1600", percent: "0" },
    // As set up by hand before: 10% PF and a fixed ESI; the law replaces both.
    { componentId: "pf", amount: "0", percent: "10" },
    { componentId: "esi", amount: "150", percent: "0" },
  ],
};

describe("salary slip with statutory deductions", () => {
  it("replaces the PF, ESI and PT components with the amounts the law gives", () => {
    const slip = calculateSalarySlip({
      components: COMPONENTS,
      structure,
      workingDays: "30",
      paidDays: "30",
      overtimeHours: "0",
      manual: new Map([["pt", "150"], ["tds", "500"]]),
      advances: [{ advanceId: "a1", label: "Advance recovery", installment: "1000", outstanding: "3000" }],
      statutory: { month: "2026-09", pf: PF, esi: { covered: true }, pt: { rule: PT_RULES["27"]!, female: false } },
    });
    expect(slip.lines.map((l) => [l.code, l.amount])).toEqual([
      ["BASIC", "12000.00"],
      ["HRA", "4800.00"],
      ["CONV", "1600.00"],
      ["PF", "1440.00"],
      ["ESI", "138.00"],
      ["PT", "200.00"],
      ["TDS", "500.00"],
      ["ADV", "1000.00"],
    ]);
    expect(slip.lines.find((l) => l.code === "PF")).toMatchObject({ componentId: "pf", label: "Provident Fund" });
    expect(slip).toMatchObject({ grossEarnings: "18400.00", totalDeductions: "3278.00", netPay: "15122.00" });
    expect(slip.statutory).toEqual({
      pf: { wages: "12000", epfWages: "12000", epsWages: "12000", edliWages: "12000", employee: "1440", employerEps: "1000", employerEpf: "440" },
      esi: { wages: "18400.00", employee: "138", employer: "598" },
      pt: { amount: "200" },
    });
  });

  it("leaves out whoever is not covered, and keeps the components as set up when the law is not applied", () => {
    const notCovered = calculateSalarySlip({ components: COMPONENTS, structure, workingDays: "30", paidDays: "30", overtimeHours: "0", statutory: { month: "2026-09", pf: null, esi: null } });
    expect(notCovered.lines.map((l) => l.code)).toEqual(["BASIC", "HRA", "CONV"]);
    expect(notCovered.statutory).toEqual({});
    const asSetUp = calculateSalarySlip({ components: COMPONENTS, structure, workingDays: "30", paidDays: "30", overtimeHours: "0" });
    expect(asSetUp.lines.filter((l) => l.type === "deduction").map((l) => [l.code, l.amount])).toEqual([
      ["PF", "1200.00"],
      ["ESI", "150.00"],
    ]);
    expect(asSetUp.statutory).toBeUndefined();
  });

  it("works PF out on the wages earned: unpaid days lower it", () => {
    const slip = calculateSalarySlip({ components: COMPONENTS, structure, workingDays: "30", paidDays: "27", overtimeHours: "0", statutory: { month: "2026-09", pf: PF } });
    // Basic 10,800 earned; pay 16,560, half 8,280: PF on 10,800.
    expect(slip.statutory?.pf).toMatchObject({ wages: "10800", employee: "1296", employerEps: "900" });
  });
});
