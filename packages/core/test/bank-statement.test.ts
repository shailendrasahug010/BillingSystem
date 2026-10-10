import { describe, expect, it } from "vitest";
import { classifyStatementLine, matchStatementLine, readBankStatement, statementDate, statementLineKey, type StatementParty } from "../src/index.js";

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
      { row: 1, date: "2026-10-03", narration: "UPI-GUPTA STORES-gupta.stores@okhdfcbank-HDFC0000123-412345678901-PAYMENT", reference: "0000412345678901", amount: 5250, balance: 105250 },
      { row: 2, date: "2026-10-04", narration: "NEFT DR-PARLE AGRO-N123456", reference: "N123456", amount: -25000, balance: 80250 },
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

  it("reads the bank's balance after each line, overdrawn when it says Dr, and leaves it out when there is none", () => {
    const read = readBankStatement([
      ["Date", "Particulars", "Debit", "Credit", "Opening Balance", "Balance"],
      ["01/10/2026", "CHQ PAID-SELF", "8,000.00", "", "", "2,000.00 Dr"],
      ["02/10/2026", "CASH DEPOSIT", "", "10,000.00", "", "8,000.00 Cr"],
    ])!;
    expect(read.lines.map((l) => l.balance)).toEqual([-2000, 8000]);
    expect(readBankStatement([["Date", "Narration", "Amount"], ["01/10/2026", "UPI", "5"]])!.lines[0]).not.toHaveProperty("balance");
  });

  it("knows the bank's own lines: interest, charges, cash in and out", () => {
    const kind = (narration: string, amount: number) => classifyStatementLine({ narration, amount });
    expect(kind("INT.PD:01-07-2026 TO 30-09-2026", 412.5)).toBe("interest");
    expect(kind("SB INTEREST CREDIT", 88)).toBe("interest");
    expect(kind("OD INT DR SEP-26", -2210)).toBe("interest");
    expect(kind("SMS ALERT CHARGES JUL-SEP", -17.7)).toBe("bank_charge");
    expect(kind("GST ON CHGS", -3.19)).toBe("bank_charge");
    expect(kind("MIN BAL NON MAINT CHGS", -590)).toBe("bank_charge");
    expect(kind("CASH DEPOSIT BY SELF", 1200)).toBe("cash_deposit");
    expect(kind("BY CASH-INDORE MAIN", 50000)).toBe("cash_deposit");
    expect(kind("ATM WDL/HDFC ATM/INDORE", -10000)).toBe("cash_withdrawal");
    expect(kind("CHQ PAID-SELF", -8000)).toBe("cash_withdrawal");
    expect(kind("NEFT DR-HUL DISTRIBUTOR-N260123456", -5000)).toBeNull();
    expect(kind("UPI/CR/412345678901/GUPTA STORES", 5250)).toBeNull();
    expect(kind("NEFT CR-BEST COMMUNICATIONS", 900)).toBeNull();
  });

  it("gives a line the same key however the bank's file wrote it", () => {
    const a = statementLineKey({ date: "2026-10-03", amount: 5250, reference: "0000412345678901", narration: "UPI-GUPTA STORES-412345678901" });
    const b = statementLineKey({ date: "2026-10-03", amount: 5250.0, reference: "412345678901", narration: "UPI - GUPTA  STORES - 412345678901" });
    expect(a).toBe(b);
    expect(statementLineKey({ date: "2026-10-03", amount: -5250, reference: "", narration: "UPI-GUPTA STORES-412345678901" })).not.toBe(a);
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

  it("matches a customer by the number of an open bill in the narration, but not inside a longer number", () => {
    const withBills: StatementParty[] = [...parties, { id: "c4", kind: "customer", name: "Anand Medical", balance: 4720, openBills: [4720], billNumbers: ["INV/2026/00042", "INV/2026/00043"] }];
    expect(matchStatementLine(line("UPI/CR/412345678903/PAYMENT FOR INV 2026 00042/ANAND", 4720), withBills, [])).toEqual({
      status: "matched",
      partyId: "c4",
      reasons: ["bill_number", "name", "bill"],
      billNumber: "INV/2026/00042",
    });
    expect(matchStatementLine(line("NEFT CR-INV202600043-RAJU", 100), withBills, [])).toMatchObject({ status: "matched", partyId: "c4", billNumber: "INV/2026/00043" });
    expect(matchStatementLine(line("NEFT CR-REF INV2026000421", 100), withBills, [])).toEqual({ status: "unmatched", partyId: null, reasons: [] });
  });

  it("marks a line already in the books by its reference, or the same amount within three days", () => {
    const recorded = [{ partyId: "c1", direction: "in" as const, date: "2026-10-01", amount: 5250, reference: "412345678901" }];
    expect(matchStatementLine(line("UPI-GUPTA", 5250, "412345678901"), parties, recorded)).toEqual({ status: "recorded", partyId: "c1", reasons: ["reference"] });
    expect(matchStatementLine(line("UPI-GUPTA", 5250), parties, [{ ...recorded[0]!, reference: null, date: "2026-10-03" }])).toMatchObject({ status: "recorded" });
    expect(matchStatementLine(line("UPI-GUPTA", 5250), parties, [{ ...recorded[0]!, reference: null, date: "2026-09-25" }])).toMatchObject({ status: "matched" });
  });
});
