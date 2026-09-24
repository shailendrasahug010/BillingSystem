import { findState } from "../gst/states.js";

/**
 * Validators for Indian business identifiers. Each returns a list of issue codes
 * (empty = valid) so the UI can show a precise, translated message instead of a
 * generic "invalid value".
 */
export type IssueCode =
  | "required"
  | "invalid_format"
  | "invalid_checksum"
  | "unknown_state_code"
  | "state_mismatch";

const GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Normal-taxpayer GSTIN: 2-digit state + PAN + entity number + 'Z' + check character. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** Other GSTIN-like formats (TDS/TCS deductors, UN bodies, NRTP, OIDAR) share length and checksum. */
const GSTIN_GENERIC_PATTERN = /^[0-9]{2}[0-9A-Z]{13}$/;
/** 4th character is the holder type (P, C, H, F, A, T, B, L, J, G...); kept permissive to avoid false rejections. */
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
const HSN_PATTERN = /^(?:[0-9]{4}|[0-9]{6}|[0-9]{8})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPI_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/;

export function normalizeGstin(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Mod-36 check character used by GSTN for the 15th character of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARSET.indexOf(first14[i]!);
    if (value < 0) throw new RangeError(`Invalid GSTIN character '${first14[i]}'`);
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (total % 36)) % 36]!;
}

export interface GstinCheckOptions {
  /** If given, the GSTIN's state code must match (catches the common "wrong state" data-entry error). */
  expectedStateCode?: string;
  /** Accept non-standard formats (TDS/UN bodies etc.) as long as the checksum holds. */
  allowSpecialFormats?: boolean;
}

export function validateGstin(raw: string | null | undefined, options: GstinCheckOptions = {}): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  const gstin = normalizeGstin(raw);
  const pattern = options.allowSpecialFormats ? GSTIN_GENERIC_PATTERN : GSTIN_PATTERN;
  if (!pattern.test(gstin)) return ["invalid_format"];
  const issues: IssueCode[] = [];
  if (!findState(gstin.slice(0, 2))) issues.push("unknown_state_code");
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) issues.push("invalid_checksum");
  if (options.expectedStateCode && gstin.slice(0, 2) !== options.expectedStateCode.padStart(2, "0")) {
    issues.push("state_mismatch");
  }
  return issues;
}

export function isValidGstin(raw: string | null | undefined, options?: GstinCheckOptions): boolean {
  return validateGstin(raw, options).length === 0;
}

export function stateCodeFromGstin(gstin: string): string {
  return normalizeGstin(gstin).slice(0, 2);
}

export function panFromGstin(gstin: string): string {
  return normalizeGstin(gstin).slice(2, 12);
}

export function validatePan(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return PAN_PATTERN.test(raw.trim().toUpperCase()) ? [] : ["invalid_format"];
}

/**
 * Normalise an Indian mobile number to 10 digits, stripping +91 / 91 / 0 prefixes,
 * spaces and dashes. Returns null when the input cannot be a valid mobile number.
 */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
}

export function validateMobile(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return normalizeIndianMobile(raw) ? [] : ["invalid_format"];
}

export function validatePincode(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return PINCODE_PATTERN.test(raw.trim()) ? [] : ["invalid_format"];
}

export function validateIfsc(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return IFSC_PATTERN.test(raw.trim().toUpperCase()) ? [] : ["invalid_format"];
}

export function validateEmail(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return EMAIL_PATTERN.test(raw.trim()) ? [] : ["invalid_format"];
}

export function validateUpiId(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return UPI_PATTERN.test(raw.trim()) ? [] : ["invalid_format"];
}

/** HSN (goods) / SAC (services) code: 4, 6 or 8 digits. */
export function validateHsn(raw: string | null | undefined): IssueCode[] {
  if (!raw || !raw.trim()) return ["required"];
  return HSN_PATTERN.test(raw.trim()) ? [] : ["invalid_format"];
}

/**
 * Minimum HSN digits to report depends on aggregate turnover and changes by
 * notification, so the thresholds are passed in from configuration (settings
 * table), never hard-coded here.
 */
export interface HsnDigitRule {
  /** Applies when previous-year aggregate turnover is at most this (in rupees); null = no upper bound. */
  maxTurnover: number | null;
  digits: 4 | 6 | 8;
}

export function requiredHsnDigits(turnover: number, rules: readonly HsnDigitRule[]): number {
  const sorted = [...rules].sort(
    (a, b) => (a.maxTurnover ?? Number.POSITIVE_INFINITY) - (b.maxTurnover ?? Number.POSITIVE_INFINITY),
  );
  for (const rule of sorted) {
    if (rule.maxTurnover === null || turnover <= rule.maxTurnover) return rule.digits;
  }
  return sorted.at(-1)?.digits ?? 4;
}
