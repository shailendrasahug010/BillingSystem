import { describe, expect, it } from "vitest";
import { buildEInvoice, buildEwayBill, ewayBillFile, needsEInvoice, needsEwayBill, qrMatrix, validEwayBillNumber, validIrn, type EDocument } from "../src/index.js";

const seller = { gstin: "23AAPFR1234K1ZX", legalName: "Ravi Distributors", tradeName: "Ravi Traders", addr1: "12 MG Road", place: "Indore", pincode: "452001", stateCode: "23", phone: "0731-2555555", email: "ravi@example.com" };
const buyer = { gstin: "23ABCDE1234F1Z5", legalName: "Sharma Kirana", addr1: "Shop 4, Rajwada", place: "Indore", pincode: "452002", stateCode: "23" };

/**
 * 10 boxes (240 pieces) of biscuits at ₹240 a box less ₹24: ₹2,376 at 5%,
 * freight ₹100 at 18% and packing ₹50 without GST:
 * 2,376 + 59.40 + 59.40 + 100 + 9 + 9 + 50 = 2,662.80, rounded to 2,663.
 */
const invoice: EDocument = {
  kind: "invoice",
  number: "INV/26-27/00007",
  date: "2026-09-24",
  seller,
  buyer,
  placeOfSupply: "23",
  supplyType: "intra_state",
  lines: [{ name: "Parle-G 100g", hsnCode: "190531", qty: "240", uqc: "PCS", discount: "24", taxable: "2376", gstRate: "5", cgst: "59.40", sgst: "59.40", igst: "0", batch: { number: "B-77", expiry: "2027-03-31" } }],
  charges: [
    { label: "Freight", taxable: "100", gstRate: "18", total: "118" },
    { label: "Packing", taxable: "50", gstRate: "0", total: "50" },
  ],
  roundOff: "0.20",
  grandTotal: "2663",
};

describe("e-invoice JSON", () => {
  it("lays out a B2B invoice as INV-01: items, taxed charges as a service line, totals that add up", () => {
    const { json, issues } = buildEInvoice(invoice);
    expect(json).toMatchObject({
      Version: "1.1",
      TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", IgstOnIntra: "N" },
      DocDtls: { Typ: "INV", No: "INV/26-27/00007", Dt: "24/09/2026" },
      SellerDtls: { Gstin: "23AAPFR1234K1ZX", LglNm: "Ravi Distributors", TrdNm: "Ravi Traders", Loc: "Indore", Pin: 452001, Stcd: "23", Ph: "07312555555", Em: "ravi@example.com" },
      BuyerDtls: { Gstin: "23ABCDE1234F1Z5", Pos: "23", Pin: 452002, Stcd: "23" },
      ValDtls: { AssVal: 2476, CgstVal: 68.4, SgstVal: 68.4, IgstVal: 0, CesVal: 0, OthChrg: 50, RndOffAmt: 0.2, TotInvVal: 2663 },
    });
    const items = json.ItemList as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ SlNo: "1", IsServc: "N", HsnCd: "190531", Qty: 240, Unit: "PCS", UnitPrice: 10, TotAmt: 2400, Discount: 24, AssAmt: 2376, GstRt: 5, CgstAmt: 59.4, SgstAmt: 59.4, TotItemVal: 2494.8, BchDtls: { Nm: "B-77", ExpDt: "31/03/2027" } });
    expect(items[1]).toMatchObject({ SlNo: "2", PrdDesc: "Freight", IsServc: "Y", HsnCd: "996511", AssAmt: 100, GstRt: 18, CgstAmt: 9, SgstAmt: 9, TotItemVal: 118 });
    expect(issues).toEqual([{ code: "CHARGE_AS_SERVICE", level: "warning", line: 2 }]);
  });

  it("marks an export: URP buyer abroad (96), no IGST under LUT, and the shipping bill", () => {
    const { json, issues } = buildEInvoice({
      ...invoice,
      number: "INV/26-27/00008",
      buyer: { gstin: null, legalName: "Gulf Traders LLC", addr1: "Deira", place: "Dubai", pincode: null, stateCode: "96" },
      placeOfSupply: "96",
      supplyType: "inter_state",
      zeroRatedType: "EXPWOP",
      lines: [{ ...invoice.lines[0]!, cgst: "0", sgst: "0", igst: "0" }],
      charges: [],
      roundOff: "0",
      grandTotal: "2376",
      shippingBill: { number: "7894561", date: "2026-09-25", portCode: "INNSA1" },
    });
    expect(json).toMatchObject({
      TranDtls: { SupTyp: "EXPWOP" },
      BuyerDtls: { Gstin: "URP", Pos: "96", Pin: 999999, Stcd: "96" },
      ExpDtls: { ShipBNo: "7894561", ShipBDt: "25/09/2026", Port: "INNSA1" },
      ValDtls: { AssVal: 2376, IgstVal: 0, TotInvVal: 2376, RndOffAmt: 0 },
    });
    expect(issues).toEqual([]);
  });

  it("refers a credit note to its invoice", () => {
    const { json } = buildEInvoice({ ...invoice, kind: "credit_note", number: "CN/26-27/00002", original: { number: "INV/26-27/00007", date: "2026-09-24" }, charges: [], roundOff: "0", grandTotal: "2494.80" });
    expect(json).toMatchObject({ DocDtls: { Typ: "CRN", No: "CN/26-27/00002" }, RefDtls: { PrecDocDtls: [{ InvNo: "INV/26-27/00007", InvDt: "24/09/2026" }] } });
  });

  it("says what the portal would refuse: no buyer address or PIN, no HSN, a number starting with 0", () => {
    const { issues } = buildEInvoice({
      ...invoice,
      number: "0071",
      buyer: { ...buyer, addr1: null, pincode: "12" },
      lines: [{ ...invoice.lines[0]!, hsnCode: null }, { ...invoice.lines[0]!, hsnCode: "1905" }],
      charges: [],
    });
    expect(issues).toEqual([
      { code: "BUYER_ADDRESS", level: "error" },
      { code: "BUYER_PINCODE", level: "error" },
      { code: "HSN_MISSING", level: "error", line: 1 },
      { code: "HSN_SHORT", level: "warning", line: 2 },
      { code: "NUMBER_FORMAT", level: "error" },
    ]);
  });

  it("knows which documents are e-invoiced and checks IRNs and e-way bill numbers", () => {
    expect(needsEInvoice({ buyerGstin: "23ABCDE1234F1Z5" })).toBe(true);
    expect(needsEInvoice({ buyerGstin: null })).toBe(false);
    expect(needsEInvoice({ buyerGstin: null, zeroRatedType: "EXPWP" })).toBe(true);
    expect(validIrn("a".repeat(64))).toBe(true);
    expect(validIrn("a".repeat(63))).toBe(false);
    expect(validEwayBillNumber("331001234567")).toBe(true);
    expect(validEwayBillNumber("33100123456")).toBe(false);
    expect(needsEwayBill("50000", "50000")).toBe(false);
    expect(needsEwayBill("50000.01", "50000")).toBe(true);
  });
});

describe("e-way bill JSON", () => {
  it("lays out Part A and B for the bulk upload: goods, their tax, the rest as other value", () => {
    const { bill, issues } = buildEwayBill(invoice, { vehicleNo: "mp 09 ab 1234", transporterName: "Shree Logistics", transporterId: "23aaacs1234m1zq", docNo: "LR-55", docDate: "2026-09-24" });
    expect(bill).toMatchObject({
      userGstin: "23AAPFR1234K1ZX",
      supplyType: "O",
      subSupplyType: 1,
      docType: "INV",
      docNo: "INV/26-27/00007",
      docDate: "24/09/2026",
      transType: 1,
      fromGstin: "23AAPFR1234K1ZX",
      fromTrdName: "Ravi Traders",
      fromPincode: 452001,
      fromStateCode: 23,
      actualFromStateCode: 23,
      toGstin: "23ABCDE1234F1Z5",
      toPincode: 452002,
      toStateCode: 23,
      totalValue: 2376,
      cgstValue: 59.4,
      sgstValue: 59.4,
      igstValue: 0,
      OthValue: 168.2,
      totInvValue: 2663,
      transMode: 1,
      transDistance: 0,
      transporterName: "Shree Logistics",
      transporterId: "23AAACS1234M1ZQ",
      transDocNo: "LR-55",
      transDocDate: "24/09/2026",
      vehicleNo: "MP09AB1234",
      vehicleType: "R",
      mainHsnCode: 190531,
    });
    expect((bill.itemList as unknown[])[0]).toEqual({ itemNo: 1, productName: "Parle-G 100g", productDesc: "Parle-G 100g", hsnCode: 190531, quantity: 240, qtyUnit: "PCS", taxableAmount: 2376, cgstRate: 2.5, sgstRate: 2.5, igstRate: 0, cessRate: 0, cessNonAdvol: 0 });
    expect(issues).toEqual([]);
    expect(ewayBillFile([bill])).toEqual({ version: "1.0.0621", billLists: [bill] });
  });

  it("sends an export to another country (99) and flags an odd vehicle number", () => {
    const { bill, issues } = buildEwayBill(
      { ...invoice, buyer: { gstin: null, legalName: "Gulf Traders LLC", addr1: "Deira", place: "Dubai", pincode: null, stateCode: "96" }, supplyType: "inter_state", zeroRatedType: "EXPWP", lines: [{ ...invoice.lines[0]!, cgst: "0", sgst: "0", igst: "118.80" }], charges: [], grandTotal: "2494.80", roundOff: "0" },
      { vehicleNo: "ABC" },
    );
    expect(bill).toMatchObject({ subSupplyType: 3, toGstin: "URP", toPincode: 999999, toStateCode: 99, actualToStateCode: 23, igstValue: 118.8 });
    expect((bill.itemList as Array<{ igstRate: number }>)[0]!.igstRate).toBe(5);
    expect(issues).toEqual([
      { code: "VEHICLE_FORMAT", level: "warning" },
      { code: "EXPORT_PORT_STATE", level: "warning" },
    ]);
  });
});

describe("QR code", () => {
  it("draws a QR code as rows of dark and light modules", () => {
    const m = qrMatrix("hello");
    expect(m).toHaveLength(21);
    expect(m.every((row) => row.length === 21)).toBe(true);
    // The finder pattern's corner.
    expect(m[0]![0]).toBe(true);
    expect(qrMatrix("x".repeat(1000)).length).toBeGreaterThan(90);
  });
});
