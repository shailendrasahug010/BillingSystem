import { billColumnOf } from "@vyapaar/core";
import { describe, expect, it } from "vitest";
import { linesOf, tableFromLines, type PdfText } from "./pdfLayout";

/** Pieces of text as pdf.js reports them: words or phrases at positions (font size 9). */
const t = (str: string, x: number, y: number, page = 1): PdfText => ({ str, x, y, width: str.length * 4.6, height: 9, page });
const isBillHeader = (cells: string[]) => {
  const cols = cells.map(billColumnOf);
  return cols.includes("item_name") && cols.includes("qty");
};

describe("tables from PDF text", () => {
  it("groups words into cells and lines", () => {
    // Words one space apart (about a quarter of the font size), the next column far off.
    const lines = linesOf([t("SURF", 70, 600), t("EXCEL", 90.8, 600.4), t("1KG", 116.2, 599.7), t("10", 320, 600), t(" ", 330, 600), t("Parle-G", 70, 585)]);
    expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual([["SURF EXCEL 1KG", "10"], ["Parle-G"]]);
  });

  it("puts every cell under its column, joins wrapped names, repeats pages and stops at the totals", () => {
    const items: PdfText[] = [
      t("SHREE GANESH AGENCIES", 40, 800),
      t("GSTIN: 23AAACM1234M1ZR", 40, 786),
      t("Invoice No. : SG/1021", 40, 760),
      t("Date : 20-09-2026", 300, 760),
      // Header: Sr, Particulars, HSN, Qty, Rate, Amount.
      t("Sr", 40, 730),
      t("Particulars", 70, 730),
      t("HSN", 250, 730),
      t("Qty", 318, 730),
      t("Rate", 370, 730),
      t("Amount", 440, 730),
      t("1", 42, 714),
      t("SURF EXCEL EASY", 70, 714),
      t("3402", 250, 714),
      t("2", 325, 714),
      t("1,380.00", 360, 714),
      t("2,691.00", 440, 714),
      t("WASH 1KG POUCH", 70, 704),
      t("2", 42, 690),
      t("PARLE-G 100 GM", 70, 690),
      t("1905", 250, 690),
      t("240", 318, 690),
      t("8.00", 372, 690),
      t("1,920.00", 440, 690),
      // Page 2: the header again, one more item, then the totals and the words.
      t("Sr", 40, 780, 2),
      t("Particulars", 70, 780, 2),
      t("HSN", 250, 780, 2),
      t("Qty", 318, 780, 2),
      t("Rate", 370, 780, 2),
      t("Amount", 440, 780, 2),
      t("3", 42, 764, 2),
      t("TATA SALT 1KG", 70, 764, 2),
      t("2501", 250, 764, 2),
      t("50", 322, 764, 2),
      t("22.00", 368, 764, 2),
      t("1,100.00", 440, 764, 2),
      t("Total", 70, 740, 2),
      t("5,711.00", 440, 740, 2),
      t("Rupees Five Thousand Seven Hundred Eleven Only", 40, 720, 2),
    ];
    const table = tableFromLines(linesOf(items), isBillHeader);
    expect(table.preamble).toEqual(["SHREE GANESH AGENCIES", "GSTIN: 23AAACM1234M1ZR", "Invoice No. : SG/1021 Date : 20-09-2026"]);
    expect(table.rows).toEqual([
      ["Sr", "Particulars", "HSN", "Qty", "Rate", "Amount"],
      ["1", "SURF EXCEL EASY WASH 1KG POUCH", "3402", "2", "1,380.00", "2,691.00"],
      ["2", "PARLE-G 100 GM", "1905", "240", "8.00", "1,920.00"],
      ["3", "TATA SALT 1KG", "2501", "50", "22.00", "1,100.00"],
    ]);
  });

  it("returns no rows when there is no header line", () => {
    expect(tableFromLines(linesOf([t("Dear sir", 40, 700), t("Please find the price list", 40, 690)]), isBillHeader)).toEqual({ rows: [], preamble: ["Dear sir", "Please find the price list"] });
  });

  it("joins headings printed over two lines and a unit that wrapped under the quantity", () => {
    const items: PdfText[] = [
      t("Sr", 40, 730),
      t("Particulars", 70, 730),
      t("Qty", 318, 730),
      t("Rate", 370, 730),
      t("GST", 420, 730),
      t("%", 424, 721),
      t("1", 42, 710),
      t("SURF EXCEL", 70, 710),
      t("2", 325, 710),
      t("1,380.00", 360, 710),
      t("18", 422, 710),
      t("EASY WASH 1KG", 70, 700),
      t("CS", 322, 700),
    ];
    expect(tableFromLines(linesOf(items), isBillHeader).rows).toEqual([
      ["Sr", "Particulars", "Qty", "Rate", "GST %"],
      ["1", "SURF EXCEL EASY WASH 1KG", "2 CS", "1,380.00", "18"],
    ]);
  });

  it("joins a wrapped name in the first column of a price list", () => {
    const isList = (cells: string[]) => cells.includes("Item Name");
    const items: PdfText[] = [t("Item Name", 40, 700), t("MRP", 300, 700), t("Harpic Toilet", 40, 686), t("99", 305, 686), t("Cleaner 500ml", 40, 677), t("Vim Bar 200g", 40, 660), t("20", 305, 660)];
    expect(tableFromLines(linesOf(items), isList).rows).toEqual([
      ["Item Name", "MRP"],
      ["Harpic Toilet Cleaner 500ml", "99"],
      ["Vim Bar 200g", "20"],
    ]);
  });
});
