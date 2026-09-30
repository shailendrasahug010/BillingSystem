import { parseCsv } from "./csv";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** What the import screens accept: CSV, Excel workbooks (.xlsx, first sheet), PDFs (made by billing software or scanned) and photos. */
export const SHEET_ACCEPT = `.csv,.xlsx,.pdf,.jpg,.jpeg,.png,.webp,text/csv,application/pdf,${XLSX},image/*`;

/** Why a file could not be read; the codes have messages under `errors.*`. */
export class SheetError extends Error {
  constructor(readonly code: "IMPORT_OLD_EXCEL" | "IMPORT_UNREADABLE" | "IMPORT_PDF_LOCKED" | "IMPORT_PHOTO_OFFLINE" | "IMPORT_PHOTO_BLANK") {
    super(code);
  }
}

/** A photo (or an image scan) rather than a sheet. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name);
}

export interface Sheet {
  rows: string[][];
  /** PDFs: the text above the table (a bill's number, date and the supplier's GSTIN). */
  preamble: string[];
  /** Read from a photo or a scanned PDF: worth checking line by line. */
  scanned?: boolean;
}

/** A spreadsheet cell as text: dates become YYYY-MM-DD, numbers lose float noise. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).trim();
}

/**
 * The rows of a CSV, .xlsx (first sheet), PDF or photo, as text. The Excel,
 * PDF and photo readers are loaded only when such a file is chosen. In a PDF
 * or photo the table starts at the first line `isHeader` accepts; reading a
 * photo or a scanned PDF needs a connection and reports each page it starts.
 * Old .xls workbooks have to be saved again as .xlsx or CSV first.
 */
export async function readSheetFile(
  file: File,
  options: { isHeader?(cells: string[]): boolean; onProgress?(page: number, pages: number): void } = {},
): Promise<Sheet> {
  const name = file.name.toLowerCase();
  const isHeader = options.isHeader ?? (() => false);
  if (name.endsWith(".xls")) throw new SheetError("IMPORT_OLD_EXCEL");
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const { readPdfTable } = await import("./pdfRead");
    return readPdfTable(file, isHeader, options.onProgress);
  }
  if (isImageFile(file)) {
    const { readImageTable } = await import("./ocrRead");
    return readImageTable(file, isHeader, options.onProgress);
  }
  if (name.endsWith(".xlsx") || file.type === XLSX) {
    try {
      const { readSheet } = await import("read-excel-file/browser");
      const rows = (await readSheet(file)) as unknown[][];
      return { rows: rows.map((r) => r.map(cellText)).filter((r) => r.some((c) => c !== "")), preamble: [] };
    } catch {
      throw new SheetError("IMPORT_UNREADABLE");
    }
  }
  return { rows: parseCsv(await file.text()), preamble: [] };
}
