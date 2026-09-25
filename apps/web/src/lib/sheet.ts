import { parseCsv } from "./csv";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** What the import screens accept: CSV, and Excel workbooks (.xlsx, first sheet). */
export const SHEET_ACCEPT = `.csv,.xlsx,text/csv,${XLSX}`;

/** Why a file could not be read; the codes have messages under `errors.*`. */
export class SheetError extends Error {
  constructor(readonly code: "IMPORT_OLD_EXCEL" | "IMPORT_UNREADABLE") {
    super(code);
  }
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
 * The rows of a CSV or .xlsx file (its first sheet), as text. The Excel
 * reader is loaded only when an Excel file is chosen. Old .xls workbooks
 * have to be saved again as .xlsx or CSV first.
 */
export async function readSheetFile(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) throw new SheetError("IMPORT_OLD_EXCEL");
  if (name.endsWith(".xlsx") || file.type === XLSX) {
    try {
      const { readSheet } = await import("read-excel-file/browser");
      const rows = (await readSheet(file)) as unknown[][];
      return rows.map((r) => r.map(cellText)).filter((r) => r.some((c) => c !== ""));
    } catch {
      throw new SheetError("IMPORT_UNREADABLE");
    }
  }
  return parseCsv(await file.text());
}
