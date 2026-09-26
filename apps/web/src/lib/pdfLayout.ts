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

const textOf = (l: PdfLine) => l.cells.map((c) => c.text);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/**
 * The header's columns, including headings printed over two or three lines
 * ("SR." / "No", "HSN" / "/SAC", "GST" / "%"): short text right above or
 * below the header line joins the heading it sits over, or becomes a column
 * of its own. Returns the columns and the lines they used.
 */
function headerColumns(lines: readonly PdfLine[], h: number): { cols: Cell[]; top: number; start: number } {
  const head = lines[h]!;
  const cols: Cell[] = head.cells.map((c) => ({ ...c }));
  // Lines of one heading sit closer than a line and a third apart; a label above the table ("GSTIN :") is further off.
  const near = (a: PdfLine, b: PdfLine) => a.page === b.page && Math.abs(a.y - b.y) < 1.3 * Math.max(a.height, b.height);
  const short = (l: PdfLine) => l.cells.every((c) => c.text.length <= 12 && !/^[\d.,]+$/.test(c.text) && !c.text.endsWith(":"));
  const merge = (l: PdfLine, above: boolean) => {
    const pad = 0.3 * l.height;
    for (const c of l.cells) {
      const col = cols.find((k) => c.x0 < k.x1 + pad && c.x1 > k.x0 - pad);
      if (col) {
        col.text = above ? `${c.text} ${col.text}` : `${col.text} ${c.text}`;
        col.x0 = Math.min(col.x0, c.x0);
        col.x1 = Math.max(col.x1, c.x1);
      } else cols.push({ ...c });
    }
    cols.sort((a, b) => a.x0 - b.x0);
  };
  let top = h;
  while (top > 0 && near(lines[top - 1]!, lines[top]!) && short(lines[top - 1]!)) merge(lines[--top]!, true);
  let start = h + 1;
  while (start < lines.length && near(lines[start]!, lines[start - 1]!) && short(lines[start]!)) merge(lines[start++]!, false);
  return { cols, top, start };
}

/** The table under the first line `isHeader` accepts. */
export function tableFromLines(lines: readonly PdfLine[], isHeader: (cells: string[]) => boolean): PdfTable {
  const h = lines.findIndex((l) => isHeader(textOf(l)));
  if (h < 0) return { rows: [], preamble: lines.map((l) => textOf(l).join(" ")) };
  const { cols, top, start } = headerColumns(lines, h);
  const headerTexts = cols.map((c) => c.text);
  const preamble = lines.slice(0, top).map((l) => textOf(l).join(" "));
  const bounds = (cells: Cell[]) => cells.slice(0, -1).map((c, i) => (c.x1 + cells[i + 1]!.x0) / 2);
  let edges = bounds(cols);
  const columnOf = (c: Cell) => {
    const mid = (c.x0 + c.x1) / 2;
    const i = edges.findIndex((e) => mid < e);
    return Math.min(i < 0 ? edges.length : i, headerTexts.length - 1);
  };

  // The body: up to the bill's totals, with the header again at the top of a later page skipped.
  const body: PdfLine[] = [];
  const headerAt = new Map<number, number[]>();
  for (const line of lines.slice(start)) {
    const texts = textOf(line);
    if (isHeader(texts)) {
      headerAt.set(body.length, bounds(line.cells));
      continue;
    }
    if (END_OF_TABLE.test(texts[0] ?? "")) break;
    body.push(line);
  }
  const edgesFor = (i: number) => {
    let e = bounds(cols);
    for (const [at, b] of headerAt) if (at <= i) e = b;
    return e;
  };

  const numbers = body.map((l) => l.cells.filter((c) => NUMERIC.test(c.text)).length);
  const most = Math.max(0, ...numbers);
  const place = (line: PdfLine, i: number) => {
    edges = edgesFor(i);
    return line.cells.map((c) => ({ k: columnOf(c), text: c.text, y: line.y, x: c.x0 }));
  };

  if (most >= 3) {
    // Item rows are the lines carrying most of the numbers (quantity, rate, amounts).
    // The other lines belong to one of them: an item name printed above and below its
    // numbers, a second line of "CGST@6 + SGST@6", a name that wrapped under a
    // top-aligned row. Between two item lines the row boundary is the widest gap
    // (cell padding and the rule between rows); text far from any item (page footers)
    // is left out.
    const anchors = body.flatMap((l, i) => (numbers[i]! >= Math.max(3, Math.ceil(most / 2)) ? [i] : []));
    const gaps = anchors.slice(1).flatMap((a, j) => (body[a]!.page === body[anchors[j]!]!.page ? [body[anchors[j]!]!.y - body[a]!.y] : []));
    const height = median(anchors.map((a) => body[a]!.height));
    const reach = Math.max(3 * height, 0.7 * median(gaps));
    const parts = anchors.map((a) => place(body[a]!, a).map((c) => ({ ...c, anchor: true })));
    const owner = new Map<number, number>();
    anchors.forEach((a, j) => {
      const next = anchors[j + 1];
      if (next === undefined || body[next]!.page !== body[a]!.page) return;
      const ys = body.slice(a, next + 1).map((l) => l.y);
      let split = 0;
      for (let k = 1; k < ys.length - 1; k++) if (ys[k]! - ys[k + 1]! >= ys[split]! - ys[split + 1]!) split = k;
      for (let i = a + 1; i < next; i++) owner.set(i, i - a <= split ? j : j + 1);
    });
    body.forEach((line, i) => {
      if (anchors.includes(i)) return;
      // Before the first item line of a page or after its last: the one on that page.
      const j = owner.get(i) ?? anchors.reduce((best, a, k) => (body[a]!.page === line.page && (best < 0 || Math.abs(body[a]!.y - line.y) < Math.abs(body[anchors[best]!]!.y - line.y)) ? k : best), -1);
      if (j >= 0 && Math.abs(body[anchors[j]!]!.y - line.y) <= reach) parts[j]!.push(...place(line, i).map((c) => ({ ...c, anchor: false })));
    });
    // A serial-number first column (only "1", "2." on the item lines) is narrow: the item
    // name printed above or below its numbers starts under it and belongs to the next column.
    const serial = parts.every((p) => p.every((c) => !c.anchor || c.k !== 0 || /^\d{1,4}\.?$/.test(c.text))) && parts.some((p) => p.some((c) => c.anchor && c.k === 0));
    const rows = parts.map((p) => {
      const row = Array<string>(headerTexts.length).fill("");
      for (const c of [...p].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const k = serial && c.k === 0 && !c.anchor ? 1 : c.k;
        row[k] = row[k] ? `${row[k]} ${c.text}` : c.text;
      }
      return row;
    });
    return { rows: [headerTexts, ...rows], preamble };
  }

  const rows: string[][] = [headerTexts];
  let prev: { row: string[]; line: PdfLine } | null = null;
  body.forEach((line, i) => {
    edges = edgesFor(i);
    if (headerAt.has(i)) prev = null;
    const row = Array<string>(headerTexts.length).fill("");
    for (const c of line.cells) {
      const k = columnOf(c);
      row[k] = row[k] ? `${row[k]} ${c.text}` : c.text;
    }
    const filled = row.flatMap((v, j) => (v ? [j] : []));
    // A line with a few words and no numbers right under a row finishes that row: the
    // rest of a long name, or a word that did not fit next to the one above.
    const p: { row: string[]; line: PdfLine } | null = prev;
    const continues =
      p !== null &&
      p.line.page === line.page &&
      p.line.y - line.y < 1.9 * Math.max(line.height, p.line.height) &&
      filled.length <= 3 &&
      filled.every((j) => !(j === 0 && NUMERIC.test(p.row[0] ?? "")) && !NUMERIC.test(row[j]!) && p.row[j]);
    if (continues) {
      for (const j of filled) p.row[j] = `${p.row[j]} ${row[j]}`;
      p.line = line;
      return;
    }
    rows.push(row);
    prev = { row, line };
  });
  return { rows, preamble };
}
