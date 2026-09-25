import { BLUE, drawFirm, drawFooters, HEAD_BG, INK, INK_2, LINE, newPdf, type Letterhead } from "./pdf-kit.js";

export type { Letterhead } from "./pdf-kit.js";

/**
 * Reports as PDF files: the firm's letterhead (logo, name, address, contact,
 * GSTIN), the report's title and period, the table with its totals, and page
 * numbers. Built on the server, so every device gets the same file.
 */

export interface PdfColumn {
  key: string;
  label: string;
}

export interface ReportPdfInput {
  letterhead: Letterhead;
  title: string;
  period: string | null;
  generatedAt: string;
  columns: PdfColumn[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown> | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-09-05 -> "5 Sep 2026". */
export function pdfDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Indian digit grouping: 135684.5 -> "1,35,684.50" (2 decimals), "8.000" -> "8". */
export function pdfCell(value: unknown): { text: string; numeric: boolean } {
  if (value === null || value === undefined || value === "") return { text: "", numeric: false };
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return { text: String(value), numeric: false };
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (m) {
    const [, sign, int, frac = ""] = m;
    const grouped = int!.length > 3 ? `${int!.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${int!.slice(-3)}` : int!;
    // Money keeps its paise; quantities drop trailing zeros; percentages keep what they have.
    const tail = frac.length === 3 ? frac.replace(/0+$/, "") : frac;
    return { text: `${sign}${grouped}${tail ? `.${tail}` : ""}`, numeric: true };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { text: pdfDate(value), numeric: false };
  return { text: value, numeric: false };
}

const titleCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const landscape = input.columns.length > 7;
  const { doc, done } = newPdf(input.title, { landscape });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const lh = input.letterhead;

  // ---- letterhead (first page)
  let y = doc.page.margins.top;
  const headRight = 210;
  const leftEnd = drawFirm(doc, lh, left, y, width - headRight - 12);
  doc.font("b").fontSize(13).fillColor(BLUE).text(input.title, left + width - headRight, y, { width: headRight, align: "right" });
  doc.font("r").fontSize(8.5).fillColor(INK_2);
  if (input.period) doc.text(input.period, { width: headRight, align: "right" });
  doc.text(`Generated ${input.generatedAt}`, { width: headRight, align: "right" });
  y = Math.max(leftEnd, doc.y) + 8;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.5).strokeColor(BLUE).stroke();
  y += 10;

  // ---- table layout
  const size = 8.5;
  const pad = 4;
  const cells = input.rows.map((r) => input.columns.map((c) => pdfCell(r[c.key])));
  const totals = input.totals ? input.columns.map((c, i) => (i === 0 ? { text: "Total", numeric: false } : pdfCell(input.totals![c.key]))) : null;
  const numericCol = input.columns.map((_, i) => cells.some((r) => r[i]!.numeric) && cells.every((r) => r[i]!.numeric || r[i]!.text === ""));
  doc.font("r").fontSize(size);
  const natural = input.columns.map((c, i) => {
    doc.font("b");
    let w = doc.widthOfString(titleCase(c.label));
    doc.font("r");
    for (const r of cells.slice(0, 400)) w = Math.max(w, doc.widthOfString(r[i]!.text));
    if (totals) {
      doc.font("b");
      w = Math.max(w, doc.widthOfString(totals[i]!.text));
      doc.font("r");
    }
    // A point to spare so a number never breaks over two lines.
    return Math.min(w, 220) + pad * 2 + 1;
  });
  const sum = natural.reduce((a, b) => a + b, 0);
  let widths = natural;
  if (sum > width) {
    // Shrink the text columns first; numbers keep their width.
    const fixed = natural.reduce((a, w, i) => a + (numericCol[i] ? w : 0), 0);
    const flexible = sum - fixed;
    const room = Math.max(width - fixed, flexible * 0.4);
    widths = natural.map((w, i) => (numericCol[i] ? w : (w / flexible) * room));
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > width) widths = widths.map((w) => (w / total) * width);
  } else {
    // Spare room goes to the first (label) column.
    widths = [...natural];
    widths[0] = widths[0]! + (width - sum);
  }
  const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));

  const rowHeight = (texts: Array<{ text: string }>, font: "r" | "b") => {
    doc.font(font).fontSize(size);
    return Math.max(...texts.map((t, i) => doc.heightOfString(t.text || " ", { width: widths[i]! - pad * 2 }))) + pad * 2;
  };
  const drawRow = (texts: Array<{ text: string }>, font: "r" | "b", opts: { fill?: string; topRule?: boolean } = {}) => {
    const h = rowHeight(texts, font);
    if (opts.fill) doc.rect(left, y, width, h).fill(opts.fill);
    if (opts.topRule) doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(INK).stroke();
    doc.font(font).fontSize(size).fillColor(INK);
    texts.forEach((t, i) => doc.text(t.text, xs[i]! + pad, y + pad, { width: widths[i]! - pad * 2, align: numericCol[i] ? "right" : "left" }));
    y += h;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(LINE).stroke();
  };
  const header = input.columns.map((c) => ({ text: titleCase(c.label) }));
  drawRow(header, "b", { fill: HEAD_BG });
  if (!cells.length) {
    doc.font("r").fontSize(size).fillColor(INK_2).text("Nothing in this period.", left + pad, y + pad);
    y = doc.y + pad;
  }
  for (const r of cells) {
    if (y + rowHeight(r, "r") > bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top;
      drawRow(header, "b", { fill: HEAD_BG });
    }
    drawRow(r, "r");
  }
  if (totals && cells.length) {
    if (y + rowHeight(totals, "b") > bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    drawRow(totals, "b", { topRule: true });
  }

  drawFooters(doc, `${lh.name} · ${input.title}`);
  doc.end();
  return done;
}
