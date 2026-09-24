import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, PageHeader, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { rangeDates, type RangeKey } from "../../data/store";
import { ApiError, api } from "../../lib/api";
import { downloadReport } from "../../lib/download";

type Row = Record<string, unknown> & { key: string | null; label: string | null };
const PRESETS: RangeKey[] = ["thisMonth", "lastMonth", "last7", "thisFy"];

const GROUPS = {
  sales: ["day", "week", "month", "customer", "product", "brand", "category", "salesperson"],
  collections: ["day", "week", "month", "method", "customer"],
  purchases: ["day", "month", "supplier", "product", "brand"],
} as const;

/** Date range picker shared by the report tabs: presets plus from / to. */
function usePeriod(initial: RangeKey = "thisMonth") {
  const start = rangeDates(initial);
  const [preset, setPreset] = useState<RangeKey | "custom">(initial);
  const [from, setFrom] = useState(start.from);
  const [to, setTo] = useState(start.to);
  const choose = (p: RangeKey | "custom") => {
    setPreset(p);
    if (p !== "custom") {
      const r = rangeDates(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };
  return { preset, from, to, choose, setFrom: (v: string) => (setPreset("custom"), setFrom(v)), setTo: (v: string) => (setPreset("custom"), setTo(v)) };
}

export function ReportsPage() {
  const { t } = useI18n();
  const tabs = [
    ...(allowed("report.view_sales") ? (["sales"] as const) : []),
    ...(allowed("report.view_collection") ? (["collections"] as const) : []),
    ...(allowed("report.view_purchase") ? (["purchases"] as const) : []),
    ...(allowed("report.view_outstanding") ? (["outstanding"] as const) : []),
  ];
  if (!tabs.length) return <ErrorNote error={new ApiError(403, "FORBIDDEN")} />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("reports.title")} subtitle={t("reports.subtitle")} />
      <Tabs.Root defaultValue={tabs[0]} className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("reports.title")}>
          {tabs.map((k) => (
            <Tabs.Trigger key={k} value={k} className={TAB_TRIGGER}>
              {t(`reports.tabs.${k}`)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {tabs.includes("sales") && (
          <Tabs.Content value="sales">
            <GroupedReport kind="sales" />
          </Tabs.Content>
        )}
        {tabs.includes("collections") && (
          <Tabs.Content value="collections">
            <GroupedReport kind="collections" />
          </Tabs.Content>
        )}
        {tabs.includes("purchases") && (
          <Tabs.Content value="purchases">
            <GroupedReport kind="purchases" />
          </Tabs.Content>
        )}
        {tabs.includes("outstanding") && (
          <Tabs.Content value="outstanding">
            <OutstandingReport />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </div>
  );
}

function ExportButton({ path, query, filename }: { path: string; query: Record<string, string>; filename: string }) {
  const i18n = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!allowed("report.export")) return null;
  return (
    <Button
      icon={<Download size={16} />}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        downloadReport(path, query, filename)
          .catch((e: unknown) => toast({ tone: "danger", title: i18n.t("errors.generic"), body: e instanceof ApiError ? e.code : undefined }))
          .finally(() => setBusy(false));
      }}
    >
      {i18n.t("common.export")}
    </Button>
  );
}

function PeriodBar({ period, children }: { period: ReturnType<typeof usePeriod>; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <FilterBar>
      <Select aria-label={t("common.period")} value={period.preset} onChange={(e) => period.choose(e.target.value as RangeKey | "custom")} className="md:w-52">
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {t(`dashboard.range.${p}`)}
          </option>
        ))}
        <option value="custom">{t("dashboard.range.custom")}</option>
      </Select>
      <Input type="date" aria-label={t("common.from")} value={period.from} max={period.to} onChange={(e) => period.setFrom(e.target.value)} className="md:w-40" />
      <Input type="date" aria-label={t("common.to")} value={period.to} min={period.from} onChange={(e) => period.setTo(e.target.value)} className="md:w-40" />
      {children}
    </FilterBar>
  );
}

function GroupedReport({ kind }: { kind: keyof typeof GROUPS }) {
  const { t, money, number, dateMedium } = useI18n();
  const period = usePeriod();
  const [groupBy, setGroupBy] = useState<string>(kind === "purchases" ? "month" : "day");
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
      <PeriodBar period={period}>
        <Select aria-label={t("common.groupBy")} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="md:w-48">
          {GROUPS[kind].map((g) => (
            <option key={g} value={g}>
              {t("common.groupBy")}: {t(`reports.groups.${g}`)}
            </option>
          ))}
        </Select>
        <div className="md:ml-auto">
          <ExportButton path={`/reports/${kind}`} query={query} filename={`${kind}-${period.from}-${period.to}.csv`} />
        </div>
      </PeriodBar>
      {q.error ? <ErrorNote error={q.error} /> : null}
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
                    <td className="py-2.5 pl-3 text-right">{totals.taxable ? money(totals.taxable) : ""}</td>
                    <td className="py-2.5 pl-3 text-right">{totals.tax ? money(totals.tax) : ""}</td>
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

function OutstandingReport() {
  const { t, money, dateMedium } = useI18n();
  const [party, setParty] = useState<"customer" | "supplier">("customer");
  const [basis, setBasis] = useState<"due_date" | "invoice_date">("due_date");
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
      <FilterBar>
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
        <span className="num text-[13px] text-ink-3 md:ml-auto">
          {q.data && (
            <>
              {t("common.total")} <span className="font-semibold text-ink">{money(q.data.totals.total)}</span> · {t("reports.asOf", { date: dateMedium(q.data.asOf) })}
            </>
          )}
        </span>
        <ExportButton path="/reports/outstanding" query={query} filename={`outstanding-${party}.csv`} />
      </FilterBar>
      {q.error ? <ErrorNote error={q.error} /> : null}
      <DataTable columns={columns} rows={q.data?.rows ?? []} rowKey={(r) => r.partyId} loading={q.isPending} minWidth={760} />
    </div>
  );
}
