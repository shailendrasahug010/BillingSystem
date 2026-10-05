import { translateError } from "@digitalbahi/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileJson, FileSpreadsheet } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/misc";
import { DataTable, ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { downloadText } from "../../lib/download";

export interface PeriodStatus {
  status: "open" | "locked" | "filed";
  lockedAt: string | null;
  filedAt: string | null;
  arn: string | null;
}

interface SectionRow {
  section: "b2b" | "b2cl" | "b2cs" | "exp" | "cdnr" | "cdnur" | "nil" | "hsn_b2b" | "hsn_b2c";
  records: number;
  value: string;
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
}

interface Gstr1Preview {
  period: string;
  gstin: string | null;
  version: string;
  b2clThreshold: string;
  hsnMinDigits: number;
  summary: SectionRow[];
  documents: Array<{ docNum: number; label: string; from: string; to: string; total: number; cancelled: number; net: number }>;
  warnings: Array<{ code: string; docNumber?: string; params?: Record<string, string> }>;
  status: { GSTR1: PeriodStatus; GSTR3B: PeriodStatus };
}

const CSV_SECTIONS = ["b2b", "b2cl", "b2cs", "exp", "cdnr", "cdnur", "hsn", "docs"] as const;

export function Gstr1Tab({ period }: { period: string }) {
  const i18n = useI18n();
  const { t, money, dateTime } = i18n;
  const toast = useToast();
  const qc = useQueryClient();
  const [section, setSection] = useState<(typeof CSV_SECTIONS)[number]>("b2b");
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["gst", "gstr1", period],
    queryFn: () => api.get<Gstr1Preview>("/gst/returns/gstr1", { period }),
    enabled: /^\d{4}-\d{2}$/.test(period),
    placeholderData: (prev) => prev,
  });
  const history = useQuery({
    queryKey: ["gst", "exports", period],
    queryFn: () => api.get<{ data: Array<{ id: string; format: string; formatterVersion: string; warnings: number; generatedAt: string; generatedBy: string | null }> }>("/gst/exports", { period }).then((r) => r.data),
  });
  const d = q.data;
  const mmyyyy = `${period.slice(5, 7)}${period.slice(0, 4)}`;

  const download = async (format: "json" | "csv") => {
    setBusy(true);
    try {
      const body = await api.get<unknown>("/gst/returns/gstr1/file", { period, format, ...(format === "csv" ? { section } : {}) });
      if (format === "json") downloadText(`GSTR1_${d?.gstin ?? ""}_${mmyyyy}.json`, typeof body === "string" ? body : JSON.stringify(body), "application/json");
      else downloadText(`${section}_${mmyyyy}.csv`, `﻿${String(body)}`);
      void qc.invalidateQueries({ queryKey: ["gst", "exports", period] });
    } catch (e) {
      toast({ tone: "danger", title: t("errors.exportFailed"), body: translateError(i18n, e instanceof ApiError ? e : null) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {d && d.warnings.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-ink">
          <p className="mb-1.5 flex items-center gap-2 font-semibold text-warn">
            <AlertTriangle size={16} /> {t("gstPage.warningsTitle", { count: d.warnings.length })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {d.warnings.slice(0, 20).map((w, i) => (
              <li key={i}>
                {t(`gstPage.warnings.${w.code as "HSN_MISSING"}`, { doc: w.docNumber ?? "", ...(w.params ?? {}) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Card>
        <CardHeader
          title={t("gstPage.gstr1Tables")}
          subtitle={d ? t("gstPage.gstr1Hint", { amount: money(d.b2clThreshold, 0), digits: d.hsnMinDigits }) : undefined}
        />
        {allowed("gst.export") && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 pt-3 pb-3 sm:px-5">
            <Button size="sm" variant="primary" icon={<FileJson size={14} />} disabled={busy || !d?.gstin} onClick={() => void download("json")}>
              {t("gstPage.downloadJson")}
            </Button>
            <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
            <div className="w-36">
              <Select aria-label={t("gstPage.csvTable")} value={section} onChange={(e) => setSection(e.target.value as typeof section)} className="h-8 px-2 text-[13px]">
                {CSV_SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {t(`gstPage.sections.${s}`)}
                  </option>
                ))}
              </Select>
            </div>
            <Button size="sm" icon={<FileSpreadsheet size={14} />} disabled={busy || !d?.gstin} onClick={() => void download("csv")}>
              {t("gstPage.downloadCsv")}
            </Button>
          </div>
        )}
        <div className="p-3 sm:p-4">
          <DataTable
            rows={d?.summary ?? []}
            loading={q.isPending}
            rowKey={(r) => r.section}
            minWidth={820}
            columns={[
              {
                key: "section",
                header: t("gstPage.section"),
                render: (r) => (
                  <div>
                    <p className="font-medium text-ink">{t(`gstPage.sections.${r.section}`)}</p>
                    <p className="text-[12px] text-ink-3">{t(`gstPage.sectionHints.${r.section}`)}</p>
                  </div>
                ),
              },
              { key: "records", header: t("gstPage.records"), align: "right", render: (r) => r.records },
              { key: "taxable", header: t("invoice.taxableValue"), align: "right", render: (r) => money(r.taxable) },
              { key: "igst", header: t("invoice.igst"), align: "right", render: (r) => money(r.igst) },
              { key: "cgst", header: t("invoice.cgst"), align: "right", render: (r) => money(r.cgst) },
              { key: "sgst", header: t("invoice.sgst"), align: "right", render: (r) => money(r.sgst) },
              { key: "cess", header: t("invoice.cess"), align: "right", render: (r) => (Number(r.cess) ? money(r.cess) : "—") },
            ]}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title={t("gstPage.documents")} subtitle={t("gstPage.documentsHint")} />
        <div className="p-3 sm:p-4">
          <DataTable
            rows={d?.documents ?? []}
            loading={q.isPending}
            rowKey={(r) => `${r.docNum}-${r.from}`}
            empty={<EmptyState title={t("gstPage.noOutward")} hint={t("gstPage.noOutwardHint")} />}
            columns={[
              { key: "nature", header: t("gstPage.nature"), render: (r) => <span className="font-medium text-ink">{t(`gstPage.docKinds.${r.docNum as 1}`)}</span> },
              { key: "from", header: t("common.from"), render: (r) => <span className="font-mono text-[12.5px]">{r.from}</span> },
              { key: "to", header: t("common.to"), render: (r) => <span className="font-mono text-[12.5px]">{r.to}</span> },
              { key: "total", header: t("common.total"), align: "right", render: (r) => r.total },
              { key: "cancelled", header: t("common.cancelled"), align: "right", render: (r) => r.cancelled },
              { key: "net", header: t("gstPage.netIssued"), align: "right", render: (r) => <span className="font-semibold">{r.net}</span> },
            ]}
          />
        </div>
      </Card>
      {(history.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader title={t("gstPage.exportHistory")} />
          <div className="p-3 sm:p-4">
            <DataTable
              rows={history.data ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: "when", header: t("common.date"), render: (r) => <span className="text-ink-2">{dateTime(r.generatedAt)}</span> },
                { key: "format", header: t("gstPage.file"), render: (r) => <span className="font-mono text-[12.5px]">{r.format.toUpperCase()} · {r.formatterVersion}</span> },
                { key: "by", header: t("audit.user"), render: (r) => r.generatedBy ?? "—" },
                { key: "warnings", header: t("gstPage.warningsShort"), align: "right", render: (r) => r.warnings },
              ]}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
