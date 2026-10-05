import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

const SHARMA = "23AAAFS1111K1ZR";
const MEHTA = "27AAAFM2222L1ZH";
const KAPOOR = "23AAAFK3333M1ZJ";

/** GSTR-2B matching: the portal's statement against the purchase bills entered. */
describe.skipIf(!hasDatabase)("GSTR-2B matching", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const file = {
    data: {
      gstin: "23AAACD1234E1Z5",
      rtnprd: "092026",
      docdata: {
        b2b: [
          {
            ctin: SHARMA,
            trdnm: "Sharma Agencies",
            inv: [
              { inum: "SA/0012", dt: "05-09-2026", val: 1180, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0, itcavl: "Y", rev: "N" },
              { inum: "SA-15", dt: "12-09-2026", val: 590, txval: 500, igst: 0, cgst: 45, sgst: 45, cess: 0, itcavl: "Y", rev: "N" },
            ],
          },
          { ctin: MEHTA, trdnm: "Mehta Traders", inv: [{ inum: "MT-77", dt: "20-09-2026", val: 2360, txval: 2000, igst: 360, cgst: 0, sgst: 0, cess: 0, itcavl: "Y", rev: "N" }] },
        ],
      },
    },
  };

  beforeAll(async () => {
    t = await createTestApp();
    t.setToday("2026-10-05");
    owner = await signup(t, { legalName: "Match Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100" })).body.id;
    ids.sharma = (await post("/suppliers", { name: "Sharma Agencies", stateCode: "23", gstin: SHARMA })).body.id;
    ids.mehta = (await post("/suppliers", { name: "Mehta Traders", stateCode: "27", gstin: MEHTA })).body.id;
    ids.kapoor = (await post("/suppliers", { name: "Kapoor & Sons", stateCode: "23", gstin: KAPOOR })).body.id;
    const buy = async (supplierId: string, number: string, date: string, qty: string, rate: string) => {
      const res = await post("/purchases", { supplierId, supplierInvoiceNumber: number, supplierInvoiceDate: date, lines: [{ productId: ids.soap, qty, rate }] });
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    };
    await buy(ids.sharma!, "sa-12", "2026-09-05", "10", "100"); // matches SA/0012
    await buy(ids.sharma!, "SA/15", "2026-09-12", "4", "100"); // typed as 400, the portal says 500
    await buy(ids.kapoor!, "K-9", "2026-09-25", "1", "300"); // not on the portal
  });
  afterAll(async () => {
    t?.setToday(null);
    await t?.close();
  });

  it("matches the statement with the purchase bills and says what to do about the rest", async () => {
    const res = await post("/gst/gstr2b/match", file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ period: "2026-09", otherGstin: false });
    expect(res.body.rows.map((r: { status: string; number: string }) => [r.status, r.number])).toEqual([
      ["mismatch", "SA-15"],
      ["not_in_books", "MT-77"],
      ["not_in_2b", "K-9"],
      ["matched", "SA/0012"],
    ]);
    expect(res.body.rows[0]).toMatchObject({ taxDifference: 18 });
    expect(res.body.summary).toEqual({ matched: 1, mismatch: 1, notInBooks: 1, notIn2b: 1, itc2b: 630, itcBooks: 306, itcAtRisk: 54, itcNotEntered: 360 });
    // A bill not entered, from a supplier in the list: the purchase can be opened for them.
    expect(res.body.suppliers).toEqual({ [MEHTA]: ids.mehta });
  });

  it("says when the file is not a GSTR-2B statement", async () => {
    const res = await post("/gst/gstr2b/match", { hello: "world" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("GSTR2B_NOT_RECOGNISED");
  });

  it("sees only this business's bills", async () => {
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    const res = await post("/gst/gstr2b/match", file, other.token);
    expect(res.body.summary).toMatchObject({ matched: 0, notInBooks: 3, notIn2b: 0, itcBooks: 0 });
  });
});
