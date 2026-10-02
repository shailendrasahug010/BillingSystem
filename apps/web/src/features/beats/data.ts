import { useQuery } from "@tanstack/react-query";
import { todayIn } from "@digitalbahi/core";
import { useEffect, useMemo, useState } from "react";
import { TODAY } from "../../data/db";
import { insightFrom, type InsightResponse } from "../../data/live";
import { setLiveInsight } from "../../data/store";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { idbGet, idbPut } from "../../offline/idb";
import {
  kindOf,
  offlineScope,
  queueEntry,
  unreachable,
  useOffline,
  workingOffline,
  type CollectionNoteEntry,
  type OrderEntry,
  type OutboxEntry,
  type PaymentEntry,
  type QueuedEntry,
  type VisitEntry,
} from "../../offline/sync";
import { isSealed, seal, unseal, vaultOpen, type Sealed } from "../../offline/vault";

/**
 * Today's beat (Phase 5.4): the salesperson's routes for the day, the
 * customers in the order they are called on, what each is due to buy again
 * and how the day is going. Fetched with each customer's buying, so the bill
 * screen suggests products without a connection, and kept on the phone
 * (encrypted like the rest of its copy): the beat opens without a
 * connection, with the work done here and not sent yet counted in.
 */

export type Outcome = "bill" | "order" | "payment" | "note" | "no_order" | "visited";
const RANK: Record<Outcome, number> = { bill: 0, order: 1, payment: 2, note: 3, no_order: 4, visited: 5 };
export const productive = (o: Outcome | undefined) => o === "bill" || o === "order";

export interface ReorderProduct {
  productId: string;
  productName: string;
  status: "overdue" | "due" | "lapsed";
  daysSinceLast: number;
  typicalIntervalDays: number;
  lastQty: string;
  suggestedQty: string;
}

export interface TodayCall {
  outcome: Outcome;
  billed: number;
  ordered: number;
  collected: number;
  reason: string | null;
  at: string | null;
  /** Some of it was done on this phone and is not sent yet. */
  waiting: boolean;
}

export interface BeatCustomer {
  id: string;
  code: string;
  name: string;
  mobile: string | null;
  city: string | null;
  routeId: string;
  sequence: number | null;
  balance: number;
  overdue: number;
  lastCallOn: string | null;
  daysSinceCall: number | null;
  typicalVisitIntervalDays: number | null;
  reorder: { overdue: number; due: number; lapsed: number; products: ReorderProduct[] };
  today: TodayCall | null;
}

export interface BeatRoute {
  id: string;
  name: string;
  visitDays: number[];
  salespersonId: string | null;
  salesperson: string | null;
  customers: number;
}

export interface Beat {
  date: string;
  weekday: number;
  routes: BeatRoute[];
  customers: BeatCustomer[];
  summary: { planned: number; called: number; productive: number; billed: number; ordered: number; collected: number };
}

type Money = string;
interface ServerBeat {
  date: string;
  weekday: number;
  routes: BeatRoute[];
  customers: Array<
    Omit<BeatCustomer, "balance" | "overdue" | "today"> & {
      balance: Money;
      overdue: Money;
      today: { outcome: Outcome; billed: Money; ordered: Money; collected: Money; reason: string | null; at: string | null } | null;
    }
  >;
  insights?: Record<string, Omit<InsightResponse, "storeAssociations">>;
  storeAssociations?: InsightResponse["storeAssociations"];
  /** When the customers' buying was fetched (kept on the phone with the beat). */
  insightsAt?: string;
}

/** What is kept on the phone: the day's beats (its own, and routes looked at), as the server sent them. */
interface Kept {
  date: string;
  savedAt: string;
  beats: Record<string, ServerBeat>;
}

const OWN = "own";
/** The customers' buying is fetched again after this (the beat itself every time it is opened). */
const INSIGHTS_FOR_MS = 2 * 3600_000;
const keyFor = (s: { userId: string; businessId: string }) => `beat:${s.userId}:${s.businessId}`;

async function readKept(): Promise<Kept | null> {
  const scope = offlineScope();
  if (!scope || !vaultOpen(scope.userId)) return null;
  const stored = await idbGet<{ sealed: Sealed }>("kv", keyFor(scope));
  if (!stored || !isSealed(stored.sealed)) return null;
  return (await unseal<Kept>(stored.sealed, keyFor(scope))) ?? null;
}

async function keep(slot: string, beat: ServerBeat): Promise<void> {
  const scope = offlineScope();
  if (!scope || !vaultOpen(scope.userId)) return;
  const before = await readKept();
  const kept: Kept = { date: beat.date, savedAt: new Date().toISOString(), beats: { ...(before?.date === beat.date ? before.beats : {}), [slot]: beat } };
  const sealed = await seal(kept, keyFor(scope));
  if (sealed) await idbPut("kv", { sealed }, keyFor(scope));
}

/** The bill screen's suggestions for these customers, from the buying the beat brought. */
function seedInsights(beat: ServerBeat): void {
  for (const [id, insight] of Object.entries(beat.insights ?? {})) setLiveInsight(id, insightFrom(id, { ...insight, storeAssociations: beat.storeAssociations ?? [] }));
}

/** The day an entry was made on this phone. */
const madeOn = (e: QueuedEntry) => todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(e.savedAt));

/** Calls made on this phone that are not on the server yet, by customer. */
export function waitingCalls(entries: readonly QueuedEntry[], date: string): Map<string, TodayCall> {
  const out = new Map<string, TodayCall>();
  const add = (customerId: string, outcome: Outcome, money: Partial<Pick<TodayCall, "billed" | "ordered" | "collected">>, reason: string | null = null) => {
    const c = out.get(customerId) ?? { outcome, billed: 0, ordered: 0, collected: 0, reason: null, at: null, waiting: true };
    if (RANK[outcome] < RANK[c.outcome]) c.outcome = outcome;
    c.billed += money.billed ?? 0;
    c.ordered += money.ordered ?? 0;
    c.collected += money.collected ?? 0;
    if (reason) c.reason = reason;
    out.set(customerId, c);
  };
  for (const e of entries) {
    switch (kindOf(e)) {
      case "invoice": {
        const b = e as OutboxEntry;
        if (b.date === date) add(b.customerId, "bill", { billed: b.total });
        break;
      }
      case "order": {
        const o = e as OrderEntry;
        if (o.date === date) add(o.customerId, "order", { ordered: o.estimate });
        break;
      }
      case "payment": {
        const p = e as PaymentEntry;
        if (p.direction === "in" && p.date === date) add(p.partyId, "payment", { collected: p.amount });
        break;
      }
      case "collection-note": {
        const n = e as CollectionNoteEntry;
        if (madeOn(n) === date) add(n.customerId, "note", {});
        break;
      }
      case "visit": {
        const v = e as VisitEntry;
        if (v.date === date) add(v.customerId, v.outcome, {}, v.reason);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const money = (n: number) => Math.round(n * 100) / 100;

/** The server's beat with the work waiting on this phone counted in, and the day's progress worked out again. */
function withWaiting(server: ServerBeat, waiting: Map<string, TodayCall>): Beat {
  const customers: BeatCustomer[] = server.customers.map((c) => {
    const fromServer: TodayCall | null = c.today
      ? { ...c.today, billed: Number(c.today.billed), ordered: Number(c.today.ordered), collected: Number(c.today.collected), waiting: false }
      : null;
    const here = waiting.get(c.id);
    const today =
      fromServer && here
        ? {
            ...fromServer,
            outcome: RANK[here.outcome] < RANK[fromServer.outcome] ? here.outcome : fromServer.outcome,
            billed: money(fromServer.billed + here.billed),
            ordered: money(fromServer.ordered + here.ordered),
            collected: money(fromServer.collected + here.collected),
            reason: here.reason ?? fromServer.reason,
            waiting: true,
          }
        : (fromServer ?? here ?? null);
    return { ...c, balance: Number(c.balance), overdue: Number(c.overdue), today };
  });
  const called = customers.filter((c) => c.today);
  return {
    date: server.date,
    weekday: server.weekday,
    routes: server.routes,
    customers,
    summary: {
      planned: customers.length,
      called: called.length,
      productive: called.filter((c) => productive(c.today!.outcome)).length,
      billed: money(called.reduce((a, c) => a + c.today!.billed, 0)),
      ordered: money(called.reduce((a, c) => a + c.today!.ordered, 0)),
      collected: money(called.reduce((a, c) => a + c.today!.collected, 0)),
    },
  };
}

/**
 * The beat: the person's own for today, or one route's. Online from the
 * server (and kept on the phone); without a connection, or when the server
 * cannot be reached, the copy kept today.
 */
export function useBeat(routeId: string | null) {
  const offline = useOffline();
  const remote = !offline.offlineMode && offline.online;
  const slot = routeId ?? OWN;
  const q = useQuery({
    queryKey: ["beat", slot],
    queryFn: async () => {
      const get = (insights: boolean) => api.get<ServerBeat>("/beats/today", { insights: insights ? "1" : "0", ...(routeId ? { routeId } : {}) });
      // The buying kept with today's beat serves for a while; a shop new to the route brings it all again.
      const before = await readKept();
      const had = before?.date === TODAY ? before.beats[slot] : undefined;
      const recent = Boolean(had?.insights && had.insightsAt && Date.now() - Date.parse(had.insightsAt) < INSIGHTS_FOR_MS);
      let beat = await get(!recent);
      if (recent && beat.customers.some((c) => !had!.insights![c.id])) beat = await get(true);
      else if (recent) beat = { ...beat, insights: had!.insights, storeAssociations: had!.storeAssociations, insightsAt: had!.insightsAt };
      if (!beat.insightsAt) beat = { ...beat, insightsAt: new Date().toISOString() };
      seedInsights(beat);
      void keep(slot, beat);
      return beat;
    },
    enabled: remote,
    staleTime: 0,
  });
  const fromDevice = !remote || (q.isError && unreachable(q.error));
  const [kept, setKept] = useState<{ beat: ServerBeat | null; savedAt: string | null } | undefined>(undefined);
  useEffect(() => {
    if (!fromDevice) return;
    let live = true;
    void readKept().then((k) => {
      if (!live) return;
      const beat = k?.beats[slot] ?? null;
      if (beat) seedInsights(beat);
      setKept({ beat, savedAt: k?.savedAt ?? null });
    });
    return () => {
      live = false;
    };
  }, [fromDevice, slot]);
  const source = fromDevice ? kept?.beat : q.data;
  const beat = useMemo(() => (source ? withWaiting(source, waitingCalls(offline.entries, source.date)) : null), [source, offline.entries]);
  if (fromDevice) {
    return { beat, source: "device" as const, loading: kept === undefined, error: null, savedAt: kept?.savedAt ?? null, stale: Boolean(beat && beat.date !== TODAY), refetch: q.refetch };
  }
  return { beat, source: "server" as const, loading: q.isPending, error: q.isError ? q.error : null, savedAt: null, stale: false, refetch: q.refetch };
}

/**
 * A call that left no bill, order or payment: checked in, or no order and
 * why. Sent at once when online; otherwise kept on the phone (the same id
 * is its key, so one sent twice is kept once) and sent with the rest.
 */
export async function recordVisit(input: {
  customer: { id: string; name: string };
  routeId: string | null;
  date: string;
  outcome: "visited" | "no_order";
  reason: string | null;
  note: string;
}): Promise<"sent" | "kept"> {
  const id = uuid();
  const body = {
    customerId: input.customer.id,
    ...(input.routeId ? { routeId: input.routeId } : {}),
    visitDate: input.date,
    outcome: input.outcome,
    ...(input.outcome === "no_order" && input.reason ? { reason: input.reason } : {}),
    ...(input.note.trim() ? { note: input.note.trim() } : {}),
    visitedAt: new Date().toISOString(),
  };
  if (!workingOffline()) {
    try {
      await api.post("/visits", body, { idempotencyKey: id });
      return "sent";
    } catch (e) {
      if (!unreachable(e)) throw e;
    }
  }
  const scope = offlineScope();
  const kept =
    scope &&
    (await queueEntry({
      kind: "visit",
      id,
      userId: scope.userId,
      businessId: scope.businessId,
      savedAt: new Date().toISOString(),
      status: "pending",
      error: null,
      customerId: input.customer.id,
      customerName: input.customer.name,
      outcome: input.outcome,
      reason: input.outcome === "no_order" ? input.reason : null,
      date: input.date,
      body,
    }));
  if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
  return "kept";
}

/** A route as GET /routes gives it. */
export interface RouteRow {
  id: string;
  name: string;
  visitDays: number[] | null;
  salespersonId: string | null;
  isActive: boolean;
}

/** Every route of the business (online). */
export function useRoutes() {
  const offline = useOffline();
  return useQuery({
    queryKey: ["routes"],
    queryFn: () => api.get<{ data: RouteRow[] }>("/routes").then((r) => r.data),
    enabled: !offline.offlineMode && offline.online,
    staleTime: 60_000,
  });
}

/** The name of an ISO weekday (1 = Monday) in the language shown. */
export function weekdayName(day: number, locale: string, width: "long" | "short" = "long"): string {
  // 1 January 2024 was a Monday.
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day)));
}

export interface BeatReportRow {
  date: string;
  employeeId: string;
  salesperson: string;
  planned: number;
  called: number;
  missed: number;
  productive: number;
  offPlan: number;
  billed: string;
  ordered: string;
  collected: string;
  noOrderReasons: Record<string, number>;
}

/** Each salesperson's days against their plan (managers). */
export function useBeatReport(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: ["beat-report", from, to],
    queryFn: () => api.get<{ from: string; to: string; rows: BeatReportRow[] }>("/reports/beats", { from, to }),
    enabled,
  });
}
