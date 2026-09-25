/**
 * Rebuilds a table from the text of a PDF made by billing software. A PDF
 * has no rows or cells, only pieces of text at positions: pieces at the same
 * height form a line, pieces close together form a cell, and the header line
 * (found by the caller's test) fixes the columns. Every later line puts each
 * cell in the column its centre falls under. A line holding only a little
 * text under a text column continues the row above it (an item name that
 * wrapped). The table ends at the bill's totals.
 */
export interface PdfText {
  str: string;
  /** Left edge and baseline in PDF units (y grows upwards). */
  x: number;
  y: number;
  width: number;
  /** Font size. */
  height: number;
  page: number;
}

interface Cell {
  text: string;
  x0: number;
  x1: number;
}

export interface PdfLine {
  page: number;
  y: number;
  height: number;
  cells: Cell[];
}

export interface PdfTable {
  /** Header row first, then the data rows; empty when no header was found. */
  rows: string[][];
  /** Text of the lines above the table (bill number, date, the supplier's GSTIN). */
  preamble: string[];
}

const NUMERIC = /^[-+]?[₹\d.,]+%?$/;
const END_OF_TABLE = /^(grand\s*total|total|sub[\s-]*total|net\s*(amount|total|payable)|amount\s*(in\s*words|chargeable)|rupees\b|bill\s*amount|invoice\s*(value|total)|round(ed)?[\s-]*off|taxable\s*(amount|value)\s*total)/i;

/** Pieces of text grouped into lines, and within a line into cells. */
export function linesOf(items: readonly PdfText[]): PdfLine[] {
  const pieces = items.filter((i) => i.str.trim() !== "").sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: Array<{ page: number; y: number; height: number; items: PdfText[] }> = [];
  for (const it of pieces) {
    const last = lines.at(-1);
    const tolerance = Math.max(2, 0.45 * Math.max(it.height, last?.height ?? 0));
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= tolerance) {
      last.items.push(it);
      last.height = Math.max(last.height, it.height);
    } else lines.push({ page: it.page, y: it.y, height: it.height, items: [it] });
  }
  return lines.map((l) => {
    const cells: Cell[] = [];
    for (const it of [...l.items].sort((a, b) => a.x - b.x)) {
      const cur = cells.at(-1);
      const gap = cur ? it.x - cur.x1 : Infinity;
      // A word space is about a quarter of the font size; columns sit further apart.
      if (cur && gap <= 0.45 * l.height) {
        cur.text += (gap > 0.12 * l.height && !cur.text.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
        cur.x1 = Math.max(cur.x1, it.x + it.width);
      } else cells.push({ text: it.str, x0: it.x, x1: it.x + it.width });
    }
    return { page: l.page, y: l.y, height: l.height, cells: cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() })) };
  });
}

/** The table under the first line `isHeader` accepts. */
export function tableFromLines(lines: readonly PdfLine[], isHeader: (cells: string[]) => boolean): PdfTable {
  const h = lines.findIndex((l) => isHeader(l.cells.map((c) => c.text)));
  if (h < 0) return { rows: [], preamble: lines.map((l) => l.cells.map((c) => c.text).join(" ")) };
  let head = lines[h]!;
  const headerTexts = head.cells.map((c) => c.text);
  const bounds = (cells: Cell[]) => cells.slice(0, -1).map((c, i) => (c.x1 + cells[i + 1]!.x0) / 2);
  let edges = bounds(head.cells);
  const columnOf = (c: Cell) => {
    const mid = (c.x0 + c.x1) / 2;
    const i = edges.findIndex((e) => mid < e);
    return i < 0 ? edges.length : i;
  };

  // Headings printed over two lines ("GST" above "%", "Batch" above "No."): the short
  // text straight below the header line belongs to the headings above it.
  let start = h + 1;
  for (let next = lines[start]; next && next.page === head.page && head.y - next.y < 1.8 * Math.max(head.height, next.height) && next.cells.every((c) => c.text.length <= 12 && !/^[\d.,]+$/.test(c.text)); next = lines[++start]) {
    for (const c of next.cells) {
      const k = Math.min(columnOf(c), headerTexts.length - 1);
      headerTexts[k] = `${headerTexts[k]} ${c.text}`;
    }
  }

  const rows: string[][] = [headerTexts];
  let prev: { row: string[]; line: PdfLine } | null = null;
  for (const line of lines.slice(start)) {
    const texts = line.cells.map((c) => c.text);
    // The header again at the top of a later page: take its columns, skip the line.
    if (isHeader(texts)) {
      head = line;
      edges = bounds(head.cells);
      prev = null;
      continue;
    }
    if (END_OF_TABLE.test(texts[0] ?? "")) break;
    const row = Array<string>(headerTexts.length).fill("");
    for (const c of line.cells) {
      const k = Math.min(columnOf(c), headerTexts.length - 1);
      row[k] = row[k] ? `${row[k]} ${c.text}` : c.text;
    }
    const filled = row.flatMap((v, i) => (v ? [i] : []));
    // A line with a few words and no numbers right under a row finishes that row: the
    // rest of a long item name, or a unit ("CS") that did not fit next to the quantity.
    const continues =
      prev !== null &&
      prev.line.page === line.page &&
      prev.line.y - line.y < 1.9 * Math.max(line.height, prev.line.height) &&
      filled.length <= 3 &&
      // Never under a serial-number column.
      filled.every((i) => !(i === 0 && NUMERIC.test(prev!.row[0] ?? "")) && !NUMERIC.test(row[i]!) && prev!.row[i]);
    if (continues) {
      for (const i of filled) prev!.row[i] = `${prev!.row[i]} ${row[i]}`;
      prev!.line = line;
      continue;
    }
    rows.push(row);
    prev = { row, line };
  }
  return { rows, preamble: lines.slice(0, h).map((l) => l.cells.map((c) => c.text).join(" ")) };
}
