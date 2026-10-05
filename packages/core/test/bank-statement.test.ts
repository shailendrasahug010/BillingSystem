import { describe, expect, it } from "vitest";
import { matchStatementLine, readBankStatement, statementDate, type StatementParty } from "../src/index.js";

describe("bank statements", () => {
  it("reads an HDFC-style statement: the header found under the bank's preamble, money in and out", () => {
    const read = readBankStatement([
      ["HDFC BANK Ltd.", "", "", "", "", "", ""],
      ["Account No : 50100012345678"],
      ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
      ["03/10/26", "UPI-GUPTA STORES-gupta.stores@okhdfcbank-HDFC0000123-412345678901-PAYMENT", "0000412345678901", "03/10/26", "", "5,250.00", "1,05,250.00"],
      ["04/10/26", "NEFT DR-PARLE AGRO-N123456", "N123456", "04/10/26", "25,000.00", "", "80,250.00"],
      ["", "Closing balance", "", "", "", "", "80,250.00"],
    ])!;
    expect(read.skipped).toBe(1);
    expect(read.lines).toEqual([
      { row: 1, date: "2026-10-03", narration: "UPI-GUPTA STORES-gupta.stores@okhdfcbank-HDFC0000123-412345678901-PAYMENT", reference: "0000412345678901", amount: 5250 },
      { row: 2, date: "2026-10-04", narration: "NEFT DR-PARLE AGRO-N123456", reference: "N123456", amount: -25000 },
    ]);
  });

  it("reads a statement with one amount column and a Dr/Cr column, and dates with month names", () => {
    const read = readBankStatement([
      ["Txn Date", "Description", "Amount", "Dr/Cr", "Balance"],
      ["05-Oct-2026", "UPI/CR/412345678902/VERMA KIRANA/SBIN/9826022222@ybl", "1,180.00", "CR", "10,000.00"],
      ["05 Oct 2026", "ATM WDL", "500", "DR", "9,500.00"],
    ])!;
    expect(read.lines.map((l) => [l.date, l.amount, l.reference])).toEqual([
      ["2026-10-05", 1180, "412345678902"],
      ["2026-10-05", -500, ""],
    ]);
    expect(statementDate("2026-10-05 10:12")).toBe("2026-10-05");
    expect(statementDate("Opening")).toBe("");
  });

  it("says when a file is not a statement", () => {
    expect(readBankStatement([["Name", "Qty"], ["Parle-G", "10"]])).toBeNull();
  });

  const parties: StatementParty[] = [
    { id: "c1", kind: "customer", name: "Gupta Stores", mobiles: ["9826011111"], upiId: "gupta.stores@okhdfcbank", balance: 7000, openBills: [5250, 1750] },
    { id: "c2", kind: "customer", name: "Verma Kirana", aliases: ["Ramesh Verma"], mobiles: ["9826022222"], balance: 1180, openBills: [1180] },
    { id: "c3", kind: "customer", name: "Sharma General Store", balance: 999, openBills: [999] },
    { id: "s1", kind: "supplier", name: "Parle Agro Pvt Ltd", balance: 25000, openBills: [25000] },
  ];
  const line = (narration: string, amount: number, reference = "") => ({ row: 1, date: "2026-10-05", narration, reference, amount });

  it("matches money in by UPI id or mobile, and money out to a supplier by name and amount", () => {
    expect(matchStatementLine(line("UPI-GUPTA STORES-gupta.stores@okhdfcbank-412345678901", 5250), parties, [])).toEqual({ status: "matched", partyId: "c1", reasons: ["upi", "name", "bill"] });
    expect(matchStatementLine(line("UPI/CR/412345678902/RAMESH/SBIN/9826022222@ybl", 1180), parties, [])).toMatchObject({ status: "matched", partyId: "c2" });
    expect(matchStatementLine(line("NEFT DR-PARLE AGRO-N123456", -25000), parties, [])).toEqual({ status: "matched", partyId: "s1", reasons: ["name", "bill"] });
  });

  it("matches the whole of a longer name; calls part of a name, or an amount only one party has open, likely; nothing else unmatched", () => {
    expect(matchStatementLine(line("NEFT DR-PARLE AGRO-N123456", -2000), parties, [])).toEqual({ status: "matched", partyId: "s1", reasons: ["name"] });
    expect(matchStatementLine(line("IMPS/SHARMA/123", 300), parties, [])).toMatchObject({ status: "likely", partyId: "c3", reasons: ["name"] });
    expect(matchStatementLine(line("CASH DEPOSIT", 999), parties, [])).toEqual({ status: "likely", partyId: "c3", reasons: ["bill"] });
    expect(matchStatementLine(line("CASH DEPOSIT", 123), parties, [])).toEqual({ status: "unmatched", partyId: null, reasons: [] });
  });

  it("marks a line already in the books by its reference, or the same amount within three days", () => {
    const recorded = [{ partyId: "c1", direction: "in" as const, date: "2026-10-01", amount: 5250, reference: "412345678901" }];
    expect(matchStatementLine(line("UPI-GUPTA", 5250, "412345678901"), parties, recorded)).toEqual({ status: "recorded", partyId: "c1", reasons: ["reference"] });
    expect(matchStatementLine(line("UPI-GUPTA", 5250), parties, [{ ...recorded[0]!, reference: null, date: "2026-10-03" }])).toMatchObject({ status: "recorded" });
    expect(matchStatementLine(line("UPI-GUPTA", 5250), parties, [{ ...recorded[0]!, reference: null, date: "2026-09-25" }])).toMatchObject({ status: "matched" });
  });
});
