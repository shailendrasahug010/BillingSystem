import { useQuery } from "@tanstack/react-query";
import { BadgeIndianRupee, CalendarCheck, CalendarClock, ChevronRight, FileText, PackageCheck, Phone, Truck } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { routePermission } from "../../app/modules";
import { useRouter, type Route } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Card, CardHeader } from "../../components/ui/Card";
import { Avatar, CountUp } from "../../components/ui/misc";
import { allowed, TODAY } from "../../data/db";
import { LIVE } from "../../data/source";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useReviewReasonText, type ReviewReason } from "../invoice/InvoiceReview";

interface QueueRow {
  id: string;
  number: string | null;
  date: string;
  customer: string;
  city: string | null;
  status: string;
}

/** GET /home: only the parts this person's role may see. */
export interface HomeData {
  asOf: string;
  orders?: { pending?: number; toPack?: number; toDispatch?: number; packNext?: QueueRow[]; dispatchNext?: QueueRow[] };
  people?: { employees: number; present: number; absent: number; halfDay: number; onLeave: number; off: number; notMarked: number };
  leave?: { pending: number; onLeaveToday: number; requests: Array<{ id: string; employee: string; type: string; from: string; to: string; days: string }> };
  payroll?: { month: string; run: { id: string; status: "draft" | "finalized" | "paid"; totalNet: string } | null };
  collections?: {
    outstanding: string;
    overdue: string;
    customers: number;
    promisesDue: number;
    promises: Array<{ customerId: string; name: string; city: string | null; mobile: string | null; date: string; amount: string | null; balance: string }>;
  };
  expenses?: { month: string; total: string; count: number };
  /** Bills made offline held for review (for invoice.review), oldest first; absent when none. */
  review?: { count: number; bills: Array<{ id: string; number: string; date: string; customer: string; total: string; reasons: ReviewReason[] }> };
}

export function useHome() {
  return useQuery({ queryKey: ["home"], queryFn: () => api.get<HomeData>("/home"), enabled: LIVE, staleTime: 30_000 });
}

const canOpen = (r: Route) => {
  const need = routePermission(r);
  return !need || allowed(need);
};

/** A card's "Open" link, only when the role may open that screen. */
function OpenLink({ route }: { route: Route }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  if (!canOpen(route)) return null;
  return (
    <button type="button" onClick={() => navigate(route)} className="inline-flex items-center gap-0.5 text-[13px] font-medium text-accent hover:underline">
      {t("home.open")}
      <ChevronRight size={14} />
    </button>
  );
}

/** Figures for the banner of a role without the sales dashboard: what that person works on. */
export function roleHeroFigures(home: HomeData | undefined, t: ReturnType<typeof useI18n>["t"], money: ReturnType<typeof useI18n>["money"]) {
  const out: Array<{ label: string; value: number; format(v: number): string; foot?: string }> = [];
  const count = (v: number) => String(Math.round(v));
  if (!home) return out;
  if (home.orders?.toPack !== undefined && allowed("packing.view")) out.push({ label: t("dashboard.kpi.toPack"), value: home.orders.toPack, format: count });
  if (home.orders?.toDispatch !== undefined && allowed("dispatch.view")) out.push({ label: t("dashboard.kpi.toDispatch"), value: home.orders.toDispatch, format: count });
  if (home.people) out.push({ label: t("home.present"), value: home.people.present, format: count, foot: t("home.ofEmployees", { count: home.people.employees }) });
  if (home.leave) out.push({ label: t("home.leaveToDecide"), value: home.leave.pending, format: count, foot: t("home.onLeaveToday", { count: home.leave.onLeaveToday }) });
  if (home.collections) {
    out.push({ label: t("collect.toCollect"), value: Number(home.collections.outstanding), format: (v) => money(v, 0), foot: t("dashboard.kpi.overdue", { amount: money(home.collections.overdue, 0) }) });
    out.push({ label: t("home.promisesDue"), value: home.collections.promisesDue, format: count });
  }
  if (!out.length && home.orders?.pending !== undefined) out.push({ label: t("dashboard.kpi.pendingOrders"), value: home.orders.pending, format: count });
  return out.slice(0, 2);
}

/** Bills made offline that reached the server after a rule changed: what each broke, oldest first. */
export function ReviewCard({ data }: { data: NonNullable<HomeData["review"]> }) {
  const { t, money, date } = useI18n();
  const { navigate } = useRouter();
  const reasonText = useReviewReasonText();
  return (
    <Card>
      <CardHeader title={t("home.reviewHeld")} subtitle={String(data.count)} />
      <ul className="px-2 pt-2 pb-3">
        {data.bills.map((b) => (
          <li key={b.id}>
            <button type="button" onClick={() => navigate({ name: "invoice-view", invoiceId: b.id })} className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2">
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-warn-soft text-warn" aria-hidden>
                <FileText size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">
                  <span className="font-mono">{b.number}</span> · {b.customer}
                </span>
                <span className="block text-[12.5px] text-ink-3">
                  {date(b.date)} · {b.reasons[0] ? reasonText(b.reasons[0]) : ""}
                  {b.reasons.length > 1 && ` ${t("home.moreReasons", { count: b.reasons.length - 1 })}`}
                </span>
              </span>
              <span className="num hidden text-[14px] font-semibold text-ink sm:block">{money(b.total, 0)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Promises to pay by today, not paid since: whom to visit or call first. */
export function PromisesCard({ data }: { data: NonNullable<HomeData["collections"]> }) {
  const { t, money, date } = useI18n();
  const { navigate } = useRouter();
  return (
    <Card>
      <CardHeader title={t("home.promisesDue")} subtitle={data.promisesDue > 0 ? String(data.promisesDue) : undefined} action={<OpenLink route={{ name: "outstanding" }} />} />
      {data.promises.length === 0 ? (
        <p className="px-4 pt-2 pb-5 text-[13px] text-ink-3 sm:px-5">{t("home.noPromises")}</p>
      ) : (
        <ul className="px-2 pt-2 pb-3">
          {data.promises.map((p) => (
            <li key={p.customerId} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2">
              <Avatar name={p.name} />
              <button type="button" onClick={() => navigate({ name: "outstanding" })} className="min-w-0 flex-1 text-left">
                <p className="truncate text-[14px] font-medium text-ink">{p.name}</p>
                <p className={cn("flex items-center gap-1 text-[12.5px]", p.date < TODAY ? "text-danger" : "text-accent-ink")}>
                  <CalendarClock size={13} aria-hidden />
                  {p.date < TODAY
                    ? t("collect.promiseMissed", { date: date(p.date) })
                    : p.amount
                      ? t("collect.promised", { amount: money(p.amount, 0), date: date(p.date) })
                      : t("collect.promisedFull", { date: date(p.date) })}
                  {p.city && <span className="text-ink-3">· {p.city}</span>}
                </p>
              </button>
              <span className="num hidden text-[14px] font-semibold text-ink sm:block">{money(p.balance, 0)}</span>
              {p.mobile && (
                <a href={`tel:${p.mobile.replace(/\s/g, "")}`} className="press inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-good-soft text-good" aria-label={`${t("common.call")} ${p.name}`}>
                  <Phone size={15} />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Who is in today, and whose attendance is still to be marked. */
export function PeopleCard({ data }: { data: NonNullable<HomeData["people"]> }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const route: Route = { name: "planned", module: "employees" };
  const cells: Array<{ label: string; n: number; tone: string }> = [
    { label: t("home.present"), n: data.present, tone: "bg-good-soft text-good" },
    { label: t("home.absent"), n: data.absent, tone: "bg-danger-soft text-danger" },
    { label: t("home.onLeave"), n: data.onLeave, tone: "bg-tint-violet-soft text-tint-violet" },
    { label: t("home.halfDay"), n: data.halfDay, tone: "bg-tint-amber-soft text-tint-amber" },
    { label: t("home.notMarked"), n: data.notMarked, tone: "bg-surface-2 text-ink-2" },
  ];
  return (
    <Card>
      <CardHeader title={t("home.peopleToday")} subtitle={t("home.ofEmployees", { count: data.employees })} action={<OpenLink route={route} />} />
      <div className="grid grid-cols-3 gap-2 px-4 pt-3 pb-4 sm:grid-cols-5 sm:px-5">
        {cells.map((c) => (
          <div key={c.label} className={cn("flex flex-col items-center gap-0.5 rounded-2xl px-2 py-2.5", c.tone)}>
            <span className="num font-display text-[22px] leading-none font-semibold">{c.n}</span>
            <span className="text-center text-[11.5px] leading-tight font-medium">{c.label}</span>
          </div>
        ))}
      </div>
      {data.notMarked > 0 && canOpen(route) && (
        <div className="px-4 pb-4 sm:px-5">
          <button type="button" onClick={() => navigate(route)} className="press inline-flex h-9 items-center gap-2 rounded-full bg-accent-soft px-4 text-[13px] font-semibold text-accent-ink">
            <CalendarCheck size={15} />
            {t("home.markAttendance")}
          </button>
        </div>
      )}
    </Card>
  );
}

/** Leave requests waiting for a decision. */
export function LeaveCard({ data }: { data: NonNullable<HomeData["leave"]> }) {
  const { t, date } = useI18n();
  return (
    <Card>
      <CardHeader title={t("home.leaveToDecide")} subtitle={t("home.onLeaveToday", { count: data.onLeaveToday })} action={<OpenLink route={{ name: "planned", module: "leave" }} />} />
      {data.requests.length === 0 ? (
        <p className="px-4 pt-2 pb-5 text-[13px] text-ink-3 sm:px-5">{t("home.noLeave")}</p>
      ) : (
        <ul className="px-2 pt-2 pb-3">
          {data.requests.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-xl px-3 py-2">
              <Avatar name={r.employee} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-ink">{r.employee}</p>
                <p className="num truncate text-[12.5px] text-ink-3">{t("home.leaveLine", { type: r.type, from: date(r.from), to: date(r.to), count: Number(r.days) })}</p>
              </div>
              <Badge tone="warn">{t("leave.status.pending")}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** This month's salary: not worked out, draft, finalised or paid. */
export function PayrollCard({ data }: { data: NonNullable<HomeData["payroll"]> }) {
  const { t, money, locale } = useI18n();
  const month = new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${data.month}T00:00:00Z`));
  const tone = !data.run ? "neutral" : data.run.status === "paid" ? "good" : data.run.status === "finalized" ? "accent" : "warn";
  return (
    <Card className="flex flex-col">
      <CardHeader title={t("home.salaryFor", { month })} action={<OpenLink route={{ name: "planned", module: "payroll" }} />} />
      <div className="flex items-center gap-3 px-4 pt-3 pb-5 sm:px-5">
        <span className="flex size-10 items-center justify-center rounded-xl bg-tint-teal-soft text-tint-teal">
          <FileText size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <Badge tone={tone}>{data.run ? t(`payroll.status.${data.run.status}`) : t("home.salaryNotRun")}</Badge>
          {data.run && <p className="num mt-1 font-display text-[20px] font-semibold text-ink">{money(data.run.totalNet, 0)}</p>}
        </div>
      </div>
    </Card>
  );
}

/** Orders waiting to be packed or sent, oldest first. */
export function QueueCard({ stage, rows, count }: { stage: "pack" | "dispatch"; rows: QueueRow[]; count: number }) {
  const { t, date } = useI18n();
  const { navigate } = useRouter();
  const route: Route = { name: "planned", module: stage === "pack" ? "packing" : "dispatch" };
  const icon: ReactNode = stage === "pack" ? <PackageCheck size={16} /> : <Truck size={16} />;
  return (
    <Card>
      <CardHeader title={stage === "pack" ? t("home.packNext") : t("home.dispatchNext")} subtitle={String(count)} action={<OpenLink route={route} />} />
      {rows.length === 0 ? (
        <p className="px-4 pt-2 pb-5 text-[13px] text-ink-3 sm:px-5">{t("home.nothingWaiting")}</p>
      ) : (
        <ul className="px-2 pt-2 pb-3">
          {rows.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                disabled={!canOpen({ name: "order-view", orderId: o.id })}
                onClick={() => navigate({ name: "order-view", orderId: o.id })}
                className="press flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left enabled:hover:bg-surface-2"
              >
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", stage === "pack" ? "bg-tint-amber-soft text-tint-amber" : "bg-tint-teal-soft text-tint-teal")}>{icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{o.customer}</span>
                  <span className="num block truncate text-[12.5px] text-ink-3">{[o.number, date(o.date), o.city].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Money spent this month, for roles that see expenses but not the sales figures. */
export function ExpensesCard({ data }: { data: NonNullable<HomeData["expenses"]> }) {
  const { t, money } = useI18n();
  return (
    <Card className="flex flex-col">
      <CardHeader title={t("home.expensesMonth")} subtitle={t("home.entries", { count: data.count })} action={<OpenLink route={{ name: "planned", module: "expenses" }} />} />
      <div className="flex items-center gap-3 px-4 pt-3 pb-5 sm:px-5">
        <span className="flex size-10 items-center justify-center rounded-xl bg-tint-rose-soft text-tint-rose">
          <BadgeIndianRupee size={18} />
        </span>
        <span className="num font-display text-[24px] font-semibold text-ink">
          <CountUp value={Number(data.total)} format={(v) => money(v, 0)} />
        </span>
      </div>
    </Card>
  );
}
