import { billColumnOf, readBillFile } from "@vyapaar/core";
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

  it("keeps a name that wrapped over three lines of a top-aligned row with its own row", () => {
    // Rows are 13.5 apart inside a cell, with more space between rows: the last line
    // of the name ("1KG") is nearer the next item's numbers than its own.
    const items: PdfText[] = [
      t("Sr", 38, 693),
      t("Particulars", 59, 693),
      t("Qty", 283, 693),
      t("Rate", 411, 693),
      t("Amount", 513, 693),
      t("1", 38, 660.6),
      t("SURF EXCEL", 59, 660.6),
      t("2", 296, 660.6),
      t("1,380.00", 390, 660.6),
      t("2,691.00", 511, 660.6),
      t("EASY WASH", 59, 647.1),
      t("CS", 286, 647.1),
      t("1KG", 59, 633.6),
      t("2", 38, 614.9),
      t("PARLE-G", 59, 614.9),
      t("240", 283, 614.9),
      t("8.00", 413, 614.9),
      t("1,920.00", 511, 614.9),
      t("BISCUIT 100G", 59, 601.4),
    ];
    expect(tableFromLines(linesOf(items), isBillHeader).rows).toEqual([
      ["Sr", "Particulars", "Qty", "Rate", "Amount"],
      ["1", "SURF EXCEL EASY WASH 1KG", "2 CS", "1,380.00", "2,691.00"],
      ["2", "PARLE-G BISCUIT 100G", "240", "8.00", "1,920.00"],
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
  it("reads a company invoice: three-line headings, item names above and below their numbers, a page without the heading", () => {
    // Body text is smaller (7.3) than the heading (9), as company invoices print it.
    const b = (str: string, x: number, y: number, page = 1): PdfText => ({ str, x, y, width: str.length * 3.7, height: 7.3, page });
    const items: PdfText[] = [
      t("Org/Dup/Trip", 513, 813),
      t("TAX INVOICE", 271, 787),
      t("Malwa Snacks Limited", 242, 770),
      t("Invoice No.", 298, 608),
      t(": 2500108676", 398, 608),
      // A label a line and a half above the heading is not part of it.
      t("GSTIN", 17, 431.6),
      t(":", 74, 431.6),
      t("SR.", 14, 419.6),
      t("HSN", 150, 419.6),
      t("Description", 59, 413.9),
      t("Qty", 192, 413.9),
      t("UOM", 229, 413.9),
      t("Unit Price", 258, 413.9),
      t("Tax %", 312, 413.9),
      t("Net Value", 354, 413.9),
      t("Total", 556, 413.9),
      t("No", 15, 408.4),
      t("/SAC", 151, 408.4),
      // Item 1: the name starts above the numbers and runs on below them; the tax text too.
      b("MALWA Namkeen Moon Chips", 29, 395.1),
      b("CGST@6 +", 313, 392),
      b("1", 18, 389.6),
      b("21069099", 146, 389.6),
      b("20.00", 193, 388.5),
      b("Bag", 234, 389.6),
      b("314.0300", 263, 389.6),
      b("6280.60", 361, 389.6),
      b("7034.28", 548, 389.6),
      b("Tomato 11 gm 96 Pkt Rs 5 - With", 28, 386.1),
      b("SGST@6", 316, 383),
      b("Party Toys", 28, 377.1),
      // Item 2: a short name that starts under the serial number's heading.
      b("Hanger", 29, 364.4),
      b("CGST@9 +", 313, 361),
      b("2", 18, 358.9),
      b("73012090", 146, 358.9),
      b("150.00", 191, 358.9),
      b("Piece", 231, 358.9),
      b("0.1000", 267, 358.9),
      b("15.00", 365, 358.9),
      b("17.70", 552, 358.9),
      b("SGST@9", 316, 352.4),
      // Page footer, then page 2 carries on without the heading.
      b("Page 1 of 2", 17, 2.8),
      b("Subject to Indore Jurisdiction", 242, 2.8),
      b("YD Namkeen Puff Tomato 20 gm", 29, 815.9, 2),
      b("CGST@6 +", 313, 813, 2),
      b("3", 18, 811, 2),
      b("21069099", 146, 811, 2),
      b("80.00", 193, 811, 2),
      b("Carton", 229, 811, 2),
      b("748.7701", 263, 811, 2),
      b("59901.61", 359, 811, 2),
      b("67089.81", 546, 811, 2),
      b("210 pkt Rs 5", 28, 805, 2),
      b("SGST@6", 316, 802, 2),
      b("Total Sales Value", 81, 788, 2),
      b("66197.21", 358, 788, 2),
      b("74141.79", 545, 788, 2),
      b("Page 2 of 2", 17, 2.8, 2),
    ];
    const table = tableFromLines(linesOf(items), isBillHeader);
    expect(table.preamble).toEqual(["Org/Dup/Trip", "TAX INVOICE", "Malwa Snacks Limited", "Invoice No. : 2500108676", "GSTIN :"]);
    expect(table.rows).toEqual([
      ["SR. No", "Description", "HSN /SAC", "Qty", "UOM", "Unit Price", "Tax %", "Net Value", "Total"],
      ["1", "MALWA Namkeen Moon Chips Tomato 11 gm 96 Pkt Rs 5 - With Party Toys", "21069099", "20.00", "Bag", "314.0300", "CGST@6 + SGST@6", "6280.60", "7034.28"],
      ["2", "Hanger", "73012090", "150.00", "Piece", "0.1000", "CGST@9 + SGST@9", "15.00", "17.70"],
      ["3", "YD Namkeen Puff Tomato 20 gm 210 pkt Rs 5", "21069099", "80.00", "Carton", "748.7701", "CGST@6 + SGST@6", "59901.61", "67089.81"],
    ]);
    expect(readBillFile(table.rows).bills[0]!.lines.map((l) => [l.qty, l.unit, l.rate, l.gstRate])).toEqual([
      ["20", "BAG", "314.03", "12"],
      ["150", "PIECE", "0.1", "18"],
      ["80", "CARTON", "748.7701", "12"],
    ]);
  });
});
