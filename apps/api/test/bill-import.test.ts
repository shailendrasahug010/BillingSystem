import { gstinCheckChar } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

describe.skipIf(!hasDatabase)("importing a supplier's bill file", () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let salesToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const match = (body: unknown, token = owner.token) => post("/purchases/import/match", body, token);
  const SUPPLIER_GSTIN = gstin("23", "AAACG4321K");

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Import Traders", stateCode: "23" });
    other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Sales Sam", mobile, roleId: roles.sales });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    salesToken = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;

    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.PCS = units.PCS;
    ids.BOX = units.BOX;
    const product = async (body: Record<string, unknown>, session = owner) =>
      (await post("/products", { taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "10", ...body }, session.token)).body.id as string;
    ids.surf = await product({ name: "Surf Excel 1 kg", code: "SURF1", units: [{ unitId: units.BOX, conversionFactor: "12", isDefaultPurchase: true }] });
    ids.parle = await product({ name: "Parle-G 100g", barcodes: ["8901719101045"] });
    ids.salt = await product({ name: "Tata Salt 1kg", aliases: ["namak"] });
    ids.soap = await product({ name: "Lux Soap 100g", code: "1001" });
    ids.dettol = await product({ name: "Dettol Soap 75g" });
    ids.dettol2 = await product({ name: "Dettol Soap 125g" });
    ids.supplier = (await post("/suppliers", { name: "Ganesh Agencies", stateCode: "23", gstin: SUPPLIER_GSTIN })).body.id;
    ids.otherSupplier = (await post("/suppliers", { name: "Ganesh Agencies", stateCode: "23", gstin: SUPPLIER_GSTIN }, other.token)).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("finds the supplier by GSTIN or name and matches lines by barcode, code, name and alias", async () => {
    const res = await match({
      supplierGstin: SUPPLIER_GSTIN.toLowerCase(),
      supplierName: "Someone Else",
      billNumber: "GA/77",
      lines: [
        { itemName: "PARLE G BISCUIT", barcode: "8901719101045" },
        { itemName: "SURF EXCEL 1KG POUCH", itemCode: "surf1" },
        { itemName: "surf excel - 1 KG" },
        { itemName: "NAMAK" },
        // Their code 1001 is our Lux soap's code, but the names disagree: not matched on code alone.
        { itemName: "Vim Bar 200g", itemCode: "1001" },
        { itemName: "Dettol Soap" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({ id: ids.supplier, matchedBy: "gstin" });
    expect(res.body.duplicate).toBeNull();
    expect(res.body.lines.map((l: { productId: string | null; matchedBy: string | null }) => [l.productId, l.matchedBy])).toEqual([
      [ids.parle, "barcode"],
      [ids.surf, "code"],
      [ids.surf, "name"],
      [ids.salt, "name"],
      [null, null],
      [null, null],
    ]);
    // Close names are offered to pick from.
    expect(res.body.lines[5].candidates.map((c: { productId: string }) => c.productId).sort()).toEqual([ids.dettol, ids.dettol2].sort());

    const byName = (await match({ supplierName: "GANESH  AGENCIES", lines: [{ itemName: "x" }] })).body;
    expect(byName.supplier).toMatchObject({ id: ids.supplier, matchedBy: "name" });
    const similar = (await match({ supplierName: "Ganesh Agency", lines: [{ itemName: "x" }] })).body;
    expect(similar.supplier).toBeNull();
    expect(similar.supplierCandidates.map((s: { id: string }) => s.id)).toEqual([ids.supplier]);
  });

  it("remembers the supplier's item names once the bill is saved, and flags the same bill again", async () => {
    const saved = await post("/purchases", {
      supplierId: ids.supplier,
      supplierInvoiceNumber: "GA/77",
      supplierInvoiceDate: "2026-09-20",
      lines: [
        { productId: ids.soap, qty: "2", rate: "25", supplierItem: { code: "VB-200", name: "VIM BAR 200G" } },
        { productId: ids.surf, unitId: ids.BOX, qty: "1", rate: "1380", supplierItem: { name: "SURF EXCEL EASY WASH" } },
      ],
    });
    expect(saved.status).toBe(201);
    const rows = (await t.owner.query("select item_key, product_id, unit_id, last_rate from supplier_items where supplier_id = $1 order by item_key", [ids.supplier])).rows;
    expect(rows).toEqual([
      { item_key: "c:VB200", product_id: ids.soap, unit_id: null, last_rate: "25.0000" },
      { item_key: "n:surfexceleasywash", product_id: ids.surf, unit_id: ids.BOX, last_rate: "1380.0000" },
      { item_key: "n:vimbar200g", product_id: ids.soap, unit_id: null, last_rate: "25.0000" },
    ]);

    const again = (
      await match({
        supplierId: ids.supplier,
        billNumber: "ga/77",
        lines: [{ itemName: "Vim bar 200 g" }, { itemName: "Anything", itemCode: "vb-200" }, { itemName: "Surf Excel Easy-Wash" }],
      })
    ).body;
    expect(again.duplicate).toMatchObject({ id: saved.body.id });
    expect(again.lines.map((l: { productId: string; matchedBy: string; unitId: string | null }) => [l.productId, l.matchedBy, l.unitId])).toEqual([
      [ids.soap, "supplier_item", null],
      [ids.soap, "supplier_item", null],
      [ids.surf, "supplier_item", ids.BOX],
    ]);

    // Another business with a supplier of the same name learns nothing from this one.
    const theirs = (await match({ supplierId: ids.otherSupplier, lines: [{ itemName: "VIM BAR 200G" }] }, other.token)).body;
    expect(theirs.lines[0]).toMatchObject({ productId: null, matchedBy: null });
    expect(theirs.supplier).toMatchObject({ id: ids.otherSupplier });
  });

  it("needs purchase rights and a valid file", async () => {
    expect((await match({ lines: [{ itemName: "x" }] }, salesToken)).status).toBe(403);
    expect((await match({ lines: [] })).status).toBe(400);
    expect((await match({ supplierId: ids.otherSupplier, lines: [{ itemName: "x" }] })).body.supplier).toBeNull();
  });
});
