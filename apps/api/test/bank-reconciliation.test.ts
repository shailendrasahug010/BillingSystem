import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, TEST_TODAY, type Session, type TestApp } from "./helpers.js";

/**
 * Saved bank reconciliation: a statement imported for a bank account, lines
 * already in the books reconciled by themselves, the rest reconciled in bulk
 * (receipts, payments, bank charges, interest, cash in and out), an
 * overlapping statement adding nothing twice, undo and link, and the bank
 * reconciliation statement agreeing with the bank.
 */
describe.skipIf(!hasDatabase)("bank reconciliation", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token: string = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token: string = owner.token) => call(t.app, "GET", url, { token });
  const day = TEST_TODAY;
  const lines = [
    { row: 1, date: day, narration: "UPI-RAMESH GUPTA-9826011111@ybl-SBIN0001234-412345678901-PAYMENT", reference: "0000412345678901", amount: 1180, balance: 101180 },
    { row: 2, date: day, narration: "UPI-KHANNA-412345678902-PAYMENT", reference: "0000412345678902", amount: 650, balance: 101830 },
    { row: 3, date: day, narration: "CASH DEPOSIT BY SELF", reference: "", amount: 1200, balance: 103030 },
    { row: 4, date: day, narration: "NEFT DR-HUL DISTRIBUTOR-N260123456", reference: "N260123456", amount: -5000, balance: 98030 },
    { row: 5, date: day, narration: "SMS ALERT CHARGES JUL-SEP", reference: "", amount: -17.7, balance: 98012.3 },
    { row: 6, date: day, narration: "SB INT CREDIT", reference: "", amount: 88, balance: 98100.3 },
    { row: 7, date: day, narration: "ATM WDL/HDFC ATM/INDORE", reference: "", amount: -10000, balance: 88100.3 },
  ];
  const openLines = async () => (await get(`/bank-statement-lines?accountId=${ids.sbi}&status=open`)).body.data as Array<{ id: string; row: number; status: string; suggestion: { status: string; partyId: string | null; partyName: string | null; reasons: string[]; kind?: string | null; billNumber?: string | null } }>;
  const lineOf = async (row: number, status = "all") => ((await get(`/bank-statement-lines?accountId=${ids.sbi}&status=${status}`)).body.data as Array<{ id: string; row: number; status: string; kind: string | null; document: { type: string; id: string; number: string | null; label: string | null; madeFromLine: boolean } | null }>).find((l) => l.row === row)!;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Bansal Agencies", stateCode: "23" });
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const soap = (await post("/products", { name: "Lifebuoy 100g", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.gupta = (await post("/customers", { name: "Gupta Stores", mobile: "9826011111", stateCode: "23" })).body.id;
    ids.khanna = (await post("/customers", { name: "Khanna Kirana", stateCode: "23" })).body.id;
    ids.hul = (await post("/suppliers", { name: "HUL Distributor", stateCode: "23", gstin: "23AAACM1234M1ZR" })).body.id;
    const bill = await post("/invoices", { customerId: ids.gupta, lines: [{ productId: soap, qty: "10" }] });
    expect(bill.body.grandTotal).toBe("1180.00");
    ids.bill = bill.body.id;
    // Entered by hand before the statement came: a UPI receipt (no account given).
    ids.khannaUpi = (await post("/payments", { direction: "in", customerId: ids.khanna, amount: "650", method: "upi", referenceNumber: "412345678902" })).body.id;
    const sbi = await post("/payment-accounts", { name: "SBI current", type: "bank", bankName: "State Bank of India", accountNumberLast4: "4321", openingBalance: "100000" });
    expect(sbi.status).toBe(201);
    ids.sbi = sbi.body.id;
    ids.cash = (await get("/payment-accounts")).body.data.find((a: { type: string }) => a.type === "cash").id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("refuses the cash drawer as a statement's account", async () => {
    const res = await post("/bank-statements", { paymentAccountId: ids.cash, lines });
    expect(res.body.error.code).toBe("BANK_ACCOUNT_REQUIRED");
  });

  it("saves a statement, reconciles what the books have and suggests the rest", async () => {
    const res = await post("/bank-statements", { paymentAccountId: ids.sbi, fileName: "sbi-sep.csv", lines });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ added: 7, known: 0, reconciled: 1 });
    ids.statement = res.body.statementId;
    // Khanna's UPI receipt was in the books already: reconciled, and now of this account.
    const khanna = await lineOf(2);
    expect(khanna).toMatchObject({ status: "reconciled", kind: "receipt", document: { type: "payment", id: ids.khannaUpi, madeFromLine: false } });
    expect((await get(`/payments/${ids.khannaUpi}`)).body.paymentAccountId).toBe(ids.sbi);

    const open = await openLines();
    expect(open.map((l) => l.row).sort()).toEqual([1, 3, 4, 5, 6, 7]);
    const by = (row: number) => open.find((l) => l.row === row)!.suggestion;
    expect(by(1)).toMatchObject({ status: "matched", partyId: ids.gupta, partyName: "Gupta Stores", reasons: ["mobile", "name", "bill"] });
    expect(by(4)).toMatchObject({ status: "matched", partyId: ids.hul, partyName: "HUL Distributor" });
    expect([by(3).kind, by(5).kind, by(6).kind, by(7).kind]).toEqual(["cash_deposit", "bank_charge", "interest", "cash_withdrawal"]);

    const statements = (await get(`/bank-statements?accountId=${ids.sbi}`)).body.data;
    expect(statements).toEqual([expect.objectContaining({ id: ids.statement, fileName: "sbi-sep.csv", periodFrom: day, periodTo: day, closingBalance: "88100.30", linesAdded: 7, linesKnown: 0, open: 6, reconciled: 1, ignored: 0 })]);
  });

  it("adds nothing twice when the same lines come again", async () => {
    const again = await post("/bank-statements", { paymentAccountId: ids.sbi, fileName: "sbi-sep-again.csv", lines: [...lines].reverse().map((l, i) => ({ ...l, row: i + 1, narration: l.narration.replace(/-/g, " - ") })) });
    expect(again.body).toMatchObject({ added: 0, known: 7, reconciled: 0 });
    // The empty one is taken out again.
    expect((await call(t.app, "DELETE", `/bank-statements/${again.body.statementId}`, { token: owner.token })).status).toBe(204);
    expect((await openLines()).length).toBe(6);
  });

  it("reconciles in bulk: receipts, payments, charges, interest and cash; what does not fit is reported", async () => {
    const open = await openLines();
    const id = (row: number) => open.find((l) => l.row === row)!.id;
    const res = await post("/bank-statement-lines/reconcile", {
      actions: [
        { lineId: id(1), action: "receipt", customerId: ids.gupta },
        { lineId: id(4), action: "payment", supplierId: ids.hul },
        { lineId: id(5), action: "bank_charge" },
        { lineId: id(6), action: "interest" },
        { lineId: id(3), action: "cash_deposit" },
        { lineId: id(7), action: "receipt", customerId: ids.gupta },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(5);
    expect(res.body.results.find((r: { lineId: string }) => r.lineId === id(7))).toMatchObject({ ok: false, error: { code: "BANK_LINE_DIRECTION" } });
    expect((await post("/bank-statement-lines/reconcile", { actions: [{ lineId: id(7), action: "cash_withdrawal" }] })).body.done).toBe(1);
    expect((await post("/bank-statement-lines/reconcile", { actions: [{ lineId: id(7), action: "ignore" }] })).body.results[0].error.code).toBe("BANK_LINE_DONE");
    expect(await openLines()).toEqual([]);

    // Gupta's bill paid from the line, by UPI, into SBI, with the bank's reference.
    expect((await get(`/invoices/${ids.bill}`)).body).toMatchObject({ balanceDue: "0.00", paymentStatus: "paid" });
    const receipt = (await lineOf(1)).document!;
    expect(receipt).toMatchObject({ type: "payment", label: "Gupta Stores", madeFromLine: true });
    expect((await get(`/payments/${receipt.id}`)).body).toMatchObject({ method: "upi", amount: "1180.00", paymentAccountId: ids.sbi, referenceNumber: "0000412345678901" });
    // The supplier paid by bank transfer; bank charges an expense of their own category; interest a receipt from the bank.
    expect((await lineOf(4)).document).toMatchObject({ type: "payment", label: "HUL Distributor" });
    expect((await lineOf(5))).toMatchObject({ kind: "bank_charge", document: { type: "expense", label: "Bank charges" } });
    const interest = await lineOf(6);
    expect(interest).toMatchObject({ kind: "interest", document: { type: "payment", label: "Bank interest" } });
    expect((await get(`/payments/${interest.document!.id}`)).body).toMatchObject({ partyType: "other", party: { name: "Bank interest" }, amount: "88.00" });
    expect((await lineOf(3))).toMatchObject({ kind: "cash_deposit", document: { type: "transfer", label: "Cash → SBI current" } });
    expect((await lineOf(7))).toMatchObject({ kind: "cash_withdrawal", document: { type: "transfer", label: "SBI current → Cash" } });
  });

  it("shows cash moved to and from the bank in the cash book", async () => {
    const book = (await get(`/payments/cash-book?from=${day}&to=${day}&book=cash`)).body;
    const transfers = book.rows.filter((r: { kind: string }) => r.kind === "transfer");
    expect(transfers.map((r: { direction: string; amount: string }) => [r.direction, r.amount]).sort()).toEqual([
      ["in", "10000.00"],
      ["out", "1200.00"],
    ]);
    const bank = (await get(`/payments/cash-book?from=${day}&to=${day}&book=bank`)).body;
    expect(bank.rows.filter((r: { kind: string }) => r.kind === "transfer").map((r: { direction: string }) => r.direction).sort()).toEqual(["in", "out"]);
    const all = (await get(`/payments/cash-book?from=${day}&to=${day}&book=all`)).body;
    expect(all.rows.some((r: { kind: string }) => r.kind === "transfer")).toBe(false);
  });

  it("agrees with the bank, explaining a cheque the bank has not shown yet", async () => {
    // A cheque from Khanna paid into SBI that the statement does not have yet.
    await post("/payments", { direction: "in", customerId: ids.khanna, amount: "500", method: "cheque", referenceNumber: "000777", paymentAccountId: ids.sbi });
    const brs = (await get(`/bank-statements/brs?accountId=${ids.sbi}`)).body;
    expect(brs).toMatchObject({
      accountName: "SBI current",
      asOf: day,
      statementId: ids.statement,
      bankBalance: "88100.30",
      openingBalance: "100000.00",
      notInBooks: { credits: "0.00", debits: "0.00", count: 0 },
      notInBank: { receipts: "500.00", payments: "0.00", count: 1 },
      difference: "0.00",
    });
    // 1,00,000 + 650 + 1,180 + 88 + 1,200 + 500 − 5,000 − 17.70 − 10,000
    expect(brs.booksBalance).toBe("88600.30");
    expect(brs.notInBank.entries).toEqual([expect.objectContaining({ type: "payment", label: "Khanna Kirana", direction: "in", amount: "500.00", reference: "000777" })]);
  });

  it("undoes a line (what it made stays) and links it again to that entry", async () => {
    const deposit = await lineOf(3);
    expect((await post("/bank-statement-lines/reconcile", { actions: [{ lineId: deposit.id, action: "undo" }] })).body.done).toBe(1);
    expect((await lineOf(3)).status).toBe("open");
    // Still agrees: the bank's credit and the books' transfer explain each other.
    const brs = (await get(`/bank-statements/brs?accountId=${ids.sbi}`)).body;
    expect(brs).toMatchObject({ notInBooks: { credits: "1200.00", count: 1 }, notInBank: { receipts: "1700.00", count: 2 }, difference: "0.00" });
    const candidates = (await get(`/bank-statement-lines/${deposit.id}/candidates`)).body.data;
    expect(candidates).toEqual([expect.objectContaining({ type: "transfer", id: deposit.document!.id, amount: "1200.00", direction: "in" })]);
    const wrong = await post("/bank-statement-lines/reconcile", { actions: [{ lineId: deposit.id, action: "link", documentType: "payment", documentId: ids.khannaUpi }] });
    expect(wrong.body.results[0].error.code).toBe("BANK_LINK_NOT_FOUND");
    const linked = await post("/bank-statement-lines/reconcile", { actions: [{ lineId: deposit.id, action: "link", documentType: "transfer", documentId: deposit.document!.id }] });
    expect(linked.body.done).toBe(1);
    expect((await lineOf(3))).toMatchObject({ status: "reconciled", kind: "cash_deposit", document: { madeFromLine: false } });
  });

  it("finds lines by text or amount, and keeps them to the business", async () => {
    expect((await get(`/bank-statement-lines?accountId=${ids.sbi}&status=all&q=5,000`)).body.data.map((l: { row: number }) => l.row)).toEqual([4]);
    expect((await get(`/bank-statement-lines?accountId=${ids.sbi}&status=all&q=khanna`)).body.data.map((l: { row: number }) => l.row)).toEqual([2]);
    const other = await signup(t, { legalName: "Other Agencies", stateCode: "23" });
    expect((await get(`/bank-statement-lines?accountId=${ids.sbi}`, other.token)).status).toBe(404);
    expect((await get(`/bank-statements/brs?accountId=${ids.sbi}`, other.token)).status).toBe(404);
  });

  it("deletes a statement and its lines; what was recorded from them stays", async () => {
    const receipts = (await get(`/payments?customerId=${ids.gupta}`)).body.data.length;
    expect((await call(t.app, "DELETE", `/bank-statements/${ids.statement}`, { token: owner.token })).status).toBe(204);
    expect((await get(`/bank-statement-lines?accountId=${ids.sbi}&status=all`)).body.data).toEqual([]);
    expect((await get(`/payments?customerId=${ids.gupta}`)).body.data.length).toBe(receipts);
    // Imported again, the lines come back open: their entries are in the books, so they are reconciled by themselves.
    const again = await post("/bank-statements", { paymentAccountId: ids.sbi, lines });
    expect(again.body).toMatchObject({ added: 7, reconciled: 7 });
  });
});
