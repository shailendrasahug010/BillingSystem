import { addDays } from "@digitalbahi/core";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Field, Input } from "../../components/ui/Field";
import { EmptyState, ProgressBar, Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { TODAY } from "../../data/db";
import { cn } from "../../lib/cn";
import { useOffline } from "../../offline/sync";
import { useBeatReport, weekdayName, type BeatReportRow } from "./data";

type Period = "today" | "yesterday" | "week" | "custom";

/** Monday of the week a day falls in. */
const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((d + 6) % 7));
};

/**
 * Each salesperson's days against the plan (managers): the shops on their
 * routes that day, how many were called on, the productive calls (a bill or
 * an order), shops missed, calls off the plan, what was billed, booked and
 * collected, and why shops did not order.
 */
export function BeatReport() {
  const { t, money, dateMedium, locale } = useI18n();
  const offline = useOffline();
  const [period, setPeriod] = useState<Period>("today");
  const [custom, setCustom] = useState({ from: addDays(TODAY, -6), to: TODAY });
  const range =
    period === "today" ? { from: TODAY, to: TODAY } : period === "yesterday" ? { from: addDays(TODAY, -1), to: addDays(TODAY, -1) } : period === "week" ? { from: mondayOf(TODAY), to: TODAY } : custom;
  const online = !offline.offlineMode && offline.online;
  const valid = range.from <= range.to;
  const report = useBeatReport(range.from, range.to, online && valid);
  const rows = report.data?.rows ?? [];
  const sum = (k: "planned" | "called" | "productive" | "missed" | "offPlan") => rows.reduce((a, r) => a + r[k], 0);
  const sumMoney = (k: "billed" | "ordered" | "collected") => rows.reduce((a, r) => a + Number(r[k]), 0);
  const planned = sum("planned");
  const called = sum("called");
  const reasons = (r: BeatReportRow) => Object.entries(r.noOrderReasons).sort(([, a], [, b]) => b - a);

  if (!online) return <EmptyState title={t("beat.reportOffline")} hint={t("common.connectHint")} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label={t("beat.period")}
          value={period}
          onChange={setPeriod}
          options={[
            { value: "today", label: t("common.today") },
            { value: "yesterday", label: t("common.yesterday") },
            { value: "week", label: t("beat.thisWeek") },
            { value: "custom", label: t("beat.custom") },
          ]}
        />
        {period === "custom" && (
          <div className="flex gap-2">
            <Field label={t("common.from")} htmlFor="beat-from">
              <Input id="beat-from" type="date" max={TODAY} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label={t("common.to")} htmlFor="beat-to">
              <Input id="beat-to" type="date" max={TODAY} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </div>
        )}
      </div>
      <ErrorNote error={report.error} onRetry={() => void report.refetch()} />

      {report.isPending ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : rows.length === 0 ? (
        <EmptyState title={t("beat.reportEmpty")} hint={t("beat.reportEmptyHint")} />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("beat.reportTotals")}>
            <Total label={t("beat.coverage")} value={planned ? `${Math.round((called / planned) * 100)}%` : "—"} sub={t("beat.calledOf", { called, planned })} />
            <Total label={t("beat.productiveCalls")} value={String(sum("productive"))} sub={t("beat.missedCount", { count: sum("missed") })} />
            <Total label={t("beat.billed")} value={money(sumMoney("billed"), 0)} sub={`${t("beat.ordered")} ${money(sumMoney("ordered"), 0)}`} />
            <Total label={t("beat.collected")} value={money(sumMoney("collected"), 0)} sub={t("beat.offPlanCount", { count: sum("offPlan") })} />
          </section>

          {/* Desktop: a table. */}
          <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface shadow-card md:block">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-4 py-2.5 font-medium">{t("beat.day")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("beat.salesperson")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.planned")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.calledCol")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.productiveCalls")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.offPlan")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.billed")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.ordered")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("beat.collected")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("beat.whyNoOrder")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.date}:${r.employeeId}`} className="border-b border-line/70 last:border-b-0">
                    <td className="num px-4 py-2.5 text-ink-2">{`${weekdayName(new Date(`${r.date}T00:00:00Z`).getUTCDay() || 7, locale, "short")} ${dateMedium(r.date)}`}</td>
                    <td className="px-3 py-2.5 font-medium text-ink">{r.salesperson}</td>
                    <td className="num px-3 py-2.5 text-right text-ink-2">{r.planned}</td>
                    <td className={cn("num px-3 py-2.5 text-right", r.missed > 0 ? "text-warn" : "text-ink")}>{r.called}</td>
                    <td className="num px-3 py-2.5 text-right text-ink">{r.productive}</td>
                    <td className="num px-3 py-2.5 text-right text-ink-2">{r.offPlan}</td>
                    <td className="num px-3 py-2.5 text-right text-ink">{money(r.billed, 0)}</td>
                    <td className="num px-3 py-2.5 text-right text-ink">{money(r.ordered, 0)}</td>
                    <td className="num px-3 py-2.5 text-right text-ink">{money(r.collected, 0)}</td>
                    <td className="px-4 py-2.5 text-ink-2">
                      <div className="flex flex-wrap gap-1">
                        {reasons(r).map(([k, n]) => (
                          <Badge key={k} tone="warn">{`${t(`beat.reasons.${k as "other"}`)} × ${n}`}</Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: a card per salesperson and day. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => (
              <li key={`${r.date}:${r.employeeId}`} className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[15px] font-semibold text-ink">{r.salesperson}</p>
                  <p className="shrink-0 text-[12.5px] text-ink-3">{dateMedium(r.date)}</p>
                </div>
                <p className="mt-0.5 text-[13px] text-ink-2">
                  {t("beat.calledOf", { called: r.called, planned: r.planned })} · {t("beat.productiveCount", { count: r.productive })}
                  {r.offPlan > 0 && ` · ${t("beat.offPlanCount", { count: r.offPlan })}`}
                </p>
                <div className="my-2">
                  <ProgressBar value={r.planned ? r.called / r.planned : 0} tone={r.missed > 0 ? "warn" : "good"} label={t("beat.coverage")} />
                </div>
                <p className="num text-[13px] text-ink">
                  {t("beat.billed")} {money(r.billed, 0)} · {t("beat.ordered")} {money(r.ordered, 0)} · {t("beat.collected")} {money(r.collected, 0)}
                </p>
                {reasons(r).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {reasons(r).map(([k, n]) => (
                      <Badge key={k} tone="warn">{`${t(`beat.reasons.${k as "other"}`)} × ${n}`}</Badge>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Total({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3 py-2.5 shadow-card">
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className="num font-display text-[20px] font-semibold text-ink">{value}</p>
      <p className="truncate text-[12px] text-ink-3">{sub}</p>
    </div>
  );
}
