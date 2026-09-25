import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

/**
 * Reports as PDF files: the firm's letterhead (logo, name, address, contact,
 * GSTIN), the report's title and period, the table with its totals, and page
 * numbers. IBM Plex Sans Devanagari covers English, Hindi and the rupee sign,
 * and PDFKit shapes Devanagari through fontkit, so Hindi names print as they
 * are written. Built on the server, so every device gets the same file.
 */

export interface PdfColumn {
  key: string;
  label: string;
}

export interface Letterhead {
  name: string;
  address: string[];
  contact: string | null;
  gstin: string | null;
  /** PNG or JPEG bytes (other types are left out). */
  logo: Buffer | null;
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

const NAVY = "#0b2d72";
const BLUE = "#1450b4";
const INK = "#0e1a33";
const INK_2 = "#47536c";
const LINE = "#d6ddea";
const HEAD_BG = "#eef2f9";
const GREEN = "#2f8f1f";

let fontsDir: string | null = null;
/** assets/fonts next to the package, from source (src/services) or the bundle (dist). */
function fonts(): string {
  if (fontsDir) return fontsDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.PDF_FONTS_DIR, resolve(process.cwd(), "assets/fonts"), join(here, "../assets/fonts"), join(here, "../../assets/fonts")].filter(Boolean) as string[];
  fontsDir = candidates.find((d) => existsSync(join(d, "IBMPlexSansDevanagari-Regular.ttf"))) ?? null;
  if (!fontsDir) throw new Error("PDF fonts not found (assets/fonts)");
  return fontsDir;
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
  const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margins: { top: 36, bottom: 44, left: 36, right: 36 }, bufferPages: true, info: { Title: input.title, Producer: "Digital Bahi", Creator: "Digital Bahi" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => {
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.on("error", rej);
  });
  doc.registerFont("r", join(fonts(), "IBMPlexSansDevanagari-Regular.ttf"));
  doc.registerFont("b", join(fonts(), "IBMPlexSansDevanagari-SemiBold.ttf"));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const lh = input.letterhead;

  // ---- letterhead (first page)
  let y = doc.page.margins.top;
  let textLeft = left;
  if (lh.logo) {
    try {
      doc.image(lh.logo, left, y, { fit: [58, 58] });
      textLeft = left + 68;
    } catch {
      // An image PDFKit cannot read is left out rather than failing the report.
    }
  }
  const headRight = 210;
  const firmWidth = width - (textLeft - left) - headRight - 12;
  doc.font("b").fontSize(15).fillColor(NAVY).text(lh.name, textLeft, y, { width: firmWidth });
  doc.font("r").fontSize(8.5).fillColor(INK_2);
  for (const line of [...lh.address, lh.contact, lh.gstin ? `GSTIN: ${lh.gstin}` : null].filter(Boolean) as string[]) doc.text(line, { width: firmWidth });
  const leftEnd = Math.max(doc.y, y + (lh.logo ? 58 : 0));
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

  // ---- footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - doc.page.margins.bottom + 16;
    // Writing below the bottom margin would start a new page; lift it for the footer.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("r").fontSize(7.5).fillColor(INK_2).text(`${lh.name} · ${input.title}`, left, fy, { width: width / 2, lineBreak: false });
    const made = "Made with ";
    doc.text(made, left + width / 2 - 45, fy, { continued: true, lineBreak: false }).font("b").fillColor(NAVY).text("Digital", { continued: true, lineBreak: false }).fillColor(GREEN).text("Bahi", { lineBreak: false });
    doc.font("r").fillColor(INK_2).text(`Page ${i - range.start + 1} of ${range.count}`, left, fy, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  doc.end();
  return done;
}
