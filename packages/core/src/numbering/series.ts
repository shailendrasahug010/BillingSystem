/**
 * Financial years and document numbering.
 *
 * Indian businesses usually run an April-March financial year and restart
 * invoice series every year, but both are configurable (settings table).
 * GST rules require a document number that is unique within a financial year,
 * at most 16 characters, using only letters, digits, '-' and '/'.
 * Those limits also live in configuration so a rule change is a settings update.
 */
export interface FinancialYear {
  /** Calendar year in which the financial year starts, e.g. 2026 for FY 2026-27. */
  startYear: number;
  /** "2026-27" */
  label: string;
  /** ISO date of the first day. */
  startDate: string;
  /** ISO date of the last day. */
  endDate: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseIsoDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) throw new RangeError(`Expected ISO date YYYY-MM-DD, got "${date}"`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** @param startMonth 1-12, default 4 (April). */
export function financialYearOf(date: string, startMonth = 4): FinancialYear {
  const { y, m } = parseIsoDate(date);
  const startYear = m >= startMonth ? y : y - 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  const label = startMonth === 1 ? String(startYear) : `${startYear}-${pad((startYear + 1) % 100)}`;
  return {
    startYear,
    label,
    startDate: isoDate(startYear, startMonth, 1),
    endDate: isoDate(endYear, endMonth, lastDay),
  };
}

export interface NumberPatternContext {
  seq: number;
  date: string;
  financialYearStartMonth?: number;
  /** Short device / counter code for offline series, e.g. "A1". */
  deviceCode?: string;
}

/**
 * Tokens: {FY} 2026-27, {FYS} 26-27, {FY2} 2627, {YYYY}, {YY}, {MM},
 * {DEVICE}, {SEQ} (no padding) or {SEQ:n} (zero-padded to n digits).
 * Example: "INV/{FY}/{SEQ:5}" -> "INV/2026-27/00042".
 */
export function formatDocumentNumber(pattern: string, ctx: NumberPatternContext): string {
  const fy = financialYearOf(ctx.date, ctx.financialYearStartMonth ?? 4);
  const { y, m } = parseIsoDate(ctx.date);
  const endYY = pad((fy.startYear + 1) % 100);
  const startYY = pad(fy.startYear % 100);
  return pattern.replace(/\{(FYS|FY2|FY|YYYY|YY|MM|DEVICE|SEQ)(?::(\d+))?\}/g, (_, token: string, width?: string) => {
    switch (token) {
      case "FY":
        return fy.label;
      case "FYS":
        return `${startYY}-${endYY}`;
      case "FY2":
        return `${startYY}${endYY}`;
      case "YYYY":
        return String(y);
      case "YY":
        return pad(y % 100);
      case "MM":
        return pad(m);
      case "DEVICE":
        return ctx.deviceCode ?? "";
      case "SEQ":
        return width ? String(ctx.seq).padStart(Number(width), "0") : String(ctx.seq);
      default:
        return "";
    }
  });
}

export interface DocumentNumberRules {
  maxLength: number;
  allowedPattern: RegExp;
}

/** Current GST invoice-number constraints; overridable from settings. */
export const DEFAULT_GST_NUMBER_RULES: DocumentNumberRules = {
  maxLength: 16,
  allowedPattern: /^[A-Za-z0-9/-]+$/,
};

export type NumberIssue = "too_long" | "invalid_characters" | "empty";

export function validateDocumentNumber(value: string, rules: DocumentNumberRules = DEFAULT_GST_NUMBER_RULES): NumberIssue[] {
  if (!value) return ["empty"];
  const issues: NumberIssue[] = [];
  if (value.length > rules.maxLength) issues.push("too_long");
  if (!rules.allowedPattern.test(value)) issues.push("invalid_characters");
  return issues;
}

/**
 * Validates a series pattern up front by rendering the widest number it can
 * produce this year, so admins learn about a too-long pattern when they
 * configure it, not when the 100000th invoice fails.
 */
export function validateSeriesPattern(
  pattern: string,
  opts: { date: string; maxSeq?: number; deviceCode?: string; rules?: DocumentNumberRules },
): NumberIssue[] {
  const widest = formatDocumentNumber(pattern, {
    seq: opts.maxSeq ?? 99999,
    date: opts.date,
    ...(opts.deviceCode !== undefined ? { deviceCode: opts.deviceCode } : {}),
  });
  return validateDocumentNumber(widest, opts.rules);
}
