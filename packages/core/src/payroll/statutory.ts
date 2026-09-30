import { DecimalClass as D, dec, maxDec, minDec, pct, sum, ZERO, type Dec, type DecimalInput } from "../money/decimal.js";

/**
 * Statutory deductions on a salary: provident fund (EPF and the pension
 * scheme, EPS), employees' state insurance (ESI) and the state's
 * professional tax (PT). Pure: the payroll run decides who is covered and
 * passes the month's earnings; the rates and limits below are the ones in
 * force and are kept in one place so a change is one edit.
 */

/** EPF wage ceiling (₹ a month). Contributions stop at it unless the employer pays on the full wages; EPS and EDLI always do. */
export const PF_WAGE_CEILING = "15000";
/** Employee share, and the employer's share in total (of which EPS takes 8.33%). */
export const PF_RATE = "12";
export const EPS_RATE = "8.33";
/** Employer only, on each member's wages up to the ceiling (account 21). */
export const EDLI_RATE = "0.5";
/** Employer only, on the month's EPF wages (account 2), at least ₹500 a month. */
export const PF_ADMIN_RATE = "0.5";
export const PF_ADMIN_MINIMUM = "500";

/** ESI covers employees earning up to this much a month (₹25,000 for a person with a disability). */
export const ESI_WAGE_LIMIT = "21000";
export const ESI_EMPLOYEE_RATE = "0.75";
export const ESI_EMPLOYER_RATE = "3.25";
/** Up to this average daily wage the employee pays no ESI; the employer still does. */
export const ESI_LOW_WAGE_PER_DAY = "176";

/** Salary components that are PF wages: basic, dearness allowance, retaining allowance. */
export const PF_WAGE_CODES: ReadonlySet<string> = new Set(["BASIC", "DA", "RA"]);
/** Left out of ESI wages: the annual (statutory) bonus. */
export const ESI_EXCLUDED_CODES: ReadonlySet<string> = new Set(["BONUS"]);

/**
 * How PF wages are read. `codes`: the Code on Social Security, 2020 (in force
 * from 21 November 2025): basic and DA, and when the allowances left out of
 * wages come to more than half the pay, the part above half counts as wages
 * too, so PF wages are at least half the month's pay. `basic_da`: basic and
 * DA only, as before the codes.
 */
export type PfWagesRule = "codes" | "basic_da";

export interface Earning {
  code: string;
  amount: DecimalInput;
}

const rupees = (v: Dec) => v.toDecimalPlaces(0, D.ROUND_HALF_UP);
const rupeesUp = (v: Dec) => v.toDecimalPlaces(0, D.ROUND_CEIL);
const whole = (v: Dec) => v.toFixed(0);

export function pfWagesOf(earnings: readonly Earning[], rule: PfWagesRule): Dec {
  const base = sum(earnings.filter((e) => PF_WAGE_CODES.has(e.code)).map((e) => e.amount));
  if (rule === "basic_da") return base;
  const pay = sum(earnings.map((e) => e.amount));
  return maxDec(base, pay.dividedBy(2));
}

export interface PfOptions {
  /** Contribute on at most ₹15,000 (the usual choice); false: on the full PF wages. */
  restrictToCeiling: boolean;
  wagesRule: PfWagesRule;
  /**
   * In the pension scheme (EPS). Not those who joined PF after 1 September
   * 2014 earning above the ceiling, nor members past 58: their employer's
   * 12% all goes to EPF.
   */
  epsMember: boolean;
}

/** One member's PF for the month, in whole rupees as the ECR carries them. */
export interface PfResult {
  /** PF wages as the rules read them, before the ceiling. */
  wages: string;
  epfWages: string;
  epsWages: string;
  edliWages: string;
  /** Deducted from pay (account 1). */
  employee: string;
  /** Employer: the pension part (account 10) and the rest to EPF (account 1). */
  employerEps: string;
  employerEpf: string;
}

export function providentFund(earnings: readonly Earning[], opts: PfOptions): PfResult {
  const wages = rupees(pfWagesOf(earnings, opts.wagesRule));
  const capped = minDec(wages, PF_WAGE_CEILING);
  const epfWages = opts.restrictToCeiling ? capped : wages;
  const employee = rupees(pct(epfWages, PF_RATE));
  const employerTotal = rupees(pct(epfWages, PF_RATE));
  const epsWages = opts.epsMember ? capped : ZERO;
  const eps = minDec(rupees(pct(epsWages, EPS_RATE)), employerTotal);
  return {
    wages: whole(wages),
    epfWages: whole(epfWages),
    epsWages: whole(epsWages),
    edliWages: whole(capped),
    employee: whole(employee),
    employerEps: whole(eps),
    employerEpf: whole(employerTotal.minus(eps)),
  };
}

/** The employer's other PF dues for the month: EDLI (account 21) and admin charges (account 2). */
export function pfEmployerCharges(members: ReadonlyArray<Pick<PfResult, "epfWages" | "edliWages">>): { edli: string; adminCharges: string } {
  if (members.length === 0) return { edli: "0", adminCharges: "0" };
  const edli = rupees(pct(sum(members.map((m) => m.edliWages)), EDLI_RATE));
  const admin = maxDec(rupees(pct(sum(members.map((m) => m.epfWages)), PF_ADMIN_RATE)), PF_ADMIN_MINIMUM);
  return { edli: whole(edli), adminCharges: whole(admin) };
}

/**
 * ESI contribution periods run April–September and October–March. Whether
 * an employee is covered is decided on their wages at the start of the
 * period (or when they join) and holds for the whole period.
 */
export function esiPeriodStart(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  if (m >= 4 && m <= 9) return `${y}-04-01`;
  return m >= 10 ? `${y}-10-01` : `${y - 1}-10-01`;
}

export function esiCovered(monthlyWages: DecimalInput): boolean {
  return dec(monthlyWages).lte(ESI_WAGE_LIMIT);
}

export interface EsiResult {
  wages: string;
  /** Deducted from pay; nothing when the average daily wage is ₹176 or less. */
  employee: string;
  employer: string;
}

/** Contributions are rounded up to the next rupee. */
export function esiContribution(earnings: readonly Earning[], paidDays: DecimalInput): EsiResult {
  const wages = sum(earnings.filter((e) => !ESI_EXCLUDED_CODES.has(e.code)).map((e) => e.amount));
  const days = dec(paidDays);
  const lowWage = days.gt(0) && wages.dividedBy(days).lte(ESI_LOW_WAGE_PER_DAY);
  return {
    wages: wages.toFixed(2),
    employee: whole(lowWage ? ZERO : rupeesUp(pct(wages, ESI_EMPLOYEE_RATE))),
    employer: whole(rupeesUp(pct(wages, ESI_EMPLOYER_RATE))),
  };
}

/** Professional tax for pay above `above` (₹); `special` is a different amount in one month of the year. */
export interface PtSlab {
  above: number;
  amount: number;
  special?: { month: number; amount: number };
}

export interface PtRule {
  /** Slabs read on the month's gross pay, or on it × 12 (states with yearly slabs). */
  basis: "monthly" | "annual";
  slabs: PtSlab[];
  /** Different slabs for women (Maharashtra). */
  femaleSlabs?: PtSlab[];
}

/**
 * Built-in slabs for the states whose professional tax is deducted monthly.
 * They are a starting point: a business can replace them with the slabs of
 * its state's current notification. States with a half-yearly tax (Tamil
 * Nadu, Kerala…) are entered by the business.
 */
export const PT_RULES: Readonly<Record<string, PtRule>> = {
  // Maharashtra: ₹2,500 a year above ₹10,000 (₹300 in February); women up to ₹25,000 pay nothing.
  "27": {
    basis: "monthly",
    slabs: [
      { above: 7500, amount: 175 },
      { above: 10000, amount: 200, special: { month: 2, amount: 300 } },
    ],
    femaleSlabs: [{ above: 25000, amount: 200, special: { month: 2, amount: 300 } }],
  },
  // Karnataka: ₹25,000 a month and more, ₹200 (₹300 in February).
  "29": { basis: "monthly", slabs: [{ above: 24999, amount: 200, special: { month: 2, amount: 300 } }] },
  "19": {
    basis: "monthly",
    slabs: [
      { above: 10000, amount: 110 },
      { above: 15000, amount: 130 },
      { above: 25000, amount: 150 },
      { above: 40000, amount: 200 },
    ],
  },
  "24": { basis: "monthly", slabs: [{ above: 11999, amount: 200 }] },
  "36": {
    basis: "monthly",
    slabs: [
      { above: 15000, amount: 150 },
      { above: 20000, amount: 200 },
    ],
  },
  "37": {
    basis: "monthly",
    slabs: [
      { above: 15000, amount: 150 },
      { above: 20000, amount: 200 },
    ],
  },
  // Madhya Pradesh: yearly slabs; the year's balance falls in March.
  "23": {
    basis: "annual",
    slabs: [
      { above: 225000, amount: 125 },
      { above: 300000, amount: 166, special: { month: 3, amount: 174 } },
      { above: 400000, amount: 208, special: { month: 3, amount: 212 } },
    ],
  },
  "18": {
    basis: "monthly",
    slabs: [
      { above: 10000, amount: 150 },
      { above: 15000, amount: 180 },
      { above: 25000, amount: 208 },
    ],
  },
};

/** The month's professional tax (whole rupees) on the month's gross pay. */
export function professionalTax(rule: PtRule, monthlyGross: DecimalInput, month: string, female = false): number {
  const base = rule.basis === "annual" ? dec(monthlyGross).times(12) : dec(monthlyGross);
  const slabs = female && rule.femaleSlabs ? rule.femaleSlabs : rule.slabs;
  const slab = [...slabs].sort((a, b) => b.above - a.above).find((s) => base.gt(s.above));
  if (!slab) return 0;
  const monthNumber = Number(month.slice(5, 7));
  return slab.special && slab.special.month === monthNumber ? slab.special.amount : slab.amount;
}
