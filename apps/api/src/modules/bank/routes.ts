import { IsoDate } from "@digitalbahi/contracts";
import { matchStatementLine, type RecordedPayment, type StatementParty } from "@digitalbahi/core";
import { schema } from "@digitalbahi/db";
import { and, between, eq, gt, isNull, ne } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { withTenant } from "../../lib/db.js";
import type { ApiModule } from "../types.js";

const MatchBody = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        row: z.number().int().positive(),
        date: IsoDate,
        narration: z.string().max(500),
        reference: z.string().max(80),
        amount: z.number().finite().refine((n) => n !== 0),
      }),
    )
    .min(1)
    .max(2000),
});

const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Bank reconciliation: the lines of a bank statement (read in the browser)
 * matched to customers (money in) and suppliers (money out), and marked when
 * the payment is already in the books. Recording the matched ones is the
 * ordinary POST /payments, one per line.
 */
export const bankModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/bank-statement/match", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], body: MatchBody } }, async (request) => {
    const ctx = request.ctx;
    const { lines } = request.body;
    const dates = lines.map((l) => l.date).sort();
    const from = shift(dates[0]!, -3);
    const to = shift(dates[dates.length - 1]!, 3);
    const c = schema.customers;
    const s = schema.suppliers;
    const inv = schema.invoices;
    const pur = schema.purchases;
    const pay = schema.payments;
    return withTenant(deps.db, ctx, async (tx) => {
      const b = ctx.businessId;
      const [customers, suppliers, invoices, purchases, payments] = await Promise.all([
        tx.select({ id: c.id, name: c.name, businessName: c.businessName, mobile: c.mobile, altMobile: c.altMobile, balance: c.balance }).from(c).where(and(eq(c.businessId, b), eq(c.isActive, true), isNull(c.deletedAt))),
        tx.select({ id: s.id, name: s.name, mobile: s.mobile, upiId: s.upiId, balance: s.balance }).from(s).where(and(eq(s.businessId, b), eq(s.isActive, true), isNull(s.deletedAt))),
        tx.select({ party: inv.customerId, due: inv.balanceDue }).from(inv).where(and(eq(inv.businessId, b), eq(inv.status, "posted"), gt(inv.balanceDue, "0"))),
        tx.select({ party: pur.supplierId, due: pur.balanceDue }).from(pur).where(and(eq(pur.businessId, b), eq(pur.status, "posted"), gt(pur.balanceDue, "0"))),
        tx
          .select({ customerId: pay.customerId, supplierId: pay.supplierId, direction: pay.direction, date: pay.paymentDate, amount: pay.amount, reference: pay.referenceNumber })
          .from(pay)
          .where(and(eq(pay.businessId, b), ne(pay.status, "cancelled"), between(pay.paymentDate, from, to))),
      ]);
      const open = new Map<string, number[]>();
      for (const d of [...invoices, ...purchases]) open.set(d.party, [...(open.get(d.party) ?? []), Number(d.due)]);
      const parties: StatementParty[] = [
        ...customers.map((x) => ({
          id: x.id,
          kind: "customer" as const,
          name: x.businessName || x.name,
          aliases: x.businessName ? [x.name] : [],
          mobiles: [x.mobile, x.altMobile].filter((m): m is string => !!m),
          balance: Number(x.balance),
          openBills: open.get(x.id) ?? [],
        })),
        ...suppliers.map((x) => ({ id: x.id, kind: "supplier" as const, name: x.name, mobiles: x.mobile ? [x.mobile] : [], upiId: x.upiId, balance: Number(x.balance), openBills: open.get(x.id) ?? [] })),
      ];
      const recorded: RecordedPayment[] = payments.flatMap((p) => {
        const partyId = p.customerId ?? p.supplierId;
        return partyId ? [{ partyId, direction: p.direction, date: p.date, amount: Number(p.amount), reference: p.reference }] : [];
      });
      const byId = new Map(parties.map((p) => [p.id, p]));
      // A payment already in the books matches one line only.
      const used = new Set<RecordedPayment>();
      return {
        lines: lines.map((line) => {
          const m = matchStatementLine(
            line,
            parties,
            recorded.filter((p) => !used.has(p)),
          );
          if (m.status === "recorded") {
            const hit = recorded.find((p) => !used.has(p) && p.partyId === m.partyId && Math.abs(p.amount - Math.abs(line.amount)) < 0.005);
            if (hit) used.add(hit);
          }
          const party = m.partyId ? byId.get(m.partyId) : undefined;
          return { row: line.row, ...m, partyName: party?.name ?? null, partyKind: party?.kind ?? null };
        }),
      };
    });
  });
};
