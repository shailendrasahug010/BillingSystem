import { addDays, daysBetween, stockLevel } from "@vyapaar/core";
import {
  ArrowDownRight,
  ArrowUpRight,
  BadgeIndianRupee,
  Boxes,
  ClipboardList,
  CreditCard,
  Package,
  PackageCheck,
  Phone,
  Receipt,
  ShoppingCart,
  Table2,
  Truck,
  UserPlus,
  Users,
  Wallet,
  ChartLine,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter, type Route } from "../../app/router";
import { AgingColumns, BarList } from "../../components/charts/BarList";
import { Legend, TrendChart } from "../../components/charts/TrendChart";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { Kbd, Segmented, Skeleton, useDelayedReady } from "../../components/ui/misc";
import {
  CUSTOMERS,
  EXPENSES_BY_DAY,
  INVOICES,
  ORDERS,
  PAYABLE_OUTSTANDING,
  PAYMENTS,
  PRODUCTS,
  PURCHASES_BY_DAY,
  TODAY,
} from "../../data/mock";
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
import { cn } from "../../lib/cn";

type Grain = "daily" | "weekly" | "monthly" | "yearly";

const sumDays = (rows: Array<{ date: string; amount: number }>, from: string, to: string) =>
  rows.filter((r) => r.date >= from && r.date <= to).reduce((s, r) => s + r.amount, 0);

function Delta({ current, previous, upIsGood = true }: { current: number; previous: number; upIsGood?: boolean }) {
  const { t } = useI18n();
  if (previous <= 0) return null;
  const change = (current - previous) / previous;
  const up = change >= 0;
  const good = up === upIsGood;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[12px] font-medium", good ? "text-good" : "text-danger")} title={t("dashboard.kpi.vsPrevious")}>
      <Icon size={14} aria-hidden />
      <span className="num">{Math.abs(Math.round(change * 100))}%</span>
    </span>
  );
}

function StatTile({
  label,
  value,
  icon,
  delta,
  foot,
  tone,
  onClick,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  delta?: ReactNode;
  foot?: ReactNode;
  tone?: "danger" | "warn";
  onClick?(): void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-4 text-left shadow-card",
        onClick && "transition-colors hover:border-line-strong",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-ink-2">{label}</span>
        <span className={cn("flex size-7 items-center justify-center rounded-md", tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-3")}>
          {icon}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="num font-display text-[24px] leading-none font-semibold text-ink">{value}</span>
        {delta}
      </div>
      {foot && <div className="text-[12px] text-ink-3">{foot}</div>}
    </Tag>
  );
}

export function DashboardPage() {
  const { t, money, compact, date, dateMedium, locale } = useI18n();
  const { navigate } = useRouter();
  useStoreVersion();
  const ready = useDelayedReady(350);
  const [range, setRange] = useState<RangeKey>("thisMonth");
  const [grain, setGrain] = useState<Grain>("daily");
  const [asTable, setAsTable] = useState(false);

  const yesterday = addDays(TODAY, -1);
  const todaySales = salesBetween(TODAY, TODAY);
  const ydaySales = salesBetween(yesterday, yesterday);
  const todayColl = collectionBetween(TODAY, TODAY);
  const ydayColl = collectionBetween(yesterday, yesterday);
  const todayPurchase = sumDays(PURCHASES_BY_DAY, TODAY, TODAY);
  const todayExpense = sumDays(EXPENSES_BY_DAY, TODAY, TODAY);
  const todayOrders = ORDERS.filter((o) => o.date === TODAY).length;
  const monthStart = `${TODAY.slice(0, 8)}01`;
  const lm = rangeDates("lastMonth");
  const sameDayLastMonth = addDays(lm.from, daysBetween(monthStart, TODAY));

  const aging = receivableAging();
  const receivable = aging.total.toNumber();
  const overdue = receivable - aging.notDue.toNumber();
  const pending = ORDERS.filter((o) => o.status === "pending" || o.status === "confirmed");
  const toPack = ORDERS.filter((o) => o.status === "confirmed" || o.status === "packing");
  const toDispatch = ORDERS.filter((o) => o.status === "packed");
  const low = PRODUCTS.filter((p) => stockLevel(p.stock, p.minStock) === "low");
  const out = PRODUCTS.filter((p) => stockLevel(p.stock, p.minStock) === "out_of_stock");

  const r = rangeDates(range);
  const rangeSales = salesBetween(r.from, r.to);
  const prevSales = salesBetween(r.prevFrom, r.prevTo);

  const trend = useMemo(() => {
    const salesByDay = new Map<string, number>();
    for (const inv of INVOICES) salesByDay.set(inv.date, (salesByDay.get(inv.date) ?? 0) + inv.total);
    const collByDay = new Map<string, number>();
    for (const p of PAYMENTS) collByDay.set(p.date, (collByDay.get(p.date) ?? 0) + p.amount);
    const bucket = (from: string, to: string, m: Map<string, number>) => {
      let s = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) s += m.get(d) ?? 0;
      return s;
    };
    const monthName = (iso: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
    if (grain === "daily") {
      const days = Array.from({ length: 30 }, (_, i) => addDays(TODAY, i - 29));
      return {
        labels: days.map((d) => `${Number(d.slice(8))} ${monthName(d)}`),
        tips: days.map((d) => dateMedium(d)),
        sales: days.map((d) => salesByDay.get(d) ?? 0),
        coll: days.map((d) => collByDay.get(d) ?? 0),
      };
    }
    if (grain === "weekly") {
      const weeks = Array.from({ length: 12 }, (_, i) => addDays(TODAY, -7 * (11 - i) - 6));
      return {
        labels: weeks.map((w) => `${Number(w.slice(8))} ${monthName(w)}`),
        tips: weeks.map((w) => `${dateMedium(w)} – ${dateMedium(addDays(w, 6))}`),
        sales: weeks.map((w) => bucket(w, addDays(w, 6), salesByDay)),
        coll: weeks.map((w) => bucket(w, addDays(w, 6), collByDay)),
      };
    }
    if (grain === "monthly") {
      const months: string[] = [];
      let m = monthStart;
      for (let i = 0; i < 6; i++) {
        months.unshift(m);
        m = `${addDays(m, -1).slice(0, 8)}01`;
      }
      const end = (start: string) => {
        const next = `${addDays(start, 32).slice(0, 8)}01`;
        return addDays(next, -1);
      };
      return {
        labels: months.map(monthName),
        tips: months.map((mm) => `${monthName(mm)} ${mm.slice(0, 4)}`),
        sales: months.map((mm) => bucket(mm, end(mm) > TODAY ? TODAY : end(mm), salesByDay)),
        coll: months.map((mm) => bucket(mm, end(mm) > TODAY ? TODAY : end(mm), collByDay)),
      };
    }
    // Yearly: this financial year from real sample data; earlier years are illustrative.
    const fy = rangeDates("thisFy");
    const ytdSales = bucket(fy.from, TODAY, salesByDay);
    const ytdColl = bucket(fy.from, TODAY, collByDay);
    const factor = 365 / Math.max(1, daysBetween(fy.from, TODAY) + 1);
    const y = Number(fy.from.slice(0, 4));
    const fyLabel = (start: number) => `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
    return {
      labels: [fyLabel(y - 2), fyLabel(y - 1), `${fyLabel(y)} YTD`],
      tips: [fyLabel(y - 2), fyLabel(y - 1), `${fyLabel(y)} (${t("dashboard.range.thisFy")})`],
      sales: [(ytdSales * factor) / 1.26, (ytdSales * factor) / 1.12, ytdSales],
      coll: [(ytdColl * factor) / 1.27, (ytdColl * factor) / 1.13, ytdColl],
    };
  }, [grain, locale, dateMedium, monthStart, t]);

  const attention = useMemo(
    () =>
      CUSTOMERS.map((c) => ({ c, ins: customerInsight(c.id) }))
        .filter((x) => x.ins.overdue > 0)
        .sort((a, b) => b.ins.overdue - a.ins.overdue)
        .slice(0, 5),
    [],
  );

  const actions: Array<{ label: string; icon: ReactNode; route: Route; keys?: string; primary?: boolean }> = [
    { label: t("dashboard.actions.createInvoice"), icon: <Receipt size={16} />, route: { name: "invoice-new" }, keys: "mod+i", primary: true },
    { label: t("dashboard.actions.newOrder"), icon: <ClipboardList size={16} />, route: { name: "planned", module: "orders" }, keys: "alt+o" },
    { label: t("dashboard.actions.receivePayment"), icon: <Wallet size={16} />, route: { name: "planned", module: "payments" }, keys: "alt+c" },
    { label: t("dashboard.actions.purchaseEntry"), icon: <ShoppingCart size={16} />, route: { name: "planned", module: "purchases" }, keys: "alt+p" },
    { label: t("dashboard.actions.addCustomer"), icon: <UserPlus size={16} />, route: { name: "customers" } },
    { label: t("dashboard.actions.addSupplier"), icon: <Users size={16} />, route: { name: "planned", module: "suppliers" } },
    { label: t("dashboard.actions.paySupplier"), icon: <CreditCard size={16} />, route: { name: "planned", module: "payments" } },
    { label: t("dashboard.actions.stockAdjustment"), icon: <Boxes size={16} />, route: { name: "planned", module: "inventory" } },
    { label: t("dashboard.actions.addProduct"), icon: <Package size={16} />, route: { name: "products" } },
    { label: t("dashboard.actions.addExpense"), icon: <BadgeIndianRupee size={16} />, route: { name: "planned", module: "expenses" } },
  ];

  const agingLabels: Record<string, string> = {
    notDue: t("dashboard.charts.notDue"),
    "0-30": "1–30",
    "31-60": "31–60",
    "61-90": "61–90",
    "90+": "90+",
  };

  const weekday = new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${TODAY}T00:00:00Z`),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-ink-3">{weekday}</p>
          <h1 className="mt-0.5 text-[26px] leading-tight font-semibold text-ink sm:text-[30px]">{t("dashboard.greeting", { name: "Anil" })}</h1>
        </div>
      </div>

      {/* Quick actions */}
      <section aria-label={t("dashboard.quickActions")} className="-mx-4 px-4 scroll-x sm:mx-0 sm:px-0">
        <div className="flex w-max gap-2 pb-1 sm:w-auto sm:flex-wrap">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => navigate(a.route)}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] border px-3.5 text-[13.5px] font-medium whitespace-nowrap transition-colors",
                a.primary ? "border-transparent bg-accent text-ink-inverse shadow-card hover:bg-accent-hover" : "border-line bg-surface text-ink hover:border-accent",
              )}
            >
              <span className={a.primary ? "" : "text-accent"}>{a.icon}</span>
              {a.label}
              {a.keys && <Kbd keys={a.keys} className={cn("hidden xl:inline-flex", a.primary && "[&_kbd]:border-white/30 [&_kbd]:bg-white/15 [&_kbd]:text-white")} />}
            </button>
          ))}
        </div>
      </section>

      {/* Today */}
      <section aria-labelledby="today-h" className="flex flex-col gap-3">
        <h2 id="today-h" className="eyebrow">{t("dashboard.section.today")}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {ready ? (
            <>
              <StatTile label={t("dashboard.kpi.todaySales")} icon={<Receipt size={15} />} value={money(todaySales, 0)} delta={<Delta current={todaySales} previous={ydaySales} />} foot={t("common.yesterday") + " " + money(ydaySales, 0)} />
              <StatTile label={t("dashboard.kpi.todayCollection")} icon={<Wallet size={15} />} value={money(todayColl, 0)} delta={<Delta current={todayColl} previous={ydayColl} />} foot={t("common.yesterday") + " " + money(ydayColl, 0)} />
              <StatTile label={t("dashboard.kpi.todayPurchase")} icon={<ShoppingCart size={15} />} value={money(todayPurchase, 0)} />
              <StatTile label={t("dashboard.kpi.todayExpenses")} icon={<BadgeIndianRupee size={15} />} value={money(todayExpense, 0)} />
              <StatTile label={t("dashboard.kpi.todayOrders")} icon={<ClipboardList size={15} />} value={todayOrders} onClick={() => navigate({ name: "planned", module: "orders" })} />
            </>
          ) : (
            Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <Skeleton className="w-24" />
                <Skeleton className="h-6 w-28" />
                <Skeleton className="w-20" />
              </div>
            ))
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Trend */}
        <Card>
          <CardHeader
            title={t("dashboard.charts.salesTrend")}
            action={
              <div className="flex items-center gap-2">
                <Segmented
                  size="sm"
                  label={t("dashboard.charts.salesTrend")}
                  value={grain}
                  onChange={setGrain}
                  options={[
                    { value: "daily", label: t("dashboard.charts.daily") },
                    { value: "weekly", label: t("dashboard.charts.weekly") },
                    { value: "monthly", label: t("dashboard.charts.monthly") },
                    { value: "yearly", label: t("dashboard.charts.yearly") },
                  ]}
                />
                <button
                  type="button"
                  onClick={() => setAsTable((v) => !v)}
                  aria-pressed={asTable}
                  className="inline-flex size-8 items-center justify-center rounded-lg border border-line text-ink-2 hover:bg-surface-2"
                  aria-label={asTable ? t("dashboard.charts.chart") : t("dashboard.charts.table")}
                  title={asTable ? t("dashboard.charts.chart") : t("dashboard.charts.table")}
                >
                  {asTable ? <ChartLine size={15} /> : <Table2 size={15} />}
                </button>
              </div>
            }
          />
          <div className="px-4 pt-3 pb-4 sm:px-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <Legend
                items={[
                  { label: t("dashboard.charts.sales"), color: "var(--series-1)" },
                  { label: t("dashboard.charts.collection"), color: "var(--series-2)" },
                ]}
              />
              <span className="num text-[12.5px] text-ink-3">
                {t("dashboard.charts.sales")} {compact(trend.sales.reduce((a, b) => a + b, 0))} · {t("dashboard.charts.collection")} {compact(trend.coll.reduce((a, b) => a + b, 0))}
              </span>
            </div>
            {ready ? (
              <TrendChart
                ariaLabel={t("dashboard.charts.salesTrend")}
                labels={trend.labels}
                tooltipLabels={trend.tips}
                series={[
                  { key: "sales", label: t("dashboard.charts.sales"), color: "var(--series-1)", values: trend.sales },
                  { key: "coll", label: t("dashboard.charts.collection"), color: "var(--series-2)", values: trend.coll },
                ]}
                formatValue={(v) => money(v, 0)}
                formatAxis={(v) => compact(v)}
                showTable={asTable}
                tableHeader={t("common.date")}
              />
            ) : (
              <Skeleton className="h-[240px] w-full" />
            )}
          </div>
        </Card>

        {/* Money + operations + stock */}
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label={t("dashboard.kpi.receivable")}
              icon={<ArrowDownRight size={15} />}
              value={compact(receivable)}
              tone={overdue > 0 ? "danger" : undefined}
              foot={<span className="text-danger">{t("dashboard.kpi.overdue", { amount: compact(overdue) })}</span>}
              onClick={() => navigate({ name: "customers" })}
            />
            <StatTile label={t("dashboard.kpi.payable")} icon={<ArrowUpRight size={15} />} value={compact(PAYABLE_OUTSTANDING)} onClick={() => navigate({ name: "planned", module: "suppliers" })} />
          </div>
          <Card className="p-2">
            <p className="eyebrow px-3 pt-2 pb-1">{t("dashboard.section.operations")}</p>
            {[
              { label: t("dashboard.kpi.pendingOrders"), n: pending.length, icon: <ClipboardList size={16} />, route: { name: "planned", module: "orders" } as Route },
              { label: t("dashboard.kpi.toPack"), n: toPack.length, icon: <PackageCheck size={16} />, route: { name: "planned", module: "packing" } as Route },
              { label: t("dashboard.kpi.toDispatch"), n: toDispatch.length, icon: <Truck size={16} />, route: { name: "planned", module: "dispatch" } as Route },
            ].map((row) => (
              <button
                key={row.label}
                type="button"
                onClick={() => navigate(row.route)}
                className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[14px] text-ink hover:bg-surface-2"
              >
                <span className="text-ink-3">{row.icon}</span>
                <span className="flex-1">{row.label}</span>
                <span className="num font-display text-[18px] font-semibold">{row.n}</span>
              </button>
            ))}
          </Card>
        </div>
      </div>

      {/* Range analytics */}
      <section className="flex flex-col gap-3" aria-labelledby="range-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="range-h" className="text-[18px] font-semibold text-ink">
            {t("dashboard.summaryFor", { range: t(`dashboard.range.${range}`) })}
          </h2>
          <div className="flex items-center gap-3">
            <span className="num text-[13px] text-ink-2">
              {t("dashboard.charts.sales")} <strong className="text-ink">{money(rangeSales, 0)}</strong>
            </span>
            <Delta current={rangeSales} previous={prevSales} />
            <label className="sr-only" htmlFor="range-select">
              {t("common.date")}
            </label>
            <Select id="range-select" value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className="h-9 w-auto min-w-40">
              {(["today", "yesterday", "last7", "thisMonth", "lastMonth", "thisFy"] as RangeKey[]).map((k) => (
                <option key={k} value={k}>
                  {t(`dashboard.range.${k}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p className="-mt-1 text-[12.5px] text-ink-3">
          {date(r.from)} – {date(r.to)}
        </p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title={t("dashboard.charts.topProducts")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList ariaLabel={t("dashboard.charts.topProducts")} items={topProducts(r.from, r.to)} format={(v) => compact(v)} />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("dashboard.charts.topCustomers")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList
                ariaLabel={t("dashboard.charts.topCustomers")}
                items={topCustomers(r.from, r.to)}
                format={(v) => compact(v)}
                onSelect={(id) => navigate({ name: "customer", customerId: id })}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("dashboard.charts.companySales")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList ariaLabel={t("dashboard.charts.companySales")} items={brandSales(r.from, r.to, 6)} format={(v) => compact(v)} />
            </div>
          </Card>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Card>
          <CardHeader title={t("dashboard.charts.outstandingAging")} subtitle={`${t("dashboard.charts.daysPastDue")} · ${t("dashboard.kpi.receivable")} ${money(receivable, 0)}`} />
          <div className="px-4 pt-4 pb-5 sm:px-5">
            <AgingColumns
              ariaLabel={t("dashboard.charts.outstandingAging")}
              labels={agingLabels}
              format={(v) => compact(v)}
              buckets={[
                { key: "notDue", amount: aging.notDue.toNumber(), count: 0 },
                ...aging.buckets.map((b) => ({ key: b.label, amount: b.amount.toNumber(), count: b.count })),
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title={t("dashboard.needsAttention")} subtitle={t("customer.filters.overdue")} />
          <ul className="px-2 pt-2 pb-3">
            {attention.map(({ c, ins }) => (
              <li key={c.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-2">
                <button type="button" onClick={() => navigate({ name: "customer", customerId: c.id })} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-[14px] font-medium text-ink">{c.businessName}</p>
                  <p className="text-[12.5px] text-ink-3">
                    {c.city} · {t("credit.overdue_invoices", { count: ins.overdueCount, amount: ins.overdue.toFixed(2), days: ins.oldestOverdueDays })}
                  </p>
                </button>
                <span className="num hidden text-[14px] font-semibold text-danger sm:block">{money(ins.overdue, 0)}</span>
                <Button size="sm" variant="ghost" icon={<Phone size={14} />} aria-label={`${t("common.call")} ${c.businessName}`} title={c.mobile}>
                  <span className="hidden sm:inline">{t("common.call")}</span>
                </Button>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-2 lg:col-span-2 xl:col-span-1">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2 pb-1">
            <p className="eyebrow">{t("dashboard.section.stock")}</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="warn">
                {t("status.stock.low")} · <span className="num">{low.length}</span>
              </Badge>
              <Badge tone="danger">
                {t("status.stock.out_of_stock")} · <span className="num">{out.length}</span>
              </Badge>
            </div>
          </div>
          <ul>
            {[...out, ...low].slice(0, 6).map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className={cn("size-2 shrink-0 rounded-full", p.stock <= 0 ? "bg-danger" : "bg-warn")} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ink">{locale === "hi" ? p.nameHi : p.name}</span>
                <span className="num text-ink-3">
                  {p.stock} / {p.minStock}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <section aria-labelledby="month-h" className="flex flex-col gap-3">
        <h2 id="month-h" className="eyebrow">{t("dashboard.section.month")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label={t("dashboard.kpi.monthSales")} icon={<Receipt size={15} />} value={compact(salesBetween(monthStart, TODAY))} delta={<Delta current={salesBetween(monthStart, TODAY)} previous={salesBetween(lm.from, sameDayLastMonth)} />} foot={t("dashboard.kpi.vsPrevious")} />
          <StatTile label={t("dashboard.kpi.monthCollection")} icon={<Wallet size={15} />} value={compact(collectionBetween(monthStart, TODAY))} delta={<Delta current={collectionBetween(monthStart, TODAY)} previous={collectionBetween(lm.from, sameDayLastMonth)} />} foot={t("dashboard.kpi.vsPrevious")} />
          <StatTile label={t("dashboard.kpi.monthPurchase")} icon={<ShoppingCart size={15} />} value={compact(sumDays(PURCHASES_BY_DAY, monthStart, TODAY))} delta={<Delta current={sumDays(PURCHASES_BY_DAY, monthStart, TODAY)} previous={sumDays(PURCHASES_BY_DAY, lm.from, sameDayLastMonth)} upIsGood={false} />} foot={t("dashboard.kpi.vsPrevious")} />
        </div>
      </section>
    </div>
  );
}
