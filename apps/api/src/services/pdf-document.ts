import { amountInWords, findState, qrMatrix, upiPayLink } from "@digitalbahi/core";
import { createTranslator, formatAmount, formatCurrency, formatDate, formatDateTimeIst, type LocaleCode } from "@digitalbahi/i18n";
import { BLUE, drawFirm, drawFooters, HEAD_BG, INK, INK_2, LINE, newPdf, RED, type Letterhead, type Pdf } from "./pdf-kit.js";

/**
 * Tax invoices, bills of supply, credit / debit notes and receipts as PDF
 * files, laid out like the printed page in the app (letterhead, GST table,
 * HSN summary, totals, amount in words, signatory), in English or Hindi.
 * The same file is downloaded, shared from a phone or sent by WhatsApp and
 * email.
 */

export interface DocumentPdfLine {
  name: string;
  batch: string | null;
  hsn: string;
  qty: string;
  /** Scheme quantity given free (purchases and sales); "0" or absent: none. */
  freeQty?: string;
  unit: string;
  rate: string;
  discountPercent: string;
  taxable: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
}

export interface DocumentPdfInput {
  letterhead: Letterhead;
  locale: LocaleCode;
  /** A purchase is our copy of a supplier's bill: their number and date, the supplier in the party box. */
  kind: "invoice" | "credit_note" | "debit_note" | "purchase";
  billOfSupply: boolean;
  cancelled: boolean;
  number: string;
  date: string;
  dueDate: string | null;
  /** Purchases: our own reference number for the supplier's bill. */
  ourNumber?: string | null;
  /** Freight and other charges on the bill (purchases), each with its GST. */
  charges?: Array<{ label: string; total: string }>;
  /** The invoice or bill a note is issued against. */
  against: { number: string; date: string } | null;
  placeOfSupply: string;
  reverseCharge: boolean;
  intraState: boolean;
  buyer: { businessName: string; name: string | null; address: string; stateCode: string; gstin: string | null };
  lines: DocumentPdfLine[];
  totals: { taxable: string; cgst: string; sgst: string; igst: string; cess: string; roundOff: string; grandTotal: string };
  /** Invoices only. */
  paid: string | null;
  credited: string | null;
  /** Invoices: raised since by debit notes. */
  debited?: string | null;
  balance: string | null;
  reason: string | null;
  terms: string | null;
  /** Where to pay (invoices): the bank account and UPI ID; a UPI QR code for the balance. */
  payment?: { bankName: string; accountNumber: string; ifsc: string; upiId: string } | null;
  /** Export / supply to SEZ: the declaration the law asks for, the LUT and the shipping bill. */
  zeroRated?: { declaration: string; lut: string | null; shippingBill: string | null } | null;
  /** The IRN, acknowledgement and signed QR code from the e-invoice portal. */
  einvoice?: { irn: string; ackNumber: string | null; ackDate: string | null; signedQrCode: string | null } | null;
  ewayBill?: { number: string; date: string | null; validUntil: string | null } | null;
}

/** A QR code drawn module by module (no image), `size` points square. */
export function drawQr(doc: Pdf, text: string, x: number, y: number, size: number) {
  const m = qrMatrix(text);
  const cell = size / m.length;
  doc.save().fillColor("#000000");
  m.forEach((row, r) => row.forEach((dark, c) => dark && doc.rect(x + c * cell, y + r * cell, cell + 0.02, cell + 0.02).fill()));
  doc.restore();
}

export interface ReceiptPdfInput {
  letterhead: Letterhead;
  locale: LocaleCode;
  direction: "in" | "out";
  number: string;
  date: string;
  cancelled: boolean;
  partyName: string;
  amount: string;
  method: string;
  reference: string | null;
  chequeDate: string | null;
  chequeBank: string | null;
  bills: Array<{ number: string | null; amount: string }>;
  onAccount: string;
  notes: string | null;
}

const num = (v: string | number) => Number(v);
const trimQty = (q: string) => String(Number(q));

/** "Madhya Pradesh (State code 23)": the name first, the code after it, as bills usually print it. */
function stateName(code: string, locale: LocaleCode): string {
  const s = findState(code);
  return s ? createTranslator(locale).t("common.stateWithCode", { name: locale === "hi" ? s.nameHi : s.name, code: s.code }) : code;
}

interface Column {
  label: string;
  value(l: DocumentPdfLine, i: number): string;
  right?: boolean;
  /** Takes the room left over. */
  flex?: boolean;
}

/** A simple ruled table with a header row repeated on each page; returns the y below it. */
function table(doc: Pdf, x: number, y: number, width: number, columns: Column[], rows: DocumentPdfLine[], opts: { size: number; bottom: number; bold?: (col: number) => boolean }): number {
  const pad = 3.5;
  doc.fontSize(opts.size);
  const widths = columns.map((c, ci) => {
    if (c.flex) return 0;
    doc.font("b");
    let w = doc.widthOfString(c.label);
    doc.font("r");
    rows.forEach((r, i) => {
      // A cell of several lines (a quantity and its free units) is as wide as its longest line,
      // with a little room so the line that sets the width does not wrap.
      const parts = c.value(r, i).split("\n");
      for (const part of parts) w = Math.max(w, doc.widthOfString(part) + (parts.length > 1 ? 2 : 0));
    });
    return w + pad * 2 + 1 + (opts.bold?.(ci) ? 2 : 0);
  });
  const flexIndex = columns.findIndex((c) => c.flex);
  const used = widths.reduce((a, b) => a + b, 0);
  if (flexIndex >= 0) widths[flexIndex] = Math.max(80, width - used);
  const total = widths.reduce((a, b) => a + b, 0);
  const scaled = total > width ? widths.map((w) => (w / total) * width) : widths;
  const xs = scaled.map((_, i) => x + scaled.slice(0, i).reduce((a, b) => a + b, 0));

  const rowHeight = (texts: string[], font: "r" | "b") => {
    doc.font(font).fontSize(opts.size);
    return Math.max(...texts.map((t, i) => doc.heightOfString(t || " ", { width: scaled[i]! - pad * 2 }))) + pad * 2;
  };
  const draw = (texts: string[], header: boolean) => {
    const h = rowHeight(texts, header ? "b" : "r");
    if (header) doc.rect(x, y, width, h).fill(HEAD_BG);
    texts.forEach((t, i) => {
      doc
        .font(header || opts.bold?.(i) ? "b" : "r")
        .fontSize(opts.size)
        .fillColor(INK)
        .text(t, xs[i]! + pad, y + pad, { width: scaled[i]! - pad * 2, align: columns[i]!.right ? "right" : "left" });
    });
    doc.lineWidth(0.5).strokeColor(LINE);
    doc.rect(x, y, width, h).stroke();
    for (let i = 1; i < xs.length; i++) doc.moveTo(xs[i]!, y).lineTo(xs[i]!, y + h).stroke();
    y += h;
  };
  const header = columns.map((c) => c.label);
  draw(header, true);
  rows.forEach((r, i) => {
    const texts = columns.map((c) => c.value(r, i));
    if (y + rowHeight(texts, "r") > opts.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      draw(header, true);
    }
    draw(texts, false);
  });
  return y;
}

/** Title block on the right of the letterhead; returns the y below it. */
function titleBlock(doc: Pdf, title: string, sub: string | null, rows: Array<[string, string]>, x: number, y: number, width: number, cancelled: string | null): number {
  doc.font("b").fontSize(15).fillColor(BLUE).text(title, x, y, { width, align: "right" });
  if (sub) doc.font("r").fontSize(8).fillColor(INK_2).text(sub, x, doc.y, { width, align: "right" });
  if (cancelled) doc.font("b").fontSize(10).fillColor(RED).text(cancelled, x, doc.y + 2, { width, align: "right" });
  let ry = doc.y + 6;
  const labelW = width * 0.45;
  for (const [k, v] of rows) {
    doc.font("r").fontSize(8.5).fillColor(INK_2).text(k, x, ry, { width: labelW - 6 });
    const h1 = doc.y - ry;
    doc.font("b").fontSize(8.5).fillColor(INK).text(v, x + labelW, ry, { width: width - labelW });
    ry += Math.max(h1, doc.y - ry) + 1;
  }
  return ry;
}

export async function renderDocumentPdf(input: DocumentPdfInput): Promise<Buffer> {
  const { t } = createTranslator(input.locale);
  const locale = input.locale;
  const isNote = input.kind === "credit_note" || input.kind === "debit_note";
  const isPurchase = input.kind === "purchase";
  const title = (isPurchase ? t("purchase.print.title") : isNote ? t(input.kind === "credit_note" ? "notes.creditNote" : "notes.debitNote") : input.billOfSupply ? t("invoice.billOfSupply") : t("invoice.taxInvoice")).toUpperCase();
  const { doc, done } = newPdf(`${title} ${input.number}`, { lang: locale === "hi" ? "hi-IN" : "en-IN" });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const m = (v: string) => formatCurrency(v, locale);
  const n = (v: string) => formatAmount(v, locale);
  const lh = input.letterhead;
  const pos = findState(input.placeOfSupply);
  const stateLabel = pos?.component === "UTGST" ? "UTGST" : "SGST";

  // ---- letterhead and title
  let y = doc.page.margins.top;
  const right = 215;
  const firmEnd = drawFirm(doc, lh, left, y, width - right - 14);
  const meta: Array<[string, string]> = [
    [isPurchase ? t("purchase.billNumber") : isNote ? t("notes.number") : t("invoice.number"), input.number],
    [isPurchase ? t("purchase.billDate") : isNote ? t("notes.date") : t("invoice.date"), formatDate(input.date)],
    ...(isPurchase && input.ourNumber ? [[t("purchase.number"), input.ourNumber] as [string, string]] : []),
    ...(isNote ? (input.against ? [[t("notes.against"), `${input.against.number} · ${formatDate(input.against.date)}`] as [string, string]] : []) : input.dueDate ? [[t("invoice.dueDate"), formatDate(input.dueDate)] as [string, string]] : []),
    [t("invoice.placeOfSupply"), stateName(input.placeOfSupply, locale)],
    [t("invoice.print.reverseCharge"), input.reverseCharge ? t("common.yes") : t("invoice.print.no")],
  ];
  const titleEnd = titleBlock(doc, title, isPurchase ? null : t("invoice.print.original"), meta, left + width - right, y, right, input.cancelled ? t("status.document.cancelled").toUpperCase() : null);
  y = Math.max(firmEnd, titleEnd) + 6;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.5).strokeColor(BLUE).stroke();
  y += 8;

  // ---- e-invoice (IRN, acknowledgement, signed QR code) and e-way bill
  if (input.einvoice || input.ewayBill) {
    const e = input.einvoice;
    const qr = e?.signedQrCode ? 84 : 0;
    const textW = width - (qr ? qr + 12 : 0);
    const top = y;
    if (e) {
      doc.font("b").fontSize(8).fillColor(INK).text(`IRN: ${e.irn}`, left, y, { width: textW });
      const ack = [e.ackNumber ? t("einvoice.print.ackNumber", { number: e.ackNumber }) : null, e.ackDate ? t("einvoice.print.ackDate", { date: formatDateTimeIst(e.ackDate) }) : null].filter(Boolean).join("   ·   ");
      if (ack) doc.font("r").fontSize(8).fillColor(INK_2).text(ack, left, doc.y + 2, { width: textW });
    }
    if (input.ewayBill) {
      const w = input.ewayBill;
      const line = [t("einvoice.print.ewayBill", { number: w.number }), w.date ? formatDateTimeIst(w.date) : null, w.validUntil ? t("einvoice.print.validUntil", { date: formatDateTimeIst(w.validUntil) }) : null].filter(Boolean).join("   ·   ");
      doc.font("r").fontSize(8).fillColor(INK_2).text(line, left, e ? doc.y + 2 : y, { width: textW });
    }
    if (e?.signedQrCode) drawQr(doc, e.signedQrCode, left + width - qr, top, qr);
    y = Math.max(doc.y, top + qr) + 6;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 8;
  }

  // ---- export / SEZ: the declaration, in capitals as it must appear, with the LUT and shipping bill
  if (input.zeroRated) {
    const z = input.zeroRated;
    doc.font("b").fontSize(8.5).fillColor(INK).text(z.declaration, left, y, { width, align: "center" });
    const more = [z.lut, z.shippingBill].filter(Boolean).join("   ·   ");
    if (more) doc.font("r").fontSize(8).fillColor(INK_2).text(more, left, doc.y + 2, { width, align: "center" });
    y = doc.y + 6;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 8;
  }

  // ---- bill to / ship to
  const half = (width - 16) / 2;
  let partyEnd = y;
  (isPurchase ? [t("purchase.print.supplier")] : [t("invoice.print.billTo"), t("invoice.print.shipTo")]).forEach((label, i) => {
    const x = left + i * (half + 16);
    const b = input.buyer;
    doc.font("b").fontSize(7.5).fillColor(INK_2).text(label.toUpperCase(), x, y, { width: half, characterSpacing: 0.4 });
    doc.font("b").fontSize(10).fillColor(INK).text(b.businessName, { width: half });
    doc.font("r").fontSize(8.5);
    for (const line of [b.name && b.name !== b.businessName ? b.name : null, b.address || null, stateName(b.stateCode, locale), b.gstin ? `GSTIN: ${b.gstin}` : null].filter(Boolean) as string[]) doc.text(line, { width: half });
    partyEnd = Math.max(partyEnd, doc.y);
  });
  y = partyEnd + 6;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 8;

  // ---- items
  const columns: Column[] = [
    { label: t("invoice.print.sn"), value: (_, i) => String(i + 1) },
    { label: t("invoice.print.description"), value: (l) => (l.batch ? `${l.name}\n${t("invoice.batch")} ${l.batch}` : l.name), flex: true },
    { label: t("invoice.hsn"), value: (l) => l.hsn },
    { label: t("invoice.qty"), value: (l) => `${trimQty(l.qty)} ${l.unit}`.trim() + (num(l.freeQty ?? "0") ? `\n+${trimQty(l.freeQty!)} ${t("invoice.free")}` : ""), right: true },
    { label: t("invoice.rate"), value: (l) => n(l.rate), right: true },
    { label: t("invoice.discount"), value: (l) => (num(l.discountPercent) ? `${trimQty(l.discountPercent)}%` : "—"), right: true },
    { label: t("invoice.taxable"), value: (l) => n(l.taxable), right: true },
    { label: "GST", value: (l) => `${trimQty(l.gstRate)}%`, right: true },
    ...(input.intraState
      ? [
          { label: "CGST", value: (l: DocumentPdfLine) => n(l.cgst), right: true },
          { label: stateLabel, value: (l: DocumentPdfLine) => n(l.sgst), right: true },
        ]
      : [{ label: "IGST", value: (l: DocumentPdfLine) => n(l.igst), right: true }]),
    { label: t("invoice.amount"), value: (l) => n(l.total), right: true },
  ];
  y = table(doc, left, y, width, columns, input.lines, { size: 8, bottom: bottom - 8, bold: (c) => c === columns.length - 1 });
  y += 10;

  // ---- tax summary (left) and totals (right)
  const hsn = new Map<string, DocumentPdfLine>();
  for (const l of input.lines) {
    const key = `${l.hsn}|${num(l.gstRate)}`;
    const row = hsn.get(key) ?? { ...l, taxable: "0", cgst: "0", sgst: "0", igst: "0" };
    for (const k of ["taxable", "cgst", "sgst", "igst"] as const) row[k] = (num(row[k]) + num(l[k])).toFixed(2);
    hsn.set(key, row);
  }
  const hsnRows = [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || num(a.gstRate) - num(b.gstRate));
  const totalsW = 190;
  const summaryW = width - totalsW - 18;
  const totalRows: Array<[string, string, boolean?]> = [
    [t("invoice.taxableValue"), m(input.totals.taxable)],
    ...((input.intraState
      ? [
          ["CGST", m(input.totals.cgst)],
          [stateLabel, m(input.totals.sgst)],
        ]
      : [["IGST", m(input.totals.igst)]]) as Array<[string, string]>),
    ...(num(input.totals.cess) > 0 ? [[t("invoice.cess"), m(input.totals.cess)] as [string, string]] : []),
    ...(input.charges ?? []).map((c) => [c.label, m(c.total)] as [string, string]),
    [t("invoice.roundOff"), m(input.totals.roundOff)],
  ];
  const blockHeight = 60 + hsnRows.length * 15 + 40;
  if (y + Math.max(blockHeight, totalRows.length * 13 + 70) > bottom - 90) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  const blockTop = y;
  doc.font("b").fontSize(7.5).fillColor(INK_2).text(t("invoice.print.taxSummary").toUpperCase(), left, y, { width: summaryW, characterSpacing: 0.4 });
  y = doc.y + 2;
  const hsnColumns: Column[] = [
    { label: "HSN", value: (l) => l.hsn || "—", flex: true },
    { label: t("invoice.taxable"), value: (l) => n(l.taxable), right: true },
    { label: "GST", value: (l) => `${trimQty(l.gstRate)}%`, right: true },
    ...(input.intraState
      ? [
          { label: "CGST", value: (l: DocumentPdfLine) => n(l.cgst), right: true },
          { label: stateLabel, value: (l: DocumentPdfLine) => n(l.sgst), right: true },
        ]
      : [{ label: "IGST", value: (l: DocumentPdfLine) => n(l.igst), right: true }]),
  ];
  y = table(doc, left, y, summaryW, hsnColumns, hsnRows, { size: 7.5, bottom: bottom - 8 }) + 8;
  doc.font("b").fontSize(7.5).fillColor(INK_2).text(t("invoice.amountInWords").toUpperCase(), left, y, { width: summaryW, characterSpacing: 0.4 });
  doc.font("b").fontSize(9).fillColor(INK).text(amountInWords(input.totals.grandTotal, locale), { width: summaryW });
  if (input.reason) {
    doc.moveDown(0.4);
    doc.font("r").fontSize(8.5).fillColor(INK_2).text(input.reason, { width: summaryW });
  }
  const leftEnd = doc.y;

  const tx = left + width - totalsW;
  let ty = blockTop;
  const line = (k: string, v: string, opts: { bold?: boolean; big?: boolean; rule?: boolean } = {}) => {
    if (opts.rule) {
      doc.moveTo(tx, ty).lineTo(tx + totalsW, ty).lineWidth(1.5).strokeColor(BLUE).stroke();
      ty += 4;
    }
    const size = opts.big ? 12 : 9;
    doc.font(opts.bold ? "b" : "r").fontSize(size).fillColor(opts.bold ? INK : INK_2).text(k, tx, ty, { width: totalsW * 0.55 });
    doc.font(opts.bold ? "b" : "r").fontSize(size).fillColor(INK).text(v, tx, ty, { width: totalsW, align: "right" });
    ty += size + 5;
  };
  for (const [k, v] of totalRows) line(k, v);
  ty += 2;
  line(t("invoice.grandTotal"), m(input.totals.grandTotal), { bold: true, big: true, rule: true });
  if (input.reverseCharge) {
    doc.font("r").fontSize(7.5).fillColor(INK_2).text(t("invoice.print.rcmNotIncluded"), tx, ty, { width: totalsW, align: "right" });
    ty = doc.y + 4;
  }
  if (!isNote && input.paid !== null) {
    if (input.debited && num(input.debited) > 0) line(t("notes.addDebits"), m(input.debited));
    line(t("invoice.print.paid"), m(input.paid));
    if (input.credited && num(input.credited) > 0) line(t("notes.lessReturns"), m(input.credited));
    line(t("invoice.balance"), m(String(Math.max(0, num(input.balance ?? "0")))), { bold: true });
  }
  y = Math.max(leftEnd, ty) + 16;

  // ---- terms and signatory
  if (y > bottom - 80) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 8;
  const termsW = width - 200;
  doc.fillColor(INK_2);
  const pay = !isNote && input.payment && (input.payment.accountNumber || input.payment.upiId) ? input.payment : null;
  if (pay) {
    // Where to pay, and (for what the bill still owes) a UPI code any payment app scans.
    const qr = pay.upiId && !input.cancelled && num(input.balance ?? "0") >= 1 ? upiPayLink({ upiId: pay.upiId, name: lh.name, amount: input.balance, note: input.number }) : null;
    const textW = qr ? termsW - 84 : termsW;
    doc.font("b").fontSize(8).fillColor(INK).text(t("invoice.print.bankDetails"), left, y, { width: textW });
    const bank = [pay.bankName, pay.accountNumber && `A/c ${pay.accountNumber}`, pay.ifsc && `IFSC ${pay.ifsc}`].filter(Boolean).join(" · ");
    if (bank) doc.font("r").fontSize(8).fillColor(INK_2).text(bank, { width: textW });
    if (pay.upiId) doc.font("r").fontSize(8).fillColor(INK_2).text(`UPI: ${pay.upiId}`, { width: textW });
    let below = doc.y;
    if (qr) {
      drawQr(doc, qr, left + termsW - 72, y, 72);
      doc.font("r").fontSize(6.5).fillColor(INK_2).text(t("thermal.scanToPay", { amount: m(input.balance!) }), left + termsW - 84, y + 75, { width: 96, align: "center" });
      below = Math.max(below, doc.y + 2);
    }
    doc.y = below;
    doc.moveDown(0.4);
    y = doc.y;
  }
  if (input.terms && !isNote) {
    doc.font("b").fontSize(8).fillColor(INK).text(t("invoice.print.terms"), left, y, { width: termsW });
    doc.font("r").fontSize(7.5).fillColor(INK_2).text(input.terms, { width: termsW });
    doc.moveDown(0.4);
  }
  doc.font("r").fontSize(7.5).fillColor(INK_2).text(isNote || isPurchase ? t("notes.computerGenerated") : t("invoice.print.computerGenerated"), left, input.terms && !isNote ? doc.y : y, { width: termsW });
  doc.font("b").fontSize(9).fillColor(INK).text(t("invoice.print.for", { business: lh.name }), left + width - 200, y, { width: 200, align: "right" });
  doc.font("r").fontSize(8).fillColor(INK_2).text(t("invoice.print.signatory"), left + width - 200, y + 44, { width: 200, align: "right" });

  drawFooters(doc, `${lh.name} · ${input.number}`, (p, of) => t("pdf.page", { page: p, count: of }));
  doc.end();
  return done;
}

export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  const { t } = createTranslator(input.locale);
  const locale = input.locale;
  const title = (input.direction === "in" ? t("receipt.title") : t("receipt.voucher")).toUpperCase();
  const { doc, done } = newPdf(`${title} ${input.number}`, { lang: locale === "hi" ? "hi-IN" : "en-IN" });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const m = (v: string) => formatCurrency(v, locale);
  const lh = input.letterhead;

  let y = doc.page.margins.top;
  const right = 200;
  const firmEnd = drawFirm(doc, lh, left, y, width - right - 14);
  const titleEnd = titleBlock(doc, title, null, [[t("common.number"), input.number], [t("common.date"), formatDate(input.date)]], left + width - right, y, right, input.cancelled ? t("status.document.cancelled").toUpperCase() : null);
  y = Math.max(firmEnd, titleEnd) + 8;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.5).strokeColor(BLUE).stroke();
  y += 10;

  const rows: Array<[string, string, boolean?]> = [
    [input.direction === "in" ? t("receipt.receivedFrom") : t("receipt.paidTo"), input.partyName, true],
    [t("receipt.amount"), m(input.amount), true],
    [t("invoice.amountInWords"), amountInWords(input.amount, locale)],
    [t("receipt.mode"), [t(`paymentMethod.${input.method}` as "paymentMethod.cash"), input.reference, input.chequeDate ? formatDate(input.chequeDate) : null, input.chequeBank].filter(Boolean).join(" · ")],
    ...(input.bills.length ? [[t("receipt.against"), input.bills.map((b) => `${b.number ?? "—"}: ${m(b.amount)}`).join("\n")] as [string, string]] : []),
    ...(num(input.onAccount) > 0 ? [[t("receipt.onAccount"), m(input.onAccount)] as [string, string]] : []),
  ];
  const labelW = width * 0.38;
  for (const [k, v, bold] of rows) {
    doc.font("r").fontSize(9.5).fillColor(INK_2).text(k, left, y + 5, { width: labelW });
    const h1 = doc.y;
    doc.font(bold ? "b" : "r").fontSize(bold ? 11 : 9.5).fillColor(INK).text(v, left + labelW, y + 5, { width: width - labelW, align: "right" });
    y = Math.max(h1, doc.y) + 5;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).dash(2, { space: 2 }).strokeColor(LINE).stroke().undash();
  }
  y += 8;
  if (input.notes) {
    doc.font("r").fontSize(9).fillColor(INK_2).text(input.notes, left, y, { width });
    y = doc.y + 4;
  }
  if (input.method === "cheque" && input.direction === "in") {
    doc.font("r").fontSize(8.5).fillColor(INK_2).text(t("receipt.chequeNote"), left, y, { width });
    y = doc.y + 4;
  }
  y += 30;
  doc.font("r").fontSize(8).fillColor(INK_2).text(t("receipt.computerGenerated"), left, y + 30, { width: width - 220 });
  doc.font("b").fontSize(9.5).fillColor(INK).text(t("invoice.print.for", { business: lh.name }), left + width - 220, y, { width: 220, align: "right" });
  doc.moveTo(left + width - 150, y + 40).lineTo(left + width, y + 40).lineWidth(0.8).strokeColor(INK).stroke();
  doc.font("r").fontSize(8.5).fillColor(INK_2).text(t("invoice.print.signatory"), left + width - 220, y + 44, { width: 220, align: "right" });

  drawFooters(doc, `${lh.name} · ${input.number}`, (p, of) => t("pdf.page", { page: p, count: of }));
  doc.end();
  return done;
}
