import type { MeResponse } from "@digitalbahi/contracts";
import { applyMe } from "../../data/live";
import { touch } from "../../data/store";
import { api } from "../../lib/api";

export interface BusinessRow {
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  pan: string | null;
  gstRegistration: "regular" | "composition" | "unregistered";
  stateCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  financialYearStartMonth: number;
}

export type Policy = "allow" | "warn" | "block";
export interface Settings {
  "stock.negative_policy": Policy;
  "stock.expiry_warning_days": number;
  "invoice.round_off": { mode: "none" | "nearest" | "up" | "down"; step: number };
  "invoice.default_print_locale": "en" | "hi";
  "credit.policy": { onLimitExceeded: Policy; onOverdue: Policy; overdueGraceDays: number };
  "payments.allocation": "oldest_first" | "manual";
  "invoice.terms": string;
  "reports.aging_buckets": number[];
  "offline.wipe_after_days"?: number;
  "gst.lut"?: { arn: string; validUntil: string } | null;
  "einvoice.enabled"?: boolean;
  "ewaybill.threshold"?: number;
  "invoice.payment_details"?: PaymentDetails;
  "invoice.unit_letters"?: Record<string, string> | null;
  "invoice.default_unit"?: string | null;
  /** Roles (by key) that must use two-step sign-in. */
  "security.two_step_roles"?: string[];
}
export type PaymentDetails = { bankName: string; accountNumber: string; ifsc: string; upiId: string };

/** Business header, rules and permissions in the running app follow the saved values at once. */
export async function reloadMe() {
  applyMe(await api.get<MeResponse>("/me"));
  touch();
}
