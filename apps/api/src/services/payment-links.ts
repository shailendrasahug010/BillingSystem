import type { PaymentGatewayView, PaymentLinksSetup, PaymentLinkView } from "@digitalbahi/contracts";
import { dec, todayIn } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { createTranslator, isLocaleCode } from "@digitalbahi/i18n";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { loadAccess } from "../lib/access.js";
import { audit, type AuditActor } from "../lib/audit.js";
import type { AppDeps, RequestCtx } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import { ApiError, badRequest, conflict, notFound, rootMessage } from "../lib/errors.js";
import { GatewayError, type GatewayKeys, type GatewayName, type LinkState, type LinkStatus } from "./gateways/index.js";
import type { MessageRow } from "./messaging/queue.js";
import { notify } from "./notifications.js";
import { recordPayment } from "./payments.js";
import { getSetting } from "./settings.js";

/**
 * Online payments through the business's own gateway account (Razorpay or
 * Cashfree): payment links for a bill or for what a customer owes, made from
 * a bill, a customer, a payment reminder or the shop's order page. When the
 * customer pays, the gateway's webhook (or the API checking open links, for
 * a server the gateway cannot reach) turns each payment into a receipt.
 */

export type GatewayRow = typeof schema.paymentGatewaySettings.$inferSelect;
type LinkRow = typeof schema.paymentLinks.$inferSelect;
export type LinkScope = { businessId: string; timeZone: string };

/** The links the gateway may still take payments on. */
const OPEN: LinkStatus[] = ["created", "partly_paid"];
/** Businesses, and links in each, looked at per round of checks. */
const BUSINESSES = 200;
const CHECKS_PER_BUSINESS = 25;
/** Neither gateway takes less than a rupee. */
const MIN_AMOUNT = "1.00";
const DAY_MS = 86_400_000;
const NAMES: Record<GatewayName, string> = { razorpay: "Razorpay", cashfree: "Cashfree" };

const isGateway = (p: string | null | undefined): p is GatewayName => p === "razorpay" || p === "cashfree";

export async function loadGateway(tx: Tx, businessId: string): Promise<GatewayRow | null> {
  const [row] = await tx.select().from(schema.paymentGatewaySettings).where(eq(schema.paymentGatewaySettings.businessId, businessId));
  return row ?? null;
}

/** A gateway is chosen and its keys are saved: links can be made. */
export const gatewayReady = (row: GatewayRow | null): boolean => Boolean(row && isGateway(row.provider) && row.keyId && row.keySecret);

/** The business's keys, decrypted (null: no gateway chosen, or its keys are not all there). */
export function gatewayKeys(deps: AppDeps, row: GatewayRow | null): GatewayKeys | null {
  if (!row || !gatewayReady(row)) return null;
  return {
    provider: row.provider as GatewayName,
    environment: row.environment === "live" ? "live" : "test",
    keyId: row.keyId!,
    keySecret: deps.cipher.decrypt(row.keySecret!),
    webhookSecret: row.webhookSecret ? deps.cipher.decrypt(row.webhookSecret) : null,
  };
}

/** The set-up as Settings shows it: secrets only as "saved" or not. */
export function gatewayView(deps: AppDeps, row: GatewayRow | null): PaymentGatewayView {
  return {
    driver: deps.gateways.driver,
    provider: row && isGateway(row.provider) ? row.provider : "none",
    environment: row?.environment === "live" ? "live" : "test",
    keyId: row?.keyId ?? null,
    hasKeySecret: Boolean(row?.keySecret),
    hasWebhookSecret: Boolean(row?.webhookSecret),
    webhookKey: row?.webhookKey ?? null,
    paymentAccountId: row?.paymentAccountId ?? null,
    upiOnly: row?.upiOnly ?? false,
    linkExpiryDays: row?.linkExpiryDays ?? 15,
    linksInReminders: row?.linksInReminders ?? true,
    lastWebhookAt: row?.lastWebhookAt ?? null,
    ready: gatewayReady(row),
  };
}

export function linksSetup(row: GatewayRow | null): PaymentLinksSetup {
  return { ready: gatewayReady(row), provider: row && isGateway(row.provider) ? row.provider : "none", environment: row?.environment === "live" ? "live" : "test" };
}

/** A gateway's refusal as the API's error, with the gateway's own words; anything else as it is. */
export function gatewayApiError(e: unknown): unknown {
  if (!(e instanceof GatewayError)) return e;
  // Cashfree makes no link without the customer's mobile number.
  if (e.code === "GATEWAY_REFUSED" && e.reason === "customer_phone") return new ApiError(422, "PAYMENT_LINK_NEEDS_MOBILE", {}, "customerId");
  return new ApiError(e.code === "GATEWAY_REFUSED" ? 422 : 502, e.code, { reason: e.reason.slice(0, 200) });
}

/** Who asked for a link, for the audit log (a person, or the payment reminders with nobody signed in). */
export interface LinkActor {
  businessId: string;
  userId: string | null;
  userName: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export const linkActor = (ctx: RequestCtx): LinkActor => ({ businessId: ctx.businessId, userId: ctx.userId, userName: ctx.userName, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });

const auditActor = (a: LinkActor): AuditActor | null => (a.userId ? { businessId: a.businessId, userId: a.userId, userName: a.userName ?? "", userAgent: a.userAgent, ip: a.ip, requestId: a.requestId } : null);

// ---------------------------------------------------------------- reading

/** Links as the screens show them: the customer, the bill, and the receipts made from their payments. */
export async function selectLinks(tx: Tx, where: SQL, limit: number): Promise<PaymentLinkView[]> {
  const l = schema.paymentLinks;
  const rows = await tx
    .select({ link: l, customerName: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})`, invoiceNumber: schema.invoices.invoiceNumber })
    .from(l)
    .innerJoin(schema.customers, eq(schema.customers.id, l.customerId))
    .leftJoin(schema.invoices, eq(schema.invoices.id, l.invoiceId))
    .where(where)
    .orderBy(desc(l.createdAt), desc(l.id))
    .limit(limit);
  const ids = rows.map((r) => r.link.id);
  const g = schema.gatewayPayments;
  const paid = ids.length
    ? await tx
        .select({ linkId: g.linkId, paymentId: g.paymentId, paymentNumber: schema.payments.paymentNumber, amount: g.amount, method: g.method, reference: g.reference, paidAt: g.paidAt })
        .from(g)
        .leftJoin(schema.payments, eq(schema.payments.id, g.paymentId))
        .where(inArray(g.linkId, ids))
        .orderBy(asc(g.paidAt))
    : [];
  return rows.map(({ link, customerName, invoiceNumber }) => ({
    id: link.id,
    provider: link.provider as GatewayName,
    environment: link.environment === "live" ? "live" : "test",
    customerId: link.customerId,
    customerName,
    invoiceId: link.invoiceId,
    invoiceNumber: invoiceNumber ?? null,
    amount: link.amount,
    amountPaid: link.amountPaid,
    description: link.description,
    url: link.url,
    status: link.status,
    expiresAt: link.expiresAt,
    source: link.source as PaymentLinkView["source"],
    paidAt: link.paidAt,
    createdAt: link.createdAt,
    payments: paid.filter((p) => p.linkId === link.id).map(({ linkId: _l, ...p }) => p),
  }));
}

export async function linkView(tx: Tx, businessId: string, id: string): Promise<PaymentLinkView> {
  const l = schema.paymentLinks;
  const [view] = await selectLinks(tx, and(eq(l.id, id), eq(l.businessId, businessId))!, 1);
  if (!view) throw notFound("payment_link");
  return view;
}

// ---------------------------------------------------------------- making links

export interface LinkAsk {
  customerId: string;
  /** The bill; none: what the customer owes. */
  invoiceId?: string | null | undefined;
  /** Less than is due (staff may also ask a customer for an advance). */
  amount?: string | null | undefined;
  source: "staff" | "reminder" | "shop";
}

/**
 * A payment link for a bill (its balance unless less is asked) or for what a
 * customer owes. The same request again (a second tap, the next reminder)
 * gets the open link for the same thing and amount while it has a day or
 * more to run. The gateway is called outside any transaction: a link it made
 * that is not saved here is only an address nobody was given.
 */
export async function createPaymentLink(deps: AppDeps, actor: LinkActor, ask: LinkAsk): Promise<{ link: PaymentLinkView; reused: boolean }> {
  const now = deps.clock.now();
  const scope = { businessId: actor.businessId, userId: actor.userId ?? "" };
  const prep = await withTenant(deps.db, scope, async (tx) => {
    const settings = await loadGateway(tx, actor.businessId);
    const keys = gatewayKeys(deps, settings);
    if (!settings || !keys) throw conflict("PAYMENT_GATEWAY_NOT_SET_UP");
    const c = schema.customers;
    const [customer] = await tx
      .select({ id: c.id, name: sql<string>`coalesce(${c.businessName}, ${c.name})`, mobile: c.mobile, email: c.email, balance: c.balance, deletedAt: c.deletedAt })
      .from(c)
      .where(and(eq(c.id, ask.customerId), eq(c.businessId, actor.businessId)));
    if (!customer || customer.deletedAt) throw notFound("customer");
    let invoice: { id: string; number: string | null; due: string } | null = null;
    if (ask.invoiceId) {
      const i = schema.invoices;
      const [bill] = await tx
        .select({ id: i.id, number: i.invoiceNumber, customerId: i.customerId, status: i.status, due: i.balanceDue })
        .from(i)
        .where(and(eq(i.id, ask.invoiceId), eq(i.businessId, actor.businessId)));
      if (!bill || bill.customerId !== customer.id) throw notFound("invoice");
      if (bill.status !== "posted" || !dec(bill.due).gt(0)) throw conflict("PAYMENT_LINK_NOTHING_DUE");
      invoice = { id: bill.id, number: bill.number, due: bill.due };
    }
    const due = dec(invoice ? invoice.due : customer.balance);
    if (!ask.amount && !due.gt(0)) throw conflict("PAYMENT_LINK_NOTHING_DUE");
    const amount = dec(ask.amount ? ask.amount : due);
    // A bill's link, a reminder's and the shop's own never ask for more than is due.
    if ((invoice || ask.source !== "staff") && amount.gt(due)) throw badRequest("PAYMENT_LINK_EXCEEDS_DUE", { due: due.toFixed(2) }, "amount");
    if (amount.lt(MIN_AMOUNT)) throw badRequest("PAYMENT_LINK_TOO_SMALL", {}, "amount");
    const l = schema.paymentLinks;
    const [same] = await tx
      .select({ id: l.id })
      .from(l)
      .where(
        and(
          eq(l.businessId, actor.businessId),
          eq(l.customerId, customer.id),
          invoice ? eq(l.invoiceId, invoice.id) : isNull(l.invoiceId),
          eq(l.status, "created"),
          eq(l.provider, keys.provider),
          eq(l.environment, keys.environment),
          eq(l.amount, amount.toFixed(2)),
          sql`${l.expiresAt} > ${new Date(now.getTime() + DAY_MS).toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(l.createdAt))
      .limit(1);
    if (same) return { reuse: await linkView(tx, actor.businessId, same.id) } as const;
    const [business] = await tx
      .select({ name: sql<string>`coalesce(${schema.businesses.tradeName}, ${schema.businesses.legalName})` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, actor.businessId));
    return { reuse: null, keys, settings, customer, invoice, amount: amount.toFixed(2), business: business?.name ?? "" } as const;
  });
  if (prep.reuse) return { link: prep.reuse, reused: true };

  const { keys, settings, customer, invoice, amount } = prep;
  const id = uuidv7();
  const expiresAt = new Date(now.getTime() + settings.linkExpiryDays * DAY_MS);
  const description = invoice ? `Bill ${invoice.number ?? ""} from ${prep.business}` : `Payment to ${prep.business}`;
  let made: { providerLinkId: string; url: string };
  try {
    made = await deps.gateways.client(keys.provider).createLink(keys, {
      referenceId: id,
      amount,
      description,
      customer: { name: customer.name, mobile: customer.mobile, email: customer.email },
      expiresAt,
      upiOnly: settings.upiOnly,
      notes: { link: id, customer: customer.name.slice(0, 200), ...(invoice?.number ? { bill: invoice.number } : {}) },
    });
  } catch (e) {
    throw gatewayApiError(e);
  }
  const link = await withTenant(deps.db, scope, async (tx) => {
    await tx.insert(schema.paymentLinks).values({
      id,
      businessId: actor.businessId,
      provider: keys.provider,
      environment: keys.environment,
      customerId: customer.id,
      invoiceId: invoice?.id ?? null,
      amount,
      description,
      providerLinkId: made.providerLinkId,
      url: made.url,
      expiresAt: expiresAt.toISOString(),
      source: ask.source,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    const who = auditActor(actor);
    if (who) {
      await audit(tx, who, {
        action: "payment_link.created",
        entityType: "customer",
        entityId: customer.id,
        entityLabel: customer.name,
        changes: { amount, bill: invoice?.number ?? null, gateway: keys.provider, environment: keys.environment, source: ask.source },
      });
    }
    return linkView(tx, actor.businessId, id);
  });
  return { link, reused: false };
}

// ---------------------------------------------------------------- payments on links

/**
 * Whose name a receipt from an online payment is made in: whoever made the
 * link while they still belong to the business, else its owner.
 */
async function receiptActor(deps: AppDeps, tx: Tx, link: LinkRow, timeZone: string): Promise<RequestCtx> {
  const m = schema.businessMembers;
  const owners = await tx
    .select({ userId: m.userId })
    .from(m)
    .where(and(eq(m.businessId, link.businessId), eq(m.isOwner, true), eq(m.isActive, true)));
  for (const userId of [...(link.createdBy ? [link.createdBy] : []), ...owners.map((o) => o.userId)]) {
    const access = await loadAccess(deps.db, userId, link.businessId);
    if (!access) continue;
    return { userId, userName: access.userName, businessId: link.businessId, sessionId: "", roleKey: access.roleKey, grants: access.grants, isOwner: access.isOwner, timeZone, requestId: uuidv7(), ip: "", userAgent: "online payment" };
  }
  throw new Error(`Nobody in business ${link.businessId} to record the online payment in the name of`);
}

/**
 * Brings a link up to date with how the gateway reports it. Each payment not
 * seen before becomes a receipt for the customer (applied to the link's bill
 * first, then the oldest due, any rest kept as an advance), and the people
 * who see customers' accounts are told. A payment reported twice (the
 * webhook and a check, a webhook sent again) is recorded once.
 */
export async function applyLinkState(deps: AppDeps, scope: LinkScope, linkId: string, state: LinkState, opts: { cancelled?: boolean } = {}): Promise<{ recorded: number; status: LinkStatus }> {
  const now = deps.clock.now();
  const nowIso = now.toISOString();
  const today = deps.clock.today(scope.timeZone);
  return withTenant(deps.db, { businessId: scope.businessId, userId: "" }, async (tx) => {
    const l = schema.paymentLinks;
    const g = schema.gatewayPayments;
    const [link] = await tx
      .select()
      .from(l)
      .where(and(eq(l.id, linkId), eq(l.businessId, scope.businessId)))
      .for("update");
    if (!link) return { recorded: 0, status: "cancelled" as LinkStatus };
    let recorded = 0;
    let context: { actor: RequestCtx; fyStart: number; account: string | null; manual: boolean; customer: string; bill: string | null } | null = null;
    for (const p of [...state.payments].sort((a, b) => a.paidAt.localeCompare(b.paidAt))) {
      const amount = dec(p.amount);
      if (!amount.gt(0)) continue;
      const [fresh] = await tx
        .insert(g)
        .values({
          businessId: scope.businessId,
          linkId: link.id,
          provider: link.provider,
          providerPaymentId: p.providerPaymentId.slice(0, 80),
          amount: amount.toFixed(2),
          method: p.method,
          reference: p.reference?.slice(0, 40) ?? null,
          paidAt: p.paidAt,
        })
        .onConflictDoNothing({ target: [g.provider, g.providerPaymentId] })
        .returning({ id: g.id });
      if (!fresh) continue;
      context ??= await (async () => {
        const settings = await loadGateway(tx, scope.businessId);
        const [business] = await tx.select({ fyStart: schema.businesses.financialYearStartMonth }).from(schema.businesses).where(eq(schema.businesses.id, scope.businessId));
        const pa = schema.paymentAccounts;
        const [account] = settings?.paymentAccountId
          ? await tx
              .select({ id: pa.id })
              .from(pa)
              .where(and(eq(pa.id, settings.paymentAccountId), eq(pa.businessId, scope.businessId), eq(pa.isActive, true)))
          : [];
        const [customer] = await tx
          .select({ name: sql<string>`coalesce(${schema.customers.businessName}, ${schema.customers.name})` })
          .from(schema.customers)
          .where(eq(schema.customers.id, link.customerId));
        const [bill] = link.invoiceId ? await tx.select({ number: schema.invoices.invoiceNumber }).from(schema.invoices).where(eq(schema.invoices.id, link.invoiceId)) : [];
        return {
          actor: await receiptActor(deps, tx, link, scope.timeZone),
          fyStart: business!.fyStart,
          account: account?.id ?? null,
          manual: (await getSetting(tx, scope.businessId, "payments.allocation")) === "manual",
          customer: customer?.name ?? "",
          bill: bill?.number ?? null,
        };
      })();
      // Allocated by hand in this business: a bill's link still pays that bill; a balance link stays an advance.
      let allocations: Array<{ documentId: string; amount: string }> | undefined;
      if (context.manual) {
        allocations = [];
        if (link.invoiceId) {
          const [bill] = await tx.select({ due: schema.invoices.balanceDue, status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, link.invoiceId));
          if (bill?.status === "posted" && dec(bill.due).gt(0)) allocations = [{ documentId: link.invoiceId, amount: (amount.lt(bill.due) ? amount : dec(bill.due)).toFixed(2) }];
        }
      }
      const paidOn = todayIn(scope.timeZone, new Date(p.paidAt));
      const receipt = await recordPayment(tx, context.actor, context.fyStart, {
        direction: "in",
        party: { type: "customer", id: link.customerId, name: context.customer },
        date: paidOn > today ? today : paidOn,
        amount: amount.toFixed(2),
        method: p.method,
        referenceNumber: (p.reference ?? p.providerPaymentId).slice(0, 40),
        paymentAccountId: context.account,
        notes: `${NAMES[link.provider as GatewayName] ?? link.provider} ${p.providerPaymentId}${context.bill ? ` · ${context.bill}` : ""}`,
        ...(allocations ? { allocations } : {}),
        preferDocumentId: link.invoiceId,
      });
      await tx.update(g).set({ paymentId: receipt.id }).where(eq(g.id, fresh.id));
      await tx.insert(schema.outboxEvents).values({
        businessId: scope.businessId,
        eventType: "payment.received",
        aggregateType: "payment",
        aggregateId: receipt.id,
        payload: { amount: amount.toFixed(2), method: p.method, gateway: link.provider },
      });
      await notify(
        tx,
        scope.businessId,
        {
          type: "payment_received_online",
          permission: "customer.view_ledger",
          severity: "success",
          titleKey: "notifications.events.payment_received_online",
          params: { customer: context.customer, amount: amount.toFixed(2), number: receipt.paymentNumber },
          entityType: "customer",
          entityId: link.customerId,
          dedupeKey: `payment_online:${fresh.id}`,
        },
        nowIso,
      );
      recorded++;
    }

    const [sum] = await tx.select({ paid: sql<string>`coalesce(sum(${g.amount}), 0)::text` }).from(g).where(eq(g.linkId, link.id));
    const known = dec(sum?.paid ?? 0);
    const reported = dec(state.amountPaid);
    const amountPaid = reported.gt(known) ? reported : known;
    let status: LinkStatus = link.status === "paid" ? "paid" : state.status;
    if (status !== "paid" && (amountPaid.gte(link.amount) || (state.status === "paid" && known.gt(0)))) status = "paid";
    if (opts.cancelled && OPEN.includes(status)) status = "cancelled";
    // A gateway slow to say so: an open link an hour past its time has run out.
    const lapsed = OPEN.includes(status) && (await tx.execute<{ lapsed: boolean }>(sql`select ${link.expiresAt}::timestamptz < ${nowIso}::timestamptz - interval '1 hour' as lapsed`)).rows[0]?.lapsed;
    if (lapsed) status = "expired";
    await tx
      .update(l)
      .set({
        status,
        amountPaid: amountPaid.toFixed(2),
        ...(status === "paid" && !link.paidAt ? { paidAt: nowIso } : {}),
        lastCheckedAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(l.id, link.id));
    return { recorded, status };
  });
}

/**
 * Asks the gateway how a link stands and applies it. A link made with keys
 * the business no longer uses (another gateway, test keys replaced by live
 * ones) cannot be asked about: it is only closed once its time has run out.
 */
export async function refreshLink(deps: AppDeps, scope: LinkScope, linkId: string, opts: { minAgeSeconds?: number } = {}): Promise<{ recorded: number; status: LinkStatus } | null> {
  const found = await withTenant(deps.db, { businessId: scope.businessId, userId: "" }, async (tx) => {
    const l = schema.paymentLinks;
    const [link] = await tx
      .select()
      .from(l)
      .where(and(eq(l.id, linkId), eq(l.businessId, scope.businessId)));
    return link ? { link, keys: gatewayKeys(deps, await loadGateway(tx, scope.businessId)) } : null;
  });
  if (!found) return null;
  const { link, keys } = found;
  if (opts.minAgeSeconds && link.lastCheckedAt && deps.clock.now().getTime() - new Date(link.lastCheckedAt).getTime() < opts.minAgeSeconds * 1000) {
    return { recorded: 0, status: link.status };
  }
  if (!keys || keys.provider !== link.provider || keys.environment !== link.environment) {
    return applyLinkState(deps, scope, link.id, { status: link.status, amountPaid: link.amountPaid, payments: [] });
  }
  let state: LinkState;
  try {
    state = await deps.gateways.client(keys.provider).fetchLink(keys, link.providerLinkId);
  } catch (e) {
    throw gatewayApiError(e);
  }
  return applyLinkState(deps, scope, link.id, state);
}

/** Stops a link at the gateway (payments it already took are recorded first). */
export async function cancelPaymentLink(deps: AppDeps, ctx: RequestCtx, linkId: string): Promise<PaymentLinkView> {
  const scope = { businessId: ctx.businessId, timeZone: ctx.timeZone };
  const found = await withTenant(deps.db, ctx, async (tx) => {
    const l = schema.paymentLinks;
    const [link] = await tx
      .select()
      .from(l)
      .where(and(eq(l.id, linkId), eq(l.businessId, ctx.businessId)));
    if (!link) throw notFound("payment_link");
    if (!OPEN.includes(link.status)) throw conflict("PAYMENT_LINK_CLOSED", { status: link.status });
    return { link, keys: gatewayKeys(deps, await loadGateway(tx, ctx.businessId)) };
  });
  const { link, keys } = found;
  if (keys && keys.provider === link.provider && keys.environment === link.environment) {
    const client = deps.gateways.client(keys.provider);
    try {
      await client.cancelLink(keys, link.providerLinkId);
    } catch (e) {
      // Refused: already paid or run out; the check below says which.
      if (!(e instanceof GatewayError && e.code === "GATEWAY_REFUSED")) throw gatewayApiError(e);
    }
    let state: LinkState;
    try {
      state = await client.fetchLink(keys, link.providerLinkId);
    } catch (e) {
      throw gatewayApiError(e);
    }
    await applyLinkState(deps, scope, link.id, state, { cancelled: true });
  } else {
    await applyLinkState(deps, scope, link.id, { status: link.status, amountPaid: link.amountPaid, payments: [] }, { cancelled: true });
  }
  return withTenant(deps.db, ctx, async (tx) => {
    const view = await linkView(tx, ctx.businessId, link.id);
    await audit(tx, ctx, { action: "payment_link.cancelled", entityType: "customer", entityId: link.customerId, entityLabel: view.customerName, changes: { amount: link.amount, status: view.status } });
    return view;
  });
}

// ---------------------------------------------------------------- checking open links

export interface LinkCheckResult {
  businesses: number;
  checked: number;
  recorded: number;
  failed: number;
}

/**
 * Asks the gateways about open links, for payments a webhook did not bring
 * (a server the gateway cannot reach, a webhook not set up, one lost). A link
 * is asked about again after an eighth of its age, at least the poll
 * interval and at most six hours apart: often while new, seldom once old.
 */
export async function runPaymentLinkChecks(deps: AppDeps): Promise<LinkCheckResult> {
  const nowIso = deps.clock.now().toISOString();
  const poll = deps.config.gateways.pollSeconds;
  const due = await deps.db.execute<{ business_id: string; time_zone: string }>(sql`select business_id, time_zone from payment_links_to_check(${nowIso}::timestamptz, ${BUSINESSES})`);
  const result: LinkCheckResult = { businesses: 0, checked: 0, recorded: 0, failed: 0 };
  for (const { business_id: businessId, time_zone: timeZone } of due.rows) {
    result.businesses++;
    const ids = await withTenant(deps.db, { businessId, userId: "" }, async (tx) => {
      const l = schema.paymentLinks;
      const next = sql`${nowIso}::timestamptz - least(interval '6 hours', greatest(make_interval(secs => ${poll}::double precision), (${nowIso}::timestamptz - ${l.createdAt}) / 8))`;
      const rows = await tx
        .select({ id: l.id })
        .from(l)
        .where(and(eq(l.businessId, businessId), inArray(l.status, OPEN), sql`coalesce(${l.lastCheckedAt}, ${l.createdAt}) < ${next}`))
        .orderBy(sql`coalesce(${l.lastCheckedAt}, ${l.createdAt})`)
        .limit(CHECKS_PER_BUSINESS);
      return rows.map((r) => r.id);
    });
    for (const id of ids) {
      try {
        const done = await refreshLink(deps, { businessId, timeZone }, id);
        result.checked++;
        result.recorded += done?.recorded ?? 0;
      } catch (e) {
        result.failed++;
        // The gateway refusing the keys refuses every link: tried again next round.
        if (e instanceof ApiError && e.code === "GATEWAY_AUTH_FAILED") break;
        if (!(e instanceof ApiError && e.code.startsWith("GATEWAY_"))) {
          deps.errors.record(e, { reference: uuidv7(), source: "job", job: "online payments (checking payment links)", details: { businessId, link: id } });
        }
      }
    }
  }
  return result;
}

export function startPaymentLinkPoller(deps: AppDeps, seconds: number, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): () => void {
  if (seconds <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runPaymentLinkChecks(deps);
      if (done.recorded || done.failed) log.info(done, "payment links checked");
    } catch (e) {
      log.warn({ err: rootMessage(e) }, "payment links could not be checked");
      deps.errors.record(e, { reference: uuidv7(), source: "job", job: "online payments (looking for open links)" });
    } finally {
      running = false;
    }
  };
  // A minute, or the poll interval if shorter: each link keeps its own pace (above).
  const timer = setInterval(() => void tick(), Math.min(seconds, 60) * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- links in payment reminders

/** Whether payment reminders this business sends carry a link to pay online. */
export async function payLinksInReminders(tx: Tx, businessId: string): Promise<boolean> {
  const row = await loadGateway(tx, businessId);
  return Boolean(row?.linksInReminders && gatewayReady(row));
}

/**
 * A payment reminder with a link to pay the balance online added to its
 * text. Only on the first try (a retry sends the text as saved), and never
 * to a WhatsApp or SMS template, whose words are fixed. Whatever stops the
 * link (nothing due, the gateway refusing) sends the reminder without one.
 */
export async function withPayLink(deps: AppDeps, queue: { businessId: string; userId: string; userName?: string | null }, row: MessageRow): Promise<MessageRow> {
  if (row.kind !== "reminder" || row.partyType !== "customer" || !row.partyId || row.template || row.attempts > 0) return row;
  let url: string;
  try {
    const { link } = await createPaymentLink(
      deps,
      { businessId: queue.businessId, userId: queue.userId || null, userName: queue.userName ?? null, ip: null, userAgent: "payment reminder", requestId: null },
      { customerId: row.partyId, source: "reminder" },
    );
    url = link.url;
  } catch (e) {
    if (!(e instanceof ApiError)) deps.errors.record(e, { reference: uuidv7(), source: "job", job: "payment link for a reminder", details: { businessId: queue.businessId, message: row.id } });
    return row;
  }
  const { t } = createTranslator(isLocaleCode(row.locale) ? row.locale : "en");
  const body = `${row.body}\n\n${t("messages.payOnline", { url })}`;
  return withTenant(deps.db, { businessId: queue.businessId, userId: queue.userId }, async (tx) => {
    const [updated] = await tx.update(schema.messages).set({ body, updatedAt: sql`now()` }).where(eq(schema.messages.id, row.id)).returning();
    return updated ?? row;
  });
}
