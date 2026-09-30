import { useQuery } from "@tanstack/react-query";
import { addDays, daysBetween, financialYearOf } from "@vyapaar/core";
import { useMemo } from "react";
import {
  CUSTOMERS,
  EXPENSES_BY_DAY,
  INVOICES,
  ORDERS,
  PAYABLE_OUTSTANDING,
  PAYMENTS,
  PURCHASES_BY_DAY,
  TODAY,
  allowed,
} from "../../data/db";
import { LIVE } from "../../data/source";
import {
  brandSales,
  collectionBetween,
  customerInsight,
  rangeDates,
  receivableAging,
  salesBetween,
  topCustomers,
  topProducts,
  useStoreVersion,
  type RangeKey,
} from "../../data/store";
import { api } from "../../lib/api";

export type Grain = "daily" | "weekly" | "monthly" | "yearly";

export interface BarItem {
  id: string;
  label: string;
  amount: number;
}

/** Everything the dashboard renders, whichever source it came from. */
export interface DashboardView {
  today: { sales: number; salesPrev: number; collections: number; collectionsPrev: number; purchases: number | null; expenses: number | null; orders: number };
  month: { sales: number; salesPrev: number; collections: number; collectionsPrev: number; purchases: number | null; purchasesPrev: number | null };
  range: { from: string; to: string; sales: number; salesPrev: number };
  receivable: { total: number; overdue: number; notDue: number; buckets: Array<{ label: string; amount: number; count: number }> };
  payable: number | null;
  orders: { pending: number; toPack: number; toDispatch: number };
  trend: Array<{ from: string; to: string; sales: number; collections: number }>;
  topProducts: BarItem[];
  topCustomers: BarItem[];
  brands: BarItem[];
  attention: Array<{ id: string; name: string; city: string; mobile: string; overdue: number; count: number; oldestDays: number }>;
}

/** Trend buckets, oldest first, the last ending today (the server uses the same rule). */
export function trendBuckets(grain: Grain, today: string, fyStartMonth = 4): Array<{ from: string; to: string }> {
  const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
  const out: Array<{ from: string; to: string }> = [];
  if (grain === "daily") for (let i = 29; i >= 0; i--) out.push({ from: addDays(today, -i), to: addDays(today, -i) });
  else if (grain === "weekly") for (let i = 11; i >= 0; i--) out.push({ from: addDays(today, -7 * i - 6), to: addDays(today, -7 * i) });
  else if (grain === "monthly") {
    const starts = [monthStart(today)];
    for (let i = 0; i < 5; i++) starts.unshift(monthStart(addDays(starts[0]!, -1)));
    starts.forEach((s, i) => out.push({ from: s, to: i === starts.length - 1 ? today : addDays(starts[i + 1]!, -1) }));
  } else {
    const fy = financialYearOf(today, fyStartMonth);
    for (let back = 2; back >= 0; back--) {
      out.push({ from: `${fy.startYear - back}${fy.startDate.slice(4)}`, to: back === 0 ? today : addDays(`${fy.startYear - back + 1}${fy.startDate.slice(4)}`, -1) });
    }
  }
  return out;
}

const sumDays = (rows: Array<{ date: string; amount: number }>, from: string, to: string) =>
  rows.filter((r) => r.date >= from && r.date <= to).reduce((s, r) => s + r.amount, 0);

function demoView(range: RangeKey, grain: Grain): DashboardView {
  const yesterday = addDays(TODAY, -1);
  const monthStart = `${TODAY.slice(0, 8)}01`;
  const lm = rangeDates("lastMonth");
  const sameDayLastMonth = addDays(lm.from, daysBetween(monthStart, TODAY));
  const r = rangeDates(range);
  const aging = receivableAging();
  const salesByDay = new Map<string, number>();
  for (const inv of INVOICES) salesByDay.set(inv.date, (salesByDay.get(inv.date) ?? 0) + inv.total);
  const collByDay = new Map<string, number>();
  for (const p of PAYMENTS) collByDay.set(p.date, (collByDay.get(p.date) ?? 0) + p.amount);
  const bucketSum = (from: string, to: string, m: Map<string, number>) => {
    let s = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) s += m.get(d) ?? 0;
    return s;
  };
  let trend = trendBuckets(grain, TODAY).map((b) => ({ ...b, sales: bucketSum(b.from, b.to, salesByDay), collections: bucketSum(b.from, b.to, collByDay) }));
  if (grain === "yearly") {
    // The sample data covers six months; earlier years are illustrative.
    const current = trend.at(-1)!;
    const factor = 365 / Math.max(1, daysBetween(current.from, TODAY) + 1);
    trend = trend.map((b, i) => (i === 2 ? b : { ...b, sales: (current.sales * factor) / (i === 0 ? 1.26 : 1.12), collections: (current.collections * factor) / (i === 0 ? 1.27 : 1.13) }));
  }
  const attention = CUSTOMERS.map((c) => ({ c, ins: customerInsight(c.id) }))
    .filter((x) => x.ins.overdue > 0)
    .sort((a, b) => b.ins.overdue - a.ins.overdue)
    .slice(0, 5)
    .map(({ c, ins }) => ({ id: c.id, name: c.businessName, city: c.city, mobile: c.mobile, overdue: ins.overdue, count: ins.overdueCount, oldestDays: ins.oldestOverdueDays }));
  return {
    today: {
      sales: salesBetween(TODAY, TODAY),
      salesPrev: salesBetween(yesterday, yesterday),
      collections: collectionBetween(TODAY, TODAY),
      collectionsPrev: collectionBetween(yesterday, yesterday),
      purchases: sumDays(PURCHASES_BY_DAY, TODAY, TODAY),
      expenses: sumDays(EXPENSES_BY_DAY, TODAY, TODAY),
      orders: ORDERS.filter((o) => o.date === TODAY).length,
    },
    month: {
      sales: salesBetween(monthStart, TODAY),
      salesPrev: salesBetween(lm.from, sameDayLastMonth),
      collections: collectionBetween(monthStart, TODAY),
      collectionsPrev: collectionBetween(lm.from, sameDayLastMonth),
      purchases: sumDays(PURCHASES_BY_DAY, monthStart, TODAY),
      purchasesPrev: sumDays(PURCHASES_BY_DAY, lm.from, sameDayLastMonth),
    },
    range: { from: r.from, to: r.to, sales: salesBetween(r.from, r.to), salesPrev: salesBetween(r.prevFrom, r.prevTo) },
    receivable: {
      total: aging.total.toNumber(),
      overdue: aging.total.toNumber() - aging.notDue.toNumber(),
      notDue: aging.notDue.toNumber(),
      buckets: aging.buckets.map((b) => ({ label: b.label, amount: b.amount.toNumber(), count: b.count })),
    },
    payable: PAYABLE_OUTSTANDING,
    orders: {
      pending: ORDERS.filter((o) => o.status === "pending" || o.status === "confirmed").length,
      toPack: ORDERS.filter((o) => o.status === "confirmed" || o.status === "packing").length,
      toDispatch: ORDERS.filter((o) => o.status === "packed").length,
    },
    trend,
    topProducts: topProducts(r.from, r.to),
    topCustomers: topCustomers(r.from, r.to),
    brands: brandSales(r.from, r.to, 6),
    attention,
  };
}

interface Sums {
  sales: string;
  collections: string;
  purchases?: string;
  expenses?: string;
  orders: number;
}

interface ApiDashboard {
  period: { from: string; to: string };
  today: Sums;
  yesterday: Sums;
  current: Sums;
  previous: Sums;
  month: { current: Sums; previous: Sums };
  receivable: { total: string; overdue: string; notDue: string; aging: Array<{ label: string; amount: string; count: number }> };
  payable?: { total: string };
  orders: { pending: number; toPack: number; toDispatch: number };
  trend: Array<{ from: string; to: string; sales: string; collections: string }>;
  topCustomers: Array<{ id: string; name: string; sales: string }>;
  topProducts: Array<{ id: string; name: string; sales: string }>;
  topBrands: Array<{ id: string; name: string; sales: string }>;
  attention: { topOverdue: Array<{ id: string; name: string; mobile: string | null; city: string | null; overdue: string; count: number; oldestDays: number }> };
}

const opt = (v: string | undefined) => (v === undefined ? null : Number(v));

function fromApi(d: ApiDashboard): DashboardView {
  return {
    today: {
      sales: Number(d.today.sales),
      salesPrev: Number(d.yesterday.sales),
      collections: Number(d.today.collections),
      collectionsPrev: Number(d.yesterday.collections),
      purchases: opt(d.today.purchases),
      expenses: opt(d.today.expenses),
      orders: d.today.orders,
    },
    month: {
      sales: Number(d.month.current.sales),
      salesPrev: Number(d.month.previous.sales),
      collections: Number(d.month.current.collections),
      collectionsPrev: Number(d.month.previous.collections),
      purchases: opt(d.month.current.purchases),
      purchasesPrev: opt(d.month.previous.purchases),
    },
    range: { from: d.period.from, to: d.period.to, sales: Number(d.current.sales), salesPrev: Number(d.previous.sales) },
    receivable: {
      total: Number(d.receivable.total),
      overdue: Number(d.receivable.overdue),
      notDue: Number(d.receivable.notDue),
      buckets: d.receivable.aging.map((b) => ({ label: b.label, amount: Number(b.amount), count: b.count })),
    },
    payable: d.payable ? Number(d.payable.total) : null,
    orders: d.orders,
    trend: d.trend.map((b) => ({ from: b.from, to: b.to, sales: Number(b.sales), collections: Number(b.collections) })),
    topProducts: d.topProducts.map((p) => ({ id: p.id, label: p.name, amount: Number(p.sales) })),
    topCustomers: d.topCustomers.map((c) => ({ id: c.id, label: c.name, amount: Number(c.sales) })),
    brands: d.topBrands.map((b) => ({ id: b.id, label: b.name === "-" ? "—" : b.name, amount: Number(b.sales) })),
    attention: d.attention.topOverdue.map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city ?? "",
      mobile: c.mobile ?? "",
      overdue: Number(c.overdue),
      count: c.count,
      oldestDays: c.oldestDays,
    })),
  };
}

/** The dashboard's data: /dashboard in live mode, computed from the sample data otherwise. */
export function useDashboardView(range: RangeKey, grain: Grain): DashboardView | null {
  const version = useStoreVersion();
  const live = useQuery({
    queryKey: ["dashboard", range, grain],
    queryFn: () => api.get<ApiDashboard>("/dashboard", { range, grain }).then(fromApi),
    // Only roles with the sales dashboard; the others get their own parts from /home.
    enabled: LIVE && allowed("dashboard.view"),
    placeholderData: (previous) => previous,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const demo = useMemo(() => (LIVE ? null : demoView(range, grain)), [range, grain, version]);
  return LIVE ? (live.data ?? null) : demo;
}
