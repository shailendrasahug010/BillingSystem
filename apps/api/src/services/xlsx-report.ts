import writeXlsxFile, { type Cell, type Row } from "write-excel-file/node";
import type { PdfColumn } from "./pdf-report.js";

/**
 * Reports as Excel workbooks: the report's title, the firm and the period on
 * top, a bold header row that stays in view while scrolling, then the rows
 * with real numbers and dates (so sums and filters work in Excel) and the
 * totals in bold. Text is always written as text, never as a formula.
 */
export interface ReportXlsxInput {
  firm: string;
  title: string;
  period: string | null;
  columns: PdfColumn[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown> | null;
}

const NUMBER = /^-?\d+(?:\.(\d+))?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEAD = "#eef2f9";
const RULE = "#b8c3d6";

function cell(value: unknown, extra: Record<string, unknown> = {}): Cell {
  if (value === null || value === undefined || value === "") return extra.fontWeight ? ({ value: "", ...extra } as Cell) : null;
  if (typeof value === "number") return { value, type: Number, ...extra } as Cell;
  if (typeof value === "boolean") return { value: value ? "Yes" : "No", type: String, ...extra } as Cell;
  const s = String(value);
  const n = NUMBER.exec(s);
  // Money keeps its paise; quantities and percentages show what they have.
  if (n) return { value: Number(s), type: Number, ...(n[1]?.length === 2 ? { format: "#,##0.00" } : {}), ...extra } as Cell;
  if (DATE.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return { value: new Date(Date.UTC(y!, m! - 1, d!)), type: Date, format: "dd/mm/yyyy", ...extra } as Cell;
  }
  return { value: s, type: String, ...extra } as Cell;
}

const width = (v: unknown) => (v === null || v === undefined ? 0 : NUMBER.test(String(v)) ? String(v).length + 3 : DATE.test(String(v)) ? 10 : String(v).length);
const titleCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export async function renderReportXlsx(input: ReportXlsxInput): Promise<Buffer> {
  const cols = input.columns;
  const pad = (first: Cell): Row => [first, ...cols.slice(1).map(() => null)];
  const data: Row[] = [
    pad({ value: input.title, type: String, fontWeight: "bold", fontSize: 14, columnSpan: cols.length } as Cell),
    pad({ value: [input.firm, input.period].filter(Boolean).join(" · "), type: String, textColor: "#47536c", columnSpan: cols.length } as Cell),
    [],
    cols.map((c) => ({ value: titleCase(c.label), type: String, fontWeight: "bold", backgroundColor: HEAD, borderColor: RULE }) as Cell),
    ...input.rows.map((r) => cols.map((c) => cell(r[c.key]))),
  ];
  if (input.totals && input.rows.length) {
    data.push(cols.map((c, i) => (i === 0 ? ({ value: "Total", type: String, fontWeight: "bold" } as Cell) : cell(input.totals![c.key], { fontWeight: "bold" }))));
  }
  const widths = cols.map((c, i) => {
    let w = c.label.length;
    for (const r of input.rows.slice(0, 500)) w = Math.max(w, width(r[c.key]));
    if (input.totals) w = Math.max(w, width(input.totals[c.key]), i === 0 ? 5 : 0);
    return { width: Math.min(50, Math.max(8, w + 2)) };
  });
  const sheet = input.title.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Report";
  return writeXlsxFile(data, { columns: widths, sheet, stickyRowsCount: 4 }).toBuffer();
}
