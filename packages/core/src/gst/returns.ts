import { dec, type Dec, ZERO } from "../money/decimal.js";
import { isValidGstin } from "../validation/identifiers.js";
import { findState } from "./states.js";
import type { ZeroRatedType } from "./supply.js";

/**
 * GST return formatters. They turn rows of the GST register (facts written
 * when documents are posted) into return tables. Return rules change, so a
 * formatter is versioned: every export records the version that produced it,
 * and a new rule means a new version, never a rewrite of posted data.
 *
 * GSTR-1 JSON follows the GSTN offline-tool / upload layout (sections b2b,
 * b2cl, b2cs, cdnr, cdnur, hsn, nil, doc_issue). Always validate a month's
 * file in the current GST offline tool before filing: the portal schema can
 * change with an advisory, and the version constants below then need a
 * new formatter version.
 */
export const GSTR1_FORMATTER_VERSION = "gstr1-json@2026.10";
/** Value written to the file's "version" field. */
export const GSTR1_SCHEMA_VERSION = "GST3.2.2";
export const GSTR3B_FORMATTER_VERSION = "gstr3b-summary@2026.10";

export type RegisterDocType = "invoice" | "credit_note" | "debit_note" | "purchase" | "purchase_credit_note" | "purchase_debit_note" | "expense";
export type Taxability = "taxable" | "exempt" | "nil_rated" | "non_gst" | "zero_rated";

/** One row of the GST register (one taxable line of a posted document). */
export interface GstRegisterRow {
  direction: "outward" | "inward";
  docType: RegisterDocType;
  docId: string;
  docNumber: string;
  /** YYYY-MM-DD */
  docDate: string;
  originalDocNumber: string | null;
  originalDocDate: string | null;
  partyName: string | null;
  partyGstin: string | null;
  placeOfSupply: string;
  supplyType: "intra_state" | "inter_state";
  isReverseCharge: boolean;
  taxability: Taxability;
  hsnCode: string | null;
  uqc: string | null;
  qty: string;
  taxableValue: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  documentValue: string;
  itcEligibility: string | null;
  isCancelled: boolean;
  /** Export or supply to an SEZ, with or without payment of IGST (a note carries its invoice's). */
  zeroRatedType?: ZeroRatedType | null;
  /** Exports: the shipping bill, when known (it often comes after the invoice). */
  shippingBill?: { number: string | null; date: string | null; portCode: string | null } | null;
}

export interface ReturnWarning {
  code:
    | "INVALID_PARTY_GSTIN"
    | "HSN_MISSING"
    | "HSN_TOO_SHORT"
    | "UQC_MISSING"
    | "ZERO_RATED_NOT_SUPPORTED"
    | "NOTE_ORIGINAL_NOT_FOUND"
    | "SHIPPING_BILL_MISSING"
    | "SEZ_GSTIN_MISSING";
  docNumber?: string;
  params?: Record<string, string>;
}

interface Heads {
  txval: Dec;
  iamt: Dec;
  camt: Dec;
  samt: Dec;
  csamt: Dec;
}
const zeroHeads = (): Heads => ({ txval: ZERO, iamt: ZERO, camt: ZERO, samt: ZERO, csamt: ZERO });
const addHeads = (h: Heads, r: GstRegisterRow, sign = 1): Heads => ({
  txval: h.txval.plus(dec(r.taxableValue).times(sign)),
  iamt: h.iamt.plus(dec(r.igst).times(sign)),
  camt: h.camt.plus(dec(r.cgst).times(sign)),
  samt: h.samt.plus(dec(r.sgst).times(sign)),
  csamt: h.csamt.plus(dec(r.cess).times(sign)),
});
/** JSON numbers with at most two decimals (the portal rejects more). */
const n2 = (d: Dec) => Number(d.toFixed(2));
const n3 = (d: Dec) => Number(d.toFixed(3));
const rateOf = (r: GstRegisterRow) => Number(dec(r.gstRate).toFixed(3));
/** 2026-09-24 -> 24-09-2026 */
export const portalDate = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
/** 2026-09 -> 092026 */
export const portalPeriod = (period: string) => `${period.slice(5, 7)}${period.slice(0, 4)}`;

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Items of one document: one item per tax rate, numbered from 1. */
function items(rows: readonly GstRegisterRow[], withIntra: boolean) {
  return [...groupBy(rows, rateOf).entries()]
    .sort(([a], [b]) => a - b)
    .map(([rt, rs], i) => {
      const h = rs.reduce((acc, r) => addHeads(acc, r), zeroHeads());
      return {
        num: i + 1,
        itm_det: withIntra ? { txval: n2(h.txval), rt, iamt: n2(h.iamt), camt: n2(h.camt), samt: n2(h.samt), csamt: n2(h.csamt) } : { txval: n2(h.txval), rt, iamt: n2(h.iamt), csamt: n2(h.csamt) },
      };
    });
}

export interface Gstr1Input {
  gstin: string;
  /** YYYY-MM */
  period: string;
  /** Invoice value above which an inter-state sale to an unregistered buyer is B2CL. */
  b2clThreshold: string;
  /** Minimum HSN digits for this business (4 or 6), from configuration. */
  hsnMinDigits: number;
  /** Outward register rows of the period, cancelled documents included (for the document summary). */
  rows: readonly GstRegisterRow[];
  /** Original invoices of the period's notes: invoice number -> its value and supply type. */
  originalInvoices?: ReadonlyMap<string, { value: string; supplyType: "intra_state" | "inter_state" }>;
}

export interface SectionSummary {
  section: "b2b" | "b2cl" | "b2cs" | "exp" | "cdnr" | "cdnur" | "nil" | "hsn_b2b" | "hsn_b2c";
  records: number;
  value: string;
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
}

export interface Gstr1Result {
  version: string;
  json: Record<string, unknown>;
  summary: SectionSummary[];
  documents: Array<{ docNum: number; label: string; from: string; to: string; total: number; cancelled: number; net: number }>;
  warnings: ReturnWarning[];
}

type B2csKey = string;

/** Builds GSTR-1 for a month from the outward GST register. */
export function buildGstr1(input: Gstr1Input): Gstr1Result {
  const warnings: ReturnWarning[] = [];
  const threshold = dec(input.b2clThreshold);
  const outward = input.rows.filter((r) => r.direction === "outward");
  const live = outward.filter((r) => !r.isCancelled);

  const warnedDocs = new Set<string>();
  const warnOnce = (w: ReturnWarning) => {
    const k = `${w.code}:${w.docNumber ?? ""}:${JSON.stringify(w.params ?? {})}`;
    if (!warnedDocs.has(k)) {
      warnedDocs.add(k);
      warnings.push(w);
    }
  };

  const b2b = new Map<string, GstRegisterRow[]>();
  const b2cl = new Map<string, GstRegisterRow[]>();
  const b2cs = new Map<B2csKey, { sply_ty: "INTRA" | "INTER"; pos: string; rt: number; h: Heads }>();
  const cdnr = new Map<string, GstRegisterRow[]>();
  const cdnur: GstRegisterRow[] = [];
  const exp = new Map<"WPAY" | "WOPAY", GstRegisterRow[]>();
  const nil = new Map<string, { expt: Dec; nil: Dec; ngsup: Dec }>();
  const hsnB2b = new Map<string, { hsn: string; uqc: string; rt: number; qty: Dec; h: Heads }>();
  const hsnB2c = new Map<string, { hsn: string; uqc: string; rt: number; qty: Dec; h: Heads }>();

  const addB2cs = (r: GstRegisterRow, sign: number) => {
    const sply = r.supplyType === "inter_state" ? "INTER" : "INTRA";
    const key = `${sply}|${r.placeOfSupply}|${rateOf(r)}`;
    const cur = b2cs.get(key) ?? { sply_ty: sply, pos: r.placeOfSupply, rt: rateOf(r), h: zeroHeads() };
    cur.h = addHeads(cur.h, r, sign);
    b2cs.set(key, cur);
  };
  const addHsn = (r: GstRegisterRow, sign: number) => {
    const hsn = r.hsnCode ?? "";
    if (!hsn) warnOnce({ code: "HSN_MISSING", docNumber: r.docNumber });
    else if (hsn.length < input.hsnMinDigits) warnOnce({ code: "HSN_TOO_SHORT", params: { hsn, digits: String(input.hsnMinDigits) } });
    if (!r.uqc) warnOnce({ code: "UQC_MISSING", params: { hsn } });
    const uqc = r.uqc ?? "OTH";
    const target = r.partyGstin ? hsnB2b : hsnB2c;
    const key = `${hsn}|${uqc}|${rateOf(r)}`;
    const cur = target.get(key) ?? { hsn, uqc, rt: rateOf(r), qty: ZERO, h: zeroHeads() };
    cur.qty = cur.qty.plus(dec(r.qty).times(sign));
    cur.h = addHeads(cur.h, r, sign);
    target.set(key, cur);
  };
  const addNil = (r: GstRegisterRow, sign: number) => {
    const key = `${r.supplyType === "inter_state" ? "INTR" : "INTRA"}${r.partyGstin ? "B2B" : "B2C"}`;
    const cur = nil.get(key) ?? { expt: ZERO, nil: ZERO, ngsup: ZERO };
    const v = dec(r.taxableValue).times(sign);
    if (r.taxability === "exempt") cur.expt = cur.expt.plus(v);
    else if (r.taxability === "nil_rated") cur.nil = cur.nil.plus(v);
    else cur.ngsup = cur.ngsup.plus(v);
    nil.set(key, cur);
  };

  for (const r of live) {
    if (r.taxability === "zero_rated" && !r.zeroRatedType) {
      warnOnce({ code: "ZERO_RATED_NOT_SUPPORTED", docNumber: r.docNumber });
      continue;
    }
    const isNote = r.docType === "credit_note" || r.docType === "debit_note";
    const sign = r.docType === "credit_note" ? -1 : 1;
    addHsn(r, sign);
    // Exports (6A) and supplies to SEZ (6B, with B2B); their notes go to CDNUR and CDNR.
    if (r.zeroRatedType) {
      const isExport = r.zeroRatedType.startsWith("EXP");
      if (!isExport && !r.partyGstin) {
        warnOnce({ code: "SEZ_GSTIN_MISSING", docNumber: r.docNumber });
        continue;
      }
      if (!isNote) {
        if (isExport) {
          if (!r.shippingBill?.number) warnOnce({ code: "SHIPPING_BILL_MISSING", docNumber: r.docNumber });
          const typ = r.zeroRatedType === "EXPWP" ? "WPAY" : "WOPAY";
          exp.set(typ, [...(exp.get(typ) ?? []), r]);
        } else b2b.set(r.partyGstin!, [...(b2b.get(r.partyGstin!) ?? []), r]);
      } else if (isExport) cdnur.push(r);
      else cdnr.set(r.partyGstin!, [...(cdnr.get(r.partyGstin!) ?? []), r]);
      continue;
    }
    if (r.taxability !== "taxable") {
      addNil(r, sign);
      continue;
    }
    if (r.partyGstin && !isValidGstin(r.partyGstin)) warnOnce({ code: "INVALID_PARTY_GSTIN", docNumber: r.docNumber, params: { gstin: r.partyGstin } });
    if (!isNote) {
      if (r.partyGstin) b2b.set(r.partyGstin, [...(b2b.get(r.partyGstin) ?? []), r]);
      else if (r.supplyType === "inter_state" && dec(r.documentValue).gt(threshold)) b2cl.set(r.placeOfSupply, [...(b2cl.get(r.placeOfSupply) ?? []), r]);
      else addB2cs(r, 1);
      continue;
    }
    if (r.partyGstin) {
      cdnr.set(r.partyGstin, [...(cdnr.get(r.partyGstin) ?? []), r]);
      continue;
    }
    // A note to an unregistered buyer is reported on its own (CDNUR) only when the
    // original invoice was a large inter-state B2CL sale; otherwise it adjusts B2CS.
    const original = r.originalDocNumber ? input.originalInvoices?.get(r.originalDocNumber) : undefined;
    if (r.originalDocNumber && !original) warnOnce({ code: "NOTE_ORIGINAL_NOT_FOUND", docNumber: r.docNumber, params: { original: r.originalDocNumber } });
    const wasB2cl = original ? original.supplyType === "inter_state" && dec(original.value).gt(threshold) : r.supplyType === "inter_state" && dec(r.documentValue).gt(threshold);
    if (wasB2cl) cdnur.push(r);
    else addB2cs(r, sign);
  }

  // ---- JSON sections
  /** B2B invoice type: regular, or a supply to an SEZ with (SEWP) or without (SEWOP) payment of IGST. */
  const invType = (r: GstRegisterRow) => (r.zeroRatedType === "SEZWP" ? "SEWP" : r.zeroRatedType === "SEZWOP" ? "SEWOP" : "R");
  const invoiceOf = (rows: GstRegisterRow[], withIntra: boolean) =>
    [...groupBy(rows, (r) => r.docId).values()]
      .sort((a, b) => a[0]!.docDate.localeCompare(b[0]!.docDate) || a[0]!.docNumber.localeCompare(b[0]!.docNumber))
      .map((rs) => ({ first: rs[0]!, itms: items(rs, withIntra) }));

  const b2bJson = [...b2b.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ctin, rows]) => ({
      ctin,
      inv: invoiceOf(rows, true).map(({ first, itms }) => ({
        inum: first.docNumber,
        idt: portalDate(first.docDate),
        val: n2(dec(first.documentValue)),
        pos: first.placeOfSupply,
        rchrg: first.isReverseCharge ? "Y" : "N",
        inv_typ: invType(first),
        itms,
      })),
    }));
  const expJson = (["WPAY", "WOPAY"] as const)
    .filter((typ) => exp.has(typ))
    .map((typ) => ({
      exp_typ: typ,
      inv: invoiceOf(exp.get(typ)!, false).map(({ first, itms }) => ({
        inum: first.docNumber,
        idt: portalDate(first.docDate),
        val: n2(dec(first.documentValue)),
        ...(first.shippingBill?.portCode ? { sbpcode: first.shippingBill.portCode } : {}),
        ...(first.shippingBill?.number ? { sbnum: first.shippingBill.number } : {}),
        ...(first.shippingBill?.date ? { sbdt: portalDate(first.shippingBill.date) } : {}),
        // Exports list their items flat (no num / itm_det).
        itms: itms.map((it) => ({ txval: it.itm_det.txval, rt: it.itm_det.rt, iamt: it.itm_det.iamt, csamt: it.itm_det.csamt })),
      })),
    }));
  const b2clJson = [...b2cl.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pos, rows]) => ({
      pos,
      inv: invoiceOf(rows, false).map(({ first, itms }) => ({ inum: first.docNumber, idt: portalDate(first.docDate), val: n2(dec(first.documentValue)), itms })),
    }));
  const b2csJson = [...b2cs.values()]
    .filter((x) => !x.h.txval.isZero() || !x.h.iamt.isZero() || !x.h.camt.isZero())
    .sort((a, b) => a.sply_ty.localeCompare(b.sply_ty) || a.pos.localeCompare(b.pos) || a.rt - b.rt)
    .map((x) => ({
      sply_ty: x.sply_ty,
      pos: x.pos,
      typ: "OE",
      txval: n2(x.h.txval),
      rt: x.rt,
      iamt: n2(x.h.iamt),
      ...(x.sply_ty === "INTRA" ? { camt: n2(x.h.camt), samt: n2(x.h.samt) } : {}),
      csamt: n2(x.h.csamt),
    }));
  const noteEntry = (first: GstRegisterRow, itms: ReturnType<typeof items>, withIntra: boolean) => ({
      ntty: first.docType === "credit_note" ? "C" : "D",
      nt_num: first.docNumber,
      nt_dt: portalDate(first.docDate),
      val: n2(dec(first.documentValue)),
      // A note on an export has no place of supply in India.
      ...(first.zeroRatedType?.startsWith("EXP") ? {} : { pos: first.placeOfSupply }),
      ...(withIntra ? { rchrg: "N", inv_typ: invType(first) } : {}),
      itms,
    });
  const cdnrJson = [...cdnr.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ctin, rows]) => ({ ctin, nt: invoiceOf(rows, true).map(({ first, itms }) => noteEntry(first, itms, true)) }));
  // Unregistered notes: on a large inter-state B2C invoice (B2CL), or on an export (EXPWP / EXPWOP).
  const cdnurJson = invoiceOf(cdnur, false).map(({ first, itms }) => ({
    typ: first.zeroRatedType === "EXPWP" || first.zeroRatedType === "EXPWOP" ? first.zeroRatedType : "B2CL",
    ...noteEntry(first, itms, false),
  }));
  const hsnJson = (m: typeof hsnB2b) =>
    [...m.values()]
      .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rt - b.rt)
      .map((x, i) => ({ num: i + 1, hsn_sc: x.hsn, desc: "", uqc: x.uqc, qty: n3(x.qty), rt: x.rt, txval: n2(x.h.txval), iamt: n2(x.h.iamt), camt: n2(x.h.camt), samt: n2(x.h.samt), csamt: n2(x.h.csamt) }));
  const nilJson = ["INTRB2B", "INTRAB2B", "INTRB2C", "INTRAB2C"]
    .filter((k) => nil.has(k))
    .map((k) => ({ sply_ty: k, expt_amt: n2(nil.get(k)!.expt), nil_amt: n2(nil.get(k)!.nil), ngsup_amt: n2(nil.get(k)!.ngsup) }));

  // ---- Document summary (Table 13): every number issued, cancelled ones included.
  const DOC_KINDS: Array<{ docType: RegisterDocType; docNum: number; label: string }> = [
    { docType: "invoice", docNum: 1, label: "Invoices for outward supply" },
    { docType: "debit_note", docNum: 4, label: "Debit Note" },
    { docType: "credit_note", docNum: 5, label: "Credit Note" },
  ];
  const documents: Gstr1Result["documents"] = [];
  for (const kind of DOC_KINDS) {
    const docs = [...groupBy(outward.filter((r) => r.docType === kind.docType), (r) => r.docId).values()].map((rs) => ({ number: rs[0]!.docNumber, cancelled: rs.every((r) => r.isCancelled) }));
    for (const [, series] of [...groupBy(docs, (d) => d.number.replace(/\d+$/, "")).entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...series].sort((a, b) => a.number.localeCompare(b.number, "en", { numeric: true }));
      const cancelled = series.filter((d) => d.cancelled).length;
      documents.push({ docNum: kind.docNum, label: kind.label, from: sorted[0]!.number, to: sorted.at(-1)!.number, total: series.length, cancelled, net: series.length - cancelled });
    }
  }
  const docIssue = DOC_KINDS.filter((k) => documents.some((d) => d.docNum === k.docNum)).map((k) => ({
    doc_num: k.docNum,
    doc_typ: k.label,
    docs: documents.filter((d) => d.docNum === k.docNum).map((d, i) => ({ num: i + 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.net })),
  }));

  const json: Record<string, unknown> = { gstin: input.gstin, fp: portalPeriod(input.period), version: GSTR1_SCHEMA_VERSION, hash: "hash" };
  if (b2bJson.length) json.b2b = b2bJson;
  if (b2clJson.length) json.b2cl = b2clJson;
  if (b2csJson.length) json.b2cs = b2csJson;
  if (expJson.length) json.exp = expJson;
  if (cdnrJson.length) json.cdnr = cdnrJson;
  if (cdnurJson.length) json.cdnur = cdnurJson;
  if (hsnB2b.size || hsnB2c.size) json.hsn = { ...(hsnB2b.size ? { hsn_b2b: hsnJson(hsnB2b) } : {}), ...(hsnB2c.size ? { hsn_b2c: hsnJson(hsnB2c) } : {}) };
  if (nilJson.length) json.nil = { inv: nilJson };
  if (docIssue.length) json.doc_issue = { doc_det: docIssue };

  // ---- Summary per section (what the offline tool shows before upload)
  // Each section holds one kind of document; notes are shown as their own (positive) amounts, as the offline tool does.
  const sum = (section: SectionSummary["section"], records: number, rows: readonly GstRegisterRow[], value: Dec): SectionSummary => {
    const h = rows.reduce((acc, r) => addHeads(acc, r), zeroHeads());
    return { section, records, value: value.toFixed(2), taxable: h.txval.toFixed(2), igst: h.iamt.toFixed(2), cgst: h.camt.toFixed(2), sgst: h.samt.toFixed(2), cess: h.csamt.toFixed(2) };
  };
  const docValue = (rows: readonly GstRegisterRow[]) => [...groupBy(rows, (r) => r.docId).values()].reduce((s, rs) => s.plus(rs[0]!.documentValue), ZERO);
  const b2bRows = [...b2b.values()].flat();
  const expRows = [...exp.values()].flat();
  const b2clRows = [...b2cl.values()].flat();
  const cdnrRows = [...cdnr.values()].flat();
  const b2csTotals = [...b2cs.values()].reduce((acc, x) => ({ txval: acc.txval.plus(x.h.txval), iamt: acc.iamt.plus(x.h.iamt), camt: acc.camt.plus(x.h.camt), samt: acc.samt.plus(x.h.samt), csamt: acc.csamt.plus(x.h.csamt) }), zeroHeads());
  const hsnSummary = (section: "hsn_b2b" | "hsn_b2c", m: typeof hsnB2b): SectionSummary => {
    const h = [...m.values()].reduce((acc, x) => ({ txval: acc.txval.plus(x.h.txval), iamt: acc.iamt.plus(x.h.iamt), camt: acc.camt.plus(x.h.camt), samt: acc.samt.plus(x.h.samt), csamt: acc.csamt.plus(x.h.csamt) }), zeroHeads());
    return { section, records: m.size, value: "0.00", taxable: h.txval.toFixed(2), igst: h.iamt.toFixed(2), cgst: h.camt.toFixed(2), sgst: h.samt.toFixed(2), cess: h.csamt.toFixed(2) };
  };
  const nilTotal = [...nil.values()].reduce((s, x) => s.plus(x.expt).plus(x.nil).plus(x.ngsup), ZERO);
  const summary: SectionSummary[] = [
    sum("b2b", new Set(b2bRows.map((r) => r.docId)).size, b2bRows, docValue(b2bRows)),
    sum("b2cl", new Set(b2clRows.map((r) => r.docId)).size, b2clRows, docValue(b2clRows)),
    {
      section: "b2cs",
      records: b2csJson.length,
      value: "0.00",
      taxable: b2csTotals.txval.toFixed(2),
      igst: b2csTotals.iamt.toFixed(2),
      cgst: b2csTotals.camt.toFixed(2),
      sgst: b2csTotals.samt.toFixed(2),
      cess: b2csTotals.csamt.toFixed(2),
    },
    sum("exp", new Set(expRows.map((r) => r.docId)).size, expRows, docValue(expRows)),
    sum("cdnr", new Set(cdnrRows.map((r) => r.docId)).size, cdnrRows, docValue(cdnrRows)),
    sum("cdnur", new Set(cdnur.map((r) => r.docId)).size, cdnur, docValue(cdnur)),
    { section: "nil", records: nilJson.length, value: nilTotal.toFixed(2), taxable: nilTotal.toFixed(2), igst: "0.00", cgst: "0.00", sgst: "0.00", cess: "0.00" },
    hsnSummary("hsn_b2b", hsnB2b),
    hsnSummary("hsn_b2c", hsnB2c),
  ];

  return { version: GSTR1_FORMATTER_VERSION, json, summary, documents, warnings };
}

// ---------------------------------------------------------------- CSV (offline tool Excel/CSV templates)

const stateLabel = (code: string) => `${code}-${findState(code)?.name ?? ""}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-09-24 -> 24-Sep-2026 (the offline tool's CSV date format) */
export const offlineToolDate = (iso: string) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;

export type Gstr1CsvSection = "b2b" | "b2cl" | "b2cs" | "exp" | "cdnr" | "cdnur" | "hsn" | "docs";

/** The offline tool's names for B2B invoice types. */
const INVOICE_TYPE: Record<string, string> = { R: "Regular B2B", SEWP: "SEZ supplies with payment", SEWOP: "SEZ supplies without payment", DE: "Deemed Exp" };

/** Rows for one GSTR-1 section in the offline tool's CSV layout (header row first). */
export function gstr1Csv(result: Gstr1Result, section: Gstr1CsvSection, names: ReadonlyMap<string, string> = new Map()): string[][] {
  const j = result.json as Record<string, any>;
  switch (section) {
    case "b2b":
      return [
        ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
        ...((j.b2b ?? []) as any[]).flatMap((p) =>
          p.inv.flatMap((inv: any) => inv.itms.map((it: any) => [p.ctin, names.get(p.ctin) ?? "", inv.inum, offlineToolDate(isoFromPortal(inv.idt)), inv.val, stateLabel(inv.pos), inv.rchrg, "", INVOICE_TYPE[inv.inv_typ] ?? "Regular B2B", "", it.itm_det.rt, it.itm_det.txval, it.itm_det.csamt])),
        ),
      ].map(strings);
    case "b2cl":
      return [
        ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
        ...((j.b2cl ?? []) as any[]).flatMap((p) => p.inv.flatMap((inv: any) => inv.itms.map((it: any) => [inv.inum, offlineToolDate(isoFromPortal(inv.idt)), inv.val, stateLabel(p.pos), "", it.itm_det.rt, it.itm_det.txval, it.itm_det.csamt, ""]))),
      ].map(strings);
    case "b2cs":
      return [["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], ...((j.b2cs ?? []) as any[]).map((x) => [x.typ, stateLabel(x.pos), "", x.rt, x.txval, x.csamt, ""])].map(strings);
    case "exp":
      return [
        ["Export Type", "Invoice Number", "Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
        ...((j.exp ?? []) as any[]).flatMap((e) =>
          e.inv.flatMap((inv: any) => inv.itms.map((it: any) => [e.exp_typ, inv.inum, offlineToolDate(isoFromPortal(inv.idt)), inv.val, inv.sbpcode ?? "", inv.sbnum ?? "", inv.sbdt ? offlineToolDate(isoFromPortal(inv.sbdt)) : "", "", it.rt, it.txval, it.csamt])),
        ),
      ].map(strings);
    case "cdnr":
      return [
        ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
        ...((j.cdnr ?? []) as any[]).flatMap((p) =>
          p.nt.flatMap((nt: any) => nt.itms.map((it: any) => [p.ctin, names.get(p.ctin) ?? "", nt.nt_num, offlineToolDate(isoFromPortal(nt.nt_dt)), nt.ntty, stateLabel(nt.pos), nt.rchrg, INVOICE_TYPE[nt.inv_typ] ?? "Regular B2B", nt.val, "", it.itm_det.rt, it.itm_det.txval, it.itm_det.csamt])),
        ),
      ].map(strings);
    case "cdnur":
      return [
        ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
        ...((j.cdnur ?? []) as any[]).flatMap((nt) => nt.itms.map((it: any) => [nt.typ, nt.nt_num, offlineToolDate(isoFromPortal(nt.nt_dt)), nt.ntty, nt.pos ? stateLabel(nt.pos) : "", nt.val, "", it.itm_det.rt, it.itm_det.txval, it.itm_det.csamt])),
      ].map(strings);
    case "hsn": {
      const rows = (tab: string, list: any[] | undefined) => (list ?? []).map((x) => [tab, x.hsn_sc, x.desc, x.uqc, x.qty, x.txval + x.iamt + x.camt + x.samt + x.csamt, x.rt, x.txval, x.iamt, x.camt, x.samt, x.csamt]);
      return [
        ["Table", "HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
        ...rows("B2B", j.hsn?.hsn_b2b),
        ...rows("B2C", j.hsn?.hsn_b2c),
      ].map((r) => strings(r.map((v) => (typeof v === "number" ? Number(v.toFixed(2)) : v))));
    }
    case "docs":
      return [["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"], ...result.documents.map((d) => [d.label, d.from, d.to, d.total, d.cancelled])].map(strings);
  }
}

const strings = (row: unknown[]) => row.map((v) => (v === null || v === undefined ? "" : String(v)));
const isoFromPortal = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;

// ---------------------------------------------------------------- GSTR-3B

export interface TaxHeads {
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
}
interface HeadsDec {
  igst: Dec;
  cgst: Dec;
  sgst: Dec;
  cess: Dec;
}
const zeroTax = (): HeadsDec => ({ igst: ZERO, cgst: ZERO, sgst: ZERO, cess: ZERO });
const fmtTax = (h: HeadsDec): TaxHeads => ({ igst: h.igst.toFixed(2), cgst: h.cgst.toFixed(2), sgst: h.sgst.toFixed(2), cess: h.cess.toFixed(2) });
const plusRow = (h: HeadsDec, r: GstRegisterRow, sign: number): HeadsDec => ({
  igst: h.igst.plus(dec(r.igst).times(sign)),
  cgst: h.cgst.plus(dec(r.cgst).times(sign)),
  sgst: h.sgst.plus(dec(r.sgst).times(sign)),
  cess: h.cess.plus(dec(r.cess).times(sign)),
});

export interface Gstr3bResult {
  version: string;
  period: string;
  /** 3.1 (a) outward taxable supplies, (b) zero-rated (exports, SEZ), (c) nil / exempt, (d) inward supplies liable to reverse charge, (e) non-GST. */
  outward: {
    taxable: { taxable: string } & TaxHeads;
    zeroRated: { taxable: string } & TaxHeads;
    nilExempt: { taxable: string };
    reverseChargeInward: { taxable: string } & TaxHeads;
    nonGst: { taxable: string };
  };
  /** 3.2 inter-state supplies to unregistered persons, by place of supply. */
  interStateUnregistered: Array<{ placeOfSupply: string; taxable: string; igst: string }>;
  /** 4: ITC available (A3 reverse charge, A5 all other), reversed (B1: section 17(5) and rules), net (C). */
  itc: { reverseCharge: TaxHeads; allOther: TaxHeads; reversed: TaxHeads; net: TaxHeads };
  /** 6.1 indicative payment: forward-charge tax paid from credit (rule 88A order), the rest and reverse charge in cash. */
  payment: { liability: TaxHeads; paidFromCredit: TaxHeads; cash: TaxHeads; creditCarriedForward: TaxHeads };
}

/**
 * Credit utilisation (section 49 and rule 88A): IGST credit is used first,
 * against IGST and then CGST / SGST (placed where the matching credit falls
 * short, to keep cash low); CGST and SGST credit then go to their own head
 * and then IGST, never to each other; cess only against cess.
 */
export function utiliseCredit(liability: TaxHeads, credit: TaxHeads) {
  const l = { igst: dec(liability.igst), cgst: dec(liability.cgst), sgst: dec(liability.sgst), cess: dec(liability.cess) };
  const c = { igst: dec(credit.igst), cgst: dec(credit.cgst), sgst: dec(credit.sgst), cess: dec(credit.cess) };
  const used = zeroTax();
  const take = (from: keyof HeadsDec, to: keyof HeadsDec, limit?: Dec) => {
    let amount = Dec_min(c[from], l[to]);
    if (limit) amount = Dec_min(amount, limit);
    if (amount.lte(0)) return;
    c[from] = c[from].minus(amount);
    l[to] = l[to].minus(amount);
    used[to] = used[to].plus(amount);
  };
  take("igst", "igst");
  // Place remaining IGST credit where CGST / SGST credit will not reach, then anywhere.
  take("igst", "cgst", Dec_max(ZERO, l.cgst.minus(c.cgst)));
  take("igst", "sgst", Dec_max(ZERO, l.sgst.minus(c.sgst)));
  take("igst", "cgst");
  take("igst", "sgst");
  take("cgst", "cgst");
  take("sgst", "sgst");
  take("cgst", "igst");
  take("sgst", "igst");
  take("cess", "cess");
  return { paidFromCredit: fmtTax(used), remaining: fmtTax(l), creditLeft: fmtTax(c) };
}
const Dec_min = (a: Dec, b: Dec) => (a.lt(b) ? a : b);
const Dec_max = (a: Dec, b: Dec) => (a.gt(b) ? a : b);

/** Builds the GSTR-3B summary for a month from the whole GST register (outward and inward). */
export function buildGstr3b(period: string, rows: readonly GstRegisterRow[]): Gstr3bResult {
  const live = rows.filter((r) => !r.isCancelled);
  const outward = live.filter((r) => r.direction === "outward");
  const inward = live.filter((r) => r.direction === "inward");
  // Sales credit notes reduce output tax; our debit notes to suppliers (purchase returns)
  // and suppliers' credit notes reduce input tax credit.
  const noteSign = (r: GstRegisterRow) =>
    r.direction === "outward" ? (r.docType === "credit_note" ? -1 : 1) : r.docType === "debit_note" || r.docType === "purchase_credit_note" ? -1 : 1;

  let taxable = ZERO;
  let taxOut = zeroTax();
  let zeroRated = ZERO;
  let zeroRatedTax = zeroTax();
  let nilExempt = ZERO;
  let nonGst = ZERO;
  const unreg = new Map<string, { taxable: Dec; igst: Dec }>();
  for (const r of outward) {
    const s = noteSign(r);
    if (r.zeroRatedType) {
      // 3.1 (b): exports and supplies to SEZ; IGST paid on those "with payment" is still due.
      zeroRated = zeroRated.plus(dec(r.taxableValue).times(s));
      zeroRatedTax = plusRow(zeroRatedTax, r, s);
    } else if (r.taxability === "taxable") {
      taxable = taxable.plus(dec(r.taxableValue).times(s));
      taxOut = plusRow(taxOut, r, s);
      if (!r.partyGstin && r.supplyType === "inter_state") {
        const cur = unreg.get(r.placeOfSupply) ?? { taxable: ZERO, igst: ZERO };
        unreg.set(r.placeOfSupply, { taxable: cur.taxable.plus(dec(r.taxableValue).times(s)), igst: cur.igst.plus(dec(r.igst).times(s)) });
      }
    } else if (r.taxability === "non_gst") nonGst = nonGst.plus(dec(r.taxableValue).times(s));
    else if (r.taxability !== "zero_rated") nilExempt = nilExempt.plus(dec(r.taxableValue).times(s));
  }

  let rcmTaxable = ZERO;
  let rcmTax = zeroTax();
  let itcRcm = zeroTax();
  let itcOther = zeroTax();
  let reversed = zeroTax();
  for (const r of inward) {
    if (r.taxability !== "taxable") continue;
    const s = noteSign(r);
    if (r.isReverseCharge) {
      rcmTaxable = rcmTaxable.plus(dec(r.taxableValue).times(s));
      rcmTax = plusRow(rcmTax, r, s);
      itcRcm = plusRow(itcRcm, r, s);
    } else {
      itcOther = plusRow(itcOther, r, s);
    }
    // Blocked credit (section 17(5)) is shown as available and then reversed (CBIC circular 170/2022).
    if (r.itcEligibility === "ineligible") reversed = plusRow(reversed, r, s);
  }
  const net: HeadsDec = {
    igst: itcRcm.igst.plus(itcOther.igst).minus(reversed.igst),
    cgst: itcRcm.cgst.plus(itcOther.cgst).minus(reversed.cgst),
    sgst: itcRcm.sgst.plus(itcOther.sgst).minus(reversed.sgst),
    cess: itcRcm.cess.plus(itcOther.cess).minus(reversed.cess),
  };
  const clamp = (h: HeadsDec): HeadsDec => ({ igst: Dec_max(ZERO, h.igst), cgst: Dec_max(ZERO, h.cgst), sgst: Dec_max(ZERO, h.sgst), cess: Dec_max(ZERO, h.cess) });
  // Reverse-charge tax is always paid in cash; forward-charge tax can use credit.
  const forward: HeadsDec = { igst: taxOut.igst.plus(zeroRatedTax.igst), cgst: taxOut.cgst.plus(zeroRatedTax.cgst), sgst: taxOut.sgst.plus(zeroRatedTax.sgst), cess: taxOut.cess.plus(zeroRatedTax.cess) };
  const u = utiliseCredit(fmtTax(clamp(forward)), fmtTax(clamp(net)));
  const cash: HeadsDec = {
    igst: dec(u.remaining.igst).plus(rcmTax.igst),
    cgst: dec(u.remaining.cgst).plus(rcmTax.cgst),
    sgst: dec(u.remaining.sgst).plus(rcmTax.sgst),
    cess: dec(u.remaining.cess).plus(rcmTax.cess),
  };

  return {
    version: GSTR3B_FORMATTER_VERSION,
    period,
    outward: {
      taxable: { taxable: taxable.toFixed(2), ...fmtTax(taxOut) },
      zeroRated: { taxable: zeroRated.toFixed(2), ...fmtTax(zeroRatedTax) },
      nilExempt: { taxable: nilExempt.toFixed(2) },
      reverseChargeInward: { taxable: rcmTaxable.toFixed(2), ...fmtTax(rcmTax) },
      nonGst: { taxable: nonGst.toFixed(2) },
    },
    interStateUnregistered: [...unreg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pos, v]) => ({ placeOfSupply: pos, taxable: v.taxable.toFixed(2), igst: v.igst.toFixed(2) })),
    itc: { reverseCharge: fmtTax(itcRcm), allOther: fmtTax(itcOther), reversed: fmtTax(reversed), net: fmtTax(net) },
    payment: {
      liability: fmtTax({ igst: forward.igst.plus(rcmTax.igst), cgst: forward.cgst.plus(rcmTax.cgst), sgst: forward.sgst.plus(rcmTax.sgst), cess: forward.cess.plus(rcmTax.cess) }),
      paidFromCredit: u.paidFromCredit,
      cash: fmtTax(cash),
      creditCarriedForward: u.creditLeft,
    },
  };
}
