import { useSyncExternalStore } from "react";
import {
  addDays,
  ageDocuments,
  computeCustomerStats,
  daysBetween,
  mineAssociations,
  paymentBehaviour,
  type AssociationRule,
  type CustomerProductStats,
  type CustomerSummary,
  type PaymentBehaviour,
} from "@digitalbahi/core";
import {
  CUSTOMERS,
  customerById,
  INVOICES,
  NEXT_INVOICE_NUMBER,
  PAYMENTS,
  productById,
  TODAY,
  FY_SHORT,
} from "./db";
import { LIVE } from "./source";
import type { Invoice, Payment } from "./types";

/**
 * In-memory store standing in for the API + local cache. Screens read through
 * these functions (never the arrays directly), which is the same seam the real
 * app uses: swap this module for TanStack Query hooks over the REST API and an
 * IndexedDB cache, and no screen changes.
 */
let version = 0;
const listeners = new Set<() => void>();
let nextInvoiceSeq = Number(NEXT_INVOICE_NUMBER.split("/").at(-1));
let pendingSync = 0;
let online = true;

function emit() {
  version += 1;
  cache.clear();
  for (const l of listeners) l();
}

/** Tell subscribed screens that workspace data changed (live hydration, saves). */
export function touch(): void {
  emit();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

const cache = new Map<string, unknown>();
function memo<T>(key: string, compute: () => T): T {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
}

export function peekNextInvoiceNumber(): string {
  return `INV/${FY_SHORT}/${String(nextInvoiceSeq).padStart(5, "0")}`;
}

export function saveInvoice(invoice: Omit<Invoice, "id" | "number">, payment?: Omit<Payment, "id" | "number">): Invoice {
  const number = peekNextInvoiceNumber();
  nextInvoiceSeq += 1;
  const saved: Invoice = { ...invoice, id: `i-new-${nextInvoiceSeq}`, number };
  INVOICES.push(saved);
  if (payment && payment.amount > 0) {
    PAYMENTS.push({ ...payment, id: `r-new-${nextInvoiceSeq}`, number: `RCT/${FY_SHORT}/N${nextInvoiceSeq}` });
  }
  if (!online) pendingSync += 1;
  emit();
  return saved;
}

export function getSyncState() {
  return { online, pending: pendingSync };
}

export function setOnline(value: boolean) {
  online = value;
  if (online && pendingSync > 0) {
    // Simulate the sync queue draining.
    setTimeout(() => {
      pendingSync = 0;
      emit();
    }, 1200);
  }
  emit();
}

// ---------------- Customer intelligence ----------------

export interface CustomerInsight {
  summary: CustomerSummary;
  stats: Map<string, CustomerProductStats>;
  totalSales: number;
  invoiceCount: number;
  avgOrderValue: number;
  outstanding: number;
  overdue: number;
  overdueCount: number;
  oldestOverdueDays: number;
  lastPurchase: string | null;
  behaviour: { avgDaysToPay: number | null; onTimeRatio: number | null; rating: PaymentBehaviour };
  openInvoices: Invoice[];
  customerAssociations: AssociationRule[];
  /** Live data: store-wide rules shipped with the insight. */
  storeAssociations?: AssociationRule[];
}

export function customerInvoices(customerId: string): Invoice[] {
  return INVOICES.filter((i) => i.customerId === customerId);
}

export function customerPayments(customerId: string): Payment[] {
  return PAYMENTS.filter((p) => p.customerId === customerId);
}

// Live mode: full insights arrive from the API (useCustomerInsight); until then
// a quick one is built from the cached customer (balance, overdue).
const liveInsights = new Map<string, CustomerInsight>();

export function setLiveInsight(customerId: string, insight: CustomerInsight): void {
  liveInsights.set(customerId, insight);
  emit();
}

export function dropLiveInsight(customerId: string): void {
  liveInsights.delete(customerId);
}

function quickInsight(customerId: string): CustomerInsight {
  const c = customerById.get(customerId);
  return {
    summary: { invoiceCount: 0, firstInvoiceOn: null, lastInvoiceOn: null, typicalVisitIntervalDays: null },
    stats: new Map(),
    totalSales: 0,
    invoiceCount: 0,
    avgOrderValue: 0,
    outstanding: c?.balance ?? 0,
    overdue: c?.overdue ?? 0,
    overdueCount: 0,
    oldestOverdueDays: 0,
    lastPurchase: null,
    behaviour: { avgDaysToPay: null, onTimeRatio: null, rating: "new" },
    openInvoices: [],
    customerAssociations: [],
  };
}

export function customerInsight(customerId: string): CustomerInsight {
  if (LIVE) return liveInsights.get(customerId) ?? quickInsight(customerId);
  return memo(`insight:${customerId}`, () => {
    const invs = customerInvoices(customerId);
    const lines = invs.flatMap((inv) =>
      inv.lines.map((l) => ({ invoiceId: inv.id, date: inv.date, productId: l.productId, qty: l.qty, rate: l.rate })),
    );
    const { summary, products: stats } = computeCustomerStats(lines, { asOf: TODAY, windowDays: 365 });
    const open = invs.filter((i) => i.total - i.paid > 0.5);
    const overdueDocs = open.filter((i) => i.dueDate < TODAY);
    const totalSales = invs.reduce((s, i) => s + i.total, 0);
    return {
      summary,
      stats,
      totalSales,
      invoiceCount: invs.length,
      avgOrderValue: invs.length ? totalSales / invs.length : 0,
      outstanding: open.reduce((s, i) => s + (i.total - i.paid), 0),
      overdue: overdueDocs.reduce((s, i) => s + (i.total - i.paid), 0),
      overdueCount: overdueDocs.length,
      oldestOverdueDays: overdueDocs.length ? Math.max(...overdueDocs.map((d) => daysBetween(d.dueDate, TODAY))) : 0,
      lastPurchase: summary.lastInvoiceOn,
      behaviour: paymentBehaviour(
        invs.map((i) => ({ date: i.date, dueDate: i.dueDate, settledOn: i.settledOn })),
        TODAY,
      ),
      openInvoices: open,
      customerAssociations: mineAssociations(
        invs.map((i) => ({ id: i.id, productIds: i.lines.map((l) => l.productId) })),
        { minPairCount: 3, minConfidence: 0.6, minLift: 1.05 },
      ),
    };
  });
}

/** Store-wide "bought together" rules, recomputed nightly in production. */
export function storeAssociations(): AssociationRule[] {
  return memo("associations", () =>
    mineAssociations(
      INVOICES.filter((i) => daysBetween(i.date, TODAY) <= 180).map((i) => ({ id: i.id, productIds: i.lines.map((l) => l.productId) })),
      { minPairCount: 5, minConfidence: 0.25, minLift: 1.3 },
    ),
  );
}

// ---------------- Dashboard aggregates ----------------

export type RangeKey = "today" | "yesterday" | "last7" | "thisMonth" | "lastMonth" | "thisFy";

export function rangeDates(key: RangeKey): { from: string; to: string; prevFrom: string; prevTo: string } {
  const monthStart = `${TODAY.slice(0, 8)}01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;
  const y = Number(TODAY.slice(0, 4));
  const fyStart = Number(TODAY.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
  const span = (from: string, to: string) => {
    const days = daysBetween(from, to) + 1;
    return { from, to, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
  };
  switch (key) {
    case "today":
      return span(TODAY, TODAY);
    case "yesterday":
      return span(addDays(TODAY, -1), addDays(TODAY, -1));
    case "last7":
      return span(addDays(TODAY, -6), TODAY);
    case "thisMonth":
      return span(monthStart, TODAY);
    case "lastMonth":
      return span(lastMonthStart, lastMonthEnd);
    case "thisFy":
      return span(fyStart, TODAY);
  }
}

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

export function salesBetween(from: string, to: string): number {
  return INVOICES.filter((i) => inRange(i.date, from, to)).reduce((s, i) => s + i.total, 0);
}

export function collectionBetween(from: string, to: string): number {
  return PAYMENTS.filter((p) => inRange(p.date, from, to)).reduce((s, p) => s + p.amount, 0);
}

export function receivableAging() {
  return memo("aging", () =>
    ageDocuments(
      INVOICES.filter((i) => i.total - i.paid > 0.5).map((i) => ({
        id: i.id,
        number: i.number,
        date: i.date,
        dueDate: i.dueDate,
        balance: (i.total - i.paid).toFixed(2),
      })),
      { asOf: TODAY, basis: "due_date" },
    ),
  );
}

export function topProducts(from: string, to: string, limit = 6) {
  const map = new Map<string, number>();
  for (const inv of INVOICES) {
    if (!inRange(inv.date, from, to)) continue;
    for (const l of inv.lines) map.set(l.productId, (map.get(l.productId) ?? 0) + l.qty * l.rate);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, amount]) => ({ id, label: productById.get(id)!.name, amount }));
}

export function topCustomers(from: string, to: string, limit = 6) {
  const map = new Map<string, number>();
  for (const inv of INVOICES) if (inRange(inv.date, from, to)) map.set(inv.customerId, (map.get(inv.customerId) ?? 0) + inv.total);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, amount]) => ({ id, label: CUSTOMERS.find((c) => c.id === id)!.businessName, amount }));
}

export function brandSales(from: string, to: string, limit = 7) {
  const map = new Map<string, number>();
  for (const inv of INVOICES) {
    if (!inRange(inv.date, from, to)) continue;
    for (const l of inv.lines) {
      const brand = productById.get(l.productId)!.brand;
      map.set(brand, (map.get(brand) ?? 0) + l.qty * l.rate);
    }
  }
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, limit).map(([label, amount]) => ({ id: label, label, amount }));
  const rest = sorted.slice(limit).reduce((s, [, a]) => s + a, 0);
  return rest > 0 ? [...head, { id: "other", label: "Other", amount: rest }] : head;
}
