import { dec, sum, ZERO, type Dec, type DecimalInput } from "../money/decimal.js";
import type { ZeroRatedType } from "./supply.js";

/**
 * E-invoices (IRN) and e-way bills as the government portals take them by
 * file upload: the e-invoice JSON of schema INV-01 (version 1.1) for the
 * IRP's bulk upload, and the e-way bill portal's bulk-generation JSON. Built
 * from a posted document; the IRN, acknowledgement and e-way bill number the
 * portals return are recorded on the document afterwards. A GSP / API
 * adapter can later send the same JSON directly.
 */

export const EINVOICE_SCHEMA_VERSION = "1.1";
export const EWAY_BILL_FILE_VERSION = "1.0.0621";
/** Freight and other taxed charges on an invoice go to the e-invoice as a service line (SAC 996511, road transport of goods). */
export const CHARGE_SAC = "996511";

export interface EDocParty {
  gstin: string | null;
  legalName: string;
  tradeName?: string | null;
  addr1: string | null;
  addr2?: string | null;
  place: string | null;
  pincode: string | null;
  stateCode: string;
  phone?: string | null;
  email?: string | null;
}

export interface EDocLine {
  name: string;
  hsnCode: string | null;
  /** Quantity in the base unit and its UQC (PCS, KGS, BOX…). */
  qty: DecimalInput;
  freeQty?: DecimalInput;
  uqc: string | null;
  /** Line and bill discount on this line. */
  discount: DecimalInput;
  taxable: DecimalInput;
  gstRate: DecimalInput;
  cgst: DecimalInput;
  sgst: DecimalInput;
  igst: DecimalInput;
  cessRate?: DecimalInput;
  cess?: DecimalInput;
  batch?: { number: string; expiry: string | null } | null;
}

export interface EDocCharge {
  label: string;
  taxable: DecimalInput;
  gstRate: DecimalInput;
  /** Taxable value plus its GST. */
  total: DecimalInput;
}

export interface EDocument {
  kind: "invoice" | "credit_note" | "debit_note";
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  seller: EDocParty;
  buyer: EDocParty;
  placeOfSupply: string;
  supplyType: "intra_state" | "inter_state";
  zeroRatedType?: ZeroRatedType | null;
  lines: EDocLine[];
  charges?: EDocCharge[];
  roundOff: DecimalInput;
  grandTotal: DecimalInput;
  /** A note: the invoice it is issued against. */
  original?: { number: string; date: string } | null;
  shippingBill?: { number: string | null; date: string | null; portCode: string | null } | null;
}

export type EDocIssueCode =
  | "SELLER_GSTIN"
  | "SELLER_ADDRESS"
  | "BUYER_GSTIN"
  | "BUYER_ADDRESS"
  | "BUYER_PINCODE"
  | "SELLER_PINCODE"
  | "HSN_MISSING"
  | "HSN_SHORT"
  | "NUMBER_FORMAT"
  | "CHARGE_AS_SERVICE"
  | "SHIPPING_BILL"
  | "VEHICLE_FORMAT"
  | "EXPORT_PORT_STATE";

export interface EDocIssue {
  code: EDocIssueCode;
  /** An error is refused by the portal; a warning is worth a look. */
  level: "error" | "warning";
  /** 1-based line, for line issues. */
  line?: number;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const n2 = (v: DecimalInput) => Number(dec(v).toFixed(2));
const n3 = (v: DecimalInput) => Number(dec(v).toFixed(3));
const clip = (s: string | null | undefined, max: number) => (s ?? "").trim().slice(0, max);
const pin = (p: string | null) => (p && /^[1-9]\d{5}$/.test(p) ? Number(p) : null);
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** A document number the portals take: up to 16 letters, digits, / and -, not starting with 0, / or -. */
export function validDocNumber(number: string): boolean {
  return /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/.test(number);
}

function splitTax(tax: Dec, intra: boolean): { cgst: Dec; sgst: Dec; igst: Dec } {
  if (!intra) return { cgst: ZERO, sgst: ZERO, igst: tax };
  const cgst = tax.dividedBy(2).toDecimalPlaces(2);
  return { cgst, sgst: tax.minus(cgst), igst: ZERO };
}

function partyIssues(p: EDocParty, who: "SELLER" | "BUYER", abroad: boolean): EDocIssue[] {
  const out: EDocIssue[] = [];
  if (!abroad && !p.gstin) out.push({ code: `${who}_GSTIN`, level: "error" });
  if (!p.addr1?.trim() || (p.place ?? "").trim().length < 3) out.push({ code: `${who}_ADDRESS`, level: "error" });
  if (!abroad && pin(p.pincode) === null) out.push({ code: `${who}_PINCODE`, level: "error" });
  return out;
}

function lineIssues(lines: EDocLine[]): EDocIssue[] {
  return lines.flatMap((l, i): EDocIssue[] => {
    const hsn = digits(l.hsnCode);
    if (hsn.length < 4) return [{ code: "HSN_MISSING", level: "error", line: i + 1 }];
    // Six digits are required from ₹5 crore turnover, the only businesses that must e-invoice.
    if (hsn.length < 6) return [{ code: "HSN_SHORT", level: "warning", line: i + 1 }];
    return [];
  });
}

/** E-invoice supply type: B2B, or the zero-rated type (SEZWP, SEZWOP, EXPWP, EXPWOP). */
export function eInvoiceSupplyType(doc: Pick<EDocument, "zeroRatedType">): string {
  return doc.zeroRatedType ?? "B2B";
}

/** Only supplies to registered buyers, SEZ units and buyers abroad are e-invoiced. */
export function needsEInvoice(doc: { buyerGstin: string | null; zeroRatedType?: ZeroRatedType | null }): boolean {
  return Boolean(doc.buyerGstin) || Boolean(doc.zeroRatedType);
}

function partyJson(p: EDocParty, abroad: boolean, placeOfSupply?: string) {
  const phone = digits(p.phone);
  return {
    Gstin: abroad ? "URP" : (p.gstin ?? ""),
    LglNm: clip(p.legalName, 100),
    ...(p.tradeName ? { TrdNm: clip(p.tradeName, 100) } : {}),
    ...(placeOfSupply ? { Pos: abroad ? "96" : placeOfSupply } : {}),
    Addr1: clip(p.addr1, 100),
    ...(p.addr2 ? { Addr2: clip(p.addr2, 100) } : {}),
    Loc: clip(p.place, 50),
    Pin: abroad ? 999999 : (pin(p.pincode) ?? 0),
    Stcd: abroad ? "96" : p.stateCode,
    ...(phone.length >= 6 && phone.length <= 12 ? { Ph: phone } : {}),
    ...(p.email && p.email.length >= 6 ? { Em: clip(p.email, 100) } : {}),
  };
}

/** The e-invoice JSON (INV-01 v1.1) of one document, and what the portal would refuse or is worth a look. */
export function buildEInvoice(doc: EDocument): { json: Record<string, unknown>; issues: EDocIssue[] } {
  const abroad = doc.zeroRatedType === "EXPWP" || doc.zeroRatedType === "EXPWOP";
  const intra = doc.supplyType === "intra_state";
  const issues: EDocIssue[] = [...partyIssues(doc.seller, "SELLER", false), ...partyIssues(doc.buyer, "BUYER", abroad), ...lineIssues(doc.lines)];
  if (!validDocNumber(doc.number)) issues.push({ code: "NUMBER_FORMAT", level: "error" });
  if (abroad && !doc.shippingBill?.number) issues.push({ code: "SHIPPING_BILL", level: "warning" });

  const items: Array<Record<string, unknown>> = doc.lines.map((l, i) => {
    const taxable = dec(l.taxable);
    const discount = dec(l.discount);
    const total = taxable.plus(discount);
    const qty = dec(l.qty);
    const tax = dec(l.cgst).plus(l.sgst).plus(l.igst).plus(l.cess ?? 0);
    return {
      SlNo: String(i + 1),
      PrdDesc: clip(l.name, 300),
      IsServc: "N",
      HsnCd: digits(l.hsnCode),
      Qty: n3(qty),
      FreeQty: n3(l.freeQty ?? 0),
      Unit: l.uqc || "OTH",
      UnitPrice: n3(qty.gt(0) ? total.dividedBy(qty) : total),
      TotAmt: n2(total),
      Discount: n2(discount),
      AssAmt: n2(taxable),
      GstRt: Number(dec(l.gstRate).toFixed(3)),
      IgstAmt: n2(l.igst),
      CgstAmt: n2(l.cgst),
      SgstAmt: n2(l.sgst),
      CesRt: Number(dec(l.cessRate ?? 0).toFixed(3)),
      CesAmt: n2(l.cess ?? 0),
      CesNonAdvlAmt: 0,
      StateCesRt: 0,
      StateCesAmt: 0,
      StateCesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: n2(taxable.plus(tax)),
      ...(l.batch ? { BchDtls: { Nm: clip(l.batch.number, 20), ...(l.batch.expiry ? { ExpDt: ddmmyyyy(l.batch.expiry) } : {}) } } : {}),
    };
  });
  // Charges with GST become service lines; charges without it go in "other charges".
  let other = ZERO;
  for (const c of doc.charges ?? []) {
    const taxable = dec(c.taxable);
    const tax = dec(c.total).minus(taxable);
    if (dec(c.gstRate).isZero() || tax.isZero()) {
      other = other.plus(c.total);
      continue;
    }
    const t = splitTax(tax, intra);
    issues.push({ code: "CHARGE_AS_SERVICE", level: "warning", line: items.length + 1 });
    items.push({
      SlNo: String(items.length + 1),
      PrdDesc: clip(c.label, 300),
      IsServc: "Y",
      HsnCd: CHARGE_SAC,
      Qty: 1,
      FreeQty: 0,
      Unit: "OTH",
      UnitPrice: n3(taxable),
      TotAmt: n2(taxable),
      Discount: 0,
      AssAmt: n2(taxable),
      GstRt: Number(dec(c.gstRate).toFixed(3)),
      IgstAmt: n2(t.igst),
      CgstAmt: n2(t.cgst),
      SgstAmt: n2(t.sgst),
      CesRt: 0,
      CesAmt: 0,
      CesNonAdvlAmt: 0,
      StateCesRt: 0,
      StateCesAmt: 0,
      StateCesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: n2(taxable.plus(tax)),
    });
  }
  const total = (k: string) => sum(items.map((it) => String(it[k])));
  const assVal = total("AssAmt");
  const taxes = total("CgstAmt").plus(total("SgstAmt")).plus(total("IgstAmt")).plus(total("CesAmt"));
  const roundOff = dec(doc.grandTotal).minus(assVal).minus(taxes).minus(other);

  const json: Record<string, unknown> = {
    Version: EINVOICE_SCHEMA_VERSION,
    TranDtls: { TaxSch: "GST", SupTyp: eInvoiceSupplyType(doc), RegRev: "N", IgstOnIntra: "N" },
    DocDtls: { Typ: doc.kind === "invoice" ? "INV" : doc.kind === "credit_note" ? "CRN" : "DBN", No: doc.number.toUpperCase(), Dt: ddmmyyyy(doc.date) },
    SellerDtls: partyJson(doc.seller, false),
    BuyerDtls: partyJson(doc.buyer, abroad, doc.placeOfSupply),
    ItemList: items,
    ValDtls: {
      AssVal: n2(assVal),
      CgstVal: n2(total("CgstAmt")),
      SgstVal: n2(total("SgstAmt")),
      IgstVal: n2(total("IgstAmt")),
      CesVal: n2(total("CesAmt")),
      StCesVal: 0,
      Discount: 0,
      OthChrg: n2(other),
      RndOffAmt: n2(roundOff),
      TotInvVal: n2(doc.grandTotal),
    },
    ...(doc.original ? { RefDtls: { PrecDocDtls: [{ InvNo: doc.original.number.toUpperCase(), InvDt: ddmmyyyy(doc.original.date) }] } } : {}),
    ...(abroad && doc.shippingBill?.number
      ? {
          ExpDtls: {
            ShipBNo: doc.shippingBill.number,
            ...(doc.shippingBill.date ? { ShipBDt: ddmmyyyy(doc.shippingBill.date) } : {}),
            ...(doc.shippingBill.portCode ? { Port: doc.shippingBill.portCode } : {}),
          },
        }
      : {}),
  };
  return { json, issues };
}

export interface EwayTransport {
  /** Kilometres; 0 lets the portal work the distance out from the PIN codes. */
  distanceKm?: number;
  vehicleNo?: string | null;
  transporterId?: string | null;
  transporterName?: string | null;
  /** Transporter's document (LR / GR) number and date. */
  docNo?: string | null;
  docDate?: string | null;
}

/** A vehicle number the portal takes: MP09AB1234 (letters and digits, no spaces). */
export function normalizeVehicleNo(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Whether the value of goods calls for an e-way bill (₹50,000 in most states). */
export function needsEwayBill(value: DecimalInput, threshold: DecimalInput): boolean {
  return dec(value).gt(threshold);
}

/** One document for the e-way bill portal's bulk generation (Part A, and Part B when the vehicle is known). */
export function buildEwayBill(doc: EDocument, transport: EwayTransport = {}): { bill: Record<string, unknown>; issues: EDocIssue[] } {
  const abroad = doc.zeroRatedType === "EXPWP" || doc.zeroRatedType === "EXPWOP";
  const intra = doc.supplyType === "intra_state";
  const issues: EDocIssue[] = [...partyIssues(doc.seller, "SELLER", false), ...partyIssues(doc.buyer, "BUYER", abroad).filter((i) => i.code !== "BUYER_GSTIN"), ...lineIssues(doc.lines).filter((i) => i.code === "HSN_MISSING")];
  if (!validDocNumber(doc.number)) issues.push({ code: "NUMBER_FORMAT", level: "error" });
  const vehicle = normalizeVehicleNo(transport.vehicleNo);
  if (vehicle && !/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(vehicle)) issues.push({ code: "VEHICLE_FORMAT", level: "warning" });
  if (abroad) issues.push({ code: "EXPORT_PORT_STATE", level: "warning" });

  const items = doc.lines.map((l, i) => {
    const rate = dec(l.gstRate);
    const taxed = !dec(l.cgst).plus(l.sgst).plus(l.igst).isZero();
    return {
      itemNo: i + 1,
      productName: clip(l.name, 100),
      productDesc: clip(l.name, 100),
      hsnCode: Number(digits(l.hsnCode) || 0),
      quantity: n3(l.qty),
      qtyUnit: l.uqc || "OTH",
      taxableAmount: n2(l.taxable),
      cgstRate: taxed && intra ? Number(rate.dividedBy(2).toFixed(3)) : 0,
      sgstRate: taxed && intra ? Number(rate.dividedBy(2).toFixed(3)) : 0,
      igstRate: taxed && !intra ? Number(rate.toFixed(3)) : 0,
      cessRate: Number(dec(l.cessRate ?? 0).toFixed(3)),
      cessNonAdvol: 0,
    };
  });
  const value = sum(doc.lines.map((l) => l.taxable));
  const cgst = sum(doc.lines.map((l) => l.cgst));
  const sgst = sum(doc.lines.map((l) => l.sgst));
  const igst = sum(doc.lines.map((l) => l.igst));
  const cess = sum(doc.lines.map((l) => l.cess ?? 0));
  const main = [...doc.lines].sort((a, b) => dec(b.taxable).comparedTo(a.taxable))[0];
  const seller = doc.seller;
  const buyer = doc.buyer;
  const bill: Record<string, unknown> = {
    userGstin: seller.gstin ?? "",
    supplyType: "O",
    // 1: supply, 3: export.
    subSupplyType: abroad ? 3 : 1,
    subSupplyDesc: "",
    docType: "INV",
    docNo: doc.number.toUpperCase(),
    docDate: ddmmyyyy(doc.date),
    transType: 1,
    fromGstin: seller.gstin ?? "",
    fromTrdName: clip(seller.tradeName || seller.legalName, 100),
    fromAddr1: clip(seller.addr1, 120),
    fromAddr2: clip(seller.addr2, 120),
    fromPlace: clip(seller.place, 50),
    fromPincode: pin(seller.pincode) ?? 0,
    fromStateCode: Number(seller.stateCode),
    actualFromStateCode: Number(seller.stateCode),
    toGstin: abroad || !buyer.gstin ? "URP" : buyer.gstin,
    toTrdName: clip(buyer.tradeName || buyer.legalName, 100),
    toAddr1: clip(buyer.addr1, 120),
    toAddr2: clip(buyer.addr2, 120),
    toPlace: clip(buyer.place, 50),
    toPincode: abroad ? 999999 : (pin(buyer.pincode) ?? 0),
    // Abroad: other country (99); the goods leave India from a port, taken here as in the seller's state.
    toStateCode: abroad ? 99 : Number(buyer.stateCode),
    actualToStateCode: abroad ? Number(seller.stateCode) : Number(buyer.stateCode),
    totalValue: n2(value),
    cgstValue: n2(cgst),
    sgstValue: n2(sgst),
    igstValue: n2(igst),
    cessValue: n2(cess),
    TotNonAdvolVal: 0,
    OthValue: n2(dec(doc.grandTotal).minus(value).minus(cgst).minus(sgst).minus(igst).minus(cess)),
    totInvValue: n2(doc.grandTotal),
    transMode: 1,
    transDistance: Math.max(0, Math.round(transport.distanceKm ?? 0)),
    transporterName: clip(transport.transporterName, 100),
    transporterId: (transport.transporterId ?? "").toUpperCase(),
    transDocNo: clip(transport.docNo, 15),
    transDocDate: transport.docDate ? ddmmyyyy(transport.docDate) : "",
    vehicleNo: vehicle,
    vehicleType: "R",
    mainHsnCode: Number(digits(main?.hsnCode ?? null) || 0),
    itemList: items,
  };
  return { bill, issues };
}

/** The file the e-way bill portal's bulk generation takes. */
export function ewayBillFile(bills: Array<Record<string, unknown>>): { version: string; billLists: Array<Record<string, unknown>> } {
  return { version: EWAY_BILL_FILE_VERSION, billLists: bills };
}

/** The IRN: 64 hexadecimal characters. */
export function validIrn(irn: string): boolean {
  return /^[0-9a-f]{64}$/i.test(irn);
}

/** An e-way bill number: 12 digits. */
export function validEwayBillNumber(n: string): boolean {
  return /^\d{12}$/.test(n);
}
