import { descendants, kid, kids, parseXml, textOf, type XmlNode } from "./xml.js";

/**
 * Masters exported from Tally (Gateway of Tally → Export → Masters, or
 * List of Accounts, as XML) read into rows for the spreadsheet importers:
 * ledgers under Sundry Debtors become customers, under Sundry Creditors
 * suppliers (with their opening balances), stock items products (with
 * their opening stock, rate, HSN and GST rate).
 */
export type TallyRow = Record<string, string>;

export interface TallyMasters {
  customers: TallyRow[];
  suppliers: TallyRow[];
  products: TallyRow[];
  /** Ledgers that are neither (sales, bank, tax…): not imported. */
  otherLedgers: number;
  /** The company named in the file, when it says. */
  company: string | null;
}

const DEBTORS = "SUNDRY DEBTORS";
const CREDITORS = "SUNDRY CREDITORS";

/** "-1500.00" → -1500; "100 Nos" → 100; "8.00/Nos" → 8; "" → null. */
export function tallyNumber(raw: string): number | null {
  const m = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const UNIT: Record<string, string> = {
  NOS: "NOS", NO: "NOS", NUMBER: "NOS", NUMBERS: "NOS",
  PCS: "PCS", PC: "PCS", PIECE: "PCS", PIECES: "PCS",
  BOX: "BOX", BOXES: "BOX", BXS: "BOX",
  CTN: "CTN", CARTON: "CTN", CARTONS: "CTN",
  PKT: "PAC", PKTS: "PAC", PAC: "PAC", PACKET: "PAC", PACKETS: "PAC",
  STRIP: "STRIP", STRIPS: "STRIP", STRP: "STRIP",
  BTL: "BTL", BOTTLE: "BTL", BOTTLES: "BTL",
  DOZ: "DOZ", DOZEN: "DOZ",
  BAG: "BAG", BAGS: "BAG",
  KG: "KG", KGS: "KG", KILOGRAM: "KG", KILOGRAMS: "KG",
  G: "G", GM: "G", GMS: "G", GRAM: "G", GRAMS: "G",
  L: "L", LTR: "L", LTRS: "L", LITRE: "L", LITRES: "L", LITER: "L",
  ML: "ML", MLT: "ML", MILLILITRE: "ML",
};

/** Tally's unit name ("Nos", "Kgs", "Pcs") as this app's unit symbol. */
export function tallyUnit(raw: string): string {
  const key = raw.trim().replace(/\.$/, "").toUpperCase();
  return UNIT[key] ?? key;
}

/** A 10-digit Indian mobile from Tally's phone text, or "" when it is not one. */
function mobileFrom(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : "";
  return /^[6-9]\d{9}$/.test(last10) ? last10 : "";
}

const fixed = (n: number | null, places: number) => (n === null ? "" : n.toFixed(places));

function nameOf(node: XmlNode): string {
  return (node.attrs.NAME || textOf(kid(kid(node, "LANGUAGENAME.LIST"), "NAME.LIST"), "NAME") || textOf(node, "NAME")).trim();
}

/** The GST rate of an item or group: the IGST rate of its latest GST details; "exempt" / "nil". */
function gstOf(node: XmlNode | undefined): string {
  if (!node) return "";
  const details = kids(node, "GSTDETAILS.LIST");
  const latest = details[details.length - 1];
  if (!latest) return "";
  const taxability = textOf(latest, "TAXABILITY").toLowerCase();
  if (taxability === "exempt") return "exempt";
  if (taxability.startsWith("nil")) return "nil";
  for (const r of descendants(latest, "RATEDETAILS.LIST")) {
    const head = textOf(r, "GSTRATEDUTYHEAD").toUpperCase();
    if (head === "IGST" || head === "INTEGRATED TAX") {
      const rate = tallyNumber(textOf(r, "GSTRATE"));
      if (rate !== null) return String(rate);
    }
  }
  return "";
}

function lastText(node: XmlNode, name: string): string {
  const all = descendants(node, name).map((n) => n.text.trim()).filter(Boolean);
  return all[all.length - 1] ?? "";
}

export function parseTallyMasters(xml: string): TallyMasters {
  const doc = parseXml(xml);
  const messages = descendants(doc, "TALLYMESSAGE");
  const nodes = messages.length ? messages.flatMap((m) => m.children) : descendants(doc, "LEDGER").concat(descendants(doc, "STOCKITEM"), descendants(doc, "GROUP"), descendants(doc, "STOCKGROUP"));

  const groupParent = new Map<string, string>();
  const stockGroups = new Map<string, XmlNode>();
  for (const n of nodes) {
    if (n.name === "GROUP") groupParent.set(nameOf(n).toUpperCase(), textOf(n, "PARENT").toUpperCase());
    if (n.name === "STOCKGROUP") stockGroups.set(nameOf(n).toUpperCase(), n);
  }
  /** Sundry Debtors / Sundry Creditors, or whatever primary group a group sits under. */
  const primary = (group: string): string => {
    let g = group.toUpperCase();
    for (let i = 0; i < 20 && g !== DEBTORS && g !== CREDITORS; i++) {
      const up = groupParent.get(g);
      if (!up) break;
      g = up;
    }
    return g;
  };
  /** The GST rate set on the item's stock group, or the group's own group, when the item has none. */
  const groupGst = (group: string): string => {
    let g = group.toUpperCase();
    for (let i = 0; i < 20 && g; i++) {
      const node = stockGroups.get(g);
      const rate = gstOf(node);
      if (rate) return rate;
      g = node ? textOf(node, "PARENT").toUpperCase() : "";
    }
    return "";
  };

  const customers: TallyRow[] = [];
  const suppliers: TallyRow[] = [];
  const products: TallyRow[] = [];
  let otherLedgers = 0;

  for (const n of nodes) {
    if (n.name === "LEDGER") {
      const kind = primary(textOf(n, "PARENT"));
      if (kind !== DEBTORS && kind !== CREDITORS) {
        otherLedgers++;
        continue;
      }
      const address = kids(kid(n, "ADDRESS.LIST"), "ADDRESS")
        .map((a) => a.text.trim())
        .filter(Boolean);
      const gstin = (textOf(n, "PARTYGSTIN") || lastText(n, "GSTIN")).toUpperCase().replace(/\s/g, "");
      // Tally keeps a debit as a negative amount: a debtor owing 1,500 is "-1500.00".
      const opening = tallyNumber(textOf(n, "OPENINGBALANCE")) ?? 0;
      const row: TallyRow = {
        name: nameOf(n),
        contact_person: textOf(n, "LEDGERCONTACT"),
        gstin,
        state: textOf(n, "LEDSTATENAME") || textOf(n, "STATENAME") || lastText(n, "STATE"),
        mobile: mobileFrom(textOf(n, "LEDGERMOBILE") || textOf(n, "LEDGERPHONE")),
        email: textOf(n, "EMAIL"),
        address: address.join(", ").slice(0, 200),
        pincode: textOf(n, "PINCODE").replace(/\s/g, ""),
        opening_balance: opening === 0 ? "" : (kind === DEBTORS ? -opening : opening).toFixed(2),
      };
      for (const k of Object.keys(row)) if (!row[k]) delete row[k];
      (kind === DEBTORS ? customers : suppliers).push(row);
    } else if (n.name === "STOCKITEM") {
      const group = textOf(n, "PARENT");
      const qty = tallyNumber(textOf(n, "OPENINGBALANCE"));
      const rate = tallyNumber(textOf(n, "OPENINGRATE"));
      const value = tallyNumber(textOf(n, "OPENINGVALUE"));
      const cost = rate ?? (qty && value ? Math.abs(value) / Math.abs(qty) : null);
      const row: TallyRow = {
        name: nameOf(n),
        unit: tallyUnit(textOf(n, "BASEUNITS") || "Nos"),
        hsn: lastText(n, "HSNCODE").replace(/\s/g, ""),
        gst: gstOf(n) || groupGst(group),
        category: group && group.toUpperCase() !== "PRIMARY" ? group : "",
        opening_stock: qty !== null && qty > 0 ? String(qty) : "",
        purchase_price: fixed(cost, 2),
        selling_price: fixed(tallyNumber(lastText(n, "RATE")), 2),
        mrp: fixed(tallyNumber(lastText(n, "MRPRATE")), 2),
      };
      for (const k of Object.keys(row)) if (!row[k]) delete row[k];
      products.push(row);
    }
  }

  const company = descendants(doc, "SVCURRENTCOMPANY")[0]?.text.trim() || null;
  return { customers, suppliers, products, otherLedgers, company };
}
