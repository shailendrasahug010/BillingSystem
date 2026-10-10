import type { ReadProgress } from "./ocrRead";
import { linesOf, tableFromLines, type PdfTable, type PdfText } from "./pdfLayout";
import { SheetError } from "./sheet";

/**
 * The table in a PDF (a supplier's bill, a price list). One made by billing
 * software is read on this device with pdf.js; a scanned one has no text in
 * it, so its pages are read as images instead (see ocrRead).
 */
export async function readPdfTable(file: File, isHeader: (cells: string[]) => boolean, onProgress?: ReadProgress): Promise<PdfTable> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    throw new SheetError((e as { name?: string }).name === "PasswordException" ? "IMPORT_PDF_LOCKED" : "IMPORT_UNREADABLE");
  }
  try {
    const items: PdfText[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const it of content.items) {
        if (!("str" in it) || !it.str) continue;
        const [, , c, d, x, y] = it.transform as number[];
        items.push({ str: it.str, x: x!, y: y!, width: it.width, height: Math.hypot(c!, d!) || it.height, page: p });
      }
    }
    if (items.filter((i) => i.str.trim()).length < 5) {
      const { readScannedPdf } = await import("./ocrRead");
      return await readScannedPdf(doc, isHeader, onProgress);
    }
    return tableFromLines(linesOf(items), isHeader);
  } finally {
    void task.destroy();
  }
}
