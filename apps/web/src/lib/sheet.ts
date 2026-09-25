import { parseCsv } from "./csv";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** What the import screens accept: CSV, Excel workbooks (.xlsx, first sheet) and PDFs made by billing software. */
export const SHEET_ACCEPT = `.csv,.xlsx,.pdf,text/csv,application/pdf,${XLSX}`;

/** Why a file could not be read; the codes have messages under `errors.*`. */
export class SheetError extends Error {
  constructor(readonly code: "IMPORT_OLD_EXCEL" | "IMPORT_UNREADABLE" | "IMPORT_PDF_SCANNED" | "IMPORT_PDF_LOCKED") {
    super(code);
  }
}

export interface Sheet {
  rows: string[][];
  /** PDFs: the text above the table (a bill's number, date and the supplier's GSTIN). */
  preamble: string[];
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
 * The rows of a CSV, .xlsx (first sheet) or PDF file, as text. The Excel and
 * PDF readers are loaded only when such a file is chosen. In a PDF the table
 * starts at the first line `isHeader` accepts. Old .xls workbooks have to be
 * saved again as .xlsx or CSV first.
 */
export async function readSheetFile(file: File, options: { isHeader?(cells: string[]): boolean } = {}): Promise<Sheet> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) throw new SheetError("IMPORT_OLD_EXCEL");
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const { readPdfTable } = await import("./pdfRead");
    return readPdfTable(file, options.isHeader ?? (() => false));
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
