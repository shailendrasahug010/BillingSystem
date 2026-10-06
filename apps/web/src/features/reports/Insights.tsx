import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { monthName } from "@digitalbahi/i18n";
import { useI18n } from "../../app/i18n";
import { Legend, TrendChart } from "../../components/charts/TrendChart";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Card, CardHeader } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { EmptyState, ProgressBar, Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote } from "../../components/ui/Page";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { ExportButton, PeriodBar, settingsPeriod } from "./period";
import type { ReportProps } from "./ReportsPage";

interface Metric {
  value: string | null;
  previous: string | null;
  change: string | null;
}

type KpiKey =
  | "netSales"
  | "grossMargin"
  | "marginPercent"
  | "costOfGoodsSold"
  | "bills"
  | "averageBill"
  | "customersBilled"
  | "newCustomers"
  | "returns"
  | "returnRate"
  | "collections"
  | "receivables"
  | "daysSalesOutstanding"
  | "inventoryValue"
  | "turnover"
  | "daysOfInventory";

interface PartyRow {
  key: string;
  name: string;
  code: string | null;
  city: string | null;
  sales: string;
  margin?: string;
  marginPercent?: string | null;
  share: string;
  cumulative: string;
  abc: "A" | "B" | "C";
  previousSales: string;
  change: string | null;
  status: "new" | "lost" | "growing" | "declining";
}

interface PartySection {
  rows: PartyRow[];
  abc: Record<"A" | "B" | "C", { count: number; sales: string; share: string | null }>;
  total: string;
  count: number;
  newCount: number;
  lostCount: number;
  lostSales: string;
}

interface MoverRow {
  productId: string;
  code: string;
  name: string;
  unit: string;
  brand: string | null;
  qtySold: string;
  sales: string;
  margin?: string;
  stock: string;
  stockValue?: string;
  daysOfCover: string | null;
  lastSold: string | null;
}

export interface InsightsData {
  from: string;
  to: string;
  days: number;
  compare: { basis: "previous" | "last_year"; from: string; to: string };
  kpis: Partial<Record<KpiKey, Metric>>;
  trend: Array<{ month: string; sales: string; margin?: string }>;
  customers: PartySection;
  companies: PartySection;
  salespeople: PartySection;
  movers: {
    slowAfterDays: number;
    deadAfterDays: number;
    fast: MoverRow[];
    slow: MoverRow[];
    dead: MoverRow[];
    slowCount: number;
    deadCount: number;
    slowValue?: string;
    deadValue?: string;
  };
}

/** How each measure is shown, and whether a rise is good (true), bad (false) or neither (null). */
const KPIS: Array<{ key: KpiKey; kind: "money" | "count" | "percent" | "days" | "times"; up: boolean | null }> = [
  { key: "netSales", kind: "money", up: true },
  { key: "grossMargin", kind: "money", up: true },
  { key: "marginPercent", kind: "percent", up: true },
  { key: "bills", kind: "count", up: true },
  { key: "averageBill", kind: "money", up: true },
  { key: "customersBilled", kind: "count", up: true },
  { key: "newCustomers", kind: "count", up: true },
  { key: "returnRate", kind: "percent", up: false },
  { key: "collections", kind: "money", up: true },
  { key: "receivables", kind: "money", up: false },
  { key: "daysSalesOutstanding", kind: "days", up: false },
  { key: "inventoryValue", kind: "money", up: null },
  { key: "turnover", kind: "times", up: true },
  { key: "daysOfInventory", kind: "days", up: false },
];

/** The measures shown first. */
const MAIN_KPIS: KpiKey[] = ["netSales", "collections", "marginPercent", "receivables"];

const ABC_TONE: Record<PartyRow["abc"], Tone> = { A: "good", B: "accent", C: "neutral" };
const STATUS_TONE: Record<PartyRow["status"], Tone> = { new: "accent", lost: "danger", growing: "good", declining: "warn" };

/**
 * Business intelligence (Phase 5.5): the period's measures against an
 * earlier period, the 12-month trend, who the sales come from and how stock
 * moves. Drawn from GET /insights; margins and stock values only for roles
 * that may see profit.
 */
export function InsightsReport({ settings, onChange }: ReportProps) {
  const { t, money, compact, number, dateMedium, locale } = useI18n();
  // "Nov 25" under the chart: "11/25" reads like a date.
  const shortMonth = (month: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "short", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  const period = settingsPeriod(settings, onChange);
  const compare = settings.compare ?? "previous";
  const query = { from: period.from, to: period.to, compare };
  const q = useQuery({
    queryKey: ["insights", query],
    queryFn: () => api.get<InsightsData>("/insights", query),
    enabled: Boolean(period.from && period.to),
    placeholderData: (prev) => prev,
  });
  const d = q.data;

  const show = (kind: (typeof KPIS)[number]["kind"], v: string | null) => {
    if (v === null) return "—";
    if (kind === "money") return money(v, 0);
    if (kind === "percent") return `${number(v, 1)}%`;
    if (kind === "days") return t("insights.days", { count: Number(v) });
    if (kind === "times") return t("insights.times", { value: number(v, 2) });
    return number(v, 0);
  };

  return (
    <div className="flex flex-col gap-4">
      <PeriodBar period={period}>
        <Select aria-label={t("insights.compare")} value={compare} onChange={(e) => onChange({ compare: e.target.value as "previous" | "last_year" })} className="md:w-64">
          {(["previous", "last_year"] as const).map((c) => (
            <option key={c} value={c}>
              {t("insights.compare")}: {t(`insights.compareWith.${c}`)}
            </option>
          ))}
        </Select>
      </PeriodBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {d && <p className="text-[12.5px] text-ink-3">{t("insights.comparedPeriod", { from: dateMedium(d.compare.from), to: dateMedium(d.compare.to) })}</p>}

      <section aria-label={t("insights.measures")} className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        {d
          ? [...KPIS.filter((k) => MAIN_KPIS.includes(k.key)), ...KPIS.filter((k) => !MAIN_KPIS.includes(k.key))]
              .filter((k) => d.kpis[k.key])
              .map((k) => {
                const m = d.kpis[k.key]!;
                return <KpiTile key={k.key} label={t(`insights.kpis.${k.key}`)} value={show(k.kind, m.value)} previous={show(k.kind, m.previous)} change={m.change} points={k.kind === "percent"} up={k.up} />;
              })
          : Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[92px] w-full" />)}
      </section>

      {d && (
        <Card>
          <CardHeader title={t("insights.trend")} />
          <div className="px-4 pt-1 pb-4 sm:px-5">
            <div className="mb-2">
              <Legend items={[{ label: t("insights.sales"), color: "var(--series-1)" }, ...(d.trend[0]?.margin !== undefined ? [{ label: t("insights.margin"), color: "var(--series-2)" }] : [])]} />
            </div>
            <TrendChart
              ariaLabel={t("insights.trend")}
              labels={d.trend.map((r) => `${shortMonth(r.month)} ${r.month.slice(2, 4)}`)}
              tooltipLabels={d.trend.map((r) => monthName(r.month, locale))}
              series={[
                { key: "sales", label: t("insights.sales"), color: "var(--series-1)", values: d.trend.map((r) => Number(r.sales)) },
                ...(d.trend[0]?.margin !== undefined ? [{ key: "margin", label: t("insights.margin"), color: "var(--series-2)", values: d.trend.map((r) => Number(r.margin)) }] : []),
              ]}
              formatValue={(v) => money(v, 0)}
              formatAxis={(v) => compact(v)}
              tableHeader={t("insights.month")}
            />
          </div>
        </Card>
      )}

      {d && <Contribution data={d} query={query} />}
      {d && <Movement data={d} query={query} />}
      <p className="text-[12.5px] text-ink-3">{t("insights.hint")}</p>
    </div>
  );
}

function KpiTile({ label, value, previous, change, points, up }: { label: string; value: string; previous: string; change: string | null; points: boolean; up: boolean | null }) {
  const { t, number } = useI18n();
  const n = change === null ? null : Number(change);
  const tone = n === null || n === 0 || up === null ? "neutral" : n > 0 === up ? "good" : "bad";
  const Icon = n === null || n === 0 ? Minus : n > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-3.5 shadow-card">
      <p className="text-[12.5px] text-ink-3">{label}</p>
      <p className="num mt-1 font-display text-[19px] leading-tight font-semibold text-ink">{value}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
        <span className={cn("inline-flex items-center gap-0.5 font-medium", tone === "good" ? "text-good" : tone === "bad" ? "text-danger" : "text-ink-3")}>
          <Icon size={13} aria-hidden />
          {n === null ? t("insights.noComparison") : points ? t("insights.points", { value: `${n > 0 ? "+" : ""}${number(n, 1)}` }) : `${n > 0 ? "+" : ""}${number(n, 1)}%`}
        </span>
        {n !== null && <span>{t("insights.was", { value: previous })}</span>}
      </p>
    </div>
  );
}

type By = "customers" | "companies" | "salespeople";

function Contribution({ data, query }: { data: InsightsData; query: Record<string, string> }) {
  const { t, money, number } = useI18n();
  const [by, setBy] = useState<By>("customers");
  const section = data[by];
  const withMargin = section.rows.some((r) => r.margin !== undefined);
  const name = (r: PartyRow) => r.name || (by === "companies" ? t("insights.noBrand") : by === "salespeople" ? t("insights.unassigned") : "—");
  return (
    <Card>
      <CardHeader
        title={t("insights.contribution")}
        action={<ExportButton path="/insights" query={{ ...query, section: by }} filename={`insights-${by}-${data.from}-${data.to}.csv`} />}
      />
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4 sm:px-5">
        <Segmented label={t("insights.contribution")} value={by} onChange={setBy} options={(["customers", "companies", "salespeople"] as const).map((v) => ({ value: v, label: t(`insights.by.${v}`) }))} />
        <div className="flex flex-wrap gap-2" aria-label={t("insights.abcHint")}>
          {(["A", "B", "C"] as const).map((c) => (
            <Badge key={c} tone={ABC_TONE[c]}>
              {t(`insights.abcSummary.${by}`, { class: c, count: section.abc[c].count, share: section.abc[c].share ?? "0" })}
            </Badge>
          ))}
          {by === "customers" && (
            <Badge tone={section.lostCount ? "warn" : "neutral"}>{t("insights.newLost", { new: section.newCount, lost: section.lostCount, lostSales: money(section.lostSales, 0) })}</Badge>
          )}
        </div>
        <DataTable
          rows={section.rows}
          rowKey={(r) => r.key}
          minWidth={820}
          empty={<EmptyState title={t("analytics.noSales")} hint={t("analytics.noSalesHint")} />}
          columns={[
            {
              key: "name",
              header: t(`insights.by.${by}`),
              render: (r) => (
                <div>
                  <p className="font-medium text-ink">{name(r)}</p>
                  {by === "customers" && <p className="text-[12px] text-ink-3">{[r.code, r.city].filter(Boolean).join(" · ")}</p>}
                </div>
              ),
            },
            { key: "sales", header: t("insights.sales"), align: "right", render: (r) => <span className="font-semibold text-ink">{money(r.sales, 0)}</span> },
            ...(withMargin ? [{ key: "margin", header: t("insights.margin"), align: "right" as const, render: (r: PartyRow) => (r.margin ? money(r.margin, 0) : "—") }] : []),
            {
              key: "share",
              header: t("insights.share"),
              render: (r) => (
                <div className="flex min-w-[110px] items-center gap-2">
                  <ProgressBar value={Number(r.share) / 100} label={`${r.share}%`} tone={r.abc === "A" ? "good" : "accent"} />
                  <span className="num w-11 text-right text-[12.5px] text-ink-2">{number(r.share, 1)}%</span>
                </div>
              ),
            },
            { key: "abc", header: t("insights.class"), render: (r) => <Badge tone={ABC_TONE[r.abc]}>{r.abc}</Badge> },
            { key: "previous", header: t("insights.earlier"), align: "right", render: (r) => <span className="text-ink-2">{money(r.previousSales, 0)}</span> },
            {
              key: "change",
              header: t("insights.change"),
              align: "right",
              render: (r) => (r.change === null ? "—" : <span className={Number(r.change) < 0 ? "text-danger" : "text-good"}>{`${Number(r.change) > 0 ? "+" : ""}${number(r.change, 1)}%`}</span>),
            },
            { key: "status", header: t("common.status"), render: (r) => <Badge tone={STATUS_TONE[r.status]}>{t(`insights.status.${r.status}`)}</Badge> },
          ]}
        />
        <p className="text-[12.5px] text-ink-3">{t("insights.abcHint")}</p>
      </div>
    </Card>
  );
}

function Movement({ data, query }: { data: InsightsData; query: Record<string, string> }) {
  const { t, money, number, dateMedium } = useI18n();
  const m = data.movers;
  const withValue = m.fast.some((r) => r.stockValue !== undefined) || m.deadValue !== undefined;
  const table = (rows: MoverRow[], kind: "fast" | "slow" | "dead") => (
    <DataTable
      rows={rows}
      rowKey={(r) => r.productId}
      minWidth={640}
      empty={<EmptyState title={t(`insights.none.${kind}`)} />}
      columns={[
        {
          key: "name",
          header: t("product.name"),
          render: (r) => (
            <div>
              <p className="font-medium text-ink">{r.name}</p>
              <p className="text-[12px] text-ink-3">{[r.code, r.brand].filter(Boolean).join(" · ")}</p>
            </div>
          ),
        },
        ...(kind === "dead"
          ? []
          : [
              { key: "sold", header: t("analytics.sold"), align: "right" as const, render: (r: MoverRow) => `${number(r.qtySold, 0)} ${r.unit}` },
              { key: "sales", header: t("insights.sales"), align: "right" as const, render: (r: MoverRow) => money(r.sales, 0) },
            ]),
        { key: "stock", header: t("product.currentStock"), align: "right", render: (r) => `${number(r.stock, 0)} ${r.unit}` },
        ...(withValue ? [{ key: "value", header: t("analytics.stockValue"), align: "right" as const, render: (r: MoverRow) => money(r.stockValue ?? "0", 0) }] : []),
        kind === "dead"
          ? { key: "last", header: t("analytics.lastSold"), render: (r: MoverRow) => <span className="text-ink-2">{r.lastSold ? dateMedium(r.lastSold) : t("insights.neverSold")}</span> }
          : { key: "cover", header: t("analytics.daysOfCover"), align: "right" as const, render: (r: MoverRow) => (r.daysOfCover ? number(r.daysOfCover, 0) : "—") },
      ]}
    />
  );
  const block = (kind: "fast" | "slow" | "dead", rows: MoverRow[], note: ReactNode) => (
    <Card>
      <CardHeader title={t(`insights.${kind}`)} action={<ExportButton path="/insights" query={{ ...query, section: kind }} filename={`insights-${kind}-${data.from}-${data.to}.csv`} />} />
      <div className="flex flex-col gap-2 px-4 pt-1 pb-4 sm:px-5">
        <p className="text-[12.5px] text-ink-3">{note}</p>
        {table(rows, kind)}
      </div>
    </Card>
  );
  return (
    <section aria-label={t("insights.stock")} className="flex flex-col gap-4">
      {block("fast", m.fast, t("insights.fastHint"))}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {block("slow", m.slow, `${t("insights.slowHint", { days: m.slowAfterDays })}${m.slowValue !== undefined ? ` · ${t("insights.tiedUp", { value: money(m.slowValue, 0), count: m.slowCount })}` : ""}`)}
        {block("dead", m.dead, `${t("insights.deadHint", { days: m.deadAfterDays })}${m.deadValue !== undefined ? ` · ${t("insights.tiedUp", { value: money(m.deadValue, 0), count: m.deadCount })}` : ""}`)}
      </div>
    </section>
  );
}
