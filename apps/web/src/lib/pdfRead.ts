import { linesOf, tableFromLines, type PdfTable, type PdfText } from "./pdfLayout";
import { SheetError } from "./sheet";

/**
 * The table in a PDF made by billing software (a supplier's bill, a price
 * list), read on this device with pdf.js. A scanned or photographed page
 * has no text to read and is refused with a message saying so.
 */
export async function readPdfTable(file: File, isHeader: (cells: string[]) => boolean): Promise<PdfTable> {
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
    if (items.filter((i) => i.str.trim()).length < 5) throw new SheetError("IMPORT_PDF_SCANNED");
    return tableFromLines(linesOf(items), isHeader);
  } finally {
    void task.destroy();
  }
}
