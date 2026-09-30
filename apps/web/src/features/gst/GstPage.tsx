import { useQuery } from "@tanstack/react-query";
import { Download, Info } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, PageHeader, TAB_TRIGGER, Tile, type Column } from "../../components/ui/Page";
import { allowed, TODAY } from "../../data/db";
import { api } from "../../lib/api";
import { downloadCsv } from "../../lib/download";
import { EInvoiceTab } from "./EInvoiceTab";
import { Gstr1Tab } from "./Gstr1Tab";
import { Gstr3bTab } from "./Gstr3bTab";
import { PeriodActions } from "./PeriodActions";

interface Heads {
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
}

interface GstSummary {
  period: string;
  status: string;
  b2clThreshold: string;
  outward: Array<Heads & { section: "B2B" | "B2CL" | "B2CS"; gstRate: string; documents: number }>;
  inward: Array<Heads & { itcEligibility: string; reverseCharge: boolean; gstRate: string; documents: number }>;
  notes: Array<Heads & { kind: "credit_note" | "debit_note" | "purchase_credit_note"; registered: boolean; gstRate: string; documents: number }>;
  hsnSummary: Array<Heads & { hsnCode: string | null; uqc: string | null; gstRate: string; qty: string }>;
  cancelledDocuments: number;
  estimate: { outputTax: Omit<Heads, "taxable">; eligibleItc: Omit<Heads, "taxable"> };
}

const sumTax = (h: Omit<Heads, "taxable">) => Number(h.cgst) + Number(h.sgst) + Number(h.igst) + Number(h.cess);

/**
 * GSTR-1 / 3B working for one month from the posted documents: outward
 * supplies by section and rate, inward supplies and ITC, the HSN summary and
 * an indicative net tax. It prepares the return; filing stays with the CA.
 */
export function GstPage() {
  const { t } = useI18n();
  const [period, setPeriod] = useState(TODAY.slice(0, 7));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("gstPage.title")} subtitle={t("gstPage.subtitle")} />
      <FilterBar>
        <Input type="month" aria-label={t("common.period")} value={period} max={TODAY.slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} className="md:w-48" />
        <PeriodActions period={period} />
      </FilterBar>
      <Tabs.Root defaultValue="summary" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("gstPage.title")}>
          <Tabs.Trigger value="summary" className={TAB_TRIGGER}>
            {t("gstPage.tabs.summary")}
          </Tabs.Trigger>
          <Tabs.Trigger value="gstr1" className={TAB_TRIGGER}>
            GSTR-1
          </Tabs.Trigger>
          <Tabs.Trigger value="gstr3b" className={TAB_TRIGGER}>
            GSTR-3B
          </Tabs.Trigger>
          <Tabs.Trigger value="einvoice" className={TAB_TRIGGER}>
            {t("einvoice.tab")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="summary">
          <SummaryTab period={period} />
        </Tabs.Content>
        <Tabs.Content value="gstr1">
          <Gstr1Tab period={period} />
        </Tabs.Content>
        <Tabs.Content value="gstr3b">
          <Gstr3bTab period={period} />
        </Tabs.Content>
        <Tabs.Content value="einvoice">
          <EInvoiceTab period={period} />
        </Tabs.Content>
      </Tabs.Root>
      <p className="flex items-start gap-2 text-[12.5px] text-ink-3">
        <Info size={14} className="mt-0.5 shrink-0" />
        {t("gstPage.disclaimer")}
      </p>
    </div>
  );
}

function SummaryTab({ period }: { period: string }) {
  const { t, money, number } = useI18n();
  const q = useQuery({
    queryKey: ["reports", "gst", period],
    queryFn: () => api.get<GstSummary>("/reports/gst", { period }),
    enabled: /^\d{4}-\d{2}$/.test(period),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const heads = <T extends Heads>(): Column<T>[] => [
    { key: "taxable", header: t("invoice.taxableValue"), align: "right", render: (r) => money(r.taxable) },
    { key: "cgst", header: t("invoice.cgst"), align: "right", render: (r) => money(r.cgst) },
    { key: "sgst", header: t("invoice.sgst"), align: "right", render: (r) => money(r.sgst) },
    { key: "igst", header: t("invoice.igst"), align: "right", render: (r) => money(r.igst) },
    { key: "cess", header: t("invoice.cess"), align: "right", render: (r) => (Number(r.cess) ? money(r.cess) : "—") },
  ];
  const output = d ? sumTax(d.estimate.outputTax) : 0;
  const itc = d ? sumTax(d.estimate.eligibleItc) : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {d && d.cancelledDocuments > 0 && <span className="text-[13px] text-ink-3">{t("gstPage.cancelled", { count: d.cancelledDocuments })}</span>}
        {d && allowed("gst.export") && (
          <Button
            className="ml-auto"
            size="sm"
            icon={<Download size={14} />}
            onClick={() =>
              downloadCsv(
                `hsn-summary-${period}.csv`,
                [
                  { label: "HSN", value: (r) => r.hsnCode },
                  { label: "UQC", value: (r) => r.uqc },
                  { label: "Rate", value: (r) => r.gstRate },
                  { label: "Qty", value: (r) => r.qty },
                  { label: "Taxable", value: (r) => r.taxable },
                  { label: "CGST", value: (r) => r.cgst },
                  { label: "SGST", value: (r) => r.sgst },
                  { label: "IGST", value: (r) => r.igst },
                  { label: "Cess", value: (r) => r.cess },
                ],
                d.hsnSummary,
              )
            }
          >
            {t("gstPage.exportHsn")}
          </Button>
        )}
      </div>
      {q.error ? <ErrorNote error={q.error} /> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label={t("gstPage.outputTax")} value={money(output)} />
        <Tile label={t("gstPage.eligibleItc")} value={money(itc)} tone="good" />
        <Tile label={t("gstPage.netEstimate")} value={money(Math.max(0, output - itc))} sub={output - itc < 0 ? t("gstPage.carryForward", { amount: money(itc - output) }) : t("gstPage.indicative")} tone={output - itc > 0 ? "danger" : undefined} />
      </div>

      <Card>
        <CardHeader title={t("gstPage.outward")} subtitle={d ? t("gstPage.b2clNote", { amount: money(d.b2clThreshold, 0) }) : undefined} />
        <div className="p-3 sm:p-4">
          <DataTable
            rows={d?.outward ?? []}
            loading={q.isPending}
            rowKey={(r) => `${r.section}-${r.gstRate}`}
            minWidth={760}
            empty={<EmptyState title={t("gstPage.noOutward")} />}
            columns={[
              { key: "section", header: t("gstPage.section"), render: (r) => <Badge tone={r.section === "B2B" ? "accent" : "neutral"}>{r.section}</Badge> },
              { key: "rate", header: t("invoice.gstRate"), align: "right", render: (r) => `${number(r.gstRate, 2)}%` },
              { key: "docs", header: t("reports.bills"), align: "right", render: (r) => r.documents },
              ...heads<GstSummary["outward"][number]>(),
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("gstPage.inward")} />
        <div className="p-3 sm:p-4">
          <DataTable
            rows={d?.inward ?? []}
            loading={q.isPending}
            rowKey={(r) => `${r.itcEligibility}-${r.reverseCharge}-${r.gstRate}`}
            minWidth={760}
            empty={<EmptyState title={t("gstPage.noInward")} />}
            columns={[
              {
                key: "itc",
                header: t("purchase.itc"),
                render: (r) => (
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={r.itcEligibility === "ineligible" ? "danger" : "good"}>{t(`purchase.itcOptions.${r.itcEligibility as "eligible"}`)}</Badge>
                    {r.reverseCharge && <Badge tone="warn">RCM</Badge>}
                  </span>
                ),
              },
              { key: "rate", header: t("invoice.gstRate"), align: "right", render: (r) => `${number(r.gstRate, 2)}%` },
              { key: "docs", header: t("reports.bills"), align: "right", render: (r) => r.documents },
              ...heads<GstSummary["inward"][number]>(),
            ]}
          />
        </div>
      </Card>

      {d && d.notes.length > 0 && (
        <Card>
          <CardHeader title={t("gstPage.notes")} subtitle={t("gstPage.notesHint")} />
          <div className="p-3 sm:p-4">
            <DataTable
              rows={d.notes}
              rowKey={(r) => `${r.kind}-${r.registered}-${r.gstRate}`}
              minWidth={760}
              columns={[
                {
                  key: "kind",
                  header: t("gstPage.section"),
                  render: (r) => (
                    <Badge tone={r.kind === "credit_note" ? "warn" : "accent"}>
                      {r.kind === "credit_note" ? (r.registered ? "CDNR" : "CDNUR") : r.kind === "purchase_credit_note" ? t("notes.supplierCreditNote") : t("notes.debitNote")}
                    </Badge>
                  ),
                },
                { key: "rate", header: t("invoice.gstRate"), align: "right", render: (r) => `${number(r.gstRate, 2)}%` },
                { key: "docs", header: t("reports.bills"), align: "right", render: (r) => r.documents },
                ...heads<GstSummary["notes"][number]>(),
              ]}
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={t("gst.hsnSummary")} subtitle={t("gstPage.hsnNet")} />
        <div className="p-3 sm:p-4">
          <DataTable
            rows={d?.hsnSummary ?? []}
            loading={q.isPending}
            rowKey={(r) => `${r.hsnCode}-${r.uqc}-${r.gstRate}`}
            minWidth={820}
            columns={[
              { key: "hsn", header: "HSN", render: (r) => <span className="font-mono">{r.hsnCode ?? "—"}</span> },
              { key: "uqc", header: "UQC", render: (r) => r.uqc ?? "—" },
              { key: "rate", header: t("invoice.gstRate"), align: "right", render: (r) => `${number(r.gstRate, 2)}%` },
              { key: "qty", header: t("invoice.qty"), align: "right", render: (r) => number(r.qty) },
              ...heads<GstSummary["hsnSummary"][number]>(),
            ]}
          />
        </div>
      </Card>
    </div>
  );
}
