import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("bank statement matching", () => {
  let t: TestApp;
  let owner: Session;
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const ids: Record<string, string> = {};
  let bill = { invoiceNumber: "", grandTotal: "" };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Bank Traders", stateCode: "23" });
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const product = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.gupta = (await post("/customers", { name: "Gupta Stores", mobile: "9826011111", stateCode: "23" })).body.id;
    ids.verma = (await post("/customers", { name: "Verma Kirana", stateCode: "23" })).body.id;
    ids.parle = (await post("/suppliers", { name: "Parle Agro", stateCode: "23", gstin: "23AAACM1234M1ZR", upiId: "parleagro@icici" })).body.id;
    bill = (await post("/invoices", { customerId: ids.gupta, lines: [{ productId: product, qty: "10" }] })).body;
    await post("/payments", { direction: "in", customerId: ids.verma, amount: "300", method: "upi", referenceNumber: "412345678909" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("matches money in to customers, money out to suppliers, and spots what is already recorded", async () => {
    const today = (await get("/payments")).body.data[0].paymentDate;
    const res = await post("/bank-statement/match", {
      lines: [
        { row: 1, date: today, narration: "UPI/CR/412345678901/RAMESH/SBIN/9826011111@ybl", reference: "412345678901", amount: Number(bill.grandTotal) },
        { row: 2, date: today, narration: "UPI/CR/412345678909/VERMA/SBIN", reference: "412345678909", amount: 300 },
        { row: 3, date: today, narration: "UPI/DR/412345678910/parleagro@icici", reference: "412345678910", amount: -5000 },
        { row: 4, date: today, narration: "CASH DEPOSIT", reference: "", amount: 77 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([
      { row: 1, status: "matched", partyId: ids.gupta, partyName: "Gupta Stores", partyKind: "customer", reasons: ["mobile", "bill"] },
      { row: 2, status: "recorded", partyId: ids.verma, partyName: "Verma Kirana", partyKind: "customer", reasons: ["reference"] },
      { row: 3, status: "matched", partyId: ids.parle, partyName: "Parle Agro", partyKind: "supplier", reasons: ["upi"] },
      { row: 4, status: "unmatched", partyId: null, partyName: null, partyKind: null, reasons: [] },
    ]);
  });

  it("refuses an empty statement and lines without an amount", async () => {
    expect((await post("/bank-statement/match", { lines: [] })).status).toBe(400);
    expect((await post("/bank-statement/match", { lines: [{ row: 1, date: "2026-10-05", narration: "", reference: "", amount: 0 }] })).status).toBe(400);
  });
});
