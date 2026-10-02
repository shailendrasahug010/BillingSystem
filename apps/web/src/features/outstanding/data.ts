import { useQuery } from "@tanstack/react-query";
import { ageDocuments, daysBetween, type PaymentMethod } from "@digitalbahi/core";
import { useMemo } from "react";
import { CUSTOMERS, customerById, PAYMENTS, TODAY } from "../../data/db";
import { LIVE } from "../../data/source";
import { customerInsight, useStoreVersion } from "../../data/store";
import { api } from "../../lib/api";
import { byCity, cityKey } from "../../lib/places";
import { unreachable, useOffline } from "../../offline/sync";

export type Sort = "amount" | "overdue" | "oldest" | "name" | "promise";

/** The customer's open promise to pay (made after their last payment). */
export interface PayPromise {
  date: string;
  amount: number | null;
  note: string | null;
}

/** One customer who owes money, as the list shows them. */
export interface OutstandingRow {
  customerId: string;
  code: string;
  name: string;
  contactName: string | null;
  mobile: string | null;
  city: string | null;
  address: string | null;
  routeId: string | null;
  route: string | null;
  outstanding: number;
  overdue: number;
  /** Unknown (null) when read from the copy on the device. */
  openBills: number | null;
  oldestDueDate: string | null;
  daysOverdue: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  promise: PayPromise | null;
  /** The latest visit note or promise, kept or not. */
  lastNote: { kind: "promise" | "note"; note: string | null; date: string } | null;
}

export interface CollectionNote {
  id: string;
  kind: "promise" | "note";
  note: string | null;
  promisedAmount: string | null;
  promisedOn: string | null;
  visitedOn: string;
  createdAt: string;
  by: string | null;
}

export interface OutstandingDetail {
  asOf: string;
  customer: {
    id: string;
    code: string;
    name: string;
    contactName: string | null;
    mobile: string | null;
    altMobile: string | null;
    email: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
    gstin: string | null;
    route: string | null;
    creditLimit: string | null;
    creditDays: number;
  };
  outstanding: string;
  overdue: string;
  notDue: string;
  other: string;
  aging: Array<{ label: string; amount: string; count: number }>;
  /** Null when the bills are not on this device (offline). */
  bills: Array<{ id: string; number: string; date: string; dueDate: string; total: string; paid: string; balance: string; daysOverdue: number }> | null;
  payments: Array<{ id: string; number: string | null; date: string; amount: string; method: PaymentMethod }>;
  promise: PayPromise | null;
  notes: CollectionNote[];
}

type ServerPromise = Omit<PayPromise, "amount"> & { amount: string | null };
type ServerRow = Omit<OutstandingRow, "outstanding" | "overdue" | "lastPaymentAmount" | "promise"> & {
  outstanding: string;
  overdue: string;
  lastPaymentAmount: string | null;
  promise: ServerPromise | null;
};

const promiseFrom = (p: ServerPromise | null): PayPromise | null => (p ? { ...p, amount: p.amount === null ? null : Number(p.amount) } : null);

const fromServer = (r: ServerRow): OutstandingRow => ({
  ...r,
  outstanding: Number(r.outstanding),
  overdue: Number(r.overdue),
  lastPaymentAmount: r.lastPaymentAmount === null ? null : Number(r.lastPaymentAmount),
  promise: promiseFrom(r.promise),
});

/** From the customers kept on the device: the demo, and live mode without a connection. */
function deviceRows(): OutstandingRow[] {
  const lastPaid = new Map<string, { date: string; amount: number }>();
  for (const p of PAYMENTS) {
    const seen = lastPaid.get(p.customerId);
    if (!seen || p.date > seen.date) lastPaid.set(p.customerId, { date: p.date, amount: p.amount });
  }
  return CUSTOMERS.flatMap((c) => {
    const ins = customerInsight(c.id);
    if (ins.outstanding <= 0.5) return [];
    const open = LIVE ? [] : ins.openInvoices;
    const oldest = open.reduce<string | null>((m, i) => (m === null || i.dueDate < m ? i.dueDate : m), null);
    const paid = lastPaid.get(c.id);
    return [
      {
        customerId: c.id,
        code: c.code,
        name: c.businessName || c.name,
        contactName: c.businessName && c.businessName !== c.name ? c.name : null,
        mobile: c.mobile || null,
        city: c.city.trim() || null,
        address: c.address || null,
        routeId: null,
        route: c.route || null,
        outstanding: ins.outstanding,
        overdue: ins.overdue,
        openBills: LIVE ? null : open.length,
        oldestDueDate: oldest,
        daysOverdue: oldest && oldest < TODAY ? daysBetween(oldest, TODAY) : 0,
        lastPaymentDate: paid?.date ?? null,
        lastPaymentAmount: paid?.amount ?? null,
        promise: null,
        lastNote: null,
      },
    ];
  });
}

/**
 * Everyone who owes money. Online it comes from the server (bills, oldest due,
 * last payment); without a connection, or when the server cannot be reached,
 * from the balances saved on the device.
 */
export function useOutstandingRows() {
  const offline = useOffline();
  const version = useStoreVersion();
  const remote = LIVE && !offline.offlineMode && offline.online;
  const q = useQuery({
    queryKey: ["collections", "outstanding"],
    queryFn: () => api.get<{ asOf: string; rows: ServerRow[] }>("/collections/outstanding"),
    enabled: remote,
    staleTime: 30_000,
  });
  const onDevice = !remote || (q.isError && unreachable(q.error));
  const device = useMemo(() => (onDevice ? deviceRows() : []), [onDevice, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const server = useMemo(() => q.data?.rows.map(fromServer) ?? [], [q.data]);
  if (onDevice) return { rows: device, source: "device" as const, loading: false, error: null, asOf: TODAY, refetch: q.refetch };
  return { rows: server, source: "server" as const, loading: q.isPending, error: q.isError ? q.error : null, asOf: q.data?.asOf ?? TODAY, refetch: q.refetch };
}

function deviceDetail(row: OutstandingRow): OutstandingDetail {
  const c = customerById.get(row.customerId);
  const ins = customerInsight(row.customerId);
  const bills = LIVE
    ? null
    : ins.openInvoices.map((i) => ({
        id: i.id,
        number: i.number,
        date: i.date,
        dueDate: i.dueDate,
        total: i.total.toFixed(2),
        paid: i.paid.toFixed(2),
        balance: (i.total - i.paid).toFixed(2),
        daysOverdue: i.dueDate < TODAY ? daysBetween(i.dueDate, TODAY) : 0,
      }));
  const aged = bills ? ageDocuments(bills, { asOf: TODAY, basis: "due_date" }) : null;
  const onBills = bills?.reduce((s, b) => s + Number(b.balance), 0) ?? 0;
  return {
    asOf: TODAY,
    customer: {
      id: row.customerId,
      code: row.code,
      name: row.name,
      contactName: row.contactName,
      mobile: row.mobile,
      altMobile: null,
      email: null,
      address: row.address,
      city: row.city,
      pincode: c?.pincode || null,
      gstin: c?.gstin ?? null,
      route: row.route,
      creditLimit: c?.creditLimit === null || c?.creditLimit === undefined ? null : String(c.creditLimit),
      creditDays: c?.creditDays ?? 0,
    },
    outstanding: row.outstanding.toFixed(2),
    overdue: row.overdue.toFixed(2),
    notDue: Math.max(0, (bills ? onBills : row.outstanding) - row.overdue).toFixed(2),
    other: bills && row.outstanding - onBills > 0.5 ? (row.outstanding - onBills).toFixed(2) : "0.00",
    aging: aged ? aged.buckets.map((b) => ({ label: b.label, amount: b.amount.toFixed(2), count: b.count })) : [],
    bills,
    payments: PAYMENTS.filter((p) => p.customerId === row.customerId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .map((p) => ({ id: p.id, number: p.number, date: p.date, amount: p.amount.toFixed(2), method: p.method })),
    promise: row.promise,
    notes: [],
  };
}

/** One customer's bills, their age and the last payments. */
export function useOutstandingDetail(row: OutstandingRow | null, source: "server" | "device") {
  const q = useQuery({
    queryKey: ["collections", "customer", row?.customerId],
    queryFn: () =>
      api
        .get<Omit<OutstandingDetail, "bills" | "promise"> & { bills: NonNullable<OutstandingDetail["bills"]>; promise: ServerPromise | null }>(`/collections/outstanding/${row!.customerId}`)
        .then((d): OutstandingDetail => ({ ...d, promise: promiseFrom(d.promise) })),
    enabled: Boolean(row) && source === "server",
  });
  const onDevice = source === "device" || (q.isError && unreachable(q.error));
  if (!row) return { detail: null, loading: false, error: null };
  if (onDevice) return { detail: deviceDetail(row), loading: false, error: null };
  return { detail: q.data ?? null, loading: q.isPending, error: q.isError ? q.error : null };
}

/** Adds rupee amounts in whole paise, so a total never drifts from its parts. */
export const sumMoney = (values: number[]) => values.reduce((acc, v) => acc + Math.round(v * 100), 0) / 100;

export interface Place {
  key: string;
  label: string | null;
  customers: number;
  total: number;
}

/** The places with money owed, largest first; customers without a city last. */
export function placesOf(rows: OutstandingRow[]): Place[] {
  return byCity(rows, (r) => r.city)
    .map((g) => ({ key: g.key, label: g.label, customers: g.rows.length, total: sumMoney(g.rows.map((r) => r.outstanding)) }))
    .sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : b.total - a.total));
}

export interface Filters {
  /** A place key (see cityKey); "" is customers without a city; null is everywhere. */
  place: string | null;
  route: string;
  q: string;
  overdueOnly: boolean;
  /** Promised to pay by today (or earlier) and not paid since. */
  promiseDue: boolean;
  sort: Sort;
}

/** Promised by today or earlier, and not paid since. */
export const promiseDue = (r: OutstandingRow, today: string) => r.promise !== null && r.promise.date <= today;

export function applyFilters(rows: OutstandingRow[], f: Filters): OutstandingRow[] {
  const q = f.q.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return rows
    .filter(
      (r) =>
        (f.place === null || cityKey(r.city) === f.place) &&
        (!f.route || r.route === f.route) &&
        (!f.overdueOnly || r.overdue > 0) &&
        (!f.promiseDue || promiseDue(r, TODAY)) &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          (r.contactName ?? "").toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q) ||
          (r.city ?? "").toLowerCase().includes(q) ||
          (digits.length >= 3 && (r.mobile ?? "").replace(/\D/g, "").includes(digits))),
    )
    .sort((a, b) => {
      switch (f.sort) {
        case "overdue":
          return b.overdue - a.overdue || b.outstanding - a.outstanding;
        case "oldest":
          return (a.oldestDueDate ?? "9999").localeCompare(b.oldestDueDate ?? "9999") || b.outstanding - a.outstanding;
        case "name":
          return a.name.localeCompare(b.name);
        case "promise":
          return (a.promise?.date ?? "9999").localeCompare(b.promise?.date ?? "9999") || b.outstanding - a.outstanding;
        default:
          return b.outstanding - a.outstanding || a.name.localeCompare(b.name);
      }
    });
}
