import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

/**
 * What every PDF from the server shares: the fonts (IBM Plex Sans
 * Devanagari covers English, Hindi and the rupee sign; PDFKit shapes
 * Devanagari through fontkit), the colours, the firm's letterhead and the
 * footer with "Made with Digital Bahi" and page numbers.
 */

export interface Letterhead {
  name: string;
  address: string[];
  contact: string | null;
  gstin: string | null;
  /** PNG or JPEG bytes (other types are left out). */
  logo: Buffer | null;
}

export const NAVY = "#0b2d72";
export const BLUE = "#1450b4";
export const INK = "#0e1a33";
export const INK_2 = "#47536c";
export const LINE = "#d6ddea";
export const HEAD_BG = "#eef2f9";
export const GREEN = "#2f8f1f";
export const RED = "#b42318";

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

export type Pdf = PDFKit.PDFDocument;

/** An A4 document with the fonts "r" (regular) and "b" (semibold); `done` resolves to the file. */
export function newPdf(title: string, opts: { landscape?: boolean; lang?: string } = {}): { doc: Pdf; done: Promise<Buffer> } {
  const doc = new PDFDocument({
    size: "A4",
    layout: opts.landscape ? "landscape" : "portrait",
    margins: { top: 36, bottom: 44, left: 36, right: 36 },
    bufferPages: true,
    ...(opts.lang ? { lang: opts.lang } : {}),
    info: { Title: title, Producer: "Digital Bahi", Creator: "Digital Bahi" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => {
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.on("error", rej);
  });
  doc.registerFont("r", join(fonts(), "IBMPlexSansDevanagari-Regular.ttf"));
  doc.registerFont("b", join(fonts(), "IBMPlexSansDevanagari-SemiBold.ttf"));
  return { doc, done };
}

/** Logo, firm name, address, contact and GSTIN at (x, y) within `width`; returns the y below it. */
export function drawFirm(doc: Pdf, lh: Letterhead, x: number, y: number, width: number): number {
  let textLeft = x;
  if (lh.logo) {
    try {
      doc.image(lh.logo, x, y, { fit: [58, 58] });
      textLeft = x + 68;
    } catch {
      // An image PDFKit cannot read is left out rather than failing the document.
    }
  }
  const w = width - (textLeft - x);
  doc.font("b").fontSize(15).fillColor(NAVY).text(lh.name, textLeft, y, { width: w });
  doc.font("r").fontSize(8.5).fillColor(INK_2);
  for (const line of [...lh.address, lh.contact, lh.gstin ? `GSTIN: ${lh.gstin}` : null].filter(Boolean) as string[]) doc.text(line, { width: w });
  return Math.max(doc.y, y + (textLeft > x ? 58 : 0));
}

/** On every page: `label` on the left, "Made with Digital Bahi" in the middle, "Page n of N" on the right. */
export function drawFooters(doc: Pdf, label: string, pageLabel: (n: number, of: number) => string = (n, of) => `Page ${n} of ${of}`): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const fy = doc.page.height - doc.page.margins.bottom + 16;
    // Writing below the bottom margin would start a new page; lift it for the footer.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("r").fontSize(7.5).fillColor(INK_2).text(label, left, fy, { width: width / 2 - 50, lineBreak: false, ellipsis: true });
    doc.text("Made with ", left + width / 2 - 45, fy, { continued: true, lineBreak: false }).font("b").fillColor(NAVY).text("Digital", { continued: true, lineBreak: false }).fillColor(GREEN).text("Bahi", { lineBreak: false });
    doc.font("r").fillColor(INK_2).text(pageLabel(i - range.start + 1, range.count), left, fy, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}
