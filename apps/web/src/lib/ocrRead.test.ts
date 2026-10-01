import { billColumnOf, readBillFile } from "@digitalbahi/core";
import { describe, expect, it } from "vitest";
import { tableOfPages, type OcrPage } from "./ocrRead";

const isBillHeader = (cells: string[]) => {
  const cols = cells.map(billColumnOf);
  return cols.includes("item_name") && cols.includes("qty");
};

/** A line of cells as the server sends them: [text, left edge] with a width of 18 px a letter. */
const line = (y: number, cells: Array<[string, number]>) => ({ y, height: 30, cells: cells.map(([text, x0]) => ({ text, x0, x1: x0 + 18 * text.length })) });

describe("a table from a photographed bill", () => {
  it("rebuilds the bill from the cells read on each page", () => {
    const page1: OcrPage = {
      width: 2400,
      height: 1800,
      lines: [
        line(120, [["SAMPLE BISCUIT AGENCY", 60]]),
        line(180, [["GSTIN: 23ABCDE1234F1Z5", 60], ["Invoice No: SB/118", 900], ["Date: 21/09/2026", 1500]]),
        line(300, [["Sr", 60], ["Item Description", 160], ["HSN", 800], ["Qty", 1000], ["Rate", 1250], ["GST%", 1500], ["Amount", 1800]]),
        // Cells a single space apart came as one (the reader's own word spacing), even when close together.
        line(360, [["1", 60], ["Glucose Biscuit 100g", 160], ["1905", 800], ["120", 1000], ["8.50", 1250], ["5", 1500], ["1020.00", 1800]]),
        line(420, [["2", 60], ["Salted Crackers 75g", 160], ["1905", 800], ["48", 1000], ["9.20", 1250], ["18", 1500], ["441.60", 1800]]),
      ],
    };
    const page2: OcrPage = {
      width: 2400,
      height: 1800,
      lines: [
        line(100, [["Sr", 60], ["Item Description", 160], ["HSN", 800], ["Qty", 1000], ["Rate", 1250], ["GST%", 1500], ["Amount", 1800]]),
        line(160, [["3", 60], ["Cream Biscuit 60g", 160], ["1905", 800], ["24", 1000], ["25.00", 1250], ["18", 1500], ["600.00", 1800]]),
        line(240, [["Grand Total: 2130.60", 1500]]),
      ],
    };
    const table = tableOfPages([page1, page2], isBillHeader);
    expect(table.scanned).toBe(true);
    expect(table.preamble).toEqual(["SAMPLE BISCUIT AGENCY", "GSTIN: 23ABCDE1234F1Z5 Invoice No: SB/118 Date: 21/09/2026"]);
    expect(table.rows).toEqual([
      ["Sr", "Item Description", "HSN", "Qty", "Rate", "GST%", "Amount"],
      ["1", "Glucose Biscuit 100g", "1905", "120", "8.50", "5", "1020.00"],
      ["2", "Salted Crackers 75g", "1905", "48", "9.20", "18", "441.60"],
      ["3", "Cream Biscuit 60g", "1905", "24", "25.00", "18", "600.00"],
    ]);
    const bill = readBillFile(table.rows).bills[0]!;
    expect(bill.lines.map((l) => [l.itemName, l.qty, l.rate])).toEqual([
      ["Glucose Biscuit 100g", "120", "8.5"],
      ["Salted Crackers 75g", "48", "9.2"],
      ["Cream Biscuit 60g", "24", "25"],
    ]);
  });

  it("says so when nothing printed was found", () => {
    expect(() => tableOfPages([{ width: 100, height: 100, lines: [] }], isBillHeader)).toThrow("IMPORT_PHOTO_BLANK");
  });
});
