import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@digitalbahi/core";
import type { LocaleCode } from "@digitalbahi/i18n";
import { Banknote, Calculator, Lock, Play, Printer, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented, Skeleton } from "../../components/ui/misc";
import { BackButton, DataTable, ErrorNote, FilterBar, PageHeader, Tile } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY, WORKSPACE } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { METHODS } from "../payments/PaymentDialog";
import { useLocalName, useSalaryComponents } from "./api";
import { SalarySlipDocument, type PrintableSlip } from "./SalarySlipDocument";
import { StatutoryCard, type StatutorySummary } from "./StatutoryCard";

type RunStatus = "draft" | "finalized" | "paid" | "cancelled";
const TONE: Record<RunStatus, Tone> = { draft: "warn", finalized: "accent", paid: "good", cancelled: "neutral" };

interface RunRow {
  id: string;
  month: string;
  status: RunStatus;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  employees: number;
  paid: number;
}

interface SlipRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  designation: string | null;
  workingDays: string;
  paidDays: string;
  unpaidDays: string;
  overtimeHours: string;
  grossEarnings: string;
  totalDeductions: string;
  netPay: string;
  paidAt: string | null;
  paymentNumber: string | null;
}

interface RunDetail extends Omit<RunRow, "employees" | "paid"> {
  slips: SlipRow[];
  skipped: Array<{ id: string; employeeCode: string; name: string }>;
}

const monthLabel = (month: string, locale: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "long", year: "numeric" }).format(new Date(`${month}-01T00:00:00`));

export function PayrollPage() {
  const { t, money, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [month, setMonth] = useState(TODAY.slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const runs = useQuery({ queryKey: ["payroll", "runs"], queryFn: () => api.get<{ data: RunRow[] }>("/payroll/runs").then((r) => r.data) });

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<RunDetail>("/payroll/runs", { month });
      void qc.invalidateQueries({ queryKey: ["payroll"] });
      toast({ tone: "success", title: t("payroll.started", { month: monthLabel(month, locale) }) });
      setOpenRun(res.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PAYROLL_RUN_EXISTS" && typeof e.params?.id === "string") setOpenRun(e.params.id);
      else setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  if (openRun) return <RunView runId={openRun} onBack={() => setOpenRun(null)} />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("payroll.title")} subtitle={t("payroll.subtitle")} />
      {allowed("payroll.run") && (
        <FilterBar>
          <Input type="month" aria-label={t("payroll.month")} value={month} max={TODAY.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} className="md:w-48" />
          <Button variant="primary" icon={<Play size={16} />} disabled={busy || !/^\d{4}-\d{2}$/.test(month)} onClick={() => void start()}>
            {t("payroll.run", { month: /^\d{4}-\d{2}$/.test(month) ? monthLabel(month, locale) : "" })}
          </Button>
        </FilterBar>
      )}
      {error ? <ErrorNote error={error} /> : null}
      {runs.error ? <ErrorNote error={runs.error} /> : null}
      <DataTable
        rows={runs.data ?? []}
        rowKey={(r) => r.id}
        loading={runs.isPending}
        onRowClick={(r) => setOpenRun(r.id)}
        minWidth={680}
        empty={<EmptyState title={t("payroll.empty")} hint={t("payroll.emptyHint")} />}
        columns={[
          { key: "month", header: t("payroll.month"), render: (r) => <span className="font-medium text-ink">{monthLabel(r.month, locale)}</span> },
          { key: "status", header: t("common.status"), render: (r) => <Badge tone={TONE[r.status]}>{t(`payroll.status.${r.status}`)}</Badge> },
          { key: "employees", header: t("payroll.employees"), align: "right", render: (r) => `${r.paid}/${r.employees}` },
          { key: "gross", header: t("payroll.gross"), align: "right", render: (r) => money(r.totalGross) },
          { key: "net", header: t("payroll.net"), align: "right", render: (r) => <span className="font-semibold">{money(r.totalNet)}</span> },
        ]}
      />
    </div>
  );
}

function RunView({ runId, onBack }: { runId: string; onBack(): void }) {
  const { t, money, number, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [adjusting, setAdjusting] = useState<SlipRow | null>(null);
  const [paying, setPaying] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["payroll", "run", runId], queryFn: () => api.get<RunDetail>(`/payroll/runs/${runId}`) });
  const run = q.data;

  const act = async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ["payroll"] });
      void qc.invalidateQueries({ queryKey: ["employees"] });
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast({ tone: "success", title: done });
      after?.();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.error || !run) return <ErrorNote error={q.error} />;
  const draft = run.status === "draft";
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        back={<BackButton onClick={onBack} />}
        title={`${t("payroll.title")} · ${monthLabel(run.month, locale)}`}
        subtitle={<Badge tone={TONE[run.status]}>{t(`payroll.status.${run.status}`)}</Badge>}
        actions={
          <>
            {draft && allowed("payroll.run") && (
              <>
                <Button variant="ghost" icon={<Trash2 size={16} />} disabled={busy} onClick={() => void act(() => api.delete(`/payroll/runs/${run.id}`), t("payroll.deleted"), onBack)}>
                  {t("common.delete")}
                </Button>
                <Button icon={<Calculator size={16} />} disabled={busy} onClick={() => void act(() => api.post(`/payroll/runs/${run.id}/recalculate`, {}), t("payroll.recalculated"))}>
                  {t("payroll.recalculate")}
                </Button>
              </>
            )}
            {draft && allowed("payroll.finalize") && (
              <Button variant="primary" icon={<Lock size={16} />} disabled={busy || run.slips.length === 0} onClick={() => void act(() => api.post(`/payroll/runs/${run.id}/finalize`, {}), t("payroll.finalized"))}>
                {t("payroll.finalize")}
              </Button>
            )}
            {run.status === "finalized" && allowed("payroll.pay") && (
              <Button variant="primary" icon={<Banknote size={16} />} onClick={() => setPaying(true)}>
                {t("payroll.pay")}
              </Button>
            )}
          </>
        }
      />
      {error ? <ErrorNote error={error} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label={t("payroll.gross")} value={money(run.totalGross)} />
        <Tile label={t("payroll.deductions")} value={money(run.totalDeductions)} />
        <Tile label={t("payroll.net")} value={money(run.totalNet)} tone="good" sub={t("payroll.employeeCount", { count: run.slips.length })} />
      </div>
      {run.skipped.length > 0 && draft && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-ink">{t("payroll.skipped", { names: run.skipped.map((s) => s.name).join(", ") })}</p>
      )}
      <DataTable
        rows={run.slips}
        rowKey={(s) => s.id}
        minWidth={860}
        onRowClick={(s) => setViewing(s.id)}
        empty={<EmptyState title={t("payroll.noSlips")} />}
        columns={[
          {
            key: "name",
            header: t("payroll.employee"),
            render: (s) => (
              <div>
                <p className="font-medium text-ink">{s.employeeName}</p>
                <p className="text-[12px] text-ink-3">
                  {s.employeeCode}
                  {s.designation ? ` · ${s.designation}` : ""}
                </p>
              </div>
            ),
          },
          { key: "days", header: t("payroll.paidDays"), align: "right", render: (s) => `${number(s.paidDays, 1)} / ${number(s.workingDays, 0)}` },
          { key: "ot", header: t("people.overtime"), align: "right", render: (s) => (Number(s.overtimeHours) ? number(s.overtimeHours, 1) : "—") },
          { key: "gross", header: t("payroll.gross"), align: "right", render: (s) => money(s.grossEarnings) },
          { key: "ded", header: t("payroll.deductions"), align: "right", render: (s) => money(s.totalDeductions) },
          { key: "net", header: t("payroll.net"), align: "right", render: (s) => <span className="font-semibold text-ink">{money(s.netPay)}</span> },
          {
            key: "action",
            header: "",
            align: "right",
            render: (s) =>
              draft && allowed("payroll.run") ? (
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAdjusting(s);
                  }}
                >
                  {t("payroll.adjust")}
                </Button>
              ) : s.paymentNumber ? (
                <Badge tone="good">{s.paymentNumber}</Badge>
              ) : null,
          },
        ]}
      />
      {allowed("payroll.view") && run.slips.length > 0 && <StatutoryCard runId={run.id} />}
      <AdjustDialog run={run} slip={adjusting} onClose={() => setAdjusting(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ["payroll"] })} />
      <PayDialog open={paying} onOpenChange={setPaying} run={run} onPay={(body) => act(() => api.post(`/payroll/runs/${run.id}/pay`, body), t("payroll.paidDone"), () => setPaying(false))} busy={busy} />
      <SlipDialog slipId={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

/** This month's incentive, bonus and other manual amounts for one person. */
function AdjustDialog({ run, slip, onClose, onSaved }: { run: RunDetail; slip: SlipRow | null; onClose(): void; onSaved(): void }) {
  const { t } = useI18n();
  const name = useLocalName();
  const components = useSalaryComponents();
  // ESI and professional tax worked out by law are not entered by hand.
  const statutory = useQuery({ queryKey: ["payroll", "statutory", run.id], queryFn: () => api.get<StatutorySummary>(`/payroll/runs/${run.id}/statutory`), enabled: Boolean(slip) });
  const byLaw = new Set([...(statutory.data?.settings.esi.enabled ? ["ESI"] : []), ...(statutory.data?.settings.pt.enabled ? ["PT"] : [])]);
  const manual = (components.data ?? []).filter((c) => c.calcType === "manual" && !byLaw.has(c.code));
  const [values, setValues] = useState<Record<string, string>>({});
  const [overtime, setOvertime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const detail = useQuery({ queryKey: ["payroll", "slip", slip?.id], queryFn: () => api.get<PrintableSlip>(`/payroll/slips/${slip!.id}`), enabled: Boolean(slip) });
  useEffect(() => {
    if (!slip) return;
    setError(null);
    setOvertime(String(Number(slip.overtimeHours)));
    setValues(Object.fromEntries((detail.data?.lines ?? []).filter((l) => l.componentId && manual.some((c) => c.id === l.componentId)).map((l) => [l.componentId!, String(Number(l.amount))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slip, detail.data]);
  const save = async () => {
    if (!slip) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/payroll/runs/${run.id}/slips/${slip.id}`, {
        manual: manual.map((c) => ({ componentId: c.id, amount: values[c.id] || "0" })),
        ...(overtime && overtime !== String(Number(slip.overtimeHours)) ? { overtimeHours: overtime } : {}),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={Boolean(slip)}
      onOpenChange={(v) => !v && onClose()}
      title={slip ? `${t("payroll.adjust")} · ${slip.employeeName}` : ""}
      description={t("payroll.adjustHint")}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {manual.map((c) => (
            <Field key={c.id} label={`${name(c)}${c.type === "deduction" ? ` (${t("people.deduction")})` : ""}`} htmlFor={`adj-${c.code}`}>
              <Input id={`adj-${c.code}`} inputMode="decimal" value={values[c.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value.trim() }))} leading={<span className="text-ink-3">₹</span>} />
            </Field>
          ))}
          <Field label={t("people.overtimeHours")} htmlFor="adj-ot" hint={t("payroll.overtimeHint")}>
            <Input id="adj-ot" inputMode="decimal" value={overtime} onChange={(e) => setOvertime(e.target.value.trim())} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function PayDialog({ open, onOpenChange, run, onPay, busy }: { open: boolean; onOpenChange(v: boolean): void; run: RunDetail; onPay(body: unknown): void; busy: boolean }) {
  const { t, money } = useI18n();
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [paidOn, setPaidOn] = useState(TODAY);
  const [reference, setReference] = useState("");
  const unpaid = run.slips.filter((s) => !s.paidAt);
  const total = unpaid.reduce((sum, s) => sum + Number(s.netPay), 0);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("payroll.pay")}
      description={t("payroll.payHint", { count: unpaid.length })}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || unpaid.length === 0} onClick={() => onPay({ method, paidOn, ...(reference.trim() ? { referenceNumber: reference.trim() } : {}) })}>
            {t("payroll.payAmount", { amount: money(total) })}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("common.method")} htmlFor="pay-method">
          <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`paymentMethod.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("common.date")} htmlFor="pay-date">
          <Input id="pay-date" type="date" max={TODAY} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t("common.reference")} htmlFor="pay-ref" hint={t("common.optional")}>
            <Input id="pay-ref" maxLength={40} value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function SlipDialog({ slipId, onClose }: { slipId: string | null; onClose(): void }) {
  const { t, locale } = useI18n();
  const [printLocale, setPrintLocale] = useState<LocaleCode>((WORKSPACE.printLocale as LocaleCode) || locale);
  const q = useQuery({ queryKey: ["payroll", "slip", slipId], queryFn: () => api.get<PrintableSlip>(`/payroll/slips/${slipId}`), enabled: Boolean(slipId) });
  return (
    <Dialog open={Boolean(slipId)} onOpenChange={(v) => !v && onClose()} size="xl" title={q.data ? `${t("payroll.slip.title")} · ${q.data.employee.name}` : t("common.loading")} closeLabel={t("common.close")}>
      {q.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              label={t("settings.printLanguage")}
              value={printLocale}
              onChange={setPrintLocale}
              options={[
                { value: "en", label: "English" },
                { value: "hi", label: "हिन्दी" },
              ]}
            />
            <Button size="sm" icon={<Printer size={14} />} onClick={() => window.print()}>
              {t("payroll.printSlip")}
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg bg-surface-2 p-2">
            <SalarySlipDocument slip={q.data} locale={printLocale} />
          </div>
          <PrintPortal>
            <SalarySlipDocument slip={q.data} locale={printLocale} />
          </PrintPortal>
        </div>
      ) : null}
    </Dialog>
  );
}
