import { ChevronRight, MapPinned, Phone, RefreshCw, RotateCcw, WifiOff } from "lucide-react";
import { Tabs } from "radix-ui";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { IconButton } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { CountUp, EmptyState, Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote, PageHeader, TAB_TRIGGER } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { cn } from "../../lib/cn";
import { useOffline } from "../../offline/sync";
import { BeatCustomerSheet } from "./BeatCustomerSheet";
import { BeatReport } from "./BeatReport";
import { CallBadge } from "./CallBadge";
import { productive, useBeat, useRoutes, weekdayName } from "./data";
import { RoutesTab } from "./RoutesTab";

/**
 * Beat (Phase 5.4): the salesperson's day on their routes. Today: the shops
 * of the day's routes in the order they are called on, what each is due to
 * buy again, and how the day is going; a shop opens with its bill, order,
 * payment, "no order" (and why) and call buttons. Works without a
 * connection from the beat kept on the phone. Managers also arrange the
 * routes (weekdays, salesperson, shops in order) and see each
 * salesperson's day against the plan.
 */
export function BeatPage() {
  const { t } = useI18n();
  const canArrange = allowed("customer.update");
  const canReport = allowed("report.view_sales");
  return (
    <div className="stagger flex flex-col gap-5">
      <PageHeader title={t("beat.title")} subtitle={t("beat.subtitle")} />
      {canArrange || canReport ? (
        <Tabs.Root defaultValue="today" className="flex flex-col gap-4">
          <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("beat.title")}>
            <Tabs.Trigger value="today" className={TAB_TRIGGER}>
              {t("beat.tabs.today")}
            </Tabs.Trigger>
            {canArrange && (
              <Tabs.Trigger value="routes" className={TAB_TRIGGER}>
                {t("beat.tabs.routes")}
              </Tabs.Trigger>
            )}
            {canReport && (
              <Tabs.Trigger value="report" className={TAB_TRIGGER}>
                {t("beat.tabs.report")}
              </Tabs.Trigger>
            )}
          </Tabs.List>
          <Tabs.Content value="today">
            <TodayBeat />
          </Tabs.Content>
          {canArrange && (
            <Tabs.Content value="routes">
              <RoutesTab />
            </Tabs.Content>
          )}
          {canReport && (
            <Tabs.Content value="report">
              <BeatReport />
            </Tabs.Content>
          )}
        </Tabs.Root>
      ) : (
        <TodayBeat />
      )}
    </div>
  );
}

type Show = "todo" | "done" | "all";

function TodayBeat() {
  const { t, money, dateMedium, dateTime, locale } = useI18n();
  const offline = useOffline();
  const [routeId, setRouteId] = useState<string | null>(null);
  const data = useBeat(routeId);
  const routes = useRoutes();
  const [show, setShow] = useState<Show>("todo");
  const [openId, setOpenId] = useState<string | null>(null);
  const beat = data.beat;
  const todo = beat?.customers.filter((c) => !c.today) ?? [];
  const done = beat?.customers.filter((c) => c.today) ?? [];
  const shown = show === "todo" ? todo : show === "done" ? done : (beat?.customers ?? []);
  const open = beat?.customers.find((c) => c.id === openId) ?? null;
  const multiRoute = (beat?.routes.length ?? 0) > 1;
  const routeName = useMemo(() => new Map(beat?.routes.map((r) => [r.id, r.name]) ?? []), [beat]);
  const s = beat?.summary;

  return (
    <div className="flex flex-col gap-4">
      {/* Which beat: the day's own, or another route's. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-ink">
            {beat ? `${weekdayName(beat.weekday, locale)} · ${dateMedium(beat.date)}` : t("beat.title")}
          </p>
          {beat && beat.routes.length > 0 && (
            <p className="truncate text-[13px] text-ink-3">
              {beat.routes.map((r) => (r.salesperson ? `${r.name} (${r.salesperson})` : r.name)).join(" · ")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {routes.data && routes.data.length > 0 && (
            <Select aria-label={t("beat.whichRoute")} value={routeId ?? ""} onChange={(e) => setRouteId(e.target.value || null)} className="w-48">
              <option value="">{t("beat.myBeat")}</option>
              {routes.data
                .filter((r) => r.isActive)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          )}
          {data.source === "server" && (
            <IconButton label={t("beat.refresh")} onClick={() => void data.refetch()}>
              <RefreshCw size={16} />
            </IconButton>
          )}
        </div>
      </div>

      {data.source === "device" && (
        <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
          <WifiOff size={15} className="mt-0.5 shrink-0" />
          {beat ? (data.stale ? t("beat.offlineOld", { date: dateMedium(beat.date) }) : t("beat.offlineNote", { time: data.savedAt ? dateTime(data.savedAt) : "" })) : null}
          {!beat && !data.loading && t("beat.offlineNone")}
        </p>
      )}

      <ErrorNote error={data.error} />

      {data.loading ? (
        <div className="flex flex-col gap-3" role="status" aria-label={t("common.loading")}>
          <Skeleton className="h-36 w-full rounded-[26px]" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : beat && beat.customers.length > 0 && s ? (
        <>
          {/* How the day is going. */}
          <section className="bg-hero on-dark relative overflow-hidden rounded-[26px] px-4 py-4 shadow-pop sm:px-6 sm:py-5" aria-label={t("beat.progress")}>
            <div className="dots pointer-events-none absolute inset-0 opacity-40" aria-hidden />
            <div className="relative flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-display text-[22px] font-semibold tracking-tight text-ink sm:text-[26px]">{t("beat.calledOf", { called: s.called, planned: s.planned })}</p>
                <p className="text-[13px] text-ink-2">{t("beat.productiveCount", { count: s.productive })}</p>
              </div>
              {/* On the dark card: a white bar on a faint track. */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/20" role="meter" aria-label={t("beat.progress")} aria-valuenow={s.planned ? Math.round((s.called / s.planned) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${s.planned ? (s.called / s.planned) * 100 : 0}%` }} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Amount label={t("beat.billed")} value={s.billed} format={(v) => money(v, 0)} />
                <Amount label={t("beat.ordered")} value={s.ordered} format={(v) => money(v, 0)} />
                <Amount label={t("beat.collected")} value={s.collected} format={(v) => money(v, 0)} />
              </div>
            </div>
          </section>

          <Segmented
            label={t("beat.show")}
            value={show}
            onChange={setShow}
            options={[
              { value: "todo", label: `${t("beat.toVisit")} · ${todo.length}` },
              { value: "done", label: `${t("beat.done")} · ${done.length}` },
              { value: "all", label: `${t("common.all")} · ${beat.customers.length}` },
            ]}
          />

          {shown.length === 0 ? (
            <EmptyState title={show === "todo" ? t("beat.allCalled") : t("beat.noneCalled")} />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
              {shown.map((c) => (
                <li key={c.id} className="flex items-center gap-1 pr-2">
                  <button type="button" onClick={() => setOpenId(c.id)} className="press flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 text-left active:bg-surface-2 sm:pl-4">
                    <span
                      className={cn(
                        "num inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
                        c.today ? (productive(c.today.outcome) ? "bg-good-soft text-good" : "bg-surface-2 text-ink-3") : "bg-accent-soft text-accent-ink",
                      )}
                      aria-hidden
                    >
                      {beat.customers.indexOf(c) + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-ink">{c.name}</p>
                      <p className="truncate text-[12.5px] text-ink-3">
                        {[c.city, multiRoute ? routeName.get(c.routeId) : null, c.lastCallOn ? t("beat.lastCall", { count: c.daysSinceCall ?? 0 }) : t("beat.neverCalled")].filter(Boolean).join(" · ")}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {c.today && <CallBadge call={c.today} />}
                        {!c.today && c.reorder.products.length > 0 && (
                          <Badge tone={c.reorder.overdue > 0 ? "warn" : "accent"} icon={<RotateCcw size={11} />}>
                            {t("beat.dueItems", { count: c.reorder.overdue + c.reorder.due + c.reorder.lapsed })}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {c.balance > 0.5 && <p className="num text-[14px] font-semibold text-ink">{money(c.balance, 0)}</p>}
                      {c.overdue > 0.5 && <p className="num text-[12px] text-danger">{t("dashboard.kpi.overdue", { amount: money(c.overdue, 0) })}</p>}
                      <ChevronRight size={16} className="ml-auto text-ink-3" />
                    </div>
                  </button>
                  {c.mobile && (
                    <a href={`tel:${c.mobile.replace(/\s/g, "")}`} className="press inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-good-soft text-good" aria-label={`${t("common.call")} ${c.name}`}>
                      <Phone size={17} />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : beat ? (
        <EmptyState icon={<MapPinned size={22} />} title={routeId ? t("beat.routeEmpty") : t("beat.noBeat")} hint={routeId ? t("beat.routeEmptyHint") : t("beat.noBeatHint", { day: weekdayName(beat.weekday, locale) })} />
      ) : null}

      {open && beat && <BeatCustomerSheet customer={open} date={beat.date} onClose={() => setOpenId(null)} working={offline.offlineMode || !offline.online} />}
    </div>
  );
}

function Amount({ label, value, format }: { label: string; value: number; format(v: number): string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-white/15 bg-white/10 px-3 py-2 backdrop-blur-sm">
      <span className="truncate text-[12px] font-medium text-ink-2">{label}</span>
      <span className="num truncate font-display text-[17px] leading-tight font-semibold text-ink sm:text-[20px]">
        <CountUp value={value} format={format} />
      </span>
    </div>
  );
}
