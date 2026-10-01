import { pgEnum } from "drizzle-orm/pg-core";
import { ORDER_STATUSES, PAYMENT_METHODS, STOCK_MOVEMENT_TYPES } from "@digitalbahi/core";

/**
 * Enum values are shared with @digitalbahi/core so the database, API and UI can
 * never disagree about what a status means. Adding a value is a migration
 * (ALTER TYPE ... ADD VALUE); business-configurable lists (expense categories,
 * leave types, customer categories...) are tables, not enums.
 */
const tuple = <T extends string>(values: readonly T[]) => values as unknown as [T, ...T[]];

export const businessGstRegistration = pgEnum("business_gst_registration", ["regular", "composition", "unregistered"]);

export const partyGstRegistration = pgEnum("party_gst_registration", [
  "regular",
  "composition",
  "unregistered",
  "consumer",
  "sez",
  "overseas",
  "deemed_export",
]);

export const customerType = pgEnum("customer_type", ["b2b", "b2c"]);
export const partyType = pgEnum("party_type", ["customer", "supplier", "employee", "other"]);
export const balanceSide = pgEnum("balance_side", ["debit", "credit"]);

export const documentStatus = pgEnum("document_status", ["draft", "posted", "cancelled"]);
export const documentKind = pgEnum("document_kind", ["tax_invoice", "bill_of_supply"]);
export const paymentStatus = pgEnum("payment_status", ["unpaid", "partial", "paid"]);
export const orderStatus = pgEnum("order_status", tuple(ORDER_STATUSES));
export const supplyType = pgEnum("supply_type", ["intra_state", "inter_state"]);
export const taxability = pgEnum("taxability", ["taxable", "exempt", "nil_rated", "non_gst", "zero_rated"]);
export const noteType = pgEnum("note_type", ["credit", "debit"]);
export const noteReason = pgEnum("note_reason", [
  "sales_return",
  "purchase_return",
  "discount",
  "rate_difference",
  "damage",
  "other",
]);

export const stockMovementType = pgEnum(
  "stock_movement_type",
  tuple(Object.keys(STOCK_MOVEMENT_TYPES) as (keyof typeof STOCK_MOVEMENT_TYPES)[]),
);
export const adjustmentReason = pgEnum("adjustment_reason", [
  "count_correction",
  "damage",
  "expiry",
  "theft",
  "sample",
  "internal_use",
  "other",
]);
export const transferStatus = pgEnum("transfer_status", ["draft", "in_transit", "received", "cancelled"]);

export const paymentMethod = pgEnum("payment_method", tuple(PAYMENT_METHODS));
export const paymentDirection = pgEnum("payment_direction", ["in", "out"]);
export const chequeStatus = pgEnum("cheque_status", ["pending", "deposited", "cleared", "bounced"]);
export const paymentAccountType = pgEnum("payment_account_type", ["cash", "bank", "upi", "wallet", "card"]);

export const packingStatus = pgEnum("packing_status", ["in_progress", "packed", "cancelled"]);
export const deliveryStatus = pgEnum("delivery_status", [
  "planned",
  "dispatched",
  "in_transit",
  "delivered",
  "partially_delivered",
  "returned",
  "cancelled",
]);

export const employeeStatus = pgEnum("employee_status", ["active", "on_notice", "resigned", "terminated"]);
export const attendanceStatus = pgEnum("attendance_status", [
  "present",
  "absent",
  "half_day",
  "leave",
  "holiday",
  "week_off",
]);
export const leaveStatus = pgEnum("leave_status", ["pending", "approved", "rejected", "cancelled"]);
export const salaryComponentType = pgEnum("salary_component_type", ["earning", "deduction"]);
export const salaryCalcType = pgEnum("salary_calc_type", ["fixed", "percent_of_basic", "per_day", "per_hour", "manual"]);
export const payrollStatus = pgEnum("payroll_status", ["draft", "finalized", "paid", "cancelled"]);
export const advanceType = pgEnum("advance_type", ["advance", "loan"]);

export const gstDirection = pgEnum("gst_direction", ["outward", "inward"]);
export const gstDocType = pgEnum("gst_doc_type", [
  "invoice",
  "credit_note",
  "debit_note",
  "purchase",
  "purchase_credit_note",
  "purchase_debit_note",
  "expense",
]);
export const itcEligibility = pgEnum("itc_eligibility", ["eligible", "ineligible", "capital_goods", "input_services"]);
export const gstPeriodStatus = pgEnum("gst_period_status", ["open", "locked", "filed"]);

export const notificationSeverity = pgEnum("notification_severity", ["info", "success", "warning", "critical"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "completed", "failed"]);
export const syncMutationStatus = pgEnum("sync_mutation_status", ["applied", "rejected", "conflict"]);
