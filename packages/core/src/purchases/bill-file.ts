/**
 * Reading a supplier's bill from the spreadsheet they send (or their software
 * exports): Marg, Tally, Busy and company DMS files all name the columns a
 * little differently ("Particulars", "Item Description", "PTR", "Sch Qty",
 * "Exp."), may start with a few title rows before the header, repeat or omit
 * the bill number on each line, and write dates as 25/09/2026, 25-Sep-26 or
 * an Excel serial. This turns such a sheet into bills and lines with plain
 * numbers and ISO dates; the caller then matches products and shows it for
 * review before anything is saved.
 */
import { normalizeGstin } from "../validation/identifiers.js";
import { normalizeSearchText } from "../search/products.js";

export type BillColumn =
  | "bill_number"
  | "bill_date"
  | "supplier_gstin"
  | "supplier_name"
  | "item_name"
  | "item_code"
  | "barcode"
  | "hsn"
  | "unit"
  | "qty"
  | "free_qty"
  | "rate"
  | "discount"
  | "gst_rate"
  | "cgst_rate"
  | "sgst_rate"
  | "igst_rate"
  | "batch"
  | "expiry"
  | "mfg"
  | "mrp"
  | "taxable";

/** Normalised header words -> column. */
const HEADERS: Record<string, BillColumn> = {};
const alias = (column: BillColumn, ...keys: string[]) => keys.forEach((k) => (HEADERS[k] = column));
alias("bill_number", "bill_no", "bill_number", "bill_num", "bill", "invoice_no", "invoice_number", "inv_no", "invoice", "voucher_no", "vch_no", "doc_no", "document_no", "supplier_invoice_no", "supplier_bill_no");
alias("bill_date", "bill_date", "invoice_date", "inv_date", "date", "voucher_date", "vch_date", "doc_date", "document_date", "dated");
alias("supplier_gstin", "supplier_gstin", "gstin", "party_gstin", "seller_gstin", "vendor_gstin", "gst_no", "gstin_no", "gstin_uin", "gstin_of_supplier", "supplier_gst_no", "gst_number");
alias("supplier_name", "supplier", "supplier_name", "party", "party_name", "seller", "seller_name", "vendor", "vendor_name", "distributor", "firm_name");
alias(
  "item_name",
  "item",
  "item_name",
  "product",
  "product_name",
  "description",
  "item_description",
  "product_description",
  "particulars",
  "name",
  "goods",
  "description_of_goods",
  "material",
  "material_name",
  "sku_name",
  "item_details",
);
alias("item_code", "item_code", "code", "product_code", "sku", "sku_code", "material_code", "article_code", "part_no", "item_no");
alias("barcode", "barcode", "bar_code", "ean", "ean_code", "upc", "gtin");
alias("hsn", "hsn", "hsn_code", "hsn_sac", "hsn_sac_code", "sac");
alias("unit", "unit", "uom", "units", "unit_of_measure", "per", "pack_unit");
alias("qty", "qty", "quantity", "billed_qty", "qty_billed", "bill_qty", "quantity_billed", "sale_qty");
alias("free_qty", "free", "free_qty", "freeqty", "scheme", "scheme_qty", "sch", "sch_qty", "bonus", "bonus_qty", "free_quantity", "free_goods");
alias("rate", "rate", "price", "ptr", "pts", "purchase_rate", "purchase_price", "unit_price", "rate_per_unit", "basic_rate", "unit_rate", "cost", "cost_price");
alias("discount", "disc", "discount", "disc_percent", "discount_percent", "disc_per", "trade_discount", "td");
alias("gst_rate", "gst_rate", "tax_rate", "gst_percent", "tax_percent", "rate_of_tax", "gst_per");
alias("batch", "batch", "batch_no", "batch_number", "batchno", "lot", "lot_no");
alias("expiry", "exp", "expiry", "expiry_date", "exp_date", "exp_dt", "expdt", "best_before", "use_before", "use_by");
alias("mfg", "mfg", "mfg_date", "mfd", "mfg_dt", "manufacturing_date", "pkd", "pkd_date", "packed_on");
alias("mrp", "mrp", "mrp_rate", "m_r_p");
alias("taxable", "taxable", "taxable_value", "taxable_amount", "taxable_amt", "taxable_val", "assessable_value", "basic_amount", "net_value");

/** GST rates a bill can carry (the half rates appear as CGST / SGST). */
const GST_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);

/** Header text -> column; "gst" or "tax" alone is only a rate when marked "%" / "rate" (else it is the tax amount). */
export function billColumnOf(header: string): BillColumn | null {
  const raw = header.toLowerCase();
  const marked = /%|rate|percent/.test(raw);
  const key = raw
    .replace(/\(.*?\)/g, " ")
    .replace(/[₹%.:#'"*]/g, " ")
    .trim()
    .replace(/[\s/_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const split = /^(c|s|ut|i)gst(_rate|_per|_percent)?$/.exec(key);
  if (split) return marked ? (split[1] === "i" ? "igst_rate" : split[1] === "c" ? "cgst_rate" : "sgst_rate") : null;
  if (key === "gst" || key === "tax") return marked ? "gst_rate" : null;
  return HEADERS[key] ?? null;
}

export interface BillFileLine {
  /** 1-based row in the sheet, for messages. */
  row: number;
  itemName: string;
  itemCode: string | null;
  barcode: string | null;
  hsnCode: string | null;
  unit: string | null;
  qty: string;
  freeQty: string | null;
  /** Per unit, before GST. */
  rate: string | null;
  discountPercent: string | null;
  gstRate: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  mfgDate: string | null;
  mrp: string | null;
}

export interface BillFileBill {
  billNumber: string | null;
  billDate: string | null;
  supplierGstin: string | null;
  supplierName: string | null;
  lines: BillFileLine[];
}

export type BillFileProblemCode = "INVALID_NUMBER" | "INVALID_DATE";

export interface BillFileProblem {
  row: number;
  column: BillColumn;
  code: BillFileProblemCode;
  value: string;
}

export interface BillFile {
  /** 1-based header row; 0 when no header with an item and a quantity column was found. */
  headerRow: number;
  columns: BillColumn[];
  /** The file's own header text for each column read, for messages ("Qty.", "PTR"). */
  headers: Partial<Record<BillColumn, string>>;
  /** Headers that were not understood (shown so the user knows what was skipped). */
  ignored: string[];
  bills: BillFileBill[];
  problems: BillFileProblem[];
}

/** "₹ 1,250.50" -> "1250.5"; null when not a non-negative number. */
export function parseBillNumber(raw: string, decimals: number): string | null {
  const v = raw
    .replace(/^rs\.?/i, "")
    .replace(/[₹,\s]/g, "")
    .trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n >= 1e12) return null;
  return String(Math.round(n * 10 ** decimals) / 10 ** decimals);
}

/**
 * A GST rate as bills print it: "18", "18%", "18.00 %", or split into its
 * halves in one cell ("CGST@6 + SGST@6" is 12, "IGST@18" is 18); null when
 * it is none of these.
 */
export function parseGstRate(raw: string): string | null {
  const parts = [...raw.matchAll(/\b(c|s|ut|i)?gst\s*[@:-]?\s*(\d+(?:\.\d+)?)\s*%?/gi)];
  if (parts.length) {
    // IGST, or "GST 18%", is the whole rate; CGST and SGST add up, one half alone ("CGST@9") stands for both.
    const whole = parts.find((m) => !m[1] || m[1].toLowerCase() === "i");
    const halves = parts.reduce((sum, m) => sum + Number(m[2]), 0);
    const rate = whole ? Number(whole[2]) : parts.length === 1 ? 2 * halves : halves;
    return String(Math.round(rate * 1000) / 1000);
  }
  return parseBillNumber(raw.replace(/%\s*$/, ""), 3);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const year4 = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
const monthOf = (m: string) => (/^\d+$/.test(m) ? Number(m) : MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2099 || m < 1 || m > 12 || d < 1 || d > lastDay(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Indian day-first dates, ISO dates, "25-Sep-2026" and Excel serial numbers -> YYYY-MM-DD. */
export function parseBillDate(raw: string): string | null {
  const v = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v) ?? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.\- ]([a-z]{3,9}|\d{1,2})[/.\-, ]+(\d{4}|\d{2})$/i.exec(v);
  if (m) return isoDate(year4(m[3]!), monthOf(m[2]!), Number(m[1]));
  m = /^(\d{5})(?:\.\d+)?$/.exec(v);
  if (m && Number(m[1]) > 30000 && Number(m[1]) < 70000) {
    // Excel counts days from 1899-12-30.
    return new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

/** Expiry as printed on packs: "09/27", "Sep-2027", "09/2027" (end of that month) or a full date. */
export function parseExpiry(raw: string): string | null {
  const full = parseBillDate(raw);
  if (full) return full;
  const m = /^([a-z]{3,9}|\d{1,2})[/.\- ]+(\d{4}|\d{2})$/i.exec(raw.trim());
  if (!m) return null;
  const y = year4(m[2]!);
  const month = monthOf(m[1]!);
  return month >= 1 && month <= 12 ? isoDate(y, month, lastDay(y, month)) : null;
}

const TOTAL_ROW = /^(sub[\s-]*)?total\b|^grand\s*total|^round(ed)?[\s-]*off|^net\s*(amount|total)|^carried|^brought/i;

/** Finds the header row (it may follow a few title rows) and reads every bill in the sheet. */
export function readBillFile(sheet: string[][]): BillFile {
  const headerIndex = sheet.slice(0, 20).findIndex((r) => {
    const cols = r.map(billColumnOf);
    return cols.includes("item_name") && cols.includes("qty");
  });
  if (headerIndex < 0) return { headerRow: 0, columns: [], headers: {}, ignored: [], bills: [], problems: [] };
  const header = sheet[headerIndex]!;
  const colOf = header.map(billColumnOf);
  // The first column of each kind wins ("Rate" before a later "Rate" for MRP, etc.).
  const index = new Map<BillColumn, number>();
  colOf.forEach((c, i) => {
    if (c && !index.has(c)) index.set(c, i);
  });
  const ignored = header.filter((h, i) => h.trim() && (!colOf[i] || index.get(colOf[i]!) !== i)).map((h) => h.trim());

  const problems: BillFileProblem[] = [];
  const bills: BillFileBill[] = [];
  let current: BillFileBill | null = null;
  const hasBillNumber = index.has("bill_number");

  for (let r = headerIndex + 1; r < sheet.length; r++) {
    const cells = sheet[r]!;
    const rowNo = r + 1;
    const get = (c: BillColumn) => {
      const i = index.get(c);
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const num = (c: BillColumn, decimals: number) => {
      const v = get(c);
      if (!v) return null;
      const n = parseBillNumber(v, decimals);
      if (n === null) problems.push({ row: rowNo, column: c, code: "INVALID_NUMBER", value: v });
      return n;
    };
    const date = (c: BillColumn, parse: (v: string) => string | null) => {
      const v = get(c);
      if (!v) return null;
      const d = parse(v);
      if (d === null) problems.push({ row: rowNo, column: c, code: "INVALID_DATE", value: v });
      return d;
    };

    const billNumber = get("bill_number");
    if (!current || (hasBillNumber && billNumber && billNumber.toUpperCase() !== current.billNumber?.toUpperCase())) {
      current = bills.find((b) => billNumber && b.billNumber?.toUpperCase() === billNumber.toUpperCase()) ?? null;
      if (!current) {
        current = { billNumber: billNumber || null, billDate: null, supplierGstin: null, supplierName: null, lines: [] };
        bills.push(current);
      }
    }
    current.billDate ??= date("bill_date", parseBillDate);
    if (!current.supplierGstin && get("supplier_gstin")) current.supplierGstin = normalizeGstin(get("supplier_gstin"));
    current.supplierName ??= get("supplier_name") || null;

    let itemName = get("item_name");
    const itemCode = get("item_code") || null;
    const barcode = get("barcode").replace(/\s+/g, "") || null;
    const qtyText = get("qty");
    if (!itemName && !itemCode && !barcode) continue;
    if (TOTAL_ROW.test(itemName) || (!qtyText && !get("rate"))) continue;
    itemName ||= itemCode ?? barcode ?? "";

    // "10 CS" in the quantity cell carries the unit when there is no unit column.
    const qtyMatch = /^([\d.,]+)\s*([a-z]{1,10})?$/i.exec(qtyText);
    const qty = qtyMatch ? parseBillNumber(qtyMatch[1]!, 3) : null;
    if (!qty || Number(qty) <= 0) {
      problems.push({ row: rowNo, column: "qty", code: "INVALID_NUMBER", value: qtyText });
      continue;
    }
    const unit = get("unit") || qtyMatch?.[2] || null;
    const freeQty = num("free_qty", 3);
    let rate = num("rate", 4);
    let discountPercent = num("discount", 3);
    if (discountPercent !== null && Number(discountPercent) > 100) {
      problems.push({ row: rowNo, column: "discount", code: "INVALID_NUMBER", value: get("discount") });
      discountPercent = null;
    }
    const taxable = num("taxable", 2);
    if (taxable !== null) {
      // The taxable value is after discount: it fixes the rate or the discount exactly.
      if (rate === null) rate = String(Math.round((Number(taxable) / Number(qty)) * 10_000) / 10_000);
      else if (Number(rate) > 0) {
        const implied = (1 - Number(taxable) / (Number(rate) * Number(qty))) * 100;
        if (implied > 0.0005 && implied <= 100) discountPercent = String(Math.round(implied * 1000) / 1000);
      }
    }

    const rateOf = (c: BillColumn) => {
      const v = get(c);
      if (!v) return null;
      // A CGST column holds its own half ("6%"); only a GST column may spell out both halves.
      const n = c === "gst_rate" ? parseGstRate(v) : parseBillNumber(v.replace(/%\s*$/, ""), 3);
      if (n === null) problems.push({ row: rowNo, column: c, code: "INVALID_NUMBER", value: v });
      return n;
    };
    let gstRate = rateOf("gst_rate");
    if (gstRate === null) {
      const igst = rateOf("igst_rate");
      const cgst = rateOf("cgst_rate");
      const sgst = rateOf("sgst_rate");
      if (igst !== null && Number(igst) > 0) gstRate = igst;
      else if (cgst !== null || sgst !== null) gstRate = String(Math.round((Number(cgst ?? 0) + Number(sgst ?? cgst ?? 0)) * 1000) / 1000);
      else if (igst !== null) gstRate = igst;
    }
    if (gstRate !== null && !GST_RATES.has(Number(gstRate))) {
      problems.push({ row: rowNo, column: "gst_rate", code: "INVALID_NUMBER", value: gstRate });
      gstRate = null;
    }

    const hsn = get("hsn").replace(/\s+/g, "");
    current.lines.push({
      row: rowNo,
      itemName: itemName.replace(/\s+/g, " "),
      itemCode,
      barcode,
      hsnCode: /^(\d{4}|\d{6}|\d{8})$/.test(hsn) ? hsn : null,
      unit: unit ? unit.toUpperCase() : null,
      qty,
      freeQty: freeQty && Number(freeQty) > 0 ? freeQty : null,
      rate,
      discountPercent: discountPercent && Number(discountPercent) > 0 ? discountPercent : null,
      gstRate,
      batchNumber: get("batch") || null,
      expiryDate: date("expiry", parseExpiry),
      mfgDate: date("mfg", parseExpiry),
      mrp: num("mrp", 4),
    });
  }
  return {
    headerRow: headerIndex + 1,
    columns: [...index.keys()],
    headers: Object.fromEntries([...index].map(([c, i]) => [c, header[i]!.trim()])),
    ignored,
    bills: bills.filter((b) => b.lines.length > 0),
    problems,
  };
}

/**
 * Keys under which a supplier's item is remembered: its code when the bill
 * has one, and its name, both normalised ("Surf Exl-1KG" -> "n:surfexl1kg").
 */
export function supplierItemKeys(item: { code?: string | null; name?: string | null }): string[] {
  const keys: string[] = [];
  const code = item.code ? item.code.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "") : "";
  if (code) keys.push(`c:${code}`.slice(0, 200));
  const name = item.name ? normalizeSearchText(item.name).replace(/ /g, "") : "";
  if (name) keys.push(`n:${name}`.slice(0, 200));
  return keys;
}

/** Name compared ignoring case, spaces and punctuation ("SURF EXCEL 1 KG" = "Surf Excel 1kg"). */
export function compactName(name: string): string {
  return normalizeSearchText(name).replace(/ /g, "");
}

const GSTIN_IN_TEXT = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const HAS_GSTIN = new RegExp(GSTIN_IN_TEXT.source);
const BILL_NO_IN_TEXT = /\b(?:tax\s+)?(?:invoice|bill|inv|voucher|vch)\s*(?:no|number|#)\.?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{0,29})/i;
const DATE_IN_TEXT = /\b(?:invoice|bill|inv|voucher|vch)?\s*date[d]?\s*[:.\-]?\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[\s\-]+[A-Za-z]{3,9}[\s\-,]+\d{2,4}|\d{4}-\d{2}-\d{2})/i;

export interface BillHeaderFields {
  billNumber: string | null;
  billDate: string | null;
  supplierGstin: string | null;
  supplierName: string | null;
}

/**
 * The bill's number, date and the supplier's GSTIN and name from the text
 * above a printed bill's item table (a PDF from the supplier's software):
 * "Invoice No. : SG/1021", "Date : 20-09-2026", the first GSTIN that is not
 * our own, and the first line (the seller's name heads a bill).
 */
export function billFieldsFromText(lines: readonly string[], ownGstin?: string | null): BillHeaderFields {
  const text = lines.join("\n");
  const own = ownGstin ? normalizeGstin(ownGstin) : null;
  const gstins = [...text.toUpperCase().matchAll(GSTIN_IN_TEXT)].map((m) => m[0]).filter((g) => g !== own);
  const number = lines.map((l) => BILL_NO_IN_TEXT.exec(l)?.[1]).find(Boolean) ?? null;
  const dateText = lines.map((l) => DATE_IN_TEXT.exec(l)?.[1]).find(Boolean);
  const firstLine = lines.map((l) => l.trim()).find((l) => l && !HAS_GSTIN.test(l.toUpperCase()) && !/^(tax\s+)?invoice$|^bill\s+of\s+supply$|^(org|orig|original|dup|duplicate|trip|triplicate)\b|^page\s+\d/i.test(l));
  return {
    billNumber: number ? number.replace(/[.,:;]+$/, "") : null,
    billDate: dateText ? parseBillDate(dateText.replace(/\s+/g, "-").replace(/,/g, "")) : null,
    supplierGstin: gstins[0] ?? null,
    supplierName: firstLine ?? null,
  };
}
