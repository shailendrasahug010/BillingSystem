import type { Customer } from "../../data/types";

/** B2B and SEZ units have a GSTIN; an export customer is abroad (place of supply 96, other country). */
export type CustomerKind = "b2b" | "b2c" | "sez" | "export";

export function customerKind(c: Pick<Customer, "type" | "gstRegistration">): CustomerKind {
  if (c.gstRegistration === "sez") return "sez";
  if (c.gstRegistration === "overseas") return "export";
  return c.type;
}

/** The label's i18n key: "B2B", "B2C", "SEZ", "Export". */
export const kindLabel = (c: Pick<Customer, "type" | "gstRegistration">) => `customer.${customerKind(c)}` as const;
