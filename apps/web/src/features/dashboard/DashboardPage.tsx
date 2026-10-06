import { stockLevel } from "@digitalbahi/core";
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
  CalendarCheck,
  CalendarPlus,
  HandCoins,
  UserRoundPlus,
  ChevronUp,
  Ellipsis,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { routePermission } from "../../app/modules";
import { useRouter, type Route } from "../../app/router";
import { AgingColumns, BarList } from "../../components/charts/BarList";
import { Legend, TrendChart } from "../../components/charts/TrendChart";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { Avatar, CountUp, Segmented, Skeleton, useDelayedReady } from "../../components/ui/misc";
import { shortcutLabel } from "../../app/shortcuts";
import { BUSINESS, PRODUCTS, TODAY, allowed } from "../../data/db";
import { useStoreVersion, type RangeKey } from "../../data/store";
import { useSession } from "../../app/session";
import { useDashboardView, type Grain } from "./data";
import { LIVE } from "../../data/source";
import { SetupGuide } from "./SetupGuide";
import { WelcomeCard } from "./WelcomeCard";
import { BackupNote } from "./BackupNote";
import { ExpensesCard, LeaveCard, PayrollCard, PeopleCard, PromisesCard, QueueCard, ReviewCard, roleHeroFigures, useHome } from "./RoleHome";
import { cn } from "../../lib/cn";


function Delta({ current, previous, upIsGood = true, onDark }: { current: number; previous: number; upIsGood?: boolean; onDark?: boolean }) {
  const { t } = useI18n();
  if (previous <= 0) return null;
  const change = (current - previous) / previous;
  const up = change >= 0;
  const good = up === upIsGood;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[12px] font-semibold",
        onDark ? "bg-white/15 text-white" : good ? "bg-good-soft text-good" : "bg-danger-soft text-danger",
      )}
      title={t("dashboard.kpi.vsPrevious")}
    >
      <Icon size={14} aria-hidden />
      <span className="num">{Math.abs(Math.round(change * 100))}%</span>
    </span>
  );
}

type Tint = "blue" | "green" | "orange" | "violet" | "rose" | "teal" | "amber";
const TINT: Record<Tint, string> = {
  blue: "bg-tint-blue-soft text-tint-blue",
  green: "bg-tint-green-soft text-tint-green",
  orange: "bg-tint-orange-soft text-tint-orange",
  violet: "bg-tint-violet-soft text-tint-violet",
  rose: "bg-tint-rose-soft text-tint-rose",
  teal: "bg-tint-teal-soft text-tint-teal",
  amber: "bg-tint-amber-soft text-tint-amber",
};

function StatTile({
  label,
  value,
  icon,
  delta,
  foot,
  tone,
  tint = "blue",
  onClick,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  delta?: ReactNode;
  foot?: ReactNode;
  tone?: "danger" | "warn";
  tint?: Tint;
  onClick?(): void;
}) {
  const Tag = onClick ? "button" : "div";
  const iconTone = tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : TINT[tint];
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-[var(--radius-card)] border border-line/80 bg-surface p-4 text-left shadow-card",
        onClick && "lift press hover:border-line-strong",
      )}
    >
      {/* A soft glow of the tile's colour in the corner. */}
      <span className={cn("pointer-events-none absolute -top-10 -right-10 size-28 rounded-full opacity-70 blur-2xl", iconTone)} aria-hidden />
      <div className="relative flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink-2">{label}</span>
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", iconTone)}>{icon}</span>
      </div>
      <div className="relative flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="num font-display text-[26px] leading-none font-semibold tracking-tight text-ink">{value}</span>
        {delta}
      </div>
      {foot && <div className="relative text-[12px] text-ink-3">{foot}</div>}
    </Tag>
  );
}

/** Today's sales or collection in the banner. */
function HeroFigure({ label, value, format, previous, foot }: { label: string; value: number; format(v: number): string; previous: number; foot: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm md:min-w-[190px]">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      <span className="num font-display text-[26px] leading-tight font-semibold tracking-tight text-ink sm:text-[30px]">
        <CountUp value={value} format={format} />
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
        <Delta current={value} previous={previous} onDark />
        {foot}
      </span>
    </div>
  );
}

/** A banner figure without a comparison (roles without the sales dashboard). */
function PlainFigure({ label, value, format, foot }: { label: string; value: number; format(v: number): string; foot?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm md:min-w-[190px]">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      <span className="num font-display text-[26px] leading-tight font-semibold tracking-tight text-ink sm:text-[30px]">
        <CountUp value={value} format={format} />
      </span>
      {foot && <span className="text-[12px] text-ink-2">{foot}</span>}
    </div>
  );
}

/**
 * Home for every role. With the sales dashboard (dashboard.view): today's
 * money, trends, top sellers, dues and stock. Everyone also gets the parts
 * of their own work the role covers: what to pack and send, who is in and
 * the leave to decide, the salary run, the promises to pay due today.
 */
export function DashboardPage() {
  const { t, money, compact, date, dateMedium, dateWeekday, locale } = useI18n();
  const { navigate } = useRouter();
  useStoreVersion();
  const ready = useDelayedReady(350);
  const [range, setRange] = useState<RangeKey>("thisMonth");
  const [grain, setGrain] = useState<Grain>("daily");
  const [asTable, setAsTable] = useState(false);
  const [allActions, setAllActions] = useState(false);

  const session = useSession();
  // Live: the sales dashboard only for roles that have it; the demo shows everything.
  const full = !LIVE || allowed("dashboard.view");
  const view = useDashboardView(range, grain);
  const home = useHome().data;
  const heroFigures = full ? [] : roleHeroFigures(home, t, money);
  const shown = ready && view !== null;

  const trend = useMemo(() => {
    const buckets = view?.trend ?? [];
    const monthName = (iso: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
    const fyLabel = (iso: string) => {
      const y = Number(iso.slice(0, 4));
      return `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;
    };
    const label = (b: { from: string; to: string }, i: number) =>
      grain === "monthly" ? monthName(b.from) : grain === "yearly" ? `${fyLabel(b.from)}${i === buckets.length - 1 ? " YTD" : ""}` : `${Number(b.from.slice(8))} ${monthName(b.from)}`;
    const tip = (b: { from: string; to: string }) =>
      grain === "daily" ? dateMedium(b.from) : grain === "yearly" ? fyLabel(b.from) : `${dateMedium(b.from)} – ${dateMedium(b.to)}`;
    return {
      labels: buckets.map(label),
      tips: buckets.map(tip),
      sales: buckets.map((b) => b.sales),
      coll: buckets.map((b) => b.collections),
    };
  }, [view, grain, locale, dateMedium]);

  const canOpen = (r: Route) => {
    const need = routePermission(r);
    return !need || allowed(need);
  };
  // Only the actions this person's role can carry out.
  const actions = (
    [
      { label: t("dashboard.actions.createInvoice"), icon: <Receipt size={19} />, route: { name: "invoice-new" }, keys: "mod+i", primary: true, tint: "blue", permission: "invoice.create" },
      { label: t("dashboard.actions.newOrder"), icon: <ClipboardList size={19} />, route: { name: "planned", module: "orders" }, keys: "alt+o", tint: "violet", permission: "order.create" },
      { label: t("dashboard.actions.receivePayment"), icon: <Wallet size={19} />, route: { name: "planned", module: "payments" }, keys: "alt+c", tint: "green", permission: "payment.collect" },
      { label: t("dashboard.actions.purchaseEntry"), icon: <ShoppingCart size={19} />, route: { name: "planned", module: "purchases" }, keys: "alt+p", tint: "teal", permission: "purchase.create" },
      { label: t("dashboard.actions.addCustomer"), icon: <UserPlus size={19} />, route: { name: "customers" }, tint: "orange", permission: "customer.create" },
      { label: t("dashboard.actions.addSupplier"), icon: <Users size={19} />, route: { name: "planned", module: "suppliers" }, tint: "blue", permission: "supplier.create" },
      { label: t("dashboard.actions.paySupplier"), icon: <CreditCard size={19} />, route: { name: "planned", module: "payments" }, tint: "rose", permission: "payment.pay" },
      { label: t("dashboard.actions.stockAdjustment"), icon: <Boxes size={19} />, route: { name: "planned", module: "inventory" }, tint: "amber", permission: "inventory.adjust" },
      { label: t("dashboard.actions.addProduct"), icon: <Package size={19} />, route: { name: "products" }, tint: "violet", permission: "product.create" },
      { label: t("dashboard.actions.addExpense"), icon: <BadgeIndianRupee size={19} />, route: { name: "planned", module: "expenses" }, tint: "rose", permission: "expense.create" },
      { label: t("dashboard.actions.collect"), icon: <HandCoins size={19} />, route: { name: "outstanding" }, tint: "green", permission: "customer.view_ledger", extra: true },
      { label: t("dashboard.actions.packOrders"), icon: <PackageCheck size={19} />, route: { name: "planned", module: "packing" }, tint: "amber", permission: "packing.pack", extra: true },
      { label: t("dashboard.actions.dispatch"), icon: <Truck size={19} />, route: { name: "planned", module: "dispatch" }, tint: "teal", permission: "dispatch.dispatch", extra: true },
      { label: t("dashboard.actions.markAttendance"), icon: <CalendarCheck size={19} />, route: { name: "planned", module: "employees" }, tint: "green", permission: "employee.update", extra: true },
      { label: t("dashboard.actions.addEmployee"), icon: <UserRoundPlus size={19} />, route: { name: "planned", module: "employees" }, tint: "blue", permission: "employee.create", extra: true },
      { label: t("dashboard.actions.applyLeave"), icon: <CalendarPlus size={19} />, route: { name: "planned", module: "leave" }, tint: "violet", permission: "leave.apply", extra: true },
    ] as Array<{ label: string; icon: ReactNode; route: Route; keys?: string; primary?: boolean; tint: Tint; permission: string; extra?: boolean }>
  )
    // The work actions (collect, pack, attendance…) for roles without the sales dashboard; the rest keep the billing actions.
    .filter((a) => allowed(a.permission) && (!a.extra || !full));

  // Orders, packing and dispatch counts, each for the roles that see that stage.
  const operations = [
    { label: t("dashboard.kpi.pendingOrders"), n: view?.orders.pending ?? 0, icon: <ClipboardList size={16} />, tint: "violet" as Tint, route: { name: "planned", module: "orders" } as Route, show: allowed("order.view") },
    { label: t("dashboard.kpi.toPack"), n: view?.orders.toPack ?? 0, icon: <PackageCheck size={16} />, tint: "amber" as Tint, route: { name: "planned", module: "packing" } as Route, show: allowed("order.view") || allowed("packing.view") },
    { label: t("dashboard.kpi.toDispatch"), n: view?.orders.toDispatch ?? 0, icon: <Truck size={16} />, tint: "teal" as Tint, route: { name: "planned", module: "dispatch" } as Route, show: allowed("order.view") || allowed("dispatch.view") },
  ].filter((row) => row.show);

  const agingLabels: Record<string, string> = {
    notDue: t("dashboard.charts.notDue"),
    "0-30": "1–30",
    "31-60": "31–60",
    "61-90": "61–90",
    "90+": "90+",
  };

  const weekday = dateWeekday(TODAY);

  return (
    <div className="stagger flex flex-col gap-6">
      {/* Banner: the day, the greeting and today's money coming in. */}
      <section className="bg-hero on-dark relative overflow-hidden rounded-[26px] px-5 py-5 shadow-pop sm:px-7 sm:py-6">
        <div className="dots pointer-events-none absolute inset-0 opacity-40" aria-hidden />
        <div className="pointer-events-none absolute -top-28 -right-24 size-80 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] text-ink-2">{weekday}</p>
            <h1 className="mt-1 text-[26px] leading-tight font-semibold tracking-tight text-ink sm:text-[32px]">{t("dashboard.greeting", { name: session.user?.name.split(" ")[0] ?? "Anil" })}</h1>
            {BUSINESS.name && <p className="mt-1 truncate text-[13.5px] text-ink-2">{BUSINESS.name}</p>}
          </div>
          {!full ? (
            heroFigures.length > 0 && (
              <div className="grid grid-cols-2 gap-3 md:flex">
                {heroFigures.map((f) => (
                  <PlainFigure key={f.label} {...f} />
                ))}
              </div>
            )
          ) : shown ? (
            <div className="grid grid-cols-2 gap-3 md:flex">
              <HeroFigure label={t("dashboard.kpi.todaySales")} value={view.today.sales} previous={view.today.salesPrev} format={(v) => money(v, 0)} foot={`${t("common.yesterday")} ${money(view.today.salesPrev, 0)}`} />
              <HeroFigure label={t("dashboard.kpi.todayCollection")} value={view.today.collections} previous={view.today.collectionsPrev} format={(v) => money(v, 0)} foot={`${t("common.yesterday")} ${money(view.today.collectionsPrev, 0)}`} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:flex">
              {[0, 1].map((i) => (
                <div key={i} className="flex flex-col gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 md:min-w-[190px]">
                  <Skeleton className="w-24" />
                  <Skeleton className="h-7 w-28" />
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <WelcomeCard />
      {home?.setup && <SetupGuide setup={home.setup} />}
      <BackupNote />

      {/* Quick actions: the four used most, in one colour, and the rest behind "More". */}
      {actions.length > 0 && <section aria-label={t("dashboard.quickActions")}>
        <div className="grid grid-cols-4 gap-x-1.5 gap-y-4 sm:flex sm:flex-wrap sm:gap-2.5">
          {(allActions || actions.length <= 4 ? actions : actions.slice(0, 3)).map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => navigate(a.route)}
              title={a.keys ? `${a.label} (${shortcutLabel(a.keys).join("+")})` : a.label}
              className={cn(
                "press group flex min-w-0 flex-col items-center gap-1.5 text-center",
                "lift sm:flex-row sm:gap-2.5 sm:rounded-2xl sm:border sm:border-line/80 sm:bg-surface sm:py-1.5 sm:pr-3.5 sm:pl-1.5 sm:text-left sm:shadow-card sm:hover:border-line-strong",
              )}
            >
              <span
                className={cn(
                  "flex size-12 shrink-0 items-center justify-center rounded-2xl transition-transform duration-200 group-hover:scale-105 sm:size-9 sm:rounded-xl",
                  a.primary ? "bg-accent bg-accent-grad text-ink-inverse shadow-glow" : "bg-accent-soft text-accent",
                )}
              >
                {a.icon}
              </span>
              <span className="line-clamp-2 text-[11.5px] leading-tight font-medium text-ink sm:text-[13.5px] sm:whitespace-nowrap">{a.label}</span>
            </button>
          ))}
          {actions.length > 4 && (
            <button
              type="button"
              aria-expanded={allActions}
              onClick={() => setAllActions((v) => !v)}
              className="press lift group flex min-w-0 flex-col items-center gap-1.5 text-center sm:flex-row sm:gap-2.5 sm:rounded-2xl sm:border sm:border-dashed sm:border-line-strong sm:bg-surface sm:py-1.5 sm:pr-3.5 sm:pl-1.5 sm:text-left"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-ink-2 sm:size-9 sm:rounded-xl">{allActions ? <ChevronUp size={19} /> : <Ellipsis size={19} />}</span>
              <span className="line-clamp-2 text-[11.5px] leading-tight font-medium text-ink sm:text-[13.5px] sm:whitespace-nowrap">{allActions ? t("suggestions.showLess") : t("common.more")}</span>
            </button>
          )}
        </div>
      </section>}

      {/* The person's own work today, from what their role covers. */}
      {LIVE && home && (() => {
        // On the owner's dashboard, attendance, leave and salary wait for the first employee (a new business has none);
        // an HR person's home is these cards, so it keeps them.
        const staff = !full || home.people === undefined || home.people.employees > 0;
        const cards = [
          home.review && <ReviewCard key="review" data={home.review} />,
          !full && home.orders?.packNext && <QueueCard key="pack" stage="pack" rows={home.orders.packNext} count={home.orders.toPack ?? 0} />,
          !full && home.orders?.dispatchNext && <QueueCard key="dispatch" stage="dispatch" rows={home.orders.dispatchNext} count={home.orders.toDispatch ?? 0} />,
          home.collections && <PromisesCard key="promises" data={home.collections} />,
          staff && home.people && <PeopleCard key="people" data={home.people} />,
          staff && home.leave && <LeaveCard key="leave" data={home.leave} />,
          staff && home.payroll && <PayrollCard key="payroll" data={home.payroll} />,
          !full && home.expenses && <ExpensesCard key="expenses" data={home.expenses} />,
          !full && allowed("product.view") && <StockCard key="stock" />,
        ].filter(Boolean);
        return cards.length > 0 ? (
          <section aria-labelledby="work-h" className="flex flex-col gap-3">
            <h2 id="work-h" className="eyebrow">{t("home.workToday")}</h2>
            <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">{cards}</div>
          </section>
        ) : null;
      })()}

      {full && <>
      {/* Today */}
      <section aria-labelledby="today-h" className="flex flex-col gap-3">
        <h2 id="today-h" className="eyebrow">{t("dashboard.section.today")}</h2>
        <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3">
          {shown ? (
            <>
              {view.today.purchases !== null && <StatTile label={t("dashboard.kpi.todayPurchase")} tint="teal" icon={<ShoppingCart size={17} />} value={<CountUp value={view.today.purchases} format={(v) => money(v, 0)} />} />}
              {view.today.expenses !== null && <StatTile label={t("dashboard.kpi.todayExpenses")} tint="rose" icon={<BadgeIndianRupee size={17} />} value={<CountUp value={view.today.expenses} format={(v) => money(v, 0)} />} />}
              {allowed("order.view") && <StatTile label={t("dashboard.kpi.todayOrders")} tint="violet" icon={<ClipboardList size={17} />} value={<CountUp value={view.today.orders} format={(v) => String(Math.round(v))} />} onClick={() => navigate({ name: "planned", module: "orders" })} />}
            </>
          ) : (
            Array.from({ length: 3 }, (_, i) => (
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
            {shown ? (
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
              icon={<ArrowDownRight size={17} />}
              tint="green"
              value={<CountUp value={view?.receivable.total ?? 0} format={(v) => compact(v)} />}
              tone={(view?.receivable.overdue ?? 0) > 0 ? "danger" : undefined}
              foot={<span className="text-danger">{t("dashboard.kpi.overdue", { amount: compact(view?.receivable.overdue ?? 0) })}</span>}
              {...(canOpen({ name: "outstanding" }) ? { onClick: () => navigate({ name: "outstanding" }) } : canOpen({ name: "customers" }) ? { onClick: () => navigate({ name: "customers" }) } : {})}
            />
            {view?.payable !== null && (
              <StatTile label={t("dashboard.kpi.payable")} icon={<ArrowUpRight size={17} />} tint="orange" value={<CountUp value={view?.payable ?? 0} format={(v) => compact(v)} />} {...(allowed("supplier.view") ? { onClick: () => navigate({ name: "planned", module: "suppliers" }) } : {})} />
            )}
          </div>
          {operations.length > 0 && <Card className="p-2">
            <p className="eyebrow px-3 pt-2 pb-1">{t("dashboard.section.operations")}</p>
            {operations.map((row) => (
              <button
                key={row.label}
                type="button"
                onClick={() => navigate(row.route)}
                // A count the role may see, but a screen it may not open (packing, dispatch).
                disabled={!canOpen(row.route)}
                className="press flex h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left text-[14px] text-ink enabled:hover:bg-surface-2"
              >
                <span className={cn("flex size-8 items-center justify-center rounded-lg", TINT[row.tint])}>{row.icon}</span>
                <span className="flex-1">{row.label}</span>
                <span className="num font-display text-[18px] font-semibold">{row.n}</span>
              </button>
            ))}
          </Card>}
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
              {t("dashboard.charts.sales")} <strong className="text-ink">{money(view?.range.sales ?? 0, 0)}</strong>
            </span>
            <Delta current={view?.range.sales ?? 0} previous={view?.range.salesPrev ?? 0} />
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
          {view ? `${date(view.range.from)} – ${date(view.range.to)}` : "\u00a0"}
        </p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title={t("dashboard.charts.topProducts")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList ariaLabel={t("dashboard.charts.topProducts")} items={view?.topProducts ?? []} empty={view ? t("dashboard.empty.topProducts") : undefined} format={(v) => compact(v)} />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("dashboard.charts.topCustomers")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList
                ariaLabel={t("dashboard.charts.topCustomers")}
                items={view?.topCustomers ?? []} empty={view ? t("dashboard.empty.topCustomers") : undefined}
                format={(v) => compact(v)}
                onSelect={(id) => navigate({ name: "customer", customerId: id })}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("dashboard.charts.companySales")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList ariaLabel={t("dashboard.charts.companySales")} items={view?.brands ?? []} empty={view ? t("dashboard.empty.companySales") : undefined} format={(v) => compact(v)} />
            </div>
          </Card>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.85fr)]">
        {allowed("customer.view_ledger") && <Card>
          <CardHeader title={t("dashboard.charts.outstandingAging")} subtitle={`${t("dashboard.charts.daysPastDue")} · ${t("dashboard.kpi.receivable")} ${money(view?.receivable.total ?? 0, 0)}`} />
          <div className="px-4 pt-4 pb-5 sm:px-5">
            <AgingColumns
              ariaLabel={t("dashboard.charts.outstandingAging")}
              labels={agingLabels}
              format={(v) => compact(v)}
              buckets={[
                { key: "notDue", amount: view?.receivable.notDue ?? 0, count: 0 },
                ...(view?.receivable.buckets ?? []).map((b) => ({ key: b.label, amount: b.amount, count: b.count })),
              ]}
            />
          </div>
        </Card>}
        {allowed("customer.view_ledger") && <Card>
          <CardHeader title={t("dashboard.needsAttention")} subtitle={t("customer.filters.overdue")} />
          {view && view.attention.length === 0 && <p className="px-4 pt-3 pb-5 text-[13px] text-ink-3 sm:px-5">{t("dashboard.empty.attention")}</p>}
          <ul className="px-2 pt-2 pb-3">
            {(view?.attention ?? []).map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2">
                <Avatar name={c.name} />
                <button type="button" onClick={() => navigate({ name: "customer", customerId: c.id })} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-[14px] font-medium text-ink">{c.name}</p>
                  <p className="text-[12.5px] text-ink-3">
                    {c.city ? `${c.city} · ` : ""}
                    {t("credit.overdue_invoices", { count: c.count, amount: c.overdue.toFixed(2), days: c.oldestDays })}
                  </p>
                </button>
                <span className="num hidden text-[14px] font-semibold text-danger sm:block">{money(c.overdue, 0)}</span>
                <Button size="sm" variant="ghost" icon={<Phone size={14} />} aria-label={`${t("common.call")} ${c.name}`} title={c.mobile} disabled={!c.mobile} onClick={() => (window.location.href = `tel:${c.mobile}`)}>
                  <span className="hidden sm:inline">{t("common.call")}</span>
                </Button>
              </li>
            ))}
          </ul>
        </Card>}
        {allowed("product.view") && <StockCard className="lg:col-span-2 xl:col-span-1" />}
      </div>

      <section aria-labelledby="month-h" className="flex flex-col gap-3">
        <h2 id="month-h" className="eyebrow">{t("dashboard.section.month")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label={t("dashboard.kpi.monthSales")} tint="blue" icon={<Receipt size={17} />} value={<CountUp value={view?.month.sales ?? 0} format={(v) => compact(v)} />} delta={<Delta current={view?.month.sales ?? 0} previous={view?.month.salesPrev ?? 0} />} foot={t("dashboard.kpi.vsPrevious")} />
          <StatTile label={t("dashboard.kpi.monthCollection")} tint="green" icon={<Wallet size={17} />} value={<CountUp value={view?.month.collections ?? 0} format={(v) => compact(v)} />} delta={<Delta current={view?.month.collections ?? 0} previous={view?.month.collectionsPrev ?? 0} />} foot={t("dashboard.kpi.vsPrevious")} />
          {view?.month.purchases !== null && (
            <StatTile label={t("dashboard.kpi.monthPurchase")} tint="teal" icon={<ShoppingCart size={17} />} value={<CountUp value={view?.month.purchases ?? 0} format={(v) => compact(v)} />} delta={<Delta current={view?.month.purchases ?? 0} previous={view?.month.purchasesPrev ?? 0} upIsGood={false} />} foot={t("dashboard.kpi.vsPrevious")} />
          )}
        </div>
      </section>
      </>}
    </div>
  );
}

/** Products at or under their minimum, and those out of stock. */
function StockCard({ className }: { className?: string }) {
  const { t, locale } = useI18n();
  useStoreVersion();
  const low = PRODUCTS.filter((p) => stockLevel(p.stock, p.minStock) === "low");
  const out = PRODUCTS.filter((p) => stockLevel(p.stock, p.minStock) === "out_of_stock");
  return (
        <Card className={cn("p-2", className)}>
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
  );
}
