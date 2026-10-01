import { calculateDocument, dec, resolveTax, type TaxCategory } from "@digitalbahi/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/lib/db.js";
import { checkBalances } from "../src/services/nightly-analytics.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

/**
 * Phase 5.3 acceptance: three devices offline for a day make 300 bills and
 * 100 receipts, then sync at the same time over a bad connection: answers
 * lost and sent again, two tabs sending the same work at once, the network
 * dropping half-way. Afterwards there is no duplicate, every bill keeps its
 * device number, every total is the one the device printed, and stock,
 * balances, ledgers and the GST register all agree.
 */
describe.skipIf(!hasDatabase)("offline chaos: three devices, a day offline", () => {
  let t: TestApp;
  let owner: Session;
  const DAY = "2026-09-23";

  // A fixed sequence of "random" numbers, so a failure can be replayed.
  let seed = Number(process.env.CHAOS_SEED ?? 20260923);
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const uuid = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

  interface Device {
    id: string;
    code: string;
    token: string;
  }
  interface Work {
    device: Device;
    kind: "invoice" | "payment";
    key: string;
    savedAt: string;
    body: Record<string, unknown>;
    customerId: string;
    /** What the device printed and counted. */
    total: string;
    paid: string;
    taxable: string;
    qty: Map<string, number>;
    number?: string;
    /** The server's answer (from whichever send got through). */
    serverId?: string;
    serverTotal?: string;
    replays: number;
  }

  const devices: Device[] = [];
  const products: Array<{ id: string; price: string; includesTax: boolean; category: TaxCategory; stock: number }> = [];
  const customers: string[] = [];
  const work: Work[] = [];
  /** Where a device's pull feed stood before the sync. */
  let feedCursor = "";

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Chaos Distributors", stateCode: "23" });
    const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
    const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const tokens = [owner.token];
    for (const name of ["Sales Asha", "Sales Bilal"]) {
      const mobile = nextMobile();
      expect((await post("/members", { name, mobile, roleId: roles.sales })).status).toBe(201);
      await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
      tokens.push((await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken);
    }
    for (const [i, token] of tokens.entries()) {
      const d = (await call(t.app, "POST", "/devices", { token, body: { name: `Phone ${i + 1}`, platform: "android" } })).body;
      devices.push({ id: d.id, code: d.seriesCode, token });
    }
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const catalogTaxes = (await get("/catalog")).body.taxCategories as TaxCategory[];
    const taxByName = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    const defs = [
      { name: "Atta 5kg", price: "247.50", tax: "GST 5%", includesTax: false },
      { name: "Tea 250g", price: "123.25", tax: "GST 5%", includesTax: true },
      { name: "Soap 100g", price: "38.75", tax: "GST 18%", includesTax: false },
      { name: "Shampoo 180ml", price: "149.00", tax: "GST 18%", includesTax: true },
      { name: "Cola 600ml", price: "40.00", tax: "GST 40%", includesTax: true },
      { name: "Biscuit 200g", price: "29.99", tax: "GST 18%", includesTax: false },
    ];
    for (const d of defs) {
      const res = await post("/products", { name: d.name, taxCategoryId: taxByName[d.tax], baseUnitId: units.PCS, sellingPrice: d.price, pricesIncludeTax: d.includesTax, openingStock: "100000" });
      expect(res.status).toBe(201);
      products.push({ id: res.body.id, price: d.price, includesTax: d.includesTax, category: catalogTaxes.find((c) => c.id === taxByName[d.tax])!, stock: 100000 });
    }
    for (let i = 1; i <= 12; i++) customers.push((await post("/customers", { name: `Shop ${i}`, stateCode: "23", creditDays: between(0, 15) })).body.id);
    const roundOff = (await get("/me")).body.settings["invoice.round_off"];
    feedCursor = (await get("/sync/pull")).body.cursor;

    // The day offline: each device bills from 9 in the morning to 7 in the evening.
    let n = 1;
    for (const device of devices) {
      let seq = 0;
      const receipts = device === devices[2] ? 34 : 33;
      const slots = [...Array.from({ length: 100 }, () => "invoice" as const), ...Array.from({ length: receipts }, () => "payment" as const)].sort(() => rand() - 0.5);
      slots.forEach((kind, i) => {
        const minutes = 9 * 60 + Math.floor((i * 600) / slots.length);
        const savedAt = `${DAY}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+05:30`;
        const customerId = pick(customers);
        const key = uuid(n++);
        if (kind === "payment") {
          const amount = (between(100, 2500) + between(0, 99) / 100).toFixed(2);
          work.push({ device, kind, key, savedAt, customerId, body: { direction: "in", customerId, amount, method: "cash", paymentDate: DAY }, total: "0", paid: amount, taxable: "0", qty: new Map(), replays: 0 });
          return;
        }
        seq += 1;
        const number = `${device.code}/26-27/${String(seq).padStart(4, "0")}`;
        const lines = Array.from({ length: between(1, 4) }, () => ({ product: pick(products), qty: between(1, 24) }));
        const totals = calculateDocument({
          supplyType: "intra_state",
          chargeTax: true,
          roundOff,
          amountPaid: 0,
          lines: lines.map((l, k) => ({
            key: `L${k + 1}`,
            qty: l.qty,
            rate: l.product.price,
            rateIncludesTax: l.product.includesTax,
            discountPercent: 0,
            conversionFactor: 1,
            tax: resolveTax(l.product.category, { date: DAY, unitValue: dec(l.product.price), unitValueIncludesTax: l.product.includesTax }),
            hsnCode: null,
            uqc: null,
          })),
        });
        const grand = totals.grandTotal;
        // A third of the bills are paid on the spot, in full or in part.
        const paid = rand() < 0.33 ? (rand() < 0.5 ? grand : grand.times(0.5).toDecimalPlaces(2)) : dec(0);
        const qty = new Map<string, number>();
        for (const l of lines) qty.set(l.product.id, (qty.get(l.product.id) ?? 0) + l.qty);
        work.push({
          device,
          kind,
          key,
          savedAt,
          customerId,
          number,
          body: {
            customerId,
            invoiceDate: DAY,
            lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty.toFixed(3), rate: dec(l.product.price).toFixed(4), discountPercent: "0.00" })),
            ...(paid.gt(0) ? { payment: { amount: paid.toFixed(2), method: "cash" } } : {}),
            offline: { deviceId: device.id, invoiceNumber: number, savedAt },
          },
          total: grand.toFixed(2),
          paid: paid.toFixed(2),
          taxable: totals.taxableTotal.toFixed(2),
          qty,
          replays: 0,
        });
      });
    }
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it("syncs 300 bills and 100 receipts from three devices at once, over a bad connection, with no duplicate", async () => {
    expect(work.filter((w) => w.kind === "invoice")).toHaveLength(300);
    expect(work.filter((w) => w.kind === "payment")).toHaveLength(100);
    const send = (w: Work) => call(t.app, "POST", w.kind === "invoice" ? "/invoices" : "/payments", { token: w.device.token, body: w.body, headers: { "idempotency-key": w.key } });
    const record = (w: Work, res: { status: number; body: Record<string, unknown> }) => {
      expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
      const id = String(res.body.id);
      if (w.serverId) expect(id).toBe(w.serverId);
      w.serverId = id;
      w.serverTotal = String(w.kind === "invoice" ? res.body.grandTotal : res.body.amount);
      if (w.kind === "invoice") {
        expect(res.body.invoiceNumber).toBe(w.number);
        expect(res.body.reviewStatus).toBeNull();
      }
    };

    // Each device sends its work oldest first, as the app does; all three at once.
    const queues = devices.map((d) => work.filter((w) => w.device === d).sort((a, b) => a.savedAt.localeCompare(b.savedAt)));
    const stats = { lostAnswers: 0, twoTabs: 0, drops: 0, rounds: 0 };
    while (queues.some((q) => q.length)) {
      stats.rounds += 1;
      await Promise.all(
        queues.map(async (q) => {
          while (q.length) {
            const w = q[0]!;
            const r = rand();
            if (r < 0.05) {
              // The network drops before sending: this device tries again next round.
              stats.drops += 1;
              return;
            }
            if (r < 0.1) {
              // Two tabs send the same work at the same moment.
              stats.twoTabs += 1;
              const both = await Promise.all([send(w), send(w)]);
              expect(both.map((x) => x.status).sort()).toEqual([200, 201]);
              both.forEach((x) => record(w, x));
              w.replays += 1;
            } else if (r < 0.25) {
              // The server took it but the answer was lost: sent again.
              stats.lostAnswers += 1;
              await send(w);
              const again = await send(w);
              expect(again.status).toBe(200);
              expect(again.headers["idempotent-replay"]).toBe("true");
              record(w, again);
              w.replays += 1;
            } else {
              const res = await send(w);
              expect(res.status, JSON.stringify(res.body)).toBe(201);
              record(w, res);
            }
            q.shift();
          }
        }),
      );
    }
    expect(stats.lostAnswers + stats.twoTabs + stats.drops).toBeGreaterThan(30);

    const q = async <T>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
    // No duplicate: one bill per piece of work, each with its device number, in an unbroken series per device.
    const bills = await q<{ client_id: string; invoice_number: string; grand_total: string; taxable_total: string; amount_paid: string; device_id: string }>(
      `select client_id, invoice_number, grand_total::text, taxable_total::text, amount_paid::text, device_id from invoices where business_id = $1`,
      [owner.businessId],
    );
    expect(bills).toHaveLength(300);
    expect(new Set(bills.map((b) => b.client_id)).size).toBe(300);
    for (const d of devices) {
      const numbers = bills.filter((b) => b.device_id === d.id).map((b) => b.invoice_number).sort();
      expect(numbers).toEqual(Array.from({ length: 100 }, (_, i) => `${d.code}/26-27/${String(i + 1).padStart(4, "0")}`));
      const [series] = await q<{ next_number: number }>(`select next_number from document_series where device_id = $1`, [d.id]);
      expect(series!.next_number).toBe(101);
    }
    const receipts = await q<{ client_id: string; amount: string }>(`select client_id, amount::text from payments where business_id = $1 and client_id is not null`, [owner.businessId]);
    expect(receipts).toHaveLength(100);
    const paidWithBills = work.filter((w) => w.kind === "invoice" && dec(w.paid).gt(0)).length;
    expect((await q<{ n: number }>(`select count(*)::int as n from payments where business_id = $1`, [owner.businessId]))[0]!.n).toBe(100 + paidWithBills);

    // Every total is the one the device printed.
    const byKey = new Map(bills.map((b) => [b.client_id, b]));
    for (const w of work.filter((x) => x.kind === "invoice")) {
      const b = byKey.get(w.key)!;
      expect(b.grand_total, w.number).toBe(w.total);
      expect(b.taxable_total, w.number).toBe(w.taxable);
      expect(w.serverTotal).toBe(w.total);
    }
    const sum = (xs: string[]) => xs.reduce((a, x) => a.plus(x), dec(0));
    expect(sum(bills.map((b) => b.grand_total)).toFixed(2)).toBe(sum(work.filter((w) => w.kind === "invoice").map((w) => w.total)).toFixed(2));
    expect(sum(receipts.map((r) => r.amount)).toFixed(2)).toBe(sum(work.filter((w) => w.kind === "payment").map((w) => w.paid)).toFixed(2));

    // Each customer owes what their bills came to, less what they paid.
    const balances = await q<{ id: string; balance: string }>(`select id, balance::text from customers where business_id = $1`, [owner.businessId]);
    for (const c of balances) {
      const mine = work.filter((w) => w.customerId === c.id);
      const owed = sum(mine.filter((w) => w.kind === "invoice").map((w) => w.total)).minus(sum(mine.map((w) => w.paid)));
      expect(c.balance, c.id).toBe(owed.toFixed(2));
    }
    // Stock went out exactly as sold.
    const stock = await q<{ product_id: string; qty: string }>(`select product_id, sum(qty)::text as qty from stock_balances where business_id = $1 group by product_id`, [owner.businessId]);
    for (const p of products) {
      const sold = work.reduce((a, w) => a + (w.qty.get(p.id) ?? 0), 0);
      expect(Number(stock.find((s) => s.product_id === p.id)!.qty)).toBe(p.stock - sold);
    }
    // Cached balances and stock agree with their ledgers; the GST register with the bills.
    const checked = await withTenant(t.app.deps.db, { businessId: owner.businessId, userId: owner.userId }, (tx) => checkBalances(tx, owner.businessId));
    expect([checked.customers.mismatched, checked.suppliers.mismatched, checked.stock.mismatched]).toEqual([0, 0, 0]);
    const [gst] = await q<{ taxable: string }>(`select sum(taxable_value)::text as taxable from gst_transactions where business_id = $1 and doc_type = 'invoice'`, [owner.businessId]);
    expect(dec(gst!.taxable).toFixed(2)).toBe(sum(bills.map((b) => b.taxable_total)).toFixed(2));

    // A device that pulls afterwards gets the stock and balances the server now has.
    const pulled = { products: new Map<string, string>(), customers: new Map<string, string>() };
    for (let cursor = feedCursor; ; ) {
      const page = (await call(t.app, "GET", `/sync/pull?cursor=${cursor}&limit=7`, { token: owner.token })).body;
      for (const p of page.products) pulled.products.set(p.id, p.stock);
      for (const c of page.customers) pulled.customers.set(c.id, c.balance);
      cursor = page.cursor;
      if (!page.more) break;
    }
    // (Only what changed comes: products sold and customers with work.)
    for (const p of products.filter((x) => work.some((w) => w.qty.has(x.id)))) expect(Number(pulled.products.get(p.id))).toBe(Number(stock.find((s) => s.product_id === p.id)!.qty));
    for (const c of balances.filter((x) => work.some((w) => w.customerId === x.id))) expect(pulled.customers.get(c.id), c.id).toBe(c.balance);
  }, 300_000);
});
