import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@vyapaar/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, Stat, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { METHODS } from "../payments/PaymentDialog";
import { STATUS_TONE, useLocalName, useSalaryComponents, type Employee } from "./api";
import { EmployeeDialog } from "./EmployeeDialog";

interface Structure {
  id: string;
  effectiveFrom: string;
  basic: string;
  monthlyGross: string;
  overtimeRatePerHour: string;
  lines: Array<{ componentId: string; amount: string; percent: string }>;
}

interface Advance {
  id: string;
  type: "advance" | "loan";
  amount: string;
  issuedOn: string;
  installmentAmount: string;
  recoveredAmount: string;
  isClosed: boolean;
  paymentNumber: string | null;
}

type Panel = null | "salary" | "advance" | "exit";

export function EmployeeDetailDialog({ employeeId, onClose }: { employeeId: string | null; onClose(): void }) {
  const { t, money, dateMedium } = useI18n();
  const name = useLocalName();
  const qc = useQueryClient();
  const toast = useToast();
  const [panel, setPanel] = useState<Panel>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fieldError = useFieldError(error);
  const components = useSalaryComponents();
  const detail = useQuery({ queryKey: ["employees", "detail", employeeId], queryFn: () => api.get<Employee>(`/employees/${employeeId}`), enabled: Boolean(employeeId) });
  const salary = useQuery({
    queryKey: ["employees", "salary", employeeId],
    queryFn: () => api.get<{ current: Structure | null; history: Structure[] }>(`/employees/${employeeId}/salary`),
    enabled: Boolean(employeeId) && allowed("payroll.view"),
  });
  const advances = useQuery({
    queryKey: ["employees", "advances", employeeId],
    queryFn: () => api.get<{ data: Advance[] }>(`/employees/${employeeId}/advances`).then((r) => r.data),
    enabled: Boolean(employeeId) && allowed("payroll.view"),
  });
  const e = detail.data;

  // Salary form: basic, overtime rate and one value per component (amount or percent).
  const [basic, setBasic] = useState("");
  const [from, setFrom] = useState(TODAY);
  const [otRate, setOtRate] = useState("0");
  const [values, setValues] = useState<Record<string, string>>({});
  // Advance form
  const [adv, setAdv] = useState({ type: "advance" as "advance" | "loan", amount: "", installmentAmount: "", method: "cash" as PaymentMethod });
  // Exit form
  const [exit, setExit] = useState({ exitDate: TODAY, status: "resigned" as "resigned" | "terminated", reason: "" });

  useEffect(() => {
    setPanel(null);
    setError(null);
  }, [employeeId]);
  useEffect(() => {
    setError(null);
    if (panel !== "salary") return;
    const cur = salary.data?.current;
    setBasic(cur?.basic ?? "");
    setOtRate(cur?.overtimeRatePerHour ?? "0");
    setFrom(TODAY.slice(0, 8) + "01");
    setValues(Object.fromEntries((cur?.lines ?? []).map((l) => [l.componentId, Number(l.percent) > 0 ? String(Number(l.percent)) : String(Number(l.amount))])));
  }, [panel, salary.data]);

  const editable = (components.data ?? []).filter((c) => c.code !== "BASIC" && (c.calcType === "fixed" || c.calcType === "percent_of_basic" || c.calcType === "manual"));
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ["employees"] });
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast({ tone: "success", title: done, body: e?.name });
      setPanel(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const saveSalary = () =>
    run(
      () =>
        api.put(`/employees/${employeeId}/salary`, {
          effectiveFrom: from,
          basic: basic || "0",
          overtimeRatePerHour: otRate || "0",
          components: editable
            .filter((c) => Number(values[c.id] ?? 0) > 0)
            .map((c) => (c.calcType === "percent_of_basic" ? { componentId: c.id, percent: values[c.id] } : { componentId: c.id, amount: values[c.id] })),
        }),
      t("people.salarySaved"),
    );

  const cur = salary.data?.current;
  return (
    <>
      <Dialog
        open={Boolean(employeeId) && !editing}
        onOpenChange={(v) => !v && onClose()}
        size="lg"
        title={e ? `${e.name} · ${e.employeeCode}` : t("common.loading")}
        description={e ? [e.designation, e.departmentName].filter(Boolean).join(" · ") || undefined : undefined}
        closeLabel={t("common.close")}
        footer={
          e && panel === null ? (
            <>
              {allowed("employee.update") && !e.exitDate && (
                <Button variant="ghost" onClick={() => setPanel("exit")}>
                  {t("people.recordExit")}
                </Button>
              )}
              {allowed("payroll.pay") && !e.exitDate && <Button onClick={() => setPanel("advance")}>{t("people.giveAdvance")}</Button>}
              {allowed("payroll.run") && <Button onClick={() => setPanel("salary")}>{t("people.changeSalary")}</Button>}
              {allowed("employee.update") && (
                <Button variant="primary" onClick={() => setEditing(true)}>
                  {t("common.edit")}
                </Button>
              )}
            </>
          ) : panel ? (
            <>
              <Button onClick={() => setPanel(null)}>{t("common.cancel")}</Button>
              {panel === "salary" && (
                <Button variant="primary" disabled={busy || !Number(basic)} onClick={() => void saveSalary()}>
                  {t("common.save")}
                </Button>
              )}
              {panel === "advance" && (
                <Button
                  variant="primary"
                  disabled={busy || !Number(adv.amount) || !Number(adv.installmentAmount)}
                  onClick={() => void run(() => api.post(`/employees/${employeeId}/advances`, adv), t("people.advanceGiven"))}
                >
                  {t("people.payAdvance", { amount: money(adv.amount || 0) })}
                </Button>
              )}
              {panel === "exit" && (
                <Button variant="danger" disabled={busy} onClick={() => void run(() => api.post(`/employees/${employeeId}/exit`, { ...exit, ...(exit.reason.trim() ? { reason: exit.reason.trim() } : { reason: undefined }) }), t("people.exitRecorded"))}>
                  {t("people.recordExit")}
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {detail.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : detail.error ? (
          <ErrorNote error={detail.error} />
        ) : e ? (
          <div className="flex flex-col gap-4">
            {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
            {panel === null && (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Stat label={t("common.status")} value={<Badge tone={STATUS_TONE[e.status]}>{t(`people.status.${e.status}`)}</Badge>} />
                  <Stat label={t("people.joiningDate")} value={dateMedium(e.joiningDate)} />
                  {e.exitDate && <Stat label={t("people.exitDate")} value={dateMedium(e.exitDate)} />}
                  <Stat label={t("common.mobile")} value={e.mobile} />
                  {e.monthlySalary !== null && <Stat label={t("people.monthlySalary")} value={money(e.monthlySalary)} />}
                  {e.bankAccountLast4 && <Stat label={t("people.bank")} value={`•••• ${e.bankAccountLast4}${e.bankIfsc ? ` · ${e.bankIfsc}` : ""}`} />}
                  {e.panMasked && <Stat label="PAN" value={e.panMasked} />}
                </div>
                {allowed("payroll.view") && (
                  <section>
                    <h3 className="mb-1.5 text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("people.salaryStructure")}</h3>
                    {cur ? (
                      <div className="rounded-lg border border-line px-3 py-2 text-[13.5px]">
                        <p className="mb-1 text-[12px] text-ink-3">{t("people.effectiveFrom", { date: dateMedium(cur.effectiveFrom) })}</p>
                        <ul className="num divide-y divide-line">
                          <li className="flex justify-between py-1">
                            <span>{t("people.basic")}</span>
                            <span>{money(cur.basic)}</span>
                          </li>
                          {cur.lines.map((l) => {
                            const c = components.data?.find((x) => x.id === l.componentId);
                            return (
                              <li key={l.componentId} className="flex justify-between py-1">
                                <span className={c?.type === "deduction" ? "text-danger" : ""}>{c ? name(c) : "—"}</span>
                                <span>{Number(l.percent) > 0 ? `${Number(l.percent)}% ${t("people.ofBasic")}` : money(l.amount)}</span>
                              </li>
                            );
                          })}
                          <li className="flex justify-between py-1 font-semibold">
                            <span>{t("people.monthlyGross")}</span>
                            <span>{money(cur.monthlyGross)}</span>
                          </li>
                        </ul>
                      </div>
                    ) : (
                      <p className="text-[13px] text-ink-3">{t("people.noStructure")}</p>
                    )}
                  </section>
                )}
                {(advances.data?.length ?? 0) > 0 && (
                  <section>
                    <h3 className="mb-1.5 text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("people.advances")}</h3>
                    <ul className="num divide-y divide-line rounded-lg border border-line text-[13.5px]">
                      {advances.data!.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                          <span>
                            {t(`people.advanceTypes.${a.type}`)} · {dateMedium(a.issuedOn)}
                            {a.paymentNumber && <span className="text-ink-3"> · {a.paymentNumber}</span>}
                          </span>
                          <span className={a.isClosed ? "text-ink-3" : "font-medium"}>
                            {money(a.recoveredAmount)} / {money(a.amount)} {a.isClosed ? `· ${t("people.recovered")}` : `· ${t("people.perMonth", { amount: money(a.installmentAmount) })}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
            {panel === "salary" && (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label={t("people.effectiveFromLabel")} htmlFor="sal-from" error={fieldError("effectiveFrom")}>
                    <Input id="sal-from" type="date" value={from} onChange={(x) => setFrom(x.target.value)} />
                  </Field>
                  <Field label={t("people.basic")} htmlFor="sal-basic" error={fieldError("basic")}>
                    <Input id="sal-basic" inputMode="decimal" autoFocus value={basic} onChange={(x) => setBasic(x.target.value.trim())} leading={<span className="text-ink-3">₹</span>} />
                  </Field>
                  <Field label={t("people.otRate")} htmlFor="sal-ot">
                    <Input id="sal-ot" inputMode="decimal" value={otRate} onChange={(x) => setOtRate(x.target.value.trim())} leading={<span className="text-ink-3">₹</span>} />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {editable.map((c) => (
                    <Field key={c.id} label={`${name(c)}${c.type === "deduction" ? ` (${t("people.deduction")})` : ""}`} htmlFor={`sal-${c.code}`} hint={c.calcType === "percent_of_basic" ? t("people.percentOfBasic") : c.calcType === "manual" ? t("people.monthlyDefault") : undefined}>
                      <Input
                        id={`sal-${c.code}`}
                        inputMode="decimal"
                        value={values[c.id] ?? ""}
                        onChange={(x) => setValues((v) => ({ ...v, [c.id]: x.target.value.trim() }))}
                        leading={<span className="text-ink-3">{c.calcType === "percent_of_basic" ? "%" : "₹"}</span>}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            )}
            {panel === "advance" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t("common.type")} htmlFor="adv-type">
                  <Select id="adv-type" value={adv.type} onChange={(x) => setAdv((a) => ({ ...a, type: x.target.value as "advance" | "loan" }))}>
                    <option value="advance">{t("people.advanceTypes.advance")}</option>
                    <option value="loan">{t("people.advanceTypes.loan")}</option>
                  </Select>
                </Field>
                <Field label={t("common.amount")} htmlFor="adv-amount" error={fieldError("amount")}>
                  <Input id="adv-amount" inputMode="decimal" autoFocus value={adv.amount} onChange={(x) => setAdv((a) => ({ ...a, amount: x.target.value.trim() }))} leading={<span className="text-ink-3">₹</span>} />
                </Field>
                <Field label={t("people.installment")} htmlFor="adv-inst" hint={t("people.installmentHint")} error={fieldError("installmentAmount")}>
                  <Input id="adv-inst" inputMode="decimal" value={adv.installmentAmount} onChange={(x) => setAdv((a) => ({ ...a, installmentAmount: x.target.value.trim() }))} leading={<span className="text-ink-3">₹</span>} />
                </Field>
                <Field label={t("common.method")} htmlFor="adv-method">
                  <Select id="adv-method" value={adv.method} onChange={(x) => setAdv((a) => ({ ...a, method: x.target.value as PaymentMethod }))}>
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`paymentMethod.${m}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {panel === "exit" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t("people.exitDate")} htmlFor="exit-date" error={fieldError("exitDate")}>
                  <Input id="exit-date" type="date" value={exit.exitDate} onChange={(x) => setExit((v) => ({ ...v, exitDate: x.target.value }))} />
                </Field>
                <Field label={t("common.status")} htmlFor="exit-status">
                  <Select id="exit-status" value={exit.status} onChange={(x) => setExit((v) => ({ ...v, status: x.target.value as "resigned" | "terminated" }))}>
                    <option value="resigned">{t("people.status.resigned")}</option>
                    <option value="terminated">{t("people.status.terminated")}</option>
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label={t("common.reason")} htmlFor="exit-reason" hint={t("common.optional")}>
                    <Input id="exit-reason" value={exit.reason} onChange={(x) => setExit((v) => ({ ...v, reason: x.target.value }))} maxLength={300} />
                  </Field>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
      <EmployeeDialog open={editing} onOpenChange={setEditing} employee={e ?? null} />
    </>
  );
}
