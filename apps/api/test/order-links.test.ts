import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

/** Order links: a shop opens its own link with no sign-in, sees its rates and places an order that waits to be confirmed. */
describe.skipIf(!hasDatabase)("order links", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const post = (url: string, body?: unknown, token: string | undefined = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token: string | undefined = owner.token) => call(t.app, "GET", url, { token });
  const shop = (key: string) => ({
    page: () => call(t.app, "GET", `/shop/${key}`, {}),
    quote: (body: unknown) => call(t.app, "POST", `/shop/${key}/quote`, { body }),
    order: (body: unknown, headers: Record<string, string> = {}) => call(t.app, "POST", `/shop/${key}/orders`, { body, headers }),
  });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Link Traders", stateCode: "23" });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.box = units.BOX;
    ids.soap = (
      await post("/products", {
        name: "Bath Soap",
        taxCategoryId: taxes["GST 18%"],
        baseUnitId: units.PCS,
        sellingPrice: "100",
        units: [{ unitId: units.BOX, conversionFactor: "12" }],
        openingStock: "500",
        openingStockCost: "70",
      })
    ).body.id;
    ids.oil = (await post("/products", { name: "Hair Oil", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "50" })).body.id;
    ids.shop = (await post("/customers", { name: "Gupta Kirana", stateCode: "23" })).body.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is made per shop, can be copied again, and a new one replaces it", async () => {
    expect((await get(`/customers/${ids.shop}/order-link`)).body).toEqual({ key: null });
    const first = await post(`/customers/${ids.shop}/order-link`);
    expect(first.status).toBe(201);
    expect(first.body.key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await get(`/customers/${ids.shop}/order-link`)).body.key).toBe(first.body.key);
    const second = await post(`/customers/${ids.shop}/order-link`);
    expect(second.body.key).not.toBe(first.body.key);
    expect((await shop(first.body.key).page()).body.error.code).toBe("ORDER_LINK_OFF");
    ids.key = second.body.key;
  });

  it("opens with no sign-in, with the shop's own rates per pack", async () => {
    const page = await shop(ids.key!).page();
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ business: { name: "Link Traders" }, customer: { name: "Gupta Kirana" }, orders: [] });
    const soap = page.body.products.find((p: { id: string }) => p.id === ids.soap);
    expect(soap).toMatchObject({ name: "Bath Soap", gstRate: "18.00", inStock: true });
    expect(soap.units.map((u: { symbol: string; rate: string }) => [u.symbol, u.rate])).toEqual([
      ["PCS", "100.00"],
      ["BOX", "1200.00"],
    ]);
    expect(page.body.products.find((p: { id: string }) => p.id === ids.oil).inStock).toBe(false);
    // Nothing of the business's own: no costs, no other customers.
    expect(JSON.stringify(page.body)).not.toMatch(/purchasePrice|avgCost/);
  });

  it("prices an order like a bill, then places it waiting to be confirmed, once", async () => {
    const lines = [
      { productId: ids.soap, unitId: ids.box, qty: "1" },
      { productId: ids.oil, qty: "2" },
    ];
    const quote = await shop(ids.key!).quote({ lines });
    expect(quote.status).toBe(200);
    expect(quote.body.grandTotal).toBe("1534.00"); // (1200 + 100) + 18% GST
    const key = "01a10b10-0000-7000-8000-000000000001";
    const placed = await shop(ids.key!).order({ lines, notes: "Deliver by Friday" }, { "idempotency-key": key });
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ status: "pending", grandTotal: "1534.00" });
    const again = await shop(ids.key!).order({ lines, notes: "Deliver by Friday" }, { "idempotency-key": key });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(placed.body.id);
    const order = (await get(`/sales-orders/${placed.body.id}`)).body;
    expect(order).toMatchObject({ source: "link", status: "pending", notes: "Deliver by Friday", customer: { id: ids.shop } });
    expect(order.items.map((i: { qty: string; rate: string }) => [i.qty, i.rate])).toEqual([
      ["1.000", "1200.0000"],
      ["2.000", "50.0000"],
    ]);
    // The shop sees its order and where it stands.
    expect((await shop(ids.key!).page()).body.orders).toEqual([expect.objectContaining({ id: placed.body.id, status: "pending" })]);
    expect((await get(`/customers/${ids.shop}/order-link`)).body.ordersPlaced).toBe(1);
  });

  it("takes no rates or other shops from the page", async () => {
    expect((await shop(ids.key!).order({ lines: [{ productId: ids.soap, qty: "1", rate: "1" }] })).status).toBe(400);
    expect((await shop(ids.key!).order({ customerId: ids.shop, lines: [{ productId: ids.soap, qty: "1" }] })).status).toBe(400);
    expect((await shop(ids.key!).order({ lines: [{ productId: ids.soap, qty: "0" }] })).status).toBe(400);
    expect((await call(t.app, "GET", "/shop/not-a-key", {})).status).toBe(400);
  });

  it("shows the shop its own bills, what it owes, its statement and where to pay, when the link does", async () => {
    // New links show it unless asked not to.
    expect((await get(`/customers/${ids.shop}/order-link`)).body.showsAccount).toBe(true);
    const payTo = { bankName: "", accountNumber: "", ifsc: "", upiId: "link.traders@okaxis" };
    expect((await call(t.app, "PUT", "/settings/invoice.payment_details", { token: owner.token, body: { value: payTo } })).status).toBe(200);
    const bill = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "2" }] });
    expect(bill.status).toBe(201);
    expect((await post("/payments", { direction: "in", customerId: ids.shop, amount: "36", method: "cash" })).status).toBe(201);

    const account = (await shop(ids.key!).page()).body.account;
    // 2 soaps at 100 with 18% GST: 236, less 36 paid.
    expect(account).toMatchObject({ balance: "200.00", overdue: "0.00", upi: { id: "link.traders@okaxis", name: "Link Traders" } });
    expect(account.bills).toEqual([expect.objectContaining({ id: bill.body.id, number: bill.body.invoiceNumber, total: "236.00", due: "200.00", overdue: false })]);
    expect(account.payments).toEqual([expect.objectContaining({ amount: "36.00", method: "cash" })]);

    const pdf = (path: string) => t.app.inject({ method: "GET", url: `/api/v1/shop/${ids.key}${path}` });
    const statement = await pdf("/statement/pdf");
    expect(statement.statusCode).toBe(200);
    expect(statement.headers["content-type"]).toBe("application/pdf");
    expect((await pdf(`/invoices/${bill.body.id}/pdf`)).statusCode).toBe(200);
    // Another shop's bill is not given out.
    const verma = (await post("/customers", { name: "Verma Stores", stateCode: "23" })).body.id;
    const theirs = await post("/invoices", { customerId: verma, lines: [{ productId: ids.soap, qty: "1" }] });
    expect((await pdf(`/invoices/${theirs.body.id}/pdf`)).statusCode).toBe(404);

    // Not shown any more: none of it.
    const off = await call(t.app, "PATCH", `/customers/${ids.shop}/order-link`, { token: owner.token, body: { showsAccount: false } });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ key: ids.key, showsAccount: false });
    expect((await shop(ids.key!).page()).body.account).toBeNull();
    expect((await pdf("/statement/pdf")).statusCode).toBe(404);
    expect((await pdf(`/invoices/${bill.body.id}/pdf`)).statusCode).toBe(404);
    // A link made without it.
    const plain = await post(`/customers/${verma}/order-link`, { showsAccount: false });
    expect(plain.body.showsAccount).toBe(false);
    expect((await shop(plain.body.key).page()).body.account).toBeNull();
  });

  it("stops opening when turned off, or when the shop is made inactive", async () => {
    expect((await call(t.app, "DELETE", `/customers/${ids.shop}/order-link`, { token: owner.token })).status).toBe(204);
    expect((await shop(ids.key!).page()).status).toBe(410);
    const fresh = (await post(`/customers/${ids.shop}/order-link`)).body.key as string;
    expect((await shop(fresh).page()).status).toBe(200);
    expect((await call(t.app, "PATCH", `/customers/${ids.shop}`, { token: owner.token, body: { isActive: false } })).status).toBe(200);
    expect((await shop(fresh).page()).body.error.code).toBe("ORDER_LINK_OFF");
    // Another business cannot see or change this shop's link.
    const other = await signup(t, { legalName: "Other Traders", stateCode: "23" });
    expect((await post(`/customers/${ids.shop}/order-link`, undefined, other.token)).status).toBe(404);
  });
});
