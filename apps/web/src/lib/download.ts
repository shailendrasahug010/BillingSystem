import { api } from "./api";

/** Saves text as a file (CSV exports, reports). */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  downloadBlob(filename, new Blob([text], { type }));
}

/** Saves a file the app has in memory (a PDF from the server, a CSV made here). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One CSV cell; text starting with = + - @ is prefixed so spreadsheets never run it as a formula. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Client-side CSV of what the screen shows (UTF-8 BOM so Excel reads Hindi names). */
export function downloadCsv<T>(filename: string, columns: Array<{ label: string; value(row: T): unknown }>, rows: T[]): void {
  const lines = [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(","))];
  downloadText(filename, `﻿${lines.join("\r\n")}\r\n`);
}

/** A report from the server as Excel (.xlsx), CSV or PDF (letterhead, totals, page numbers); needs report.export. */
export async function downloadReport(path: string, query: Record<string, string>, filename: string, format: "csv" | "pdf" | "xlsx" = "csv"): Promise<void> {
  const name = filename.replace(/\.(csv|pdf|xlsx)$/i, "") + `.${format}`;
  if (format === "pdf" || format === "xlsx") {
    downloadBlob(name, await api.blob(path, { ...query, format }));
    return;
  }
  const text = await api.get<string>(path, { ...query, format: "csv" });
  downloadText(name, text);
}
