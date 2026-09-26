import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { DataTable, ErrorNote, Tile } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { api } from "../../lib/api";
import { downloadCsv } from "../../lib/download";
import { stateName } from "../../lib/states";

interface Tax {
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
}

interface Gstr3b {
  period: string;
  version: string;
  outward: { taxable: { taxable: string } & Tax; nilExempt: { taxable: string }; reverseChargeInward: { taxable: string } & Tax; nonGst: { taxable: string } };
  interStateUnregistered: Array<{ placeOfSupply: string; taxable: string; igst: string }>;
  itc: { reverseCharge: Tax; allOther: Tax; reversed: Tax; net: Tax };
  payment: { liability: Tax; paidFromCredit: Tax; cash: Tax; creditCarriedForward: Tax };
}

type Line = { key: string; label: string; taxable?: string } & Partial<Tax>;
const total = (t: Tax) => Number(t.igst) + Number(t.cgst) + Number(t.sgst) + Number(t.cess);

/** GSTR-3B working: the figures to type into the portal, table by table. */
export function Gstr3bTab({ period }: { period: string }) {
  const { t, money, locale } = useI18n();
  const q = useQuery({
    queryKey: ["gst", "gstr3b", period],
    queryFn: () => api.get<Gstr3b>("/gst/returns/gstr3b", { period }),
    enabled: /^\d{4}-\d{2}$/.test(period),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const cell = (v: string | undefined) => (v === undefined ? "" : Number(v) ? money(v) : "—");
  const columns = (withTaxable: boolean) => [
    { key: "label", header: t("gstPage.table"), render: (r: Line) => <span className="font-medium text-ink">{r.label}</span> },
    ...(withTaxable ? [{ key: "taxable", header: t("invoice.taxableValue"), align: "right" as const, render: (r: Line) => cell(r.taxable) }] : []),
    { key: "igst", header: t("invoice.igst"), align: "right" as const, render: (r: Line) => cell(r.igst) },
    { key: "cgst", header: t("invoice.cgst"), align: "right" as const, render: (r: Line) => cell(r.cgst) },
    { key: "sgst", header: t("invoice.sgst"), align: "right" as const, render: (r: Line) => cell(r.sgst) },
    { key: "cess", header: t("invoice.cess"), align: "right" as const, render: (r: Line) => cell(r.cess) },
  ];
  const outward: Line[] = d
    ? [
        { key: "a", label: t("gstPage.r3b.outwardTaxable"), ...d.outward.taxable },
        { key: "c", label: t("gstPage.r3b.nilExempt"), taxable: d.outward.nilExempt.taxable },
        { key: "d", label: t("gstPage.r3b.reverseCharge"), ...d.outward.reverseChargeInward },
        { key: "e", label: t("gstPage.r3b.nonGst"), taxable: d.outward.nonGst.taxable },
      ]
    : [];
  const itc: Line[] = d
    ? [
        { key: "a3", label: t("gstPage.r3b.itcRcm"), ...d.itc.reverseCharge },
        { key: "a5", label: t("gstPage.r3b.itcOther"), ...d.itc.allOther },
        { key: "b1", label: t("gstPage.r3b.itcReversed"), ...d.itc.reversed },
        { key: "c", label: t("gstPage.r3b.itcNet"), ...d.itc.net },
      ]
    : [];
  const payment: Line[] = d
    ? [
        { key: "l", label: t("gstPage.r3b.liability"), ...d.payment.liability },
        { key: "u", label: t("gstPage.r3b.paidFromCredit"), ...d.payment.paidFromCredit },
        { key: "c", label: t("gstPage.r3b.cash"), ...d.payment.cash },
        { key: "f", label: t("gstPage.r3b.carryForward"), ...d.payment.creditCarriedForward },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      {q.error ? <ErrorNote error={q.error} /> : null}
      {d && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label={t("gstPage.r3b.liability")} value={money(total(d.payment.liability))} />
          <Tile label={t("gstPage.r3b.paidFromCredit")} value={money(total(d.payment.paidFromCredit))} tone="good" />
          <Tile label={t("gstPage.r3b.cash")} value={money(total(d.payment.cash))} tone={total(d.payment.cash) > 0 ? "danger" : undefined} sub={t("gstPage.r3b.cashHint")} />
        </div>
      )}
      <Card>
        <CardHeader
          title={t("gstPage.r3b.t31")}
          action={
            d && allowed("gst.export") ? (
              <Button
                size="sm"
                icon={<Download size={14} />}
                onClick={() =>
                  downloadCsv(
                    `gstr3b-${period}.csv`,
                    [
                      { label: "Table", value: (r: Line) => r.label },
                      { label: "Taxable", value: (r: Line) => r.taxable ?? "" },
                      { label: "IGST", value: (r: Line) => r.igst ?? "" },
                      { label: "CGST", value: (r: Line) => r.cgst ?? "" },
                      { label: "SGST", value: (r: Line) => r.sgst ?? "" },
                      { label: "Cess", value: (r: Line) => r.cess ?? "" },
                    ],
                    [...outward, ...itc, ...payment],
                  )
                }
              >
                {t("common.export")}
              </Button>
            ) : undefined
          }
        />
        <div className="p-3 sm:p-4">
          <DataTable rows={outward} rowKey={(r) => r.key} loading={q.isPending} minWidth={760} columns={columns(true)} />
        </div>
      </Card>
      {d && d.interStateUnregistered.length > 0 && (
        <Card>
          <CardHeader title={t("gstPage.r3b.t32")} />
          <div className="p-3 sm:p-4">
            <DataTable
              rows={d.interStateUnregistered}
              rowKey={(r) => r.placeOfSupply}
              columns={[
                { key: "pos", header: t("invoice.placeOfSupply"), render: (r) => stateName(r.placeOfSupply, locale) },
                { key: "taxable", header: t("invoice.taxableValue"), align: "right", render: (r) => money(r.taxable) },
                { key: "igst", header: t("invoice.igst"), align: "right", render: (r) => money(r.igst) },
              ]}
            />
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title={t("gstPage.r3b.t4")} subtitle={t("gstPage.r3b.t4Hint")} />
        <div className="p-3 sm:p-4">
          <DataTable rows={itc} rowKey={(r) => r.key} loading={q.isPending} minWidth={640} columns={columns(false)} />
        </div>
      </Card>
      <Card>
        <CardHeader title={t("gstPage.r3b.t6")} subtitle={t("gstPage.r3b.t6Hint")} />
        <div className="p-3 sm:p-4">
          <DataTable rows={payment} rowKey={(r) => r.key} loading={q.isPending} minWidth={640} columns={columns(false)} />
        </div>
      </Card>
    </div>
  );
}
