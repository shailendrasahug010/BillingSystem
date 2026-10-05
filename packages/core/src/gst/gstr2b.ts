/**
 * GSTR-2B matching. GSTR-2B is the monthly statement on the GST portal of
 * the purchase bills suppliers reported against the business's GSTIN, and
 * so the input tax credit it may claim. Matching it with the purchase bills
 * entered shows which agree, which differ, which the books lack (a bill not
 * entered) and which the portal lacks (the supplier did not report it: the
 * credit is at risk until they do).
 */

export interface Tax2b {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Invoice2b extends Tax2b {
  supplierGstin: string;
  supplierName: string | null;
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  value: number;
  /** "N": the portal says this credit may not be claimed (place of supply, a late bill, and so on). */
  itcAvailable: boolean;
  reverseCharge: boolean;
}

export interface Parsed2b {
  /** The business's GSTIN the statement is for. */
  gstin: string | null;
  /** YYYY-MM, from the statement's return period. */
  period: string | null;
  invoices: Invoice2b[];
  /** Credit and debit notes in the statement (counted, not matched). */
  notes: number;
}

export interface BookBill extends Tax2b {
  id: string;
  supplierGstin: string;
  supplierName: string;
  number: string;
  date: string;
  value: number;
}

export type Match2bStatus = "matched" | "mismatch" | "not_in_books" | "not_in_2b";

export interface Match2bRow {
  status: Match2bStatus;
  supplierGstin: string;
  supplierName: string | null;
  number: string;
  date: string;
  portal: (Tax2b & { value: number; itcAvailable: boolean; reverseCharge: boolean }) | null;
  books: (Tax2b & { id: string; value: number; date: string; number: string }) | null;
  /** Portal tax minus the books' tax (total of the four heads), on a mismatch. */
  taxDifference: number;
  /** The dates differ (a typing slip, usually; the credit still matches). */
  dateDiffers: boolean;
}

export interface Match2bSummary {
  matched: number;
  mismatch: number;
  notInBooks: number;
  notIn2b: number;
  /** Credit the portal shows as available. */
  itc2b: number;
  /** Credit on the bills entered for the month. */
  itcBooks: number;
  /** Credit on bills the portal does not show: at risk until the supplier reports them. */
  itcAtRisk: number;
  /** Credit on the portal for bills not entered: claimable once entered. */
  itcNotEntered: number;
}

/** Amounts within a rupee are the same (rounding on either side). */
export const MATCH_TOLERANCE = 1;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
export const taxOf = (t: Tax2b) => round2(t.igst + t.cgst + t.sgst + t.cess);

/** DD-MM-YYYY (the portal's) or YYYY-MM-DD to YYYY-MM-DD; null when it is neither. */
function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(v.trim());
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
}

/** MMYYYY (the portal's return period) to YYYY-MM. */
function period(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{2})(\d{4})$/.exec(v.trim());
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${m[1]}` : null;
}

/**
 * The same bill number however it was typed: case, spaces, slashes and
 * dashes, and leading zeros in each run of digits ("INV/0012" and "inv-12").
 */
export function billNumberKey(n: string): string {
  return n
    .toUpperCase()
    .replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ""))
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Reads a GSTR-2B JSON file as downloaded from the portal (Returns →
 * GSTR-2B → Download → JSON). Accepts the statement with or without its
 * outer "data". Throws GSTR2B_NOT_RECOGNISED for anything else.
 */
export function parseGstr2b(file: unknown): Parsed2b {
  const root = (file && typeof file === "object" ? file : {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const docdata = (data.docdata && typeof data.docdata === "object" ? data.docdata : data) as Record<string, unknown>;
  const b2b = docdata.b2b;
  if (!Array.isArray(b2b) && !Array.isArray(docdata.cdnr)) throw new Error("GSTR2B_NOT_RECOGNISED");
  const invoices: Invoice2b[] = [];
  for (const supplier of Array.isArray(b2b) ? b2b : []) {
    const s = (supplier ?? {}) as Record<string, unknown>;
    const gstin = typeof s.ctin === "string" ? s.ctin.trim().toUpperCase() : "";
    if (!gstin) continue;
    for (const inv of Array.isArray(s.inv) ? s.inv : []) {
      const i = (inv ?? {}) as Record<string, unknown>;
      const items = Array.isArray(i.items) ? (i.items as Array<Record<string, unknown>>) : [];
      // The statement gives the invoice's totals; older files only its items.
      const sum = (k: string) => (i[k] !== undefined ? num(i[k]) : items.reduce((a, it) => a + num(it[k]), 0));
      const date = isoDate(i.dt);
      if (typeof i.inum !== "string" || !date) continue;
      invoices.push({
        supplierGstin: gstin,
        supplierName: typeof s.trdnm === "string" ? s.trdnm : null,
        number: i.inum.trim(),
        date,
        value: num(i.val),
        taxable: round2(sum("txval")),
        igst: round2(sum("igst")),
        cgst: round2(sum("cgst")),
        sgst: round2(sum("sgst")),
        cess: round2(sum("cess")),
        itcAvailable: i.itcavl !== "N",
        reverseCharge: i.rev === "Y",
      });
    }
  }
  const notes = (Array.isArray(docdata.cdnr) ? docdata.cdnr : []).reduce((n: number, s) => n + (Array.isArray((s as { nt?: unknown[] })?.nt) ? (s as { nt: unknown[] }).nt.length : 0), 0);
  return { gstin: typeof data.gstin === "string" ? data.gstin.toUpperCase() : null, period: period(data.rtnprd), invoices, notes };
}

/**
 * Matches the statement's bills with the purchase bills entered, by
 * supplier GSTIN and bill number. `books` may reach back before the month (a
 * supplier reporting an old bill late); only the month's own bills are
 * listed as missing from the portal.
 */
export function match2b(parsed: Parsed2b, books: BookBill[], month: string): { rows: Match2bRow[]; summary: Match2bSummary } {
  const byKey = new Map<string, BookBill>();
  for (const b of books) byKey.set(`${b.supplierGstin.toUpperCase()}|${billNumberKey(b.number)}`, b);
  const used = new Set<string>();
  const rows: Match2bRow[] = [];
  for (const p of parsed.invoices) {
    const key = `${p.supplierGstin}|${billNumberKey(p.number)}`;
    const b = byKey.get(key);
    const portal = { taxable: p.taxable, igst: p.igst, cgst: p.cgst, sgst: p.sgst, cess: p.cess, value: p.value, itcAvailable: p.itcAvailable, reverseCharge: p.reverseCharge };
    if (!b || used.has(b.id)) {
      rows.push({ status: "not_in_books", supplierGstin: p.supplierGstin, supplierName: p.supplierName, number: p.number, date: p.date, portal, books: null, taxDifference: taxOf(p), dateDiffers: false });
      continue;
    }
    used.add(b.id);
    const diff = round2(taxOf(p) - taxOf(b));
    const same = Math.abs(diff) <= MATCH_TOLERANCE && Math.abs(p.taxable - b.taxable) <= MATCH_TOLERANCE;
    rows.push({
      status: same ? "matched" : "mismatch",
      supplierGstin: p.supplierGstin,
      supplierName: p.supplierName ?? b.supplierName,
      number: p.number,
      date: p.date,
      portal,
      books: { id: b.id, taxable: b.taxable, igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess, value: b.value, date: b.date, number: b.number },
      taxDifference: same ? 0 : diff,
      dateDiffers: p.date !== b.date,
    });
  }
  for (const b of books) {
    if (used.has(b.id) || b.date.slice(0, 7) !== month) continue;
    rows.push({
      status: "not_in_2b",
      supplierGstin: b.supplierGstin,
      supplierName: b.supplierName,
      number: b.number,
      date: b.date,
      portal: null,
      books: { id: b.id, taxable: b.taxable, igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess, value: b.value, date: b.date, number: b.number },
      taxDifference: round2(-taxOf(b)),
      dateDiffers: false,
    });
  }
  const order: Record<Match2bStatus, number> = { mismatch: 0, not_in_books: 1, not_in_2b: 2, matched: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (a.supplierName ?? "").localeCompare(b.supplierName ?? "") || a.date.localeCompare(b.date));
  const count = (s: Match2bStatus) => rows.filter((r) => r.status === s).length;
  const sum = (pick: (r: Match2bRow) => number) => round2(rows.reduce((a, r) => a + pick(r), 0));
  return {
    rows,
    summary: {
      matched: count("matched"),
      mismatch: count("mismatch"),
      notInBooks: count("not_in_books"),
      notIn2b: count("not_in_2b"),
      itc2b: sum((r) => (r.portal?.itcAvailable ? taxOf(r.portal) : 0)),
      itcBooks: round2(books.filter((b) => b.date.slice(0, 7) === month).reduce((a, b) => a + taxOf(b), 0)),
      itcAtRisk: sum((r) => (r.status === "not_in_2b" && r.books ? taxOf(r.books) : 0)),
      itcNotEntered: sum((r) => (r.status === "not_in_books" && r.portal?.itcAvailable ? taxOf(r.portal) : 0)),
    },
  };
}
