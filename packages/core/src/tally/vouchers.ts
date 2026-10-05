import { escapeXml } from "./xml.js";

/**
 * Vouchers for Tally (Gateway of Tally → Import → Transactions): sales,
 * purchases, credit and debit notes, receipts and payments, in Tally's
 * accounting-voucher form, with the ledgers they use so a CA's company
 * that lacks them gets them on import. Amounts: positive is a debit.
 */
export interface TallyLedger {
  name: string;
  /** The Tally group it sits under (Sundry Debtors, Sales Accounts…). */
  parent: string;
  gstin?: string | null;
  stateName?: string | null;
  address?: string[];
}

export interface TallyEntry {
  ledger: string;
  /** Positive debits the ledger, negative credits it. */
  amount: number;
  party?: boolean;
}

export type TallyVoucherType = "Sales" | "Purchase" | "Credit Note" | "Debit Note" | "Receipt" | "Payment";

export interface TallyVoucher {
  type: TallyVoucherType;
  /** ISO date. */
  date: string;
  number: string;
  party: string;
  partyGstin?: string | null;
  reference?: string | null;
  referenceDate?: string | null;
  narration?: string | null;
  entries: TallyEntry[];
}

/** The ledgers the vouchers post to besides the parties, and their Tally groups. */
export const TALLY_LEDGERS = {
  sales: { name: "Sales", parent: "Sales Accounts" },
  purchase: { name: "Purchase", parent: "Purchase Accounts" },
  outputCgst: { name: "Output CGST", parent: "Duties & Taxes" },
  outputSgst: { name: "Output SGST", parent: "Duties & Taxes" },
  outputIgst: { name: "Output IGST", parent: "Duties & Taxes" },
  outputCess: { name: "Output Cess", parent: "Duties & Taxes" },
  inputCgst: { name: "Input CGST", parent: "Duties & Taxes" },
  inputSgst: { name: "Input SGST", parent: "Duties & Taxes" },
  inputIgst: { name: "Input IGST", parent: "Duties & Taxes" },
  inputCess: { name: "Input Cess", parent: "Duties & Taxes" },
  roundOff: { name: "Round Off", parent: "Indirect Expenses" },
  cash: { name: "Cash", parent: "Cash-in-Hand" },
  bank: { name: "Bank", parent: "Bank Accounts" },
} as const satisfies Record<string, TallyLedger>;

/** The totals every GST document carries (strings as stored). */
export interface TallyDocumentTotals {
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  cessTotal: string;
  roundOff: string;
  grandTotal: string;
  isReverseCharge?: boolean;
}

const cents = (v: string | number) => Math.round(Number(v) * 100);

/**
 * The entries of a GST document from the party's side: `sign` +1 when the
 * party is debited (a sale, a debit note to a customer), -1 when credited.
 * The counter ledger (Sales / Purchase) takes whatever the taxes and round
 * off leave, so the voucher always balances to the paisa.
 */
export function documentEntries(doc: TallyDocumentTotals, party: string, side: "sales" | "purchase", sign: 1 | -1): TallyEntry[] {
  const L = TALLY_LEDGERS;
  const total = cents(doc.grandTotal);
  // Reverse charge: the bill does not include the GST, the buyer pays it to the government.
  const taxes =
    doc.isReverseCharge && side === "purchase"
      ? []
      : ([
          [side === "sales" ? L.outputCgst : L.inputCgst, cents(doc.cgstTotal)],
          [side === "sales" ? L.outputSgst : L.inputSgst, cents(doc.sgstTotal)],
          [side === "sales" ? L.outputIgst : L.inputIgst, cents(doc.igstTotal)],
          [side === "sales" ? L.outputCess : L.inputCess, cents(doc.cessTotal)],
        ] as const);
  const round = cents(doc.roundOff);
  const counter = total - taxes.reduce((s, [, v]) => s + v, 0) - round;
  const entries: Array<[string, number, boolean]> = [
    [party, sign * total, true],
    [side === "sales" ? L.sales.name : L.purchase.name, -sign * counter, false],
    ...taxes.map(([l, v]) => [l.name, -sign * v, false] as [string, number, boolean]),
    [L.roundOff.name, -sign * round, false],
  ];
  return entries.filter(([, v, isParty]) => isParty || v !== 0).map(([ledger, v, isParty]) => ({ ledger, amount: v / 100, ...(isParty ? { party: true } : {}) }));
}

/** A receipt (money in from a customer) or a payment (money out to a supplier). */
export function paymentEntries(amount: string, party: string, cash: boolean, direction: "in" | "out"): TallyEntry[] {
  const v = cents(amount) / 100;
  const account = cash ? TALLY_LEDGERS.cash.name : TALLY_LEDGERS.bank.name;
  return direction === "in"
    ? [
        { ledger: party, amount: -v, party: true },
        { ledger: account, amount: v },
      ]
    : [
        { ledger: party, amount: v, party: true },
        { ledger: account, amount: -v },
      ];
}

const tallyDate = (iso: string) => iso.replace(/-/g, "");
const amountText = (v: number) => (-v).toFixed(2);

function ledgerXml(l: TallyLedger): string {
  const lines = [`<LEDGER NAME="${escapeXml(l.name)}">`, `<NAME.LIST TYPE="String"><NAME>${escapeXml(l.name)}</NAME></NAME.LIST>`, `<PARENT>${escapeXml(l.parent)}</PARENT>`];
  if (l.address?.length) lines.push(`<ADDRESS.LIST TYPE="String">${l.address.map((a) => `<ADDRESS>${escapeXml(a)}</ADDRESS>`).join("")}</ADDRESS.LIST>`);
  if (l.stateName) lines.push(`<LEDSTATENAME>${escapeXml(l.stateName)}</LEDSTATENAME>`);
  if (l.gstin) lines.push(`<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>`, `<PARTYGSTIN>${escapeXml(l.gstin)}</PARTYGSTIN>`);
  if (l.parent === "Sundry Debtors" || l.parent === "Sundry Creditors") lines.push(`<ISBILLWISEON>Yes</ISBILLWISEON>`);
  lines.push(`<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${escapeXml(l.name)}</NAME></NAME.LIST></LANGUAGENAME.LIST>`, `</LEDGER>`);
  return lines.join("");
}

function voucherXml(v: TallyVoucher): string {
  const total = Math.round(v.entries.reduce((s, e) => s + e.amount * 100, 0));
  if (total !== 0) throw new Error(`voucher ${v.number} does not balance (${total / 100})`);
  const parts = [
    `<VOUCHER VCHTYPE="${escapeXml(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${tallyDate(v.date)}</DATE>`,
    `<EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(v.type)}</VOUCHERTYPENAME>`,
    `<VOUCHERNUMBER>${escapeXml(v.number)}</VOUCHERNUMBER>`,
    `<PARTYLEDGERNAME>${escapeXml(v.party)}</PARTYLEDGERNAME>`,
  ];
  if (v.partyGstin) parts.push(`<PARTYGSTIN>${escapeXml(v.partyGstin)}</PARTYGSTIN>`);
  if (v.reference) parts.push(`<REFERENCE>${escapeXml(v.reference)}</REFERENCE>`);
  if (v.referenceDate) parts.push(`<REFERENCEDATE>${tallyDate(v.referenceDate)}</REFERENCEDATE>`);
  if (v.narration) parts.push(`<NARRATION>${escapeXml(v.narration)}</NARRATION>`);
  parts.push(`<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`, `<ISINVOICE>No</ISINVOICE>`);
  for (const e of v.entries) {
    const debit = e.amount > 0;
    parts.push(
      `<ALLLEDGERENTRIES.LIST>`,
      `<LEDGERNAME>${escapeXml(e.ledger)}</LEDGERNAME>`,
      `<ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
      `<ISPARTYLEDGER>${e.party ? "Yes" : "No"}</ISPARTYLEDGER>`,
      // Tally writes a debit as a negative amount.
      `<AMOUNT>${amountText(e.amount)}</AMOUNT>`,
    );
    if (e.party && (v.type === "Sales" || v.type === "Purchase" || v.type === "Credit Note" || v.type === "Debit Note")) {
      // Bill-wise: the voucher opens (or settles against) a bill of its own number.
      const against = v.type === "Credit Note" || v.type === "Debit Note" ? "Agst Ref" : "New Ref";
      parts.push(`<BILLALLOCATIONS.LIST><NAME>${escapeXml(v.reference && against === "Agst Ref" ? v.reference : v.number)}</NAME><BILLTYPE>${against}</BILLTYPE><AMOUNT>${amountText(e.amount)}</AMOUNT></BILLALLOCATIONS.LIST>`);
    }
    parts.push(`</ALLLEDGERENTRIES.LIST>`);
  }
  parts.push(`</VOUCHER>`);
  return parts.join("");
}

/** The whole import file: the ledgers first, then the vouchers in date order. */
export function tallyImportXml({ company, ledgers, vouchers }: { company?: string | null; ledgers: TallyLedger[]; vouchers: TallyVoucher[] }): string {
  const sorted = [...vouchers].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.number.localeCompare(b.number));
  const messages = [...ledgers.map(ledgerXml), ...sorted.map(voucherXml)].map((m) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>`,
    `<BODY><IMPORTDATA>`,
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : ""}</REQUESTDESC>`,
    `<REQUESTDATA>`,
    ...messages,
    `</REQUESTDATA>`,
    `</IMPORTDATA></BODY>`,
    `</ENVELOPE>`,
  ].join("\n");
}
