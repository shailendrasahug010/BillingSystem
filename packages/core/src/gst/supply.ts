import { stateTaxComponent, type StateTaxComponent } from "./states.js";

export type SupplyType = "intra_state" | "inter_state";

/**
 * How the business itself is registered. Only "regular" registrants charge GST
 * on their invoices; composition dealers and unregistered businesses issue a
 * Bill of Supply without tax.
 */
export type BusinessGstRegistration = "regular" | "composition" | "unregistered";

/** How the counter-party is registered; drives B2B vs B2C reporting, not the tax amount. */
export type PartyGstRegistration =
  | "regular"
  | "composition"
  | "unregistered"
  | "consumer"
  | "sez"
  | "overseas"
  | "deemed_export";

export interface SupplyContext {
  supplierStateCode: string;
  /** Place of supply: for goods, where movement terminates (usually the ship-to state). */
  placeOfSupplyStateCode: string;
  recipientRegistration?: PartyGstRegistration;
  isExport?: boolean;
}

/**
 * Intra-state => CGST + SGST/UTGST, inter-state => IGST.
 * Supplies to SEZ units and exports are always treated as inter-state.
 */
export function determineSupplyType(ctx: SupplyContext): SupplyType {
  if (ctx.isExport || ctx.recipientRegistration === "sez" || ctx.recipientRegistration === "overseas") {
    return "inter_state";
  }
  return ctx.supplierStateCode.padStart(2, "0") === ctx.placeOfSupplyStateCode.padStart(2, "0")
    ? "intra_state"
    : "inter_state";
}

export function chargesGst(registration: BusinessGstRegistration): boolean {
  return registration === "regular";
}

export type DocumentKind = "tax_invoice" | "bill_of_supply";

export function documentKindFor(registration: BusinessGstRegistration): DocumentKind {
  return chargesGst(registration) ? "tax_invoice" : "bill_of_supply";
}

export interface TaxComponentLabels {
  central: "CGST";
  state: StateTaxComponent;
  integrated: "IGST";
}

export function taxComponentLabels(placeOfSupplyStateCode: string): TaxComponentLabels {
  return { central: "CGST", state: stateTaxComponent(placeOfSupplyStateCode), integrated: "IGST" };
}

/** B2B when the recipient has a GSTIN (regular/composition/SEZ), otherwise B2C. */
export function isB2B(recipientGstin: string | null | undefined): boolean {
  return Boolean(recipientGstin && recipientGstin.trim().length === 15);
}
