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

/**
 * Zero-rated supplies (section 16 of the IGST Act): exports of goods, and
 * supplies to a unit or developer in a Special Economic Zone. They are
 * inter-state, and made either on payment of IGST (refunded later) or under
 * bond / letter of undertaking (LUT) without tax.
 */
export type ZeroRatedKind = "export" | "sez";

/** How GSTR-1 names a zero-rated invoice: EXPWP / EXPWOP (table 6A), SEZWP / SEZWOP (6B, filed with B2B). */
export type ZeroRatedType = "EXPWP" | "EXPWOP" | "SEZWP" | "SEZWOP";

/** A buyer abroad makes an export; an SEZ unit or developer a supply to SEZ; anyone else neither. */
export function zeroRatedKindFor(registration: PartyGstRegistration | string | null | undefined): ZeroRatedKind | null {
  return registration === "overseas" ? "export" : registration === "sez" ? "sez" : null;
}

export function zeroRatedTypeOf(kind: ZeroRatedKind, withPayment: boolean): ZeroRatedType {
  return kind === "export" ? (withPayment ? "EXPWP" : "EXPWOP") : withPayment ? "SEZWP" : "SEZWOP";
}

/** What a zero-rated invoice must say on its face (rule 46 of the CGST Rules; notification 37/2017). */
export function zeroRatedDeclaration(type: ZeroRatedType): string {
  switch (type) {
    case "EXPWP":
      return "SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX";
    case "EXPWOP":
      return "SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";
    case "SEZWP":
      return "SUPPLY TO SEZ UNIT / DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX";
    case "SEZWOP":
      return "SUPPLY TO SEZ UNIT / DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";
  }
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
