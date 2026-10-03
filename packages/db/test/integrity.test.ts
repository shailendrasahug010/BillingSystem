/**
 * Integration test against a real PostgreSQL (16+). It creates a throw-away
 * database, applies every migration, seeds defaults and then proves the
 * integrity rules hold at the database level. Skipped when DATABASE_URL is not
 * set (e.g. a laptop without Postgres); always runs in CI.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @digitalbahi/db test
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  calculateDocument,
  financialYearOf,
  formatDocumentNumber,
  taxAt,
  TAX_ENGINE_VERSION,
} from "@digitalbahi/core";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seedBusinessDefaults, seedReferenceData } from "../src/index.js";
import * as s from "../src/schema/index.js";

const adminUrl = process.env.DATABASE_URL;
const dbName = `digitalbahi_it_${Date.now()}`;
const today = "2026-09-24";

function urlFor(database: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${database}`;
  return u.toString();
}

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const err = e as { code?: string; message: string; cause?: { code?: string; message: string } };
    return err.cause && err.cause.code ? err.cause : err;
  }
  throw new Error("expected the database to reject this statement");
}

describe.skipIf(!adminUrl)("database integrity (PostgreSQL)", () => {
  let handle: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>["db"];
  const ids = {} as { bizA: string; bizB: string; unit: string; warehouse: string; product: string; customer: string };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    await runMigrations(urlFor(dbName));
    handle = createDb(urlFor(dbName));
    db = handle.db;
    await seedReferenceData(db);

    const [bizA] = await db
      .insert(s.businesses)
      .values({ legalName: "Sharma Distributors", gstin: "23AAPFU0939F1ZS", stateCode: "23" })
      .returning();
    const [bizB] = await db.insert(s.businesses).values({ legalName: "Other Traders", stateCode: "27" }).returning();
    ids.bizA = bizA!.id;
    ids.bizB = bizB!.id;
    await seedBusinessDefaults(db, ids.bizA, today);
    await seedBusinessDefaults(db, ids.bizB, today);

    const [pcs] = await db.select().from(s.units).where(and(eq(s.units.businessId, ids.bizA), eq(s.units.symbol, "PCS")));
    const [wh] = await db.select().from(s.warehouses).where(eq(s.warehouses.businessId, ids.bizA));
    const [cat] = await db
      .insert(s.taxCategories)
      .values({ businessId: ids.bizA, name: "Biscuits", kind: "taxable" })
      .returning();
    await db.insert(s.taxRates).values([
      { businessId: ids.bizA, taxCategoryId: cat!.id, effectiveFrom: "2017-07-01", effectiveTo: "2025-09-21", gstRate: "18" },
      { businessId: ids.bizA, taxCategoryId: cat!.id, effectiveFrom: "2025-09-22", gstRate: "5" },
    ]);
    const [product] = await db
      .insert(s.products)
      .values({
        businessId: ids.bizA,
        name: "Parle-G 100g",
        code: "PG100",
        hsnCode: "1905",
        taxCategoryId: cat!.id,
        baseUnitId: pcs!.id,
        sellingPrice: "9.5000",
      })
      .returning();
    const [customer] = await db
      .insert(s.customers)
      .values({
        businessId: ids.bizA,
        code: "C001",
        name: "ABC General Store",
        customerType: "b2b",
        gstRegistration: "regular",
        gstin: "23AAPFU0939F1ZS",
        stateCode: "23",
        creditLimit: "50000",
        creditDays: 15,
      })
      .returning();
    await db.insert(s.customers).values({ businessId: ids.bizB, code: "C001", name: "Someone Else", stateCode: "27" });
    Object.assign(ids, { unit: pcs!.id, warehouse: wh!.id, product: product!.id, customer: customer!.id });
  });

  afterAll(async () => {
    await handle?.pool.end();
    if (!adminUrl) return;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  /**
   * Reference posting flow (what the API's InvoiceService.post does): one
   * transaction allocates the number, writes the invoice + lines, moves stock
   * through the ledger, debits the customer ledger and records GST.
   */
  async function postInvoice(qty: number, opts: { number?: string } = {}) {
    return db.transaction(async (tx) => {
      const totals = calculateDocument({
        lines: [{ key: "1", qty, rate: "9.50", tax: taxAt(5), hsnCode: "1905", uqc: "PCS" }],
        supplyType: "intra_state",
        chargeTax: true,
      });
      const fy = financialYearOf(today).label;
      const [series] = await tx
        .update(s.documentSeries)
        .set({ nextNumber: sql`${s.documentSeries.nextNumber} + 1` })
        .where(and(eq(s.documentSeries.businessId, ids.bizA), eq(s.documentSeries.docType, "invoice"), eq(s.documentSeries.financialYear, fy)))
        .returning({ id: s.documentSeries.id, pattern: s.documentSeries.pattern, next: s.documentSeries.nextNumber });
      const number = opts.number ?? formatDocumentNumber(series!.pattern, { seq: series!.next - 1, date: today });
      const line = totals.lines[0]!;
      const [invoice] = await tx
        .insert(s.invoices)
        .values({
          businessId: ids.bizA,
          invoiceNumber: number,
          seriesId: series!.id,
          financialYear: fy,
          invoiceDate: today,
          dueDate: "2026-10-09",
          customerId: ids.customer,
          partyName: "ABC General Store",
          partyGstin: "23AAPFU0939F1ZS",
          placeOfSupply: "23",
          supplyType: "intra_state",
          taxEngineVersion: TAX_ENGINE_VERSION,
          warehouseId: ids.warehouse,
          status: "posted",
          grossTotal: totals.grossTotal.toFixed(2),
          taxableTotal: totals.taxableTotal.toFixed(2),
          cgstTotal: totals.cgstTotal.toFixed(2),
          sgstTotal: totals.sgstTotal.toFixed(2),
          roundOff: totals.roundOff.toFixed(2),
          grandTotal: totals.grandTotal.toFixed(2),
          balanceDue: totals.grandTotal.toFixed(2),
          postedAt: new Date().toISOString(),
        })
        .returning();
      await tx.insert(s.invoiceItems).values({
        businessId: ids.bizA,
        invoiceId: invoice!.id,
        lineNo: 1,
        productId: ids.product,
        productName: "Parle-G 100g",
        hsnCode: "1905",
        uqc: "PCS",
        unitId: ids.unit,
        qty: String(qty),
        qtyBase: String(qty),
        rate: "9.5000",
        grossAmount: line.gross.toFixed(2),
        taxableValue: line.taxable.toFixed(2),
        gstRate: "5",
        cgstRate: "2.5",
        cgstAmount: line.cgst.toFixed(2),
        sgstRate: "2.5",
        sgstAmount: line.sgst.toFixed(2),
        lineTotal: line.total.toFixed(2),
      });

      // Stock: lock the balance row, insert the ledger movement with the running balance.
      await tx
        .insert(s.stockBalances)
        .values({ businessId: ids.bizA, productId: ids.product, warehouseId: ids.warehouse })
        .onConflictDoNothing();
      const [bal] = await tx
        .select()
        .from(s.stockBalances)
        .where(and(eq(s.stockBalances.productId, ids.product), eq(s.stockBalances.warehouseId, ids.warehouse)))
        .for("update");
      const after = (Number(bal!.qty) - qty).toFixed(3);
      const [ledger] = await tx
        .insert(s.stockLedger)
        .values({
          businessId: ids.bizA,
          productId: ids.product,
          warehouseId: ids.warehouse,
          txnDate: today,
          movementType: "sale",
          qtyOut: String(qty),
          balanceAfter: after,
          refType: "invoice",
          refId: invoice!.id,
          refNumber: number,
        })
        .returning({ id: s.stockLedger.id });
      await tx.update(s.stockBalances).set({ qty: after, lastLedgerId: ledger!.id }).where(eq(s.stockBalances.id, bal!.id));

      // Customer ledger + cached balance.
      await tx.insert(s.partyLedgerEntries).values({
        businessId: ids.bizA,
        partyType: "customer",
        customerId: ids.customer,
        entryDate: today,
        docType: "invoice",
        docId: invoice!.id,
        docNumber: number,
        debit: totals.grandTotal.toFixed(2),
      });
      await tx
        .update(s.customers)
        .set({ balance: sql`${s.customers.balance} + ${totals.grandTotal.toFixed(2)}` })
        .where(eq(s.customers.id, ids.customer));

      // GST register fact row.
      await tx.insert(s.gstTransactions).values({
        businessId: ids.bizA,
        direction: "outward",
        docType: "invoice",
        docId: invoice!.id,
        docNumber: number,
        docDate: today,
        returnPeriod: today.slice(0, 7),
        partyGstin: "23AAPFU0939F1ZS",
        partyRegistration: "regular",
        placeOfSupply: "23",
        supplyType: "intra_state",
        taxability: "taxable",
        hsnCode: "1905",
        uqc: "PCS",
        qty: String(qty),
        taxableValue: line.taxable.toFixed(2),
        gstRate: "5",
        cgstAmount: line.cgst.toFixed(2),
        sgstAmount: line.sgst.toFixed(2),
        documentValue: totals.grandTotal.toFixed(2),
      });
      return invoice!;
    });
  }

  it("seeds reference data and business defaults", async () => {
    const [{ count: stateCount }] = (await db.execute(sql`select count(*)::int as count from states`)).rows as [{ count: number }];
    expect(stateCount).toBeGreaterThanOrEqual(38);
    const roles = await db.select().from(s.roles).where(eq(s.roles.businessId, ids.bizA));
    expect(roles.map((r) => r.key).sort()).toEqual(["accountant", "admin", "hr", "manager", "sales", "warehouse"]);
    const series = await db.select().from(s.documentSeries).where(eq(s.documentSeries.businessId, ids.bizA));
    expect(series.find((x) => x.docType === "invoice")?.financialYear).toBe("2026-27");
  });

  it("renames the price lists first created as Retail / Wholesale / Distributor to Price A / B / C, and only those", async () => {
    const rename = readFileSync(new URL("../migrations/0013_price_list_names.sql", import.meta.url), "utf8");
    const names = async (business: string) =>
      (await db.select({ name: s.priceLevels.name }).from(s.priceLevels).where(eq(s.priceLevels.businessId, business)).orderBy(s.priceLevels.sortOrder)).map((l) => l.name);
    const setNames = async (business: string, list: string[]) => {
      const levels = await db.select().from(s.priceLevels).where(eq(s.priceLevels.businessId, business)).orderBy(s.priceLevels.sortOrder);
      for (const [i, l] of levels.entries()) await db.update(s.priceLevels).set({ name: list[i]! }).where(eq(s.priceLevels.id, l.id));
    };
    // A business as it was first set up, and one that had already renamed a list.
    await setNames(ids.bizA, ["Retail", "Wholesale", "Distributor"]);
    await setNames(ids.bizB, ["Retail", "Wholesale", "Super Stockist"]);
    await db.execute(sql.raw(rename));
    expect(await names(ids.bizA)).toEqual(["Price A", "Price B", "Price C"]);
    expect(await names(ids.bizB)).toEqual(["Retail", "Wholesale", "Super Stockist"]);
    await setNames(ids.bizB, ["Price A", "Price B", "Price C"]);
  });

  it("posts an invoice atomically and keeps ledger and balances consistent", async () => {
    const inv1 = await postInvoice(48);
    const inv2 = await postInvoice(10);
    expect(inv1.invoiceNumber).toBe("INV/26-27/00001");
    expect(inv2.invoiceNumber).toBe("INV/26-27/00002");
    expect(inv1.grandTotal).toBe("479.00"); // 456.00 + 5% GST = 478.80, rounded

    const [check] = (
      await db.execute(sql`
        select
          (select coalesce(sum(qty_in - qty_out), 0) from stock_ledger where product_id = ${ids.product}) as ledger_qty,
          (select qty from stock_balances where product_id = ${ids.product}) as balance_qty,
          (select coalesce(sum(debit - credit), 0) from party_ledger_entries where customer_id = ${ids.customer}) as ledger_amt,
          (select balance from customers where id = ${ids.customer}) as balance_amt`)
    ).rows as [{ ledger_qty: string; balance_qty: string; ledger_amt: string; balance_amt: string }];
    expect(Number(check.ledger_qty)).toBe(-58);
    expect(Number(check.balance_qty)).toBe(-58);
    expect(Number(check.ledger_amt)).toBe(Number(check.balance_amt));
  });

  it("rolls back everything when any step fails", async () => {
    const before = await db.select().from(s.stockLedger);
    const err = await pgError(postInvoice(1, { number: "INV/26-27/00001" })); // duplicate number
    expect(err.code).toBe("23505");
    const after = await db.select().from(s.stockLedger);
    expect(after.length).toBe(before.length);
  });

  it("keeps ledgers and the audit log append-only", async () => {
    const e1 = await pgError(db.execute(sql`update stock_ledger set qty_out = 1`));
    expect(e1.message).toMatch(/append-only/);
    const e2 = await pgError(db.execute(sql`delete from party_ledger_entries`));
    expect(e2.message).toMatch(/append-only/);
    await db.insert(s.auditLogs).values({ businessId: ids.bizA, action: "invoice.updated", entityType: "invoice", changes: { grandTotal: ["12500.00", "13200.00"] } });
    const e3 = await pgError(db.execute(sql`delete from audit_logs`));
    expect(e3.message).toMatch(/append-only/);
    const e4 = await pgError(db.execute(sql`update gst_transactions set taxable_value = 0`));
    expect(e4.message).toMatch(/only be marked cancelled/);
    await db.execute(sql`update gst_transactions set is_cancelled = true where id = (select min(id) from gst_transactions)`);
  });

  it("never physically deletes a posted invoice", async () => {
    const e = await pgError(db.execute(sql`delete from invoices where status = 'posted'`));
    expect(e.message).toMatch(/cancel it instead/);
  });

  it("locks a filed GST period but still accepts payments against it", async () => {
    await db.insert(s.gstReturnPeriods).values({ businessId: ids.bizA, returnType: "GSTR1", period: "2026-09", status: "filed" });
    const e = await pgError(
      db.execute(sql`update invoices set grand_total = grand_total + 1 where invoice_number = 'INV/26-27/00001'`),
    );
    expect(e.message).toMatch(/GST period 2026-09 is locked/);
    await db.execute(
      sql`update invoices set amount_paid = 100, balance_due = grand_total - 100, payment_status = 'partial' where invoice_number = 'INV/26-27/00001'`,
    );
  });

  it("enforces check constraints on money, stock and parties", async () => {
    const both = await pgError(
      db.insert(s.stockLedger).values({
        businessId: ids.bizA,
        productId: ids.product,
        warehouseId: ids.warehouse,
        txnDate: today,
        movementType: "adjustment_in",
        qtyIn: "1",
        qtyOut: "1",
        balanceAfter: "0",
        refType: "adjustment",
      }),
    );
    expect(both.code).toBe("23514");

    const b2b = await pgError(
      db.insert(s.customers).values({ businessId: ids.bizA, code: "C002", name: "No GSTIN", customerType: "b2b", stateCode: "23" }),
    );
    expect(b2b.code).toBe("23514");

    const [payment] = await db
      .insert(s.payments)
      .values({
        businessId: ids.bizA,
        financialYear: "2026-27",
        direction: "in",
        partyType: "customer",
        customerId: ids.customer,
        paymentDate: today,
        amount: "500",
        method: "upi",
      })
      .returning();
    const [inv] = await db.select().from(s.invoices).limit(1);
    const twoTargets = await pgError(
      db.insert(s.paymentAllocations).values({ businessId: ids.bizA, paymentId: payment!.id, invoiceId: inv!.id, noteId: randomUUID(), amount: "10" }),
    );
    expect(twoTargets.code).toBe("23514");

    // GST invoice numbers: max 16 characters, letters, digits, '/' and '-' only.
    const badNumber = await pgError(
      db.insert(s.invoices).values({
        businessId: ids.bizA,
        invoiceNumber: "INV 1",
        financialYear: "2026-27",
        invoiceDate: "2026-10-01",
        customerId: ids.customer,
        partyName: "ABC General Store",
        placeOfSupply: "23",
        supplyType: "intra_state",
        taxEngineVersion: TAX_ENGINE_VERSION,
        warehouseId: ids.warehouse,
      }),
    );
    expect(badNumber.code).toBe("23514");
  });

  it("treats a missing batch as one stock bucket (NULLS NOT DISTINCT)", async () => {
    const dup = await pgError(
      db.insert(s.stockBalances).values({ businessId: ids.bizA, productId: ids.product, warehouseId: ids.warehouse }),
    );
    expect(dup.code).toBe("23505");
  });

  it("isolates businesses with row-level security for the application role", async () => {
    const client = await handle.pool.connect();
    try {
      await client.query(`CREATE ROLE digitalbahi_it_app NOLOGIN`);
      await client.query(`GRANT SELECT, INSERT ON customers TO digitalbahi_it_app`);
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE digitalbahi_it_app");
      const none = await client.query("select count(*)::int as n from customers");
      expect(none.rows[0].n).toBe(0);
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [ids.bizA]);
      const mine = await client.query("select name from customers");
      expect(mine.rows.map((r) => r.name)).toEqual(["ABC General Store"]);
      await client.query("SAVEPOINT sp");
      const crossTenant = await client
        .query(`insert into customers (business_id, code, name, state_code) values ($1, 'X1', 'Sneaky', '27')`, [ids.bizB])
        .then(() => null)
        .catch((e: Error) => e);
      expect(crossTenant?.message).toMatch(/row-level security/);
      await client.query("ROLLBACK");
    } finally {
      await client.query("DROP OWNED BY digitalbahi_it_app; DROP ROLE digitalbahi_it_app").catch(() => undefined);
      client.release();
    }
  });
});
