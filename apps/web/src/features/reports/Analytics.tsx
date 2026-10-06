import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Card, CardHeader } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { EmptyState, ProgressBar } from "../../components/ui/misc";
import { DataTable, ErrorNote, Tile } from "../../components/ui/Page";
import { api } from "../../lib/api";
import { ExportButton, PeriodBar, settingsPeriod } from "./period";
import type { ReportProps } from "./ReportsPage";

const PROFIT_GROUPS = ["product", "brand", "category", "customer", "salesperson", "month"] as const;
type ProfitGroup = (typeof PROFIT_GROUPS)[number];

interface ProfitRow {
  key: string;
  label: string;
  qty: string;
  sales: string;
  cost: string;
  margin: string;
  marginPercent: string | null;
}

/** Margin by product, company, category, customer, salesperson or month. */
export function ProfitReport({ settings, onChange }: ReportProps) {
  const { t, money, number } = useI18n();
  const period = settingsPeriod(settings, onChange);
  const groupBy = (settings.groupBy ?? "product") as ProfitGroup;
  const setGroupBy = (g: ProfitGroup) => onChange({ groupBy: g });
  const query = { from: period.from, to: period.to, groupBy };
  const q = useQuery({
    queryKey: ["reports", "profit", query],
    queryFn: () => api.get<{ rows: ProfitRow[]; totals: { sales: string; cost: string; margin: string; marginPercent: string | null } }>("/reports/profit", query),
    enabled: Boolean(period.from && period.to),
    placeholderData: (prev) => prev,
  });
  const totals = q.data?.totals;
  return (
    <div className="flex flex-col gap-4">
      <PeriodBar period={period} actions={<ExportButton path="/reports/profit" query={query} filename={`profit-${groupBy}-${period.from}-${period.to}.csv`} />}>
        <Select aria-label={t("common.groupBy")} value={groupBy} onChange={(e) => setGroupBy(e.target.value as ProfitGroup)} className="md:w-48">
          {PROFIT_GROUPS.map((g) => (
            <option key={g} value={g}>
              {t("common.groupBy")}: {t(`reports.groups.${g}`)}
            </option>
          ))}
        </Select>
      </PeriodBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {totals && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label={t("analytics.netSales")} value={money(totals.sales)} />
          <Tile label={t("analytics.cost")} value={money(totals.cost)} />
          <Tile label={t("analytics.margin")} value={money(totals.margin)} sub={totals.marginPercent ? `${totals.marginPercent}%` : undefined} tone={Number(totals.margin) >= 0 ? "good" : "danger"} />
        </div>
      )}
      <DataTable
        rows={q.data?.rows ?? []}
        rowKey={(r) => r.key}
        loading={q.isPending}
        minWidth={760}
        empty={<EmptyState title={t("analytics.noSales")} hint={t("analytics.noSalesHint")} />}
        columns={[
          { key: "label", header: t(`reports.groups.${groupBy}`), render: (r) => <span className="font-medium text-ink">{r.label}</span> },
          ...(groupBy === "product" ? [{ key: "qty", header: t("invoice.qty"), align: "right" as const, render: (r: ProfitRow) => number(r.qty) }] : []),
          { key: "sales", header: t("analytics.netSales"), align: "right", render: (r) => money(r.sales) },
          { key: "cost", header: t("analytics.cost"), align: "right", render: (r) => money(r.cost) },
          { key: "margin", header: t("analytics.margin"), align: "right", render: (r) => <span className={Number(r.margin) < 0 ? "font-semibold text-danger" : "font-semibold text-ink"}>{money(r.margin)}</span> },
          {
            key: "pct",
            header: "%",
            align: "right",
            render: (r) =>
              r.marginPercent === null ? (
                "—"
              ) : (
                <div className="ml-auto flex w-24 items-center justify-end gap-2">
                  <ProgressBar value={Math.max(0, Math.min(1, Number(r.marginPercent) / 50))} tone={Number(r.marginPercent) < 5 ? "warn" : "good"} label={`${r.marginPercent}%`} />
                  <span className="num text-[12px]">{r.marginPercent}%</span>
                </div>
              ),
          },
        ]}
      />
      <p className="text-[12.5px] text-ink-3">{t("analytics.profitHint")}</p>
    </div>
  );
}

interface Pnl {
  sales: string;
  costOfGoodsSold: string;
  grossProfit: string;
  grossMarginPercent: string | null;
  expenses: Array<{ category: string; categoryHi: string | null; amount: string }>;
  expenseTotal: string;
  salaries: string;
  netProfit: string;
  netMarginPercent: string | null;
}

/** A plain profit and loss statement for the period. */
export function PnlReport({ settings, onChange }: ReportProps) {
  const { t, money, locale } = useI18n();
  const period = settingsPeriod(settings, onChange);
  const q = useQuery({
    queryKey: ["reports", "pnl", period.from, period.to],
    queryFn: () => api.get<Pnl>("/reports/pnl", { from: period.from, to: period.to }),
    enabled: Boolean(period.from && period.to),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const row = (label: string, value: string, opts: { strong?: boolean; minus?: boolean; indent?: boolean } = {}) => (
    <div className={`flex justify-between gap-4 py-1.5 ${opts.strong ? "border-t border-line font-semibold text-ink" : "text-ink-2"} ${opts.indent ? "pl-4" : ""}`}>
      <span>{label}</span>
      <span className="num">{opts.minus ? `− ${money(value)}` : money(value)}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <PeriodBar period={period} />
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {d && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile label={t("analytics.grossProfit")} value={money(d.grossProfit)} sub={d.grossMarginPercent ? `${d.grossMarginPercent}%` : undefined} />
            <Tile label={t("analytics.expensesAndSalaries")} value={money(Number(d.expenseTotal) + Number(d.salaries))} />
            <Tile label={t("analytics.netProfit")} value={money(d.netProfit)} sub={d.netMarginPercent ? `${d.netMarginPercent}%` : undefined} tone={Number(d.netProfit) >= 0 ? "good" : "danger"} />
          </div>
          <Card>
            <CardHeader title={t("analytics.pnl")} subtitle={t("analytics.pnlHint")} />
            <div className="p-4 text-[14px] sm:px-5">
              {row(t("analytics.netSales"), d.sales)}
              {row(t("analytics.cogs"), d.costOfGoodsSold, { minus: true })}
              {row(t("analytics.grossProfit"), d.grossProfit, { strong: true })}
              {d.expenses.map((e) => (
                <div key={e.category}>{row((locale === "hi" && e.categoryHi) || e.category, e.amount, { minus: true, indent: true })}</div>
              ))}
              {row(t("analytics.salaries"), d.salaries, { minus: true, indent: true })}
              {row(t("analytics.netProfit"), d.netProfit, { strong: true })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

interface ProductRow {
  productId: string;
  code: string;
  name: string;
  unit: string;
  brand: string | null;
  qtySold: string;
  sales: string;
  margin?: string;
  marginPercent?: string | null;
  stockValue?: string;
  stock: string;
  daysOfCover: string | null;
  lastSold: string | null;
  movement: "fast" | "slow" | "not_moving" | "no_stock";
}

const MOVEMENT_TONE: Record<ProductRow["movement"], Tone> = { fast: "good", slow: "warn", not_moving: "danger", no_stock: "neutral" };

/** Fast, slow and not-moving products with stock, value and days of cover. */
export function ProductsReport({ settings, onChange }: ReportProps) {
  const { t, money, number, dateMedium } = useI18n();
  const period = settingsPeriod(settings, onChange);
  const movement: "" | ProductRow["movement"] = settings.movement ?? "";
  const setMovement = (m: typeof movement) => onChange({ movement: m === "" ? undefined : (m as "fast" | "slow" | "not_moving") });
  const query = { from: period.from, to: period.to };
  const q = useQuery({
    queryKey: ["reports", "products", query],
    queryFn: () => api.get<{ rows: ProductRow[] }>("/reports/products", query),
    enabled: Boolean(period.from && period.to),
    placeholderData: (prev) => prev,
  });
  const rows = (q.data?.rows ?? []).filter((r) => !movement || r.movement === movement);
  const withCost = q.data?.rows.some((r) => r.stockValue !== undefined) ?? false;
  const counts = (m: ProductRow["movement"]) => (q.data?.rows ?? []).filter((r) => r.movement === m).length;
  return (
    <div className="flex flex-col gap-4">
      <PeriodBar period={period} actions={<ExportButton path="/reports/products" query={query} filename={`products-${period.from}-${period.to}.csv`} />}>
        <Select aria-label={t("analytics.movement")} value={movement} onChange={(e) => setMovement(e.target.value as typeof movement)} className="md:w-52">
          <option value="">
            {t("analytics.movement")}: {t("common.all")}
          </option>
          {(["fast", "slow", "not_moving"] as const).map((m) => (
            <option key={m} value={m}>
              {t(`analytics.movements.${m}`)} ({counts(m)})
            </option>
          ))}
        </Select>
      </PeriodBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable
        rows={rows}
        rowKey={(r) => r.productId}
        loading={q.isPending}
        minWidth={900}
        empty={<EmptyState title={t("analytics.noProducts")} hint={t("analytics.noProductsHint")} />}
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
          { key: "movement", header: t("analytics.movement"), render: (r) => <Badge tone={MOVEMENT_TONE[r.movement]}>{t(`analytics.movements.${r.movement}`)}</Badge> },
          { key: "sold", header: t("analytics.sold"), align: "right", render: (r) => `${number(r.qtySold, 0)} ${r.unit}` },
          { key: "sales", header: t("analytics.netSales"), align: "right", render: (r) => money(r.sales) },
          ...(withCost ? [{ key: "margin", header: t("analytics.margin"), align: "right" as const, render: (r: ProductRow) => (r.margin ? money(r.margin) : "—") }] : []),
          { key: "stock", header: t("product.currentStock"), align: "right", render: (r) => number(r.stock, 0) },
          ...(withCost ? [{ key: "value", header: t("analytics.stockValue"), align: "right" as const, render: (r: ProductRow) => money(r.stockValue ?? "0") }] : []),
          { key: "cover", header: t("analytics.daysOfCover"), align: "right", render: (r) => (r.daysOfCover ? number(r.daysOfCover, 0) : "—") },
          { key: "last", header: t("analytics.lastSold"), render: (r) => <span className="text-ink-2">{r.lastSold ? dateMedium(r.lastSold) : "—"}</span> },
        ]}
      />
      <p className="text-[12.5px] text-ink-3">{t("analytics.movementHint")}</p>
    </div>
  );
}
