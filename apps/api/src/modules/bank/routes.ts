import { BankLineListQuery, BankReconcileBody, BankStatementBody, BrsQuery, StatementLineInput } from "@digitalbahi/contracts";
import { matchStatementLine, type RecordedPayment } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, page } from "../../lib/pagination.js";
import { bankAccount, brs, importStatement, lineCandidates, lineFilter, lineViews, matchingParties, reconcileLines, statementViews } from "../../services/bank-reconciliation.js";
import type { ApiModule } from "../types.js";

const MatchBody = z.strictObject({ lines: z.array(StatementLineInput).min(1).max(2000) });
const IdParams = z.object({ id: z.uuid() });
const AccountQuery = z.object({ accountId: z.uuid() });

const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

/** Importing and reconciling are for those who record money in or out. */
const mayReconcile = (ctx: RequestCtx) => can(ctx, "payment.collect") || can(ctx, "payment.pay");

/**
 * Bank reconciliation. A statement's lines (read in the browser from the
 * bank's CSV, Excel or PDF) are matched to customers (money in) and
 * suppliers (money out) and marked when already in the books; saved per
 * account, they are reconciled one by one or in bulk, and the bank
 * reconciliation statement shows what is left.
 */
export const bankModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** Matching only, nothing kept (a statement looked at without saving it). */
  r.post("/bank-statement/match", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], body: MatchBody } }, async (request) => {
    const ctx = request.ctx;
    const { lines } = request.body;
    const dates = lines.map((l) => l.date).sort();
    return tenant(ctx, async (tx) => {
      const { parties, recorded } = await matchingParties(tx, ctx.businessId, shift(dates[0]!, -3), shift(dates[dates.length - 1]!, 3));
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

  /** Saves a statement for an account: new lines kept, those already in the books reconciled. */
  r.post("/bank-statements", { preHandler: guard(deps), schema: { tags: ["payments"], body: BankStatementBody } }, async (request, reply) => {
    const ctx = request.ctx;
    if (!mayReconcile(ctx)) throw forbidden("payment.collect");
    const done = await tenant(ctx, (tx) => importStatement(tx, ctx, request.body));
    return reply.code(201).send(done);
  });

  r.get("/bank-statements", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], querystring: AccountQuery } }, async (request) =>
    tenant(request.ctx, async (tx) => {
      await bankAccount(tx, request.ctx.businessId, request.query.accountId);
      return { data: await statementViews(tx, request.ctx.businessId, request.query.accountId) };
    }),
  );

  /** A statement and its lines go; what was recorded from them stays. */
  r.delete("/bank-statements/:id", { preHandler: guard(deps), schema: { tags: ["payments"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    if (!mayReconcile(ctx)) throw forbidden("payment.collect");
    await tenant(ctx, async (tx) => {
      const st = schema.bankStatements;
      const [gone] = await tx
        .delete(st)
        .where(and(eq(st.id, request.params.id), eq(st.businessId, ctx.businessId)))
        .returning({ id: st.id, accountId: st.paymentAccountId, fileName: st.fileName, periodFrom: st.periodFrom, periodTo: st.periodTo });
      if (!gone) throw notFound("bank_statement");
      await audit(tx, ctx, { action: "bank_statement.deleted", entityType: "payment_account", entityId: gone.accountId, changes: { file: gone.fileName, from: gone.periodFrom, to: gone.periodTo } });
    });
    return reply.code(204).send();
  });

  r.get("/bank-statement-lines", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], querystring: BankLineListQuery } }, async (request) => {
    const ctx = request.ctx;
    const q = request.query;
    const l = schema.bankStatementLines;
    const cursor = decodeCursor(q.cursor);
    return tenant(ctx, async (tx) => {
      await bankAccount(tx, ctx.businessId, q.accountId);
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null;
      // "5,250" or "₹5250.00" finds the amount, in or out.
      const asAmount = q.q && /^[₹\s]*[\d,]+(\.\d{1,2})?$/.test(q.q) ? q.q.replace(/[₹,\s]/g, "") : null;
      const rows = await tx
        .select()
        .from(l)
        .where(
          and(
            lineFilter(ctx.businessId, q),
            ...(like ? [asAmount ? sql`(${l.narration} ilike ${like} or ${l.reference} ilike ${like} or abs(${l.amount}) = ${asAmount}::numeric)` : sql`(${l.narration} ilike ${like} or ${l.reference} ilike ${like})`] : []),
            ...(cursor ? [sql`(${l.lineDate}, ${l.id}) < (${String(cursor.v)}::date, ${cursor.id}::uuid)`] : []),
          ),
        )
        .orderBy(desc(l.lineDate), desc(l.id))
        .limit(q.limit + 1);
      const { data, nextCursor } = page(rows, q.limit, (x) => ({ v: x.lineDate, id: x.id }));
      return { data: await lineViews(tx, data), nextCursor };
    });
  });

  /** Entries in the books a line could be: the same money the same way, within a fortnight, not reconciled yet. */
  r.get("/bank-statement-lines/:id/candidates", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], params: IdParams } }, async (request) =>
    tenant(request.ctx, async (tx) => ({ data: await lineCandidates(tx, request.ctx.businessId, request.params.id) })),
  );

  /** Reconciles lines in bulk: each on its own, so one that cannot be done does not stop the others. */
  r.post("/bank-statement-lines/reconcile", { preHandler: guard(deps), schema: { tags: ["payments"], body: BankReconcileBody } }, async (request) => {
    const ctx = request.ctx;
    if (!mayReconcile(ctx) && !can(ctx, "expense.create")) throw forbidden("payment.collect");
    const today = deps.clock.today(ctx.timeZone);
    return tenant(ctx, async (tx) => {
      const done = await reconcileLines(tx, ctx, request.body.actions, today);
      const l = schema.bankStatementLines;
      const ids = request.body.actions.map((a) => a.lineId);
      const rows = await tx
        .select()
        .from(l)
        .where(and(eq(l.businessId, ctx.businessId), sql`${l.id} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`));
      return { ...done, lines: await lineViews(tx, rows) };
    });
  });

  /** The bank reconciliation statement of an account, as at a statement's end (the latest unless one is chosen). */
  r.get("/bank-statements/brs", { preHandler: guard(deps, "payment.view"), schema: { tags: ["payments"], querystring: BrsQuery } }, async (request) =>
    tenant(request.ctx, (tx) => brs(tx, request.ctx.businessId, request.query.accountId, request.query.statementId)),
  );
};
