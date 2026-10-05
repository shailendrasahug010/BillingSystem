import { describe, expect, it } from "vitest";
import { buildGstr1, buildGstr3b, gstr1Csv, utiliseCredit, type GstRegisterRow } from "../src/index.js";

const B2B = "23AAACM1234M1ZR";
function row(p: Partial<GstRegisterRow> & Pick<GstRegisterRow, "docNumber" | "taxableValue" | "gstRate" | "documentValue">): GstRegisterRow {
  return {
    direction: "outward",
    docType: "invoice",
    docId: p.docNumber,
    docDate: "2026-09-10",
    originalDocNumber: null,
    originalDocDate: null,
    partyName: null,
    partyGstin: null,
    placeOfSupply: "23",
    supplyType: "intra_state",
    isReverseCharge: false,
    taxability: "taxable",
    hsnCode: "1905",
    uqc: "PCS",
    qty: "1",
    cgst: "0",
    sgst: "0",
    igst: "0",
    cess: "0",
    itcEligibility: null,
    isCancelled: false,
    ...p,
  };
}

/** A month for a business in Madhya Pradesh (23), worked out by hand. */
const OUTWARD: GstRegisterRow[] = [
  row({ docNumber: "INV/26-27/00001", partyGstin: B2B, partyName: "Mehta Stores", hsnCode: "1905", qty: "100", taxableValue: "1000", gstRate: "5", cgst: "25", sgst: "25", documentValue: "1640" }),
  row({ docNumber: "INV/26-27/00001", partyGstin: B2B, partyName: "Mehta Stores", hsnCode: "3402", qty: "10", taxableValue: "500", gstRate: "18", cgst: "45", sgst: "45", documentValue: "1640" }),
  row({ docNumber: "INV/26-27/00002", hsnCode: "1905", qty: "20", taxableValue: "200", gstRate: "5", cgst: "5", sgst: "5", documentValue: "210" }),
  row({ docNumber: "INV/26-27/00003", docDate: "2026-09-12", placeOfSupply: "27", supplyType: "inter_state", hsnCode: "3402", qty: "1000", taxableValue: "100000", gstRate: "18", igst: "18000", documentValue: "118000" }),
  row({ docNumber: "INV/26-27/00004", placeOfSupply: "27", supplyType: "inter_state", hsnCode: "3402", qty: "10", taxableValue: "1000", gstRate: "18", igst: "180", documentValue: "1180" }),
  row({ docNumber: "INV/26-27/00005", taxableValue: "400", gstRate: "5", cgst: "10", sgst: "10", documentValue: "420", isCancelled: true }),
  row({ docNumber: "INV/26-27/00006", taxability: "exempt", hsnCode: "0701", uqc: "KGS", qty: "30", taxableValue: "300", gstRate: "0", documentValue: "300" }),
  row({ docNumber: "CN/26-27/00001", docType: "credit_note", docDate: "2026-09-20", originalDocNumber: "INV/26-27/00001", partyGstin: B2B, hsnCode: "1905", qty: "10", taxableValue: "100", gstRate: "5", cgst: "2.5", sgst: "2.5", documentValue: "105" }),
  row({ docNumber: "CN/26-27/00002", docType: "credit_note", docDate: "2026-09-21", originalDocNumber: "INV/26-27/00003", placeOfSupply: "27", supplyType: "inter_state", hsnCode: "3402", qty: "100", taxableValue: "10000", gstRate: "18", igst: "1800", documentValue: "11800" }),
  row({ docNumber: "CN/26-27/00003", docType: "credit_note", docDate: "2026-09-22", originalDocNumber: "INV/26-27/00002", hsnCode: "1905", qty: "5", taxableValue: "50", gstRate: "5", cgst: "1.25", sgst: "1.25", documentValue: "52.50" }),
];

const INWARD: GstRegisterRow[] = [
  row({ direction: "inward", docType: "purchase", docNumber: "HUL/991", partyGstin: B2B, taxableValue: "5000", gstRate: "18", cgst: "450", sgst: "450", documentValue: "5900", itcEligibility: "eligible" }),
  row({ direction: "inward", docType: "expense", docNumber: "TRN-7", partyGstin: "27AAACT1234T1Z5", supplyType: "inter_state", taxableValue: "500", gstRate: "18", igst: "90", documentValue: "590", itcEligibility: "input_services" }),
  row({ direction: "inward", docType: "purchase", docNumber: "GTA/12", isReverseCharge: true, taxableValue: "1000", gstRate: "5", cgst: "25", sgst: "25", documentValue: "1000", itcEligibility: "eligible" }),
  row({ direction: "inward", docType: "expense", docNumber: "FOOD-3", partyGstin: B2B, taxableValue: "200", gstRate: "5", cgst: "5", sgst: "5", documentValue: "210", itcEligibility: "ineligible" }),
  row({ direction: "inward", docType: "debit_note", docNumber: "DN/26-27/00001", partyGstin: B2B, taxableValue: "500", gstRate: "18", cgst: "45", sgst: "45", documentValue: "590", itcEligibility: "eligible" }),
];

const originals = new Map([
  ["INV/26-27/00001", { value: "1640", supplyType: "intra_state" as const }],
  ["INV/26-27/00002", { value: "210", supplyType: "intra_state" as const }],
  ["INV/26-27/00003", { value: "118000", supplyType: "inter_state" as const }],
]);

describe("GSTR-1", () => {
  const result = buildGstr1({ gstin: "23AAPFK1234K1ZX", period: "2026-09", b2clThreshold: "100000", hsnMinDigits: 4, rows: OUTWARD, originalInvoices: originals });

  it("sorts each document into its table (golden file)", () => {
    expect(result.version).toBe("gstr1-json@2026.10");
    expect(result.json).toEqual({
      gstin: "23AAPFK1234K1ZX",
      fp: "092026",
      version: "GST3.2.2",
      hash: "hash",
      b2b: [
        {
          ctin: B2B,
          inv: [
            {
              inum: "INV/26-27/00001",
              idt: "10-09-2026",
              val: 1640,
              pos: "23",
              rchrg: "N",
              inv_typ: "R",
              itms: [
                { num: 1, itm_det: { txval: 1000, rt: 5, iamt: 0, camt: 25, samt: 25, csamt: 0 } },
                { num: 2, itm_det: { txval: 500, rt: 18, iamt: 0, camt: 45, samt: 45, csamt: 0 } },
              ],
            },
          ],
        },
      ],
      b2cl: [{ pos: "27", inv: [{ inum: "INV/26-27/00003", idt: "12-09-2026", val: 118000, itms: [{ num: 1, itm_det: { txval: 100000, rt: 18, iamt: 18000, csamt: 0 } }] }] }],
      // The small inter-state sale, and the B2CS sale net of its credit note.
      b2cs: [
        { sply_ty: "INTER", pos: "27", typ: "OE", txval: 1000, rt: 18, iamt: 180, csamt: 0 },
        { sply_ty: "INTRA", pos: "23", typ: "OE", txval: 150, rt: 5, iamt: 0, camt: 3.75, samt: 3.75, csamt: 0 },
      ],
      cdnr: [
        {
          ctin: B2B,
          nt: [{ ntty: "C", nt_num: "CN/26-27/00001", nt_dt: "20-09-2026", val: 105, pos: "23", rchrg: "N", inv_typ: "R", itms: [{ num: 1, itm_det: { txval: 100, rt: 5, iamt: 0, camt: 2.5, samt: 2.5, csamt: 0 } }] }],
        },
      ],
      // Only the note against the B2CL invoice is reported on its own.
      cdnur: [{ typ: "B2CL", ntty: "C", nt_num: "CN/26-27/00002", nt_dt: "21-09-2026", val: 11800, pos: "27", itms: [{ num: 1, itm_det: { txval: 10000, rt: 18, iamt: 1800, csamt: 0 } }] }],
      hsn: {
        hsn_b2b: [
          { num: 1, hsn_sc: "1905", desc: "", uqc: "PCS", qty: 90, rt: 5, txval: 900, iamt: 0, camt: 22.5, samt: 22.5, csamt: 0 },
          { num: 2, hsn_sc: "3402", desc: "", uqc: "PCS", qty: 10, rt: 18, txval: 500, iamt: 0, camt: 45, samt: 45, csamt: 0 },
        ],
        hsn_b2c: [
          { num: 1, hsn_sc: "0701", desc: "", uqc: "KGS", qty: 30, rt: 0, txval: 300, iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { num: 2, hsn_sc: "1905", desc: "", uqc: "PCS", qty: 15, rt: 5, txval: 150, iamt: 0, camt: 3.75, samt: 3.75, csamt: 0 },
          { num: 3, hsn_sc: "3402", desc: "", uqc: "PCS", qty: 910, rt: 18, txval: 91000, iamt: 16380, camt: 0, samt: 0, csamt: 0 },
        ],
      },
      nil: { inv: [{ sply_ty: "INTRAB2C", expt_amt: 300, nil_amt: 0, ngsup_amt: 0 }] },
      doc_issue: {
        doc_det: [
          { doc_num: 1, doc_typ: "Invoices for outward supply", docs: [{ num: 1, from: "INV/26-27/00001", to: "INV/26-27/00006", totnum: 6, cancel: 1, net_issue: 5 }] },
          { doc_num: 5, doc_typ: "Credit Note", docs: [{ num: 1, from: "CN/26-27/00001", to: "CN/26-27/00003", totnum: 3, cancel: 0, net_issue: 3 }] },
        ],
      },
    });
    expect(result.warnings).toEqual([]);
  });

  it("summarises each table the way the offline tool does", () => {
    const by = Object.fromEntries(result.summary.map((s) => [s.section, s]));
    expect(by.b2b).toMatchObject({ records: 1, value: "1640.00", taxable: "1500.00", cgst: "70.00", sgst: "70.00" });
    expect(by.b2cl).toMatchObject({ records: 1, value: "118000.00", taxable: "100000.00", igst: "18000.00" });
    expect(by.b2cs).toMatchObject({ records: 2, taxable: "1150.00", igst: "180.00", cgst: "3.75" });
    expect(by.cdnr).toMatchObject({ records: 1, value: "105.00", taxable: "100.00", cgst: "2.50" });
    expect(by.cdnur).toMatchObject({ records: 1, value: "11800.00", igst: "1800.00" });
    expect(by.nil).toMatchObject({ records: 1, value: "300.00" });
  });

  it("warns about missing HSN / UQC, short HSN codes and bad GSTINs instead of failing", () => {
    const r = buildGstr1({
      gstin: "23AAPFK1234K1ZX",
      period: "2026-09",
      b2clThreshold: "100000",
      hsnMinDigits: 6,
      rows: [
        row({ docNumber: "INV/1", partyGstin: "23AAACM1234M1ZZ", taxableValue: "10", gstRate: "5", cgst: "0.25", sgst: "0.25", documentValue: "10.50" }),
        row({ docNumber: "INV/2", hsnCode: null, uqc: null, taxableValue: "10", gstRate: "5", cgst: "0.25", sgst: "0.25", documentValue: "10.50" }),
        row({ docNumber: "CN/1", docType: "credit_note", originalDocNumber: "INV/OLD", taxableValue: "5", gstRate: "5", documentValue: "5.25" }),
      ],
    });
    expect(r.warnings.map((w) => w.code)).toEqual(["HSN_TOO_SHORT", "INVALID_PARTY_GSTIN", "HSN_MISSING", "UQC_MISSING", "NOTE_ORIGINAL_NOT_FOUND"]);
  });

  it("writes the offline tool's CSV layout per table", () => {
    const b2b = gstr1Csv(result, "b2b", new Map([[B2B, "Mehta Stores"]]));
    expect(b2b[0]![0]).toBe("GSTIN/UIN of Recipient");
    expect(b2b[1]).toEqual([B2B, "Mehta Stores", "INV/26-27/00001", "10-Sep-2026", "1640", "23-Madhya Pradesh", "N", "", "Regular B2B", "", "5", "1000", "0"]);
    expect(gstr1Csv(result, "b2cs")[2]).toEqual(["OE", "23-Madhya Pradesh", "", "5", "150", "0", ""]);
    expect(gstr1Csv(result, "docs")[1]).toEqual(["Invoices for outward supply", "INV/26-27/00001", "INV/26-27/00006", "6", "1"]);
    expect(gstr1Csv(result, "hsn")[1]).toEqual(["B2B", "1905", "", "PCS", "90", "945", "5", "900", "0", "22.5", "22.5", "0"]);
  });
});

describe("GSTR-3B", () => {
  const r = buildGstr3b("2026-09", [...OUTWARD, ...INWARD]);

  it("computes outward tax net of credit notes, nil/exempt and reverse charge", () => {
    expect(r.outward.taxable).toEqual({ taxable: "92550.00", igst: "16380.00", cgst: "71.25", sgst: "71.25", cess: "0.00" });
    expect(r.outward.nilExempt).toEqual({ taxable: "300.00" });
    expect(r.outward.reverseChargeInward).toEqual({ taxable: "1000.00", igst: "0.00", cgst: "25.00", sgst: "25.00", cess: "0.00" });
    expect(r.interStateUnregistered).toEqual([{ placeOfSupply: "27", taxable: "91000.00", igst: "16380.00" }]);
  });

  it("reports ITC with purchase returns netted and blocked credit reversed", () => {
    expect(r.itc.reverseCharge).toEqual({ igst: "0.00", cgst: "25.00", sgst: "25.00", cess: "0.00" });
    expect(r.itc.allOther).toEqual({ igst: "90.00", cgst: "410.00", sgst: "410.00", cess: "0.00" });
    expect(r.itc.reversed).toEqual({ igst: "0.00", cgst: "5.00", sgst: "5.00", cess: "0.00" });
    expect(r.itc.net).toEqual({ igst: "90.00", cgst: "430.00", sgst: "430.00", cess: "0.00" });
  });

  it("uses credit in the legal order and pays reverse charge in cash", () => {
    expect(r.payment.liability).toEqual({ igst: "16380.00", cgst: "96.25", sgst: "96.25", cess: "0.00" });
    expect(r.payment.paidFromCredit).toEqual({ igst: "807.50", cgst: "71.25", sgst: "71.25", cess: "0.00" });
    expect(r.payment.cash).toEqual({ igst: "15572.50", cgst: "25.00", sgst: "25.00", cess: "0.00" });
    expect(r.payment.creditCarriedForward).toEqual({ igst: "0.00", cgst: "0.00", sgst: "0.00", cess: "0.00" });
  });

  it("places spare IGST credit where CGST / SGST credit falls short", () => {
    // CGST credit covers CGST fully; IGST credit should go to SGST, not waste itself on CGST.
    const u = utiliseCredit({ igst: "0", cgst: "100", sgst: "100", cess: "0" }, { igst: "100", cgst: "100", sgst: "0", cess: "0" });
    expect(u.remaining).toEqual({ igst: "0.00", cgst: "0.00", sgst: "0.00", cess: "0.00" });
    expect(u.paidFromCredit).toEqual({ igst: "0.00", cgst: "100.00", sgst: "100.00", cess: "0.00" });
    // CGST credit never pays SGST.
    const v = utiliseCredit({ igst: "0", cgst: "0", sgst: "50", cess: "0" }, { igst: "0", cgst: "80", sgst: "0", cess: "0" });
    expect(v.remaining.sgst).toBe("50.00");
    expect(v.creditLeft.cgst).toBe("80.00");
  });
});

describe("exports and supplies to SEZ (zero-rated)", () => {
  const SEZ = "27AABCS1429B1ZB";
  const rows: GstRegisterRow[] = [
    // Export on payment of IGST, shipping bill known.
    row({ docNumber: "EXP/1", partyName: "Gulf Traders LLC", placeOfSupply: "96", supplyType: "inter_state", zeroRatedType: "EXPWP", shippingBill: { number: "7894561", date: "2026-09-12", portCode: "INMUN1" }, hsnCode: "1905", qty: "500", taxableValue: "50000", gstRate: "18", igst: "9000", documentValue: "59000" }),
    // Export under LUT: no tax, the rate kept; shipping bill not yet in.
    row({ docNumber: "EXP/2", placeOfSupply: "96", supplyType: "inter_state", zeroRatedType: "EXPWOP", hsnCode: "1905", qty: "200", taxableValue: "20000", gstRate: "18", documentValue: "20000" }),
    // Supplies to an SEZ unit (in Maharashtra), with and without payment.
    row({ docNumber: "INV/9", partyGstin: SEZ, placeOfSupply: "27", supplyType: "inter_state", zeroRatedType: "SEZWP", hsnCode: "3402", qty: "10", taxableValue: "10000", gstRate: "18", igst: "1800", documentValue: "11800" }),
    row({ docNumber: "INV/10", partyGstin: SEZ, placeOfSupply: "27", supplyType: "inter_state", zeroRatedType: "SEZWOP", hsnCode: "3402", qty: "5", taxableValue: "5000", gstRate: "18", documentValue: "5000" }),
    // Notes on them carry the invoice's type.
    row({ docNumber: "CN/7", docType: "credit_note", originalDocNumber: "EXP/2", placeOfSupply: "96", supplyType: "inter_state", zeroRatedType: "EXPWOP", hsnCode: "1905", qty: "10", taxableValue: "1000", gstRate: "18", documentValue: "1000" }),
    row({ docNumber: "CN/8", docType: "credit_note", originalDocNumber: "INV/9", partyGstin: SEZ, placeOfSupply: "27", supplyType: "inter_state", zeroRatedType: "SEZWP", hsnCode: "3402", qty: "1", taxableValue: "1000", gstRate: "18", igst: "180", documentValue: "1180" }),
    // An ordinary local sale in the same month.
    row({ docNumber: "INV/11", hsnCode: "1905", qty: "10", taxableValue: "100", gstRate: "18", cgst: "9", sgst: "9", documentValue: "118" }),
  ];
  const result = buildGstr1({ gstin: "23AAGFG5678G1ZA", period: "2026-09", b2clThreshold: "100000", hsnMinDigits: 4, rows });
  const j = result.json as Record<string, any>;

  it("files exports in the EXP table, by with and without payment of IGST, with the shipping bill", () => {
    expect(j.exp).toEqual([
      { exp_typ: "WPAY", inv: [{ inum: "EXP/1", idt: "10-09-2026", val: 59000, sbpcode: "INMUN1", sbnum: "7894561", sbdt: "12-09-2026", itms: [{ txval: 50000, rt: 18, iamt: 9000, csamt: 0 }] }] },
      { exp_typ: "WOPAY", inv: [{ inum: "EXP/2", idt: "10-09-2026", val: 20000, itms: [{ txval: 20000, rt: 18, iamt: 0, csamt: 0 }] }] },
    ]);
    expect(j.b2cl).toBeUndefined();
    expect(j.b2cs).toEqual([{ sply_ty: "INTRA", pos: "23", typ: "OE", txval: 100, rt: 18, iamt: 0, camt: 9, samt: 9, csamt: 0 }]);
    expect(result.warnings).toContainEqual({ code: "SHIPPING_BILL_MISSING", docNumber: "EXP/2" });
  });

  it("files supplies to SEZ with B2B as SEWP / SEWOP, and the notes in CDNR / CDNUR by the invoice's type", () => {
    expect(j.b2b).toEqual([
      {
        ctin: SEZ,
        inv: [
          { inum: "INV/10", idt: "10-09-2026", val: 5000, pos: "27", rchrg: "N", inv_typ: "SEWOP", itms: [{ num: 1, itm_det: { txval: 5000, rt: 18, iamt: 0, camt: 0, samt: 0, csamt: 0 } }] },
          { inum: "INV/9", idt: "10-09-2026", val: 11800, pos: "27", rchrg: "N", inv_typ: "SEWP", itms: [{ num: 1, itm_det: { txval: 10000, rt: 18, iamt: 1800, camt: 0, samt: 0, csamt: 0 } }] },
        ],
      },
    ]);
    expect(j.cdnr[0].nt).toEqual([{ ntty: "C", nt_num: "CN/8", nt_dt: "10-09-2026", val: 1180, pos: "27", rchrg: "N", inv_typ: "SEWP", itms: [{ num: 1, itm_det: { txval: 1000, rt: 18, iamt: 180, camt: 0, samt: 0, csamt: 0 } }] }]);
    expect(j.cdnur).toEqual([{ typ: "EXPWOP", ntty: "C", nt_num: "CN/7", nt_dt: "10-09-2026", val: 1000, itms: [{ num: 1, itm_det: { txval: 1000, rt: 18, iamt: 0, csamt: 0 } }] }]);
  });

  it("puts exports in the B2C HSN table and SEZ in B2B, and sums the EXP section", () => {
    expect(j.hsn.hsn_b2b).toEqual([{ num: 1, hsn_sc: "3402", desc: "", uqc: "PCS", qty: 14, rt: 18, txval: 14000, iamt: 1620, camt: 0, samt: 0, csamt: 0 }]);
    expect(j.hsn.hsn_b2c.find((h: { hsn_sc: string; rt: number }) => h.hsn_sc === "1905" && h.rt === 18)).toMatchObject({ qty: 700, txval: 69100, iamt: 9000 });
    expect(result.summary.find((s) => s.section === "exp")).toEqual({ section: "exp", records: 2, value: "79000.00", taxable: "70000.00", igst: "9000.00", cgst: "0.00", sgst: "0.00", cess: "0.00" });
  });

  it("writes the offline tool's export sheet and names SEZ invoice types", () => {
    expect(gstr1Csv(result, "exp")).toEqual([
      ["Export Type", "Invoice Number", "Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
      ["WPAY", "EXP/1", "10-Sep-2026", "59000", "INMUN1", "7894561", "12-Sep-2026", "", "18", "50000", "0"],
      ["WOPAY", "EXP/2", "10-Sep-2026", "20000", "", "", "", "", "18", "20000", "0"],
    ]);
    expect(gstr1Csv(result, "b2b").slice(1).map((r) => r[8])).toEqual(["SEZ supplies without payment", "SEZ supplies with payment"]);
    expect(gstr1Csv(result, "cdnur")[1]!.slice(0, 5)).toEqual(["EXPWOP", "CN/7", "10-Sep-2026", "C", ""]);
  });

  it("shows exports and SEZ in GSTR-3B 3.1(b), with the IGST paid on them due, and not in 3.2", () => {
    const r3b = buildGstr3b("2026-09", rows);
    expect(r3b.outward.zeroRated).toEqual({ taxable: "83000.00", igst: "10620.00", cgst: "0.00", sgst: "0.00", cess: "0.00" });
    expect(r3b.outward.taxable).toEqual({ taxable: "100.00", igst: "0.00", cgst: "9.00", sgst: "9.00", cess: "0.00" });
    expect(r3b.interStateUnregistered).toEqual([]);
    expect(r3b.payment.liability).toEqual({ igst: "10620.00", cgst: "9.00", sgst: "9.00", cess: "0.00" });
  });
});
