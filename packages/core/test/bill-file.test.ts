import { describe, expect, it } from "vitest";
import { billColumnOf, billFieldsFromText, compactName, parseBillDate, parseBillNumber, parseExpiry, parseGstRate, readBillFile, supplierItemKeys } from "../src/index.js";

describe("supplier bill files", () => {
  it("understands the column names bills and billing software use", () => {
    expect(["Particulars", "Item Description", "Product Name"].map(billColumnOf)).toEqual(["item_name", "item_name", "item_name"]);
    expect(["Qty.", "Sch Qty", "PTR", "Disc %", "HSN/SAC", "Exp.", "Batch No", "M.R.P."].map(billColumnOf)).toEqual(["qty", "free_qty", "rate", "discount", "hsn", "expiry", "batch", "mrp"]);
    // Rates, not the tax amounts in the next column.
    expect(["GST %", "GST", "CGST %", "CGST", "IGST Rate", "Tax Rate", "Tax"].map(billColumnOf)).toEqual(["gst_rate", null, "cgst_rate", null, "igst_rate", "gst_rate", null]);
    expect(["Invoice No.", "Inv Date", "Party GSTIN", "Amount"].map(billColumnOf)).toEqual(["bill_number", "bill_date", "supplier_gstin", null]);
  });

  it("parses Indian numbers and dates", () => {
    expect(parseBillNumber("₹ 1,250.50", 2)).toBe("1250.5");
    expect(parseBillNumber("Rs. 99", 2)).toBe("99");
    expect(parseBillNumber("12.34567", 4)).toBe("12.3457");
    expect(parseBillNumber("-5", 2)).toBeNull();
    expect(parseBillNumber("abc", 2)).toBeNull();
    expect(["25/09/2026", "25-09-26", "25.09.2026", "2026-09-25", "25-Sep-2026", "25 Sept 2026", "46290"].map(parseBillDate)).toEqual(Array(7).fill("2026-09-25"));
    expect(parseBillDate("31/02/2026")).toBeNull();
    expect(parseBillDate("hello")).toBeNull();
    expect(["09/27", "Sep-2027", "09/2027", "30/09/2027"].map(parseExpiry)).toEqual(Array(4).fill("2027-09-30"));
    expect(parseExpiry("02/28")).toBe("2028-02-29");
  });

  it("reads a Marg-style export: title rows, one bill, split GST, scheme quantity, batch and expiry", () => {
    const file = readBillFile([
      ["SHREE GANESH AGENCIES"],
      ["GSTIN: 23AAACM1234M1ZR"],
      ["Invoice No.", "Inv Date", "Party GSTIN", "Particulars", "Item Code", "HSN", "Qty", "Sch Qty", "PTR", "Disc %", "CGST %", "SGST %", "CGST", "SGST", "Batch", "Exp.", "M.R.P.", "Amount"],
      ["SG/1021", "20/09/2026", "23aaacm1234m1zr", "SURF EXCEL EASY WASH 1KG", "HU-1102", "3402", "10 CS", "1", "1,380.00", "2.5", "9", "9", "", "", "", "", "140", "13455"],
      ["", "", "", "PARLE-G 100G", "PA-100", "1905", "240", "", "8", "", "2.5", "2.5", "", "", "B2291", "08/27", "10", "1920"],
      ["", "", "", "Total", "", "", "", "", "", "", "", "", "", "", "", "", "", "15375"],
    ]);
    expect(file.headerRow).toBe(3);
    expect(file.ignored).toEqual(["CGST", "SGST", "Amount"]);
    expect(file.headers).toMatchObject({ item_name: "Particulars", rate: "PTR", free_qty: "Sch Qty", expiry: "Exp." });
    expect(file.problems).toEqual([]);
    expect(file.bills).toHaveLength(1);
    const bill = file.bills[0]!;
    expect(bill).toMatchObject({ billNumber: "SG/1021", billDate: "2026-09-20", supplierGstin: "23AAACM1234M1ZR" });
    expect(bill.lines).toEqual([
      {
        row: 4,
        itemName: "SURF EXCEL EASY WASH 1KG",
        itemCode: "HU-1102",
        barcode: null,
        hsnCode: "3402",
        unit: "CS",
        qty: "10",
        freeQty: "1",
        rate: "1380",
        discountPercent: "2.5",
        gstRate: "18",
        batchNumber: null,
        expiryDate: null,
        mfgDate: null,
        mrp: "140",
      },
      {
        row: 5,
        itemName: "PARLE-G 100G",
        itemCode: "PA-100",
        barcode: null,
        hsnCode: "1905",
        unit: null,
        qty: "240",
        freeQty: null,
        rate: "8",
        discountPercent: null,
        gstRate: "5",
        batchNumber: "B2291",
        expiryDate: "2027-08-31",
        mfgDate: null,
        mrp: "10",
      },
    ]);
  });

  it("splits a file with several bills and works out the discount from the taxable value", () => {
    const file = readBillFile([
      ["Bill No", "Bill Date", "Item", "Qty", "Rate", "Taxable Value", "GST Rate", "Barcode"],
      ["A-1", "01-09-2026", "Tea 250g", "12", "100", "1140", "5", "8901234567890"],
      ["A-1", "", "Salt 1kg", "20", "", "400", "0", ""],
      ["A-2", "02-09-2026", "Soap", "abc", "30", "", "18", ""],
      ["A-2", "", "Soap 100g", "5", "30", "", "12.5", ""],
    ]);
    expect(file.bills.map((b) => [b.billNumber, b.billDate, b.lines.length])).toEqual([
      ["A-1", "2026-09-01", 2],
      ["A-2", "2026-09-02", 1],
    ]);
    expect(file.bills[0]!.lines.map((l) => [l.itemName, l.rate, l.discountPercent, l.gstRate, l.barcode])).toEqual([
      ["Tea 250g", "100", "5", "5", "8901234567890"],
      ["Salt 1kg", "20", null, "0", null],
    ]);
    expect(file.problems).toEqual([
      { row: 4, column: "qty", code: "INVALID_NUMBER", value: "abc" },
      { row: 5, column: "gst_rate", code: "INVALID_NUMBER", value: "12.5" },
    ]);
  });

  it("reads GST written as its halves in one cell and the net value as the taxable value", () => {
    expect(["CGST@6 + SGST@6", "CGST@9+SGST@9", "IGST@18", "IGST @ 5%", "GST 18%", "CGST@2.5", "18%", "12.00 %", "5"].map(parseGstRate)).toEqual(["12", "18", "18", "5", "18", "5", "18", "12", "5"]);
    expect(parseGstRate("VAT")).toBeNull();
    expect(["Net Value", "Tax %", "Unit Price", "UOM", "SR. No"].map(billColumnOf)).toEqual(["taxable", "gst_rate", "rate", "unit", null]);
    const file = readBillFile([
      ["SR. No", "Description", "HSN /SAC", "Qty", "UOM", "Unit Price", "Tax %", "Net Value", "CGST", "SGST", "IGST", "Total"],
      ["1", "AVDH Namkeen Moon Chips Tomato 11 gm 96 Pkt Rs 5", "21069099", "20.00", "Bag", "314.0300", "CGST@6 + SGST@6", "6280.60", "376.84", "376.84", "0.00", "7034.28"],
      ["2", "Adhesive Tape", "39199090", "1.00", "Piece", "40.0000", "CGST@9 + SGST@9", "40.00", "3.60", "3.60", "0.00", "47.20"],
    ]);
    expect(file.problems).toEqual([]);
    expect(file.bills[0]!.lines.map((l) => [l.itemName, l.hsnCode, l.unit, l.qty, l.rate, l.discountPercent, l.gstRate])).toEqual([
      ["AVDH Namkeen Moon Chips Tomato 11 gm 96 Pkt Rs 5", "21069099", "BAG", "20", "314.03", null, "12"],
      ["Adhesive Tape", "39199090", "PIECE", "1", "40", null, "18"],
    ]);
  });

  it("reports a sheet without an item and quantity header", () => {
    expect(readBillFile([["Name", "Mobile"], ["Ramesh", "98260"]])).toMatchObject({ headerRow: 0, bills: [] });
  });

  it("remembers supplier items by code and by name, ignoring case and punctuation", () => {
    expect(supplierItemKeys({ code: "hu-1102", name: "SURF  EXCEL, 1 Kg" })).toEqual(["c:HU1102", "n:surfexcel1kg"]);
    expect(supplierItemKeys({ name: "नमक 1 किलो" })).toEqual(["n:नमक1किलो"]);
    expect(supplierItemKeys({})).toEqual([]);
    expect(compactName("Surf Excel 1 KG")).toBe(compactName("surf-excel 1kg"));
  });

  it("reads the bill number, date and supplier from the top of a printed bill", () => {
    expect(
      billFieldsFromText(
        ["SHREE GANESH AGENCIES", "12 Siyaganj, Indore · GSTIN: 23AAACM1234M1ZR", "TAX INVOICE", "Invoice No. : SG/1021 Date : 20-09-2026", "Bill to: Laxmi Traders GSTIN 23AAGFL4321K1Z5"],
        "23aagfl4321k1z5",
      ),
    ).toEqual({ billNumber: "SG/1021", billDate: "2026-09-20", supplierGstin: "23AAACM1234M1ZR", supplierName: "SHREE GANESH AGENCIES" });
    expect(billFieldsFromText(["Tax Invoice", "Malwa Foods", "Bill No: 4471", "Dated 5 Sep 2026"])).toMatchObject({ billNumber: "4471", billDate: "2026-09-05", supplierName: "Malwa Foods", supplierGstin: null });
    // Copy marks and the "Tax Invoice" title come before the seller's name on many bills.
    expect(billFieldsFromText(["Org/Dup/Trip", "TAX INVOICE", "Malwa Snacks Limited", "Invoice No. : 2500108676", "Invoice Date 24/08/2025"])).toMatchObject({ billNumber: "2500108676", billDate: "2025-08-24", supplierName: "Malwa Snacks Limited" });
    expect(billFieldsFromText(["Original for Recipient", "Malwa Foods"]).supplierName).toBe("Malwa Foods");
    expect(billFieldsFromText([])).toEqual({ billNumber: null, billDate: null, supplierGstin: null, supplierName: null });
  });
});
