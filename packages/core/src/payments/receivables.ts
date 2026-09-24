import { dec, type Dec, type DecimalInput, minDec, roundAmount, sum, ZERO } from "../money/decimal.js";
import { daysBetween } from "../dates.js";
import { ValidationError } from "../errors.js";

export type PaymentMethod = "cash" | "upi" | "bank_transfer" | "cheque" | "card" | "other";

export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "upi", "bank_transfer", "cheque", "card", "other"];

/** An invoice (or purchase bill) that still has a balance to settle. */
export interface OpenDocument {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  balance: DecimalInput;
}

export interface Allocation {
  documentId: string;
  documentNumber: string;
  amount: Dec;
}

/**
 * Split a payment across open documents. Default: oldest due date first
 * (what most distributors expect). Whatever is left is kept as an unallocated
 * advance on the party's account, never silently dropped.
 */
export function allocatePayment(
  amount: DecimalInput,
  openDocuments: readonly OpenDocument[],
  manual?: ReadonlyArray<{ documentId: string; amount: DecimalInput }>,
): { allocations: Allocation[]; unallocated: Dec } {
  const total = roundAmount(amount);
  if (total.lte(0)) throw new ValidationError("PAYMENT_NOT_POSITIVE", "Payment amount must be greater than zero");

  if (manual) {
    const byId = new Map(openDocuments.map((d) => [d.id, d]));
    const allocations: Allocation[] = manual.map((m) => {
      const doc = byId.get(m.documentId);
      if (!doc) throw new ValidationError("ALLOCATION_UNKNOWN_DOCUMENT", "Document is not open for this party");
      const value = roundAmount(m.amount);
      if (value.lte(0)) throw new ValidationError("ALLOCATION_NOT_POSITIVE", "Allocation must be greater than zero");
      if (value.gt(dec(doc.balance))) {
        throw new ValidationError("ALLOCATION_EXCEEDS_BALANCE", `Allocation exceeds balance of ${doc.number}`, {
          document: doc.number,
          balance: dec(doc.balance).toFixed(2),
        });
      }
      return { documentId: doc.id, documentNumber: doc.number, amount: value };
    });
    const allocated = sum(allocations.map((a) => a.amount));
    if (allocated.gt(total)) throw new ValidationError("ALLOCATION_EXCEEDS_PAYMENT", "Allocations exceed the payment amount");
    return { allocations, unallocated: total.minus(allocated) };
  }

  let remaining = total;
  const allocations: Allocation[] = [];
  const ordered = [...openDocuments].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
  );
  for (const doc of ordered) {
    if (remaining.lte(0)) break;
    const balance = dec(doc.balance);
    if (balance.lte(0)) continue;
    const take = minDec(balance, remaining);
    allocations.push({ documentId: doc.id, documentNumber: doc.number, amount: take });
    remaining = remaining.minus(take);
  }
  return { allocations, unallocated: remaining };
}

export interface AgingBucket {
  /** Inclusive lower bound in days. */
  from: number;
  /** Inclusive upper bound in days; null = open ended ("90+"). */
  to: number | null;
  label: string;
  amount: Dec;
  count: number;
}

export interface AgingOptions {
  asOf: string;
  /** Upper edges of each bucket. Default [30, 60, 90] -> 0-30, 31-60, 61-90, 90+. */
  edges?: readonly number[];
  /** Age from invoice date (default) or from due date (overdue analysis; not-yet-due goes to "not_due"). */
  basis?: "invoice_date" | "due_date";
}

export function ageDocuments(
  docs: readonly OpenDocument[],
  options: AgingOptions,
): { buckets: AgingBucket[]; notDue: Dec; total: Dec } {
  const edges = options.edges ?? [30, 60, 90];
  const buckets: AgingBucket[] = [];
  let lower = 0;
  for (const edge of edges) {
    buckets.push({ from: lower, to: edge, label: `${lower === 0 ? 0 : lower}-${edge}`, amount: ZERO, count: 0 });
    lower = edge + 1;
  }
  buckets.push({ from: lower, to: null, label: `${edges.at(-1) ?? 0}+`, amount: ZERO, count: 0 });
  let notDue = ZERO;
  for (const doc of docs) {
    const balance = dec(doc.balance);
    if (balance.lte(0)) continue;
    const ref = options.basis === "due_date" ? doc.dueDate : doc.date;
    const age = daysBetween(ref, options.asOf);
    if (options.basis === "due_date" && age <= 0) {
      notDue = notDue.plus(balance);
      continue;
    }
    const bucket = buckets.find((b) => age >= b.from && (b.to === null || age <= b.to)) ?? buckets[0]!;
    bucket.amount = bucket.amount.plus(balance);
    bucket.count += 1;
  }
  return { buckets, notDue, total: sum(buckets.map((b) => b.amount)).plus(notDue) };
}

export type CreditPolicyAction = "allow" | "warn" | "block";

export interface CreditPolicy {
  /** What to do when the new invoice would exceed the credit limit. */
  onLimitExceeded: CreditPolicyAction;
  /** What to do when the customer has invoices overdue by more than `overdueGraceDays`. */
  onOverdue: CreditPolicyAction;
  overdueGraceDays: number;
}

export const DEFAULT_CREDIT_POLICY: CreditPolicy = { onLimitExceeded: "warn", onOverdue: "warn", overdueGraceDays: 0 };

export interface CreditReason {
  code: "credit_limit_exceeded" | "overdue_invoices";
  params: Record<string, string | number>;
}

export interface CreditCheck {
  level: CreditPolicyAction | "ok";
  reasons: CreditReason[];
  /** Outstanding + this invoice. */
  projectedOutstanding: Dec;
  /** Credit still available before this invoice (never negative). */
  availableCredit: Dec | null;
}

export function evaluateCredit(input: {
  creditLimit: DecimalInput | null;
  outstanding: DecimalInput;
  newAmount: DecimalInput;
  openDocuments?: readonly OpenDocument[];
  asOf: string;
  policy?: CreditPolicy;
}): CreditCheck {
  const policy = input.policy ?? DEFAULT_CREDIT_POLICY;
  const outstanding = dec(input.outstanding);
  const projected = outstanding.plus(dec(input.newAmount));
  const reasons: CreditReason[] = [];
  const levels: CreditPolicyAction[] = [];
  let availableCredit: Dec | null = null;

  if (input.creditLimit !== null && input.creditLimit !== undefined && dec(input.creditLimit).gt(0)) {
    const limit = dec(input.creditLimit);
    availableCredit = limit.gt(outstanding) ? limit.minus(outstanding) : ZERO;
    if (projected.gt(limit) && policy.onLimitExceeded !== "allow") {
      reasons.push({
        code: "credit_limit_exceeded",
        params: { limit: limit.toFixed(2), projected: projected.toFixed(2), excess: projected.minus(limit).toFixed(2) },
      });
      levels.push(policy.onLimitExceeded);
    }
  }

  const overdue = (input.openDocuments ?? []).filter(
    (d) => dec(d.balance).gt(0) && daysBetween(d.dueDate, input.asOf) > policy.overdueGraceDays,
  );
  if (overdue.length > 0 && policy.onOverdue !== "allow") {
    const oldest = Math.max(...overdue.map((d) => daysBetween(d.dueDate, input.asOf)));
    reasons.push({
      code: "overdue_invoices",
      params: { count: overdue.length, amount: sum(overdue.map((d) => d.balance)).toFixed(2), days: oldest },
    });
    levels.push(policy.onOverdue);
  }

  const level = levels.includes("block") ? "block" : levels.includes("warn") ? "warn" : "ok";
  return { level, reasons, projectedOutstanding: projected, availableCredit };
}

export interface SettledDocument {
  date: string;
  dueDate: string;
  /** Date the document was fully paid; null if still open. */
  settledOn: string | null;
}

export type PaymentBehaviour = "excellent" | "good" | "slow" | "risky" | "new";

/** Summarises how a customer pays: average days to pay and on-time share. */
export function paymentBehaviour(
  docs: readonly SettledDocument[],
  asOf: string,
): { avgDaysToPay: number | null; onTimeRatio: number | null; rating: PaymentBehaviour } {
  const settled = docs.filter((d) => d.settledOn);
  const openOverdue = docs.filter((d) => !d.settledOn && daysBetween(d.dueDate, asOf) > 0);
  if (settled.length + openOverdue.length < 3) return { avgDaysToPay: null, onTimeRatio: null, rating: "new" };
  const days = settled.map((d) => daysBetween(d.date, d.settledOn!));
  const avg = days.length ? days.reduce((a, b) => a + b, 0) / days.length : null;
  const onTime = settled.filter((d) => d.settledOn! <= d.dueDate).length;
  const ratio = onTime / (settled.length + openOverdue.length);
  const rating: PaymentBehaviour = ratio >= 0.9 ? "excellent" : ratio >= 0.7 ? "good" : ratio >= 0.4 ? "slow" : "risky";
  return { avgDaysToPay: avg === null ? null : Math.round(avg * 10) / 10, onTimeRatio: Math.round(ratio * 100) / 100, rating };
}
