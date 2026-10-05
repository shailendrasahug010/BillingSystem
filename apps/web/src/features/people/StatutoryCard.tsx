import { useQuery } from "@tanstack/react-query";
import { Download, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ErrorNote } from "../../components/ui/Page";
import { api, ApiError } from "../../lib/api";
import { downloadBlob } from "../../lib/download";
import { stateName } from "../../lib/states";

export interface StatutorySummary {
  month: string;
  settings: {
    pf: { enabled: boolean; establishmentCode: string | null };
    esi: { enabled: boolean; employerCode: string | null };
    pt: { enabled: boolean; stateCode: string; hasSlabs: boolean };
  };
  pf: {
    members: Array<{ employeeId: string; name: string; uan: string | null }>;
    totals: { employee: string; employerEpf: string; employerEps: string; edli: string; adminCharges: string; ac1: string; ac2: string; ac10: string; ac21: string; total: string };
  };
  esi: { members: Array<{ employeeId: string }>; totals: { employee: string; employer: string; total: string } };
  pt: { stateCode: string; rows: Array<{ employeeId: string; amount: string }>; total: string };
  missing: Array<{ employeeId: string; name: string; what: "uan" | "esiNumber" }>;
}

function Row({ label, value, strong }: { label: ReactNode; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between gap-3 border-t border-line pt-1.5 font-semibold text-ink" : "flex justify-between gap-3 text-ink-2"}>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

/**
 * The month's PF, ESI and professional tax as worked out on the slips: what
 * to pay on each challan and the files to upload (EPFO ECR, ESIC monthly
 * contribution sheet, PT list), with the numbers still missing.
 */
export function StatutoryCard({ runId }: { runId: string }) {
  const { t, money, locale } = useI18n();
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ["payroll", "statutory", runId], queryFn: () => api.get<StatutorySummary>(`/payroll/runs/${runId}/statutory`) });
  const s = q.data;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  if (!s) return null;
  const { pf, esi, pt } = s.settings;
  if (!pf.enabled && !esi.enabled && !pt.enabled) return <p className="text-[13px] text-ink-3">{t("payroll.statutory.off")}</p>;
  const [y, m] = s.month.split("-");
  const download = async (file: "ecr" | "esi" | "pt", name: string) => {
    setError(null);
    try {
      downloadBlob(name, await api.blob(`/payroll/runs/${runId}/statutory/${file}`));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  const block = (title: string, sub: string, body: ReactNode, action: ReactNode) => (
    <section className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        <p className="text-[12px] text-ink-3">{sub}</p>
      </div>
      <dl className="flex flex-col gap-1 text-[13px]">{body}</dl>
      <div className="mt-auto pt-1">{action}</div>
    </section>
  );
  return (
    <Card>
      <CardHeader title={t("payroll.statutory.title")} subtitle={t("payroll.statutory.hint")} />
      <div className="flex flex-col gap-3 px-4 pt-3 pb-4 sm:px-5">
        {error ? <ErrorNote error={error} /> : null}
        {s.missing.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-ink" role="status">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
            <span>
              {s.missing.map((x) => t(x.what === "uan" ? "payroll.statutory.noUan" : "payroll.statutory.noEsiNumber", { name: x.name })).join(" · ")}
            </span>
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {pf.enabled &&
            block(
              t("payroll.statutory.pf"),
              [t("payroll.statutory.members", { count: s.pf.members.length }), pf.establishmentCode].filter(Boolean).join(" · "),
              <>
                <Row label={t("payroll.statutory.employeeShare")} value={money(s.pf.totals.employee)} />
                <Row label={t("payroll.statutory.employerEpf")} value={money(s.pf.totals.employerEpf)} />
                <Row label={t("payroll.statutory.eps")} value={money(s.pf.totals.employerEps)} />
                <Row label={t("payroll.statutory.edli")} value={money(s.pf.totals.edli)} />
                <Row label={t("payroll.statutory.admin")} value={money(s.pf.totals.adminCharges)} />
                <Row label={t("payroll.statutory.challan")} value={money(s.pf.totals.total)} strong />
                <p className="num text-[11.5px] text-ink-3">
                  {t("payroll.statutory.accounts", { ac1: money(s.pf.totals.ac1), ac2: money(s.pf.totals.ac2), ac10: money(s.pf.totals.ac10), ac21: money(s.pf.totals.ac21) })}
                </p>
              </>,
              <Button size="sm" icon={<Download size={14} />} disabled={s.pf.members.every((x) => !x.uan)} onClick={() => void download("ecr", `ECR_${m}${y}.txt`)}>
                {t("payroll.statutory.ecr")}
              </Button>,
            )}
          {esi.enabled &&
            block(
              t("payroll.statutory.esi"),
              [t("payroll.statutory.members", { count: s.esi.members.length }), esi.employerCode].filter(Boolean).join(" · "),
              <>
                <Row label={t("payroll.statutory.employeeShare")} value={money(s.esi.totals.employee)} />
                <Row label={t("payroll.statutory.employerShare")} value={money(s.esi.totals.employer)} />
                <Row label={t("payroll.statutory.challan")} value={money(s.esi.totals.total)} strong />
              </>,
              <Button size="sm" icon={<Download size={14} />} disabled={s.esi.members.length === 0} onClick={() => void download("esi", `ESI_${m}${y}.csv`)}>
                {t("payroll.statutory.esiSheet")}
              </Button>,
            )}
          {pt.enabled &&
            block(
              t("payroll.statutory.pt"),
              stateName(s.pt.stateCode, locale),
              <>
                {!pt.hasSlabs && <p className="text-[12.5px] text-warn">{t("payroll.statutory.noSlabs", { state: stateName(s.pt.stateCode, locale) })}</p>}
                <Row label={t("payroll.statutory.ptPayers", { count: s.pt.rows.filter((r) => Number(r.amount) > 0).length })} value="" />
                <Row label={t("payroll.statutory.challan")} value={money(s.pt.total)} strong />
              </>,
              <Button size="sm" icon={<Download size={14} />} disabled={s.pt.rows.length === 0} onClick={() => void download("pt", `PT_${s.pt.stateCode}_${m}${y}.csv`)}>
                {t("payroll.statutory.ptList")}
              </Button>,
            )}
        </div>
      </div>
    </Card>
  );
}
