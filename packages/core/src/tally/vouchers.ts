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

/** A stock item for Tally's masters, so item-wise vouchers find it on import. */
export interface TallyStockItem {
  name: string;
  /** Tally's unit name (the app's unit symbol). */
  unit: string;
  unitDecimals?: number;
  hsn?: string | null;
}

/**
 * One item line of an item-wise (invoice) voucher. `amount` follows the
 * voucher's sign rule: positive debits the counter ledger (a purchase),
 * negative credits it (a sale).
 */
export interface TallyInventoryLine {
  item: string;
  unit: string;
  /** Quantity billed. */
  qty: number;
  /** Free pieces on top (scheme): moved in stock, not billed. */
  freeQty?: number;
  /** Rate per unit before tax. */
  rate: number;
  amount: number;
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
  /**
   * The item lines, for a sale, purchase or note: the voucher is then written
   * item-wise (Tally's invoice view), the lines allocated to `counterLedger`.
   */
  inventory?: TallyInventoryLine[];
  /** The ledger the item lines post to (Sales / Purchase). */
  counterLedger?: string;
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
  /** TDS customers deducted on their payments: claimed against the business's own tax. */
  tdsReceivable: { name: "TDS Receivable", parent: "Current Assets" },
  /** TDS kept back on purchase bills, until paid to the government. */
  tdsPayable: { name: "TDS Payable", parent: "Duties & Taxes" },
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
  /** A purchase bill's TDS kept back: the supplier is owed the rest, TDS Payable takes it. */
  tdsAmount?: string;
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
  const tds = side === "purchase" && doc.tdsAmount ? cents(doc.tdsAmount) : 0;
  const entries: Array<[string, number, boolean]> = [
    [party, sign * (total - tds), true],
    [side === "sales" ? L.sales.name : L.purchase.name, -sign * counter, false],
    ...taxes.map(([l, v]) => [l.name, -sign * v, false] as [string, number, boolean]),
    [L.roundOff.name, -sign * round, false],
    [L.tdsPayable.name, sign * tds, false],
  ];
  return entries.filter(([, v, isParty]) => isParty || v !== 0).map(([ledger, v, isParty]) => ({ ledger, amount: v / 100, ...(isParty ? { party: true } : {}) }));
}

/**
 * A receipt (money in from a customer) or a payment (money out to a supplier). A receipt the customer
 * deducted TDS on credits them with both: the money to cash or bank, the TDS to TDS Receivable.
 */
export function paymentEntries(amount: string, party: string, cash: boolean, direction: "in" | "out", tdsAmount = "0"): TallyEntry[] {
  const v = cents(amount) / 100;
  const tds = direction === "in" ? cents(tdsAmount) / 100 : 0;
  const account = cash ? TALLY_LEDGERS.cash.name : TALLY_LEDGERS.bank.name;
  return direction === "in"
    ? [
        { ledger: party, amount: -(cents(amount) + cents(tds)) / 100, party: true },
        { ledger: account, amount: v },
        ...(tds ? [{ ledger: TALLY_LEDGERS.tdsReceivable.name, amount: tds }] : []),
      ]
    : [
        { ledger: party, amount: v, party: true },
        { ledger: account, amount: -v },
      ];
}

/**
 * An expense paid out: the expense head (debited with the amount, and with
 * the GST too when it is not claimed), the input GST when claimed, and the
 * cash or bank account credited with what was paid.
 */
export function expenseEntries(
  e: { amount: string; cgstAmount: string; sgstAmount: string; igstAmount: string; totalAmount: string; claimable: boolean },
  head: string,
  cash: boolean,
): TallyEntry[] {
  const L = TALLY_LEDGERS;
  const total = cents(e.totalAmount);
  const taxes = e.claimable
    ? ([
        [L.inputCgst.name, cents(e.cgstAmount)],
        [L.inputSgst.name, cents(e.sgstAmount)],
        [L.inputIgst.name, cents(e.igstAmount)],
      ] as const)
    : [];
  const expense = total - taxes.reduce((n, [, v]) => n + v, 0);
  return [
    { ledger: head, amount: expense / 100 },
    ...taxes.filter(([, v]) => v !== 0).map(([ledger, v]) => ({ ledger, amount: v / 100 })),
    { ledger: cash ? L.cash.name : L.bank.name, amount: -total / 100 },
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

function unitXml(u: { unit: string; unitDecimals?: number }): string {
  return `<UNIT NAME="${escapeXml(u.unit)}"><NAME>${escapeXml(u.unit)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>${u.unitDecimals ?? 0}</DECIMALPLACES></UNIT>`;
}

function stockItemXml(i: TallyStockItem): string {
  const lines = [`<STOCKITEM NAME="${escapeXml(i.name)}">`, `<NAME.LIST TYPE="String"><NAME>${escapeXml(i.name)}</NAME></NAME.LIST>`, `<PARENT></PARENT>`, `<BASEUNITS>${escapeXml(i.unit)}</BASEUNITS>`];
  if (i.hsn) lines.push(`<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>${escapeXml(i.hsn)}</HSNCODE></GSTDETAILS.LIST>`);
  lines.push(`<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${escapeXml(i.name)}</NAME></NAME.LIST></LANGUAGENAME.LIST>`, `</STOCKITEM>`);
  return lines.join("");
}

const qtyText = (n: number, unit: string) => ` ${Number(n.toFixed(3))} ${unit}`;

/**
 * The item lines as Tally writes them, and what is left of the counter
 * ledger's amount (charges such as freight) to post to it directly; null when
 * the lines do not fit the voucher (then it is written as an accounting voucher).
 */
function inventoryParts(v: TallyVoucher): { xml: string[]; rest: number } | null {
  if (!v.inventory?.length || !v.counterLedger) return null;
  const counter = v.entries.filter((e) => e.ledger === v.counterLedger && !e.party).reduce((n, e) => n + Math.round(e.amount * 100), 0);
  const items = v.inventory.reduce((n, l) => n + Math.round(l.amount * 100), 0);
  // The lines must go the same way as the ledger, and not exceed it.
  if (items === 0 || Math.sign(items) !== Math.sign(counter) || Math.abs(items) > Math.abs(counter)) return null;
  const xml = v.inventory.map((l) => {
    const debit = l.amount > 0;
    const billed = qtyText(l.qty, l.unit);
    const actual = qtyText(l.qty + (l.freeQty ?? 0), l.unit);
    return [
      `<ALLINVENTORYENTRIES.LIST>`,
      `<STOCKITEMNAME>${escapeXml(l.item)}</STOCKITEMNAME>`,
      `<ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
      `<RATE>${l.rate.toFixed(2)}/${escapeXml(l.unit)}</RATE>`,
      `<AMOUNT>${amountText(l.amount)}</AMOUNT>`,
      `<ACTUALQTY>${escapeXml(actual)}</ACTUALQTY>`,
      `<BILLEDQTY>${escapeXml(billed)}</BILLEDQTY>`,
      `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${escapeXml(v.counterLedger!)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amountText(l.amount)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>`,
      `</ALLINVENTORYENTRIES.LIST>`,
    ].join("");
  });
  return { xml, rest: (counter - items) / 100 };
}

function voucherXml(v: TallyVoucher): string {
  const total = Math.round(v.entries.reduce((s, e) => s + e.amount * 100, 0));
  if (total !== 0) throw new Error(`voucher ${v.number} does not balance (${total / 100})`);
  const inventory = inventoryParts(v);
  // Item-wise, the counter ledger is reached through the item lines; what they leave stays a ledger line.
  const entries = inventory
    ? [...v.entries.filter((e) => e.party || e.ledger !== v.counterLedger), ...(inventory.rest !== 0 ? [{ ledger: v.counterLedger!, amount: inventory.rest }] : [])]
    : v.entries;
  const list = inventory ? "LEDGERENTRIES.LIST" : "ALLLEDGERENTRIES.LIST";
  const view = inventory ? "Invoice Voucher View" : "Accounting Voucher View";
  const parts = [
    `<VOUCHER VCHTYPE="${escapeXml(v.type)}" ACTION="Create" OBJVIEW="${view}">`,
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
  parts.push(`<PERSISTEDVIEW>${view}</PERSISTEDVIEW>`, `<ISINVOICE>${inventory ? "Yes" : "No"}</ISINVOICE>`);
  for (const e of entries) {
    const debit = e.amount > 0;
    parts.push(
      `<${list}>`,
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
    parts.push(`</${list}>`);
  }
  if (inventory) parts.push(...inventory.xml);
  parts.push(`</VOUCHER>`);
  return parts.join("");
}

/** The whole import file: units, stock items and ledgers first, then the vouchers in date order. */
export function tallyImportXml({ company, ledgers, vouchers, stockItems = [] }: { company?: string | null; ledgers: TallyLedger[]; vouchers: TallyVoucher[]; stockItems?: TallyStockItem[] }): string {
  const sorted = [...vouchers].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.number.localeCompare(b.number));
  const units = [...new Map(stockItems.map((i) => [i.unit.toUpperCase(), i])).values()];
  const messages = [...units.map(unitXml), ...stockItems.map(stockItemXml), ...ledgers.map(ledgerXml), ...sorted.map(voucherXml)].map((m) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`);
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
