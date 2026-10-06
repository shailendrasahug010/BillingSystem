import { useQuery, useQueryClient } from "@tanstack/react-query";
import { translateError } from "@digitalbahi/i18n";
import { BookmarkPlus } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, PageHeader, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { ApiError, api } from "../../lib/api";
import { PnlReport, ProductsReport, ProfitReport } from "./Analytics";
import { InsightsReport } from "./Insights";
import { ExportButton, PeriodBar, settingsPeriod } from "./period";
import { ActiveViewBar, ViewDialog, ViewsMenu, type ViewDialogMode } from "./SavedViews";
import { opensReport, REPORT_DEFAULTS, sameSettings, savedSettings, useReportViews, type ReportSettings, type ReportTab, type SavedView } from "./views";

/** A report tab drawn from its settings, which the Reports screen keeps (to save and restore them). */
export interface ReportProps {
  settings: ReportSettings;
  onChange(patch: Partial<ReportSettings>): void;
}

type Row = Record<string, unknown> & { key: string | null; label: string | null };

const GROUPS = {
  sales: ["day", "week", "month", "customer", "product", "brand", "category", "salesperson"],
  collections: ["day", "week", "month", "method", "customer"],
  purchases: ["day", "month", "supplier", "product", "brand"],
} as const;

/** The Reports screen: a tab per report the role opens, and views saved from them (see SavedViews). */
export function ReportsPage(props: { initialTab?: ReportTab; initialGroup?: "brand" | "product" } = {}) {
  const tabs = REPORT_TABS.filter(opensReport);
  if (!tabs.length) return <ErrorNote error={new ApiError(403, "FORBIDDEN")} />;
  return <Reports key={`${props.initialTab ?? ""}-${props.initialGroup ?? ""}`} tabs={tabs} {...props} />;
}

const REPORT_TABS: ReportTab[] = ["insights", "sales", "collections", "purchases", "outstanding", "profit", "pnl", "products"];

function Reports({ tabs, initialTab, initialGroup }: { tabs: ReportTab[]; initialTab?: ReportTab; initialGroup?: "brand" | "product" }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<ReportTab>(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0]!);
  const [settings, setSettings] = useState<Record<ReportTab, ReportSettings>>(() => ({ ...REPORT_DEFAULTS, profit: { ...REPORT_DEFAULTS.profit, groupBy: initialGroup ?? "product" } }));
  const [active, setActive] = useState<SavedView | null>(null);
  const [dialog, setDialog] = useState<ViewDialogMode | null>(null);
  const [busy, setBusy] = useState(false);
  const views = useReportViews();
  const shown = (views.data ?? []).filter((v) => tabs.includes(v.report));

  const change = (report: ReportTab) => (patch: Partial<ReportSettings>) => setSettings((prev) => ({ ...prev, [report]: { ...prev[report], ...patch } }));
  const open = (view: SavedView) => {
    setTab(view.report);
    setSettings((prev) => ({ ...prev, [view.report]: { ...REPORT_DEFAULTS[view.report], ...view.settings } }));
    setActive(view);
  };
  const changed = active !== null && !sameSettings(active.report, settings[active.report], active.settings);
  const refresh = () => qc.invalidateQueries({ queryKey: ["report-views"] });

  const create = async (name: string, shared: boolean) => {
    const view = await api.post<SavedView>("/report-views", { name, report: tab, settings: savedSettings(tab, settings[tab]), shared });
    setActive(view);
    void refresh();
    toast({ tone: "success", title: t("reportViews.saved", { name: view.name }) });
  };
  const update = async (view: SavedView, patch: { name?: string; shared?: boolean; settings?: ReportSettings }) => {
    const updated = await api.patch<SavedView>(`/report-views/${view.id}`, patch);
    setActive(updated);
    void refresh();
    toast({ tone: "success", title: t("reportViews.updated", { name: updated.name }) });
  };
  const saveChanges = () => {
    if (!active) return;
    setBusy(true);
    update(active, { settings: savedSettings(active.report, settings[active.report]) })
      .catch((e: unknown) => toast({ tone: "danger", title: t("errors.generic"), body: e instanceof ApiError ? translateError(i18n, e) : undefined }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
        actions={
          <>
            <ViewsMenu views={shown} activeId={active?.id ?? null} onOpen={open} />
            <Button variant="soft" icon={<BookmarkPlus size={16} />} onClick={() => setDialog({ kind: "save", name: "" })}>
              {t("reportViews.save")}
            </Button>
          </>
        }
      />
      {active && (
        <ActiveViewBar
          view={active}
          changed={changed}
          busy={busy}
          onSaveChanges={saveChanges}
          onEdit={() => setDialog({ kind: "edit", view: active })}
          onDelete={() => setDialog({ kind: "delete", view: active })}
          onCopy={() => setDialog({ kind: "copy", name: active.name })}
          onClose={() => setActive(null)}
        />
      )}
      <ViewDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onSave={({ name, shared }) => (dialog?.kind === "edit" ? update(dialog.view, { name, shared }) : create(name, shared))}
        onDelete={async (view) => {
          await api.delete(`/report-views/${view.id}`);
          setActive(null);
          void refresh();
          toast({ tone: "success", title: t("reportViews.deleted", { name: view.name }) });
        }}
      />
      <Tabs.Root
        value={tab}
        onValueChange={(v) => {
          setTab(v as ReportTab);
          // A view belongs to one report: moving to another leaves it.
          if (active && v !== active.report) setActive(null);
        }}
        className="flex flex-col gap-4"
      >
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("reports.title")}>
          {tabs.map((k) => (
            <Tabs.Trigger key={k} value={k} className={TAB_TRIGGER}>
              {t(`reports.tabs.${k}`)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {tabs.includes("insights") && (
          <Tabs.Content value="insights">
            <InsightsReport settings={settings.insights} onChange={change("insights")} />
          </Tabs.Content>
        )}
        {tabs.includes("sales") && (
          <Tabs.Content value="sales">
            <GroupedReport kind="sales" settings={settings.sales} onChange={change("sales")} />
          </Tabs.Content>
        )}
        {tabs.includes("collections") && (
          <Tabs.Content value="collections">
            <GroupedReport kind="collections" settings={settings.collections} onChange={change("collections")} />
          </Tabs.Content>
        )}
        {tabs.includes("purchases") && (
          <Tabs.Content value="purchases">
            <GroupedReport kind="purchases" settings={settings.purchases} onChange={change("purchases")} />
          </Tabs.Content>
        )}
        {tabs.includes("outstanding") && (
          <Tabs.Content value="outstanding">
            <OutstandingReport settings={settings.outstanding} onChange={change("outstanding")} />
          </Tabs.Content>
        )}
        {tabs.includes("profit") && (
          <Tabs.Content value="profit">
            <ProfitReport settings={settings.profit} onChange={change("profit")} />
          </Tabs.Content>
        )}
        {tabs.includes("pnl") && (
          <Tabs.Content value="pnl">
            <PnlReport settings={settings.pnl} onChange={change("pnl")} />
          </Tabs.Content>
        )}
        {tabs.includes("products") && (
          <Tabs.Content value="products">
            <ProductsReport settings={settings.products} onChange={change("products")} />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </div>
  );
}

function GroupedReport({ kind, settings, onChange }: { kind: keyof typeof GROUPS } & ReportProps) {
  const { t, money, number, dateMedium } = useI18n();
  const period = settingsPeriod(settings, onChange);
  const groupBy = settings.groupBy ?? REPORT_DEFAULTS[kind].groupBy!;
  const setGroupBy = (g: string) => onChange({ groupBy: g });
  const query = { from: period.from, to: period.to, groupBy };
  const q = useQuery({
    queryKey: ["reports", kind, query],
    queryFn: () => api.get<{ rows: Row[]; totals: Record<string, string> }>(`/reports/${kind}`, query),
    enabled: Boolean(period.from && period.to),
    placeholderData: (prev) => prev,
  });
  const dateGroup = ["day", "week", "month", "year"].includes(groupBy);
  const label = (r: Row) => {
    if (kind === "collections" && groupBy === "method" && r.label) return t(`paymentMethod.${r.label as "cash"}`);
    if (dateGroup && typeof r.label === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.label)) return groupBy === "month" ? r.label.slice(0, 7) : dateMedium(r.label.slice(0, 10));
    return r.label ?? "—";
  };
  const countKey = kind === "sales" ? "invoices" : kind === "purchases" ? "bills" : "count";
  const columns: Column<Row>[] = [
    { key: "label", header: t(`reports.groups.${groupBy as "day"}`), render: (r) => <span className="font-medium text-ink">{label(r)}</span> },
    { key: "count", header: t(`reports.count.${kind}`), align: "right", render: (r) => number(Number(r[countKey] ?? 0), 0) },
    ...(kind === "collections"
      ? [{ key: "amount", header: t("common.amount"), align: "right" as const, render: (r: Row) => <span className="font-semibold">{money(String(r.amount ?? 0))}</span> }]
      : [
          ...(r0HasQty(q.data?.rows) ? [{ key: "qty", header: t("invoice.qty"), align: "right" as const, render: (r: Row) => number(String(r.qty ?? 0)) }] : []),
          { key: "taxable", header: t("invoice.taxable"), align: "right" as const, render: (r: Row) => money(String(r.taxable ?? 0)) },
          { key: "tax", header: t("invoice.tax"), align: "right" as const, render: (r: Row) => money(String(r.tax ?? 0)) },
          { key: "total", header: t("common.total"), align: "right" as const, render: (r: Row) => <span className="font-semibold">{money(String(r.total ?? 0))}</span> },
        ]),
  ];
  const totals = q.data?.totals;
  return (
    <div className="flex flex-col gap-4">
      <PeriodBar period={period} actions={<ExportButton path={`/reports/${kind}`} query={query} filename={`${kind}-${period.from}-${period.to}.csv`} />}>
        <Select aria-label={t("common.groupBy")} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="md:w-48">
          {GROUPS[kind].map((g) => (
            <option key={g} value={g}>
              {t("common.groupBy")}: {t(`reports.groups.${g}`)}
            </option>
          ))}
        </Select>
      </PeriodBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable
        columns={columns}
        rows={q.data?.rows ?? []}
        rowKey={(r) => String(r.key ?? r.label ?? "—")}
        loading={q.isPending}
        footer={
          totals ? (
            <tfoot className="num border-t border-line bg-surface-2 font-semibold text-ink">
              <tr>
                <td className="py-2.5 pl-4">{t("common.total")}</td>
                <td />
                {kind === "collections" ? (
                  <td className="py-2.5 pr-4 pl-3 text-right">{money(totals.amount ?? "0")}</td>
                ) : (
                  <>
                    {r0HasQty(q.data?.rows) && <td />}
                    <td className="py-2.5 pr-3 pl-3 text-right">{totals.taxable ? money(totals.taxable) : ""}</td>
                    <td className="py-2.5 pr-3 pl-3 text-right">{totals.tax ? money(totals.tax) : ""}</td>
                    <td className="py-2.5 pr-4 pl-3 text-right">{money(totals.total ?? "0")}</td>
                  </>
                )}
              </tr>
            </tfoot>
          ) : undefined
        }
      />
    </div>
  );
}

const r0HasQty = (rows: Row[] | undefined) => Boolean(rows?.some((r) => r.qty !== undefined && r.qty !== null));

interface OutstandingRow {
  partyId: string;
  name: string;
  mobile: string | null;
  documents: number;
  total: string;
  notDue: string;
  buckets: Array<{ label: string; amount: string; count: number }>;
  oldestDueDate: string;
}

function OutstandingReport({ settings, onChange }: ReportProps) {
  const { t, money, dateMedium } = useI18n();
  const party = settings.party ?? "customer";
  const basis = settings.basis ?? "due_date";
  const setParty = (v: typeof party) => onChange({ party: v });
  const setBasis = (v: typeof basis) => onChange({ basis: v });
  const query = { party, basis };
  const q = useQuery({
    queryKey: ["reports", "outstanding", query],
    queryFn: () => api.get<{ asOf: string; bucketLabels: string[]; rows: OutstandingRow[]; totals: { total: string; notDue: string } }>("/reports/outstanding", query),
    placeholderData: (prev) => prev,
  });
  const labels = q.data?.bucketLabels ?? [];
  const columns: Column<OutstandingRow>[] = [
    {
      key: "name",
      header: party === "customer" ? t("nav.customers") : t("nav.suppliers"),
      render: (r) => (
        <div>
          <p className="font-medium text-ink">{r.name}</p>
          <p className="text-[12px] text-ink-3">
            {r.mobile ?? ""} · {t("reports.oldestDue")} {dateMedium(r.oldestDueDate)}
          </p>
        </div>
      ),
    },
    { key: "docs", header: t("reports.bills"), align: "right", render: (r) => r.documents },
    { key: "notDue", header: t("reports.notDue"), align: "right", render: (r) => (Number(r.notDue) ? money(r.notDue) : "—") },
    ...labels.map((l, i) => ({
      key: `b${i}`,
      header: t("reports.bucket", { label: l }),
      align: "right" as const,
      render: (r: OutstandingRow) => {
        const v = r.buckets[i]?.amount ?? "0";
        return Number(v) ? <span className={i >= 1 ? "text-danger" : "text-warn"}>{money(v)}</span> : "—";
      },
    })),
    { key: "total", header: t("common.total"), align: "right", render: (r) => <span className="font-semibold">{money(r.total)}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        fit
        actions={
          <>
            <span className="num text-[13px] text-ink-3">
              {q.data && (
                <>
                  {t("common.total")} <span className="font-semibold text-ink">{money(q.data.totals.total)}</span> · {t("reports.asOf", { date: dateMedium(q.data.asOf) })}
                </>
              )}
            </span>
            <ExportButton path="/reports/outstanding" query={query} filename={`outstanding-${party}.csv`} />
          </>
        }
      >
        <Segmented
          size="sm"
          label={t("common.party")}
          value={party}
          onChange={setParty}
          options={[
            { value: "customer", label: t("reports.receivable") },
            ...(allowed("supplier.view") ? [{ value: "supplier" as const, label: t("reports.payable") }] : []),
          ]}
        />
        <Segmented
          size="sm"
          label={t("reports.basis")}
          value={basis}
          onChange={setBasis}
          options={[
            { value: "due_date", label: t("reports.byDueDate") },
            { value: "invoice_date", label: t("reports.byBillDate") },
          ]}
        />
      </FilterBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable columns={columns} rows={q.data?.rows ?? []} rowKey={(r) => r.partyId} loading={q.isPending} minWidth={760} />
    </div>
  );
}
