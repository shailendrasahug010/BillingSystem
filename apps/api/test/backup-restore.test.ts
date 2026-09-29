import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe.skipIf(!hasDatabase)("backup and restore", () => {
  let t: TestApp;
  let owner: Session;
  let backup: Buffer;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const raw = (method: "POST", url: string, token: string, payload: Buffer | object, headers: Record<string, string> = {}) =>
    t.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}`, ...(Buffer.isBuffer(payload) ? { "content-type": "application/octet-stream" } : {}), ...headers }, payload });
  /** The owner's own password goes along unless the test says otherwise (null: none). */
  const restore = (file: Buffer, opts: { dryRun?: boolean; passphrase?: string; token?: string; accountPassword?: string | null } = {}) => {
    const account = opts.accountPassword === undefined ? owner.password : opts.accountPassword;
    return raw("POST", `/backups/restore${opts.dryRun ? "?dryRun=true" : ""}`, opts.token ?? owner.token, file, {
      ...(opts.passphrase ? { "x-backup-passphrase": Buffer.from(opts.passphrase).toString("base64") } : {}),
      ...(account ? { "x-account-password": Buffer.from(account).toString("base64") } : {}),
    });
  };
  /** Opens an unprotected backup, lets the test change it, and packs it again. */
  const tamper = (file: Buffer, change: (doc: { tables: Record<string, Array<Record<string, unknown>>> }) => void) => {
    const doc = JSON.parse(gunzipSync(file.subarray(6)).toString());
    change(doc);
    return Buffer.concat([file.subarray(0, 6), gzipSync(Buffer.from(JSON.stringify(doc)))]);
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Laxmi Traders", stateCode: "23" });
    await call(t.app, "PATCH", "/business", { token: owner.token, body: { addressLine1: "12 Siyaganj Main Road", city: "Indore", email: "accounts@laxmitraders.in" } });
    await call(t.app, "PUT", "/business/logo", { token: owner.token, body: { image: PNG } });
    await call(t.app, "PUT", "/settings/invoice.terms", { token: owner.token, body: { value: "Goods once sold will not be taken back." } });
    await call(t.app, "PUT", "/messaging/settings", { token: owner.token, body: { whatsappProvider: "meta", whatsappPhoneNumberId: "1234567", whatsappSecret: "EAAG-secret-token" } });
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", nameLocal: "नहाने का साबुन", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "100", openingStock: "100", openingStockCost: "70" })).body.id;
    ids.salt = (await post("/products", { name: "Tata Salt 1kg", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "25", openingStock: "200", openingStockCost: "20" })).body.id;
    ids.shop = (await post("/customers", { name: "Sharma Kirana", mobile: "9826011111", stateCode: "23" })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Shree Ganesh Agencies", stateCode: "23", gstin: "23AAACM1234M1ZR" })).body.id;
    const bought = await post("/purchases", { supplierId: ids.supplier, supplierInvoiceNumber: "SG/1", supplierInvoiceDate: "2026-09-20", lines: [{ productId: ids.salt, qty: "50", rate: "20" }] });
    if (bought.status !== 201) throw new Error(JSON.stringify(bought.body));
    const inv = await post("/invoices", { customerId: ids.shop, lines: [{ productId: ids.soap, qty: "10" }, { productId: ids.salt, qty: "4" }], payment: { amount: "500", method: "upi" } });
    ids.invoice = inv.body.id;
    ids.invoiceNumber = inv.body.invoiceNumber;
    await post(`/invoices/${ids.invoice}/returns`, { lines: [{ lineId: inv.body.items[0].id, qty: "2" }] });
    await post("/payments", { direction: "in", customerId: ids.shop, amount: "300", method: "cash" });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("downloads the whole firm as one file and lists it", async () => {
    const res = await raw("POST", "/backups/download", owner.token, {});
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="digital-bahi-laxmi-traders-\d{4}-\d{2}-\d{2}\.dbbackup"$/);
    backup = res.rawPayload;
    expect(backup.subarray(0, 4).toString()).toBe("DBBK");
    const doc = JSON.parse(gunzipSync(backup.subarray(6)).toString());
    expect(doc.counts).toMatchObject({ invoices: 1, invoice_items: 2, customers: 1, credit_debit_notes: 1, payments: 2, purchases: 1, files: 1 });
    expect(doc.counts.audit_logs).toBeGreaterThan(5);
    // Secrets and sign-in data stay out.
    expect(JSON.stringify(doc)).not.toContain("secret-token");
    expect(doc.tables.refresh_tokens).toBeUndefined();
    expect(doc.tables.business_members).toBeUndefined();
    const history = (await get("/backups")).body.data;
    expect(history[0]).toMatchObject({ kind: "download", status: "completed", encrypted: false, sizeBytes: backup.length, schemaVersion: expect.stringMatching(/^\d{4}_/) });
  });

  it("says what is in a file before restoring it", async () => {
    const res = await restore(backup, { dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().manifest).toMatchObject({ format: "digital-bahi-backup", business: { legalName: "Laxmi Traders" }, counts: { invoices: 1 } });
    expect((await get("/me")).body.business.legalName).toBe("Laxmi Traders");
  });

  it("asks for the person's own password again before restoring", async () => {
    const missing = await restore(backup, { accountPassword: null });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: "ACCOUNT_PASSWORD_REQUIRED", field: "accountPassword" });
    const wrong = await restore(backup, { accountPassword: "not-my-password" });
    expect(wrong.json().error).toMatchObject({ code: "ACCOUNT_PASSWORD_WRONG", field: "accountPassword" });
    // Nothing was created, and checking a file never needs it.
    expect((await get("/businesses")).body.data).toHaveLength(1);
    expect((await restore(backup, { dryRun: true, accountPassword: null })).statusCode).toBe(200);
  });

  it("restores into a new business with everything in place, the original untouched", async () => {
    const res = await restore(backup);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.session.business).toMatchObject({ tradeName: "Laxmi Traders (restored)", isOwner: true, status: "trial" });
    expect(body.session.businesses).toHaveLength(2);
    const token = body.session.accessToken as string;
    const newId = body.session.business.id as string;
    expect(newId).not.toBe(owner.businessId);

    const [was, now] = await Promise.all([get(`/invoices/${ids.invoice}`), get("/invoices", token)]);
    expect(now.body.data).toHaveLength(1);
    const copy = (await get(`/invoices/${now.body.data[0].id}`, token)).body;
    expect(copy.id).not.toBe(ids.invoice);
    expect(copy).toMatchObject({ invoiceNumber: ids.invoiceNumber, grandTotal: was.body.grandTotal, amountPaid: was.body.amountPaid, balanceDue: was.body.balanceDue });
    expect(copy.items.map((i: { productName: string; qty: string }) => [i.productName, i.qty])).toEqual(was.body.items.map((i: { productName: string; qty: string }) => [i.productName, i.qty]));
    expect(copy.returns).toHaveLength(1);
    // Stock, balances, reports and settings came across.
    const stock = (tok: string) => get("/catalog", tok).then((r) => Object.fromEntries(r.body.products.map((p: { name: string; stock: string }) => [p.name, p.stock])));
    expect(await stock(token)).toEqual(await stock(owner.token));
    const customers = (await get("/customers", token)).body.data;
    expect(customers.map((c: { name: string; balance: string }) => [c.name, c.balance])).toEqual((await get("/customers")).body.data.map((c: { name: string; balance: string }) => [c.name, c.balance]));
    const report = (tok: string) => get("/reports/sales?from=2026-09-01&to=2026-09-30&groupBy=product", tok).then((r) => r.body.totals);
    expect(await report(token)).toEqual(await report(owner.token));
    expect((await get("/settings", token)).body["invoice.terms"]).toBe("Goods once sold will not be taken back.");
    expect((await get("/business/logo", token)).body.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await get("/messaging/settings", token)).body.whatsapp).toMatchObject({ provider: "meta", hasSecret: false });
    // Numbering carries on from where the book stood.
    const next = await post("/invoices", { customerId: customers[0].id, lines: [{ productId: (await get("/products", token)).body.data[0].id, qty: "1" }] }, token);
    expect(next.body.invoiceNumber).toBe(ids.invoiceNumber!.replace(/\d+$/, (n) => String(Number(n) + 1).padStart(n.length, "0")));
    // The original still has its single invoice; the audit trail says what happened.
    expect((await get("/invoices")).body.data).toHaveLength(1);
    expect((await get("/audit-logs?entityType=business", token)).body.data.some((a: { action: string }) => a.action === "business.restored")).toBe(true);
    expect((await get("/audit-logs?entityType=business")).body.data.some((a: { action: string }) => a.action === "backup.restored_as_new")).toBe(true);
  });

  it("protects a backup with a password", async () => {
    const res = await raw("POST", "/backups/download", owner.token, { passphrase: "kirana-2026!" });
    const locked = res.rawPayload;
    expect(locked[5]).toBe(1);
    expect(gunzipSync.bind(null, locked.subarray(6))).toThrow();
    expect((await restore(locked, { dryRun: true })).json().error.code).toBe("BACKUP_PASSWORD_REQUIRED");
    expect((await restore(locked, { dryRun: true, passphrase: "wrong-password" })).json().error.code).toBe("BACKUP_PASSWORD_WRONG");
    expect((await restore(locked, { dryRun: true, passphrase: "kirana-2026!" })).json().manifest.counts.invoices).toBe(1);
    expect((await raw("POST", "/backups/download", owner.token, { passphrase: "short" })).statusCode).toBe(400);
  });

  it("refuses damaged files, and files that point at another firm's rows", async () => {
    const broken = Buffer.from(backup);
    broken[40] = broken[40]! ^ 0xff;
    expect((await restore(broken, { dryRun: true })).json().error.code).toBe("BACKUP_NOT_RECOGNISED");
    expect((await restore(Buffer.from("hello"), { dryRun: true })).json().error.code).toBe("BACKUP_NOT_RECOGNISED");
    // Someone else's customer (not in the file) on an invoice: refused.
    const other = await signup(t, { legalName: "Other Firm", stateCode: "27" });
    const theirs = (await call(t.app, "POST", "/customers", { token: other.token, body: { name: "Their Customer", stateCode: "27" } })).body.id;
    const crafted = tamper(backup, (doc) => {
      doc.tables.invoices![0]!.customerId = theirs;
    });
    const refused = await restore(crafted);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({ code: "BACKUP_INCONSISTENT", params: { table: "invoices" } });
    // An optional link to another firm's row is simply dropped.
    const theirLevel = (await call(t.app, "GET", "/price-levels", { token: other.token })).body.data?.[0]?.id ?? theirs;
    const softened = tamper(backup, (doc) => {
      doc.tables.customers![0]!.priceLevelId = theirLevel;
      doc.tables.columns_that_do_not_exist = [];
      delete doc.tables.columns_that_do_not_exist;
    });
    const ok = await restore(softened);
    expect(ok.statusCode).toBe(201);
    const tok = ok.json().session.accessToken;
    expect((await get("/customers", tok)).body.data[0].priceLevelId).toBeNull();
    // Unknown tables or columns mean a newer version made the file.
    expect((await restore(tamper(backup, (doc) => void (doc.tables.customers![0]!.favouriteColour = "blue")), { dryRun: true })).json().error.code).toBe("BACKUP_TOO_NEW");
  });

  it("emails a protected copy, and keeps backups to the owner's roles", async () => {
    expect((await post("/backups/email", {})).status).toBe(400);
    const sent = await post("/backups/email", { passphrase: "kirana-2026!" });
    expect(sent.status).toBe(200);
    expect(sent.body.sentTo).toBe("accounts@laxmitraders.in");
    const mail = t.messenger.sent.at(-1)!;
    expect(mail).toMatchObject({ channel: "email", to: "accounts@laxmitraders.in" });
    expect(mail.attachment!.filename).toMatch(/\.dbbackup$/);
    expect(mail.attachment!.content[5]).toBe(1);
    expect((await get("/backups")).body.data[0]).toMatchObject({ kind: "email", encrypted: true, status: "completed" });

    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await post("/members", { name: "Manager Mohan", mobile, roleId: roles.manager });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    const manager = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
    expect((await raw("POST", "/backups/download", manager, {})).statusCode).toBe(403);
    expect((await restore(backup, { token: manager, dryRun: true })).statusCode).toBe(403);
    expect((await get("/backups", manager)).status).toBe(403);
  });
});
