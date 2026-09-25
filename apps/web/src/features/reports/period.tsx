import { Download, FileText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { FilterBar } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { rangeDates, type RangeKey } from "../../data/store";
import { ApiError } from "../../lib/api";
import { downloadReport } from "../../lib/download";

const PRESETS: RangeKey[] = ["thisMonth", "lastMonth", "last7", "thisFy"];

/** Date range picker shared by the report tabs: presets plus from / to. */
export function usePeriod(initial: RangeKey = "thisMonth") {
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

/** Download the report as a PDF (with the firm's letterhead) or as CSV for Excel. */
export function ExportButton({ path, query, filename }: { path: string; query: Record<string, string>; filename: string }) {
  const i18n = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<"pdf" | "csv" | null>(null);
  if (!allowed("report.export")) return null;
  const run = (format: "pdf" | "csv") => {
    setBusy(format);
    downloadReport(path, query, filename, format)
      .catch((e: unknown) => toast({ tone: "danger", title: i18n.t("errors.generic"), body: e instanceof ApiError ? e.code : undefined }))
      .finally(() => setBusy(null));
  };
  return (
    <div className="flex gap-2">
      <Button icon={<FileText size={16} />} disabled={busy !== null} onClick={() => run("pdf")}>
        {busy === "pdf" ? i18n.t("reports.preparing") : i18n.t("reports.exportPdf")}
      </Button>
      <Button icon={<Download size={16} />} disabled={busy !== null} onClick={() => run("csv")}>
        {i18n.t("reports.exportCsv")}
      </Button>
    </div>
  );
}

export function PeriodBar({ period, children }: { period: ReturnType<typeof usePeriod>; children?: ReactNode }) {
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
