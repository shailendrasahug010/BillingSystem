import { describe, expect, it } from "vitest";
import { csvRecords, headerKey, parseCsv } from "./csv";

describe("CSV import parsing", () => {
  it("handles quotes, commas, line breaks, CRLF and the Excel BOM", () => {
    const text = '﻿Name,Price\r\n"Parle-G, 100g","1,020.50"\r\n"Say ""hi""",5\r\n"Two\nlines",7\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["Name", "Price"],
      ["Parle-G, 100g", "1,020.50"],
      ['Say "hi"', "5"],
      ["Two\nlines", "7"],
    ]);
  });

  it("reads semicolon-separated files", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("maps headers to column keys, with aliases", () => {
    expect(headerKey("Selling Price (₹)")).toBe("selling_price");
    expect(headerKey("GST %")).toBe("gst");
    expect(headerKey("Product Name", { product_name: "name" })).toBe("name");
    const { records } = csvRecords("Product Name,HSN Code\nSoap,3401", { product_name: "name", hsn_code: "hsn" });
    expect(records).toEqual([{ name: "Soap", hsn: "3401" }]);
  });
});
