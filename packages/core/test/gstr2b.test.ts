import { describe, expect, it } from "vitest";
import { billNumberKey, match2b, parseGstr2b, type BookBill } from "../src/index.js";

const file = {
  chksum: "x",
  data: {
    gstin: "23aaacd1234e1z5",
    rtnprd: "092026",
    docdata: {
      b2b: [
        {
          ctin: "23AAAFS1111K1Z1",
          trdnm: "Sharma Agencies",
          inv: [
            { inum: "SA/0012", dt: "05-09-2026", val: 1180, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0, itcavl: "Y", rev: "N" },
            // Only items (an older file): summed.
            { inum: "SA-15", dt: "12-09-2026", val: 590, itcavl: "Y", rev: "N", items: [{ num: 1, rt: 18, txval: 500, igst: 0, cgst: 45, sgst: 45, cess: 0 }] },
          ],
        },
        { ctin: "27AAAFM2222L1Z2", trdnm: "Mehta Traders", inv: [{ inum: "MT-77", dt: "20-09-2026", val: 2360, txval: 2000, igst: 360, cgst: 0, sgst: 0, cess: 0, itcavl: "N", rev: "N" }] },
      ],
      cdnr: [{ ctin: "23AAAFS1111K1Z1", nt: [{ ntnum: "CN1" }, { ntnum: "CN2" }] }],
    },
  },
};

const bill = (b: Partial<BookBill> & Pick<BookBill, "id" | "supplierGstin" | "number" | "date">): BookBill => ({ supplierName: "Supplier", value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, ...b });

describe("GSTR-2B", () => {
  it("reads the portal's JSON, with invoice totals or only items", () => {
    const p = parseGstr2b(file);
    expect(p).toMatchObject({ gstin: "23AAACD1234E1Z5", period: "2026-09", notes: 2 });
    expect(p.invoices).toHaveLength(3);
    expect(p.invoices[1]).toMatchObject({ number: "SA-15", date: "2026-09-12", taxable: 500, cgst: 45, sgst: 45 });
    expect(p.invoices[2]).toMatchObject({ supplierName: "Mehta Traders", igst: 360, itcAvailable: false });
    expect(parseGstr2b(file.data).invoices).toHaveLength(3);
    expect(() => parseGstr2b({ hello: 1 })).toThrow("GSTR2B_NOT_RECOGNISED");
  });

  it("knows a bill number however it was typed", () => {
    expect(billNumberKey("SA/0012")).toBe(billNumberKey("sa-12"));
    expect(billNumberKey("INV 2026/001")).toBe("INV20261");
    expect(billNumberKey("A-12")).not.toBe(billNumberKey("A-120"));
  });

  it("matches by supplier and number, and says what differs or is missing", () => {
    const books = [
      bill({ id: "b1", supplierGstin: "23AAAFS1111K1Z1", number: "sa-12", date: "2026-09-05", taxable: 1000, cgst: 90, sgst: 90 }),
      // Tax typed wrong.
      bill({ id: "b2", supplierGstin: "23AAAFS1111K1Z1", number: "SA/15", date: "2026-09-13", taxable: 500, cgst: 40, sgst: 40 }),
      // Not on the portal.
      bill({ id: "b3", supplierGstin: "23AAAFK3333M1Z3", number: "K-9", date: "2026-09-25", taxable: 300, cgst: 7.5, sgst: 7.5 }),
      // Last month's, not on this statement: not listed as missing this month.
      bill({ id: "b4", supplierGstin: "23AAAFK3333M1Z3", number: "K-8", date: "2026-08-25", taxable: 100, cgst: 2.5, sgst: 2.5 }),
    ];
    const { rows, summary } = match2b(parseGstr2b(file), books, "2026-09");
    expect(rows.map((r) => [r.status, r.number])).toEqual([
      ["mismatch", "SA-15"],
      ["not_in_books", "MT-77"],
      ["not_in_2b", "K-9"],
      ["matched", "SA/0012"],
    ]);
    expect(rows[0]).toMatchObject({ taxDifference: 10, dateDiffers: true });
    expect(summary).toEqual({ matched: 1, mismatch: 1, notInBooks: 1, notIn2b: 1, itc2b: 270, itcBooks: 275, itcAtRisk: 15, itcNotEntered: 0 });
  });

  it("calls amounts within a rupee the same", () => {
    const p = parseGstr2b(file);
    const books = [bill({ id: "b1", supplierGstin: "23AAAFS1111K1Z1", number: "SA/0012", date: "2026-09-05", taxable: 1000.4, cgst: 90.3, sgst: 90.3 })];
    expect(match2b(p, books, "2026-09").rows.find((r) => r.number === "SA/0012")?.status).toBe("matched");
  });
});
