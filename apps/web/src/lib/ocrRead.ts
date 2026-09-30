import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { api, ApiError } from "./api";
import { fitScale, pageForReading } from "./pageImage";
import { linesOf, tableFromLines, type PdfTable, type PdfText } from "./pdfLayout";
import { SheetError } from "./sheet";

/**
 * Photographed bills and scanned PDFs: each page is cleaned up on this
 * device, read by the server (which keeps nothing), and the table rebuilt
 * from the lines of text it sends back, as for a PDF made by billing
 * software.
 */
export interface OcrPage {
  width: number;
  height: number;
  lines: Array<{ y: number; height: number; cells: Array<{ text: string; x0: number; x1: number }> }>;
}

/** Reports "reading page 2 of 3". */
export type ReadProgress = (page: number, pages: number) => void;

/** Pages of a scanned PDF that are read; a bill longer than this is rare. */
export const MAX_SCANNED_PAGES = 10;

/** The cells of a read page as positioned text, the way pdf.js gives a PDF's (y grows upwards). */
export function ocrText(page: OcrPage, pageNo: number): PdfText[] {
  return page.lines.flatMap((line) =>
    line.cells.map((c) => ({ str: c.text, x: c.x0, y: page.height - line.y, width: c.x1 - c.x0, height: line.height, page: pageNo, whole: true })),
  );
}

/** The table on the read pages, starting at the first line `isHeader` accepts. */
export function tableOfPages(pages: readonly OcrPage[], isHeader: (cells: string[]) => boolean): PdfTable {
  const items = pages.flatMap((p, i) => ocrText(p, i + 1));
  if (items.length < 3) throw new SheetError("IMPORT_PHOTO_BLANK");
  return { ...tableFromLines(linesOf(items), isHeader), scanned: true };
}

async function readPage(png: Blob): Promise<OcrPage> {
  try {
    return await api.upload<OcrPage>("/imports/read-page", png);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) throw new SheetError("IMPORT_PHOTO_OFFLINE");
    throw e;
  }
}

function needsConnection() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new SheetError("IMPORT_PHOTO_OFFLINE");
}

/** A photo of a bill or list (JPEG, PNG, WebP; whatever this browser can open). */
export async function readImageTable(file: File, isHeader: (cells: string[]) => boolean, onProgress?: ReadProgress): Promise<PdfTable> {
  needsConnection();
  let bitmap: ImageBitmap;
  try {
    // Turned the right way up from the photo's own orientation tag.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new SheetError("IMPORT_UNREADABLE");
  }
  try {
    onProgress?.(1, 1);
    const png = await pageForReading(bitmap, bitmap.width, bitmap.height);
    return tableOfPages([await readPage(png)], isHeader);
  } finally {
    bitmap.close();
  }
}

/** A PDF of scanned pages: each page is drawn as an image and read. */
export async function readScannedPdf(doc: PDFDocumentProxy, isHeader: (cells: string[]) => boolean, onProgress?: ReadProgress): Promise<PdfTable> {
  needsConnection();
  const pages = Math.min(doc.numPages, MAX_SCANNED_PAGES);
  const read: OcrPage[] = [];
  for (let n = 1; n <= pages; n++) {
    onProgress?.(n, pages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // Drawn sharp (about 350 dpi for A4); pageForReading then sizes it to the print.
    const viewport = page.getViewport({ scale: fitScale(base.width, base.height, 6) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const png = await pageForReading(canvas, canvas.width, canvas.height);
    page.cleanup();
    canvas.width = canvas.height = 0;
    read.push(await readPage(png));
  }
  return tableOfPages(read, isHeader);
}
