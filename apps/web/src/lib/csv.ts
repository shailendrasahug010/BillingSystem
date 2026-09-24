/**
 * RFC 4180 CSV parser for spreadsheet imports: quoted cells with commas,
 * line breaks and doubled quotes, CRLF or LF, a leading UTF-8 BOM (Excel),
 * and semicolon-separated files (Excel in some locales). Empty lines are
 * dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** Header text -> canonical column key: "Selling Price (₹)" -> "selling_price". */
export function headerKey(header: string, aliases: Record<string, string> = {}): string {
  const key = header
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[₹%.]/g, "")
    .trim()
    .replace(/[\s/-]+/g, "_");
  return aliases[key] ?? key;
}

/** Rows as objects keyed by canonical header. */
export function csvRecords(text: string, aliases: Record<string, string> = {}): { columns: string[]; records: Array<Record<string, string>> } {
  const [head, ...body] = parseCsv(text);
  if (!head) return { columns: [], records: [] };
  const columns = head.map((h) => headerKey(h, aliases));
  return { columns, records: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? "").trim()]))) };
}
