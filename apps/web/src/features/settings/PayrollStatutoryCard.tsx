import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PT_RULES, type PtRule, type PtSlab } from "@vyapaar/core";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { stateName, stateOptions } from "../../lib/states";

export interface PayrollStatutory {
  pf: { enabled: boolean; establishmentCode: string | null; restrictToCeiling: boolean; wagesRule: "codes" | "basic_da" };
  esi: { enabled: boolean; employerCode: string | null };
  pt: { enabled: boolean; stateCode: string | null; rule: PtRule | null };
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * PF, ESI and professional tax worked out on every salary slip. Professional
 * tax uses the built-in slabs for the state unless the business enters its
 * own (from the state's current notification).
 */
export function PayrollStatutoryCard() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ "payroll.statutory": PayrollStatutory }>("/settings") });
  const [form, setForm] = useState<PayrollStatutory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data["payroll.statutory"]);
  }, [q.data, form]);

  if (q.isPending || (!form && !q.error)) return <Skeleton className="h-48 w-full" />;
  if (q.error || !form) return <ErrorNote error={q.error} />;
  const ptState = form.pt.stateCode ?? BUSINESS.stateCode;
  const builtIn = PT_RULES[ptState] ?? null;
  const rule = form.pt.rule ?? builtIn;
  const setPf = (p: Partial<PayrollStatutory["pf"]>) => setForm({ ...form, pf: { ...form.pf, ...p } });
  const setEsi = (p: Partial<PayrollStatutory["esi"]>) => setForm({ ...form, esi: { ...form.esi, ...p } });
  const setPt = (p: Partial<PayrollStatutory["pt"]>) => setForm({ ...form, pt: { ...form.pt, ...p } });
  // Editing a slab turns the built-in slabs into the business's own.
  const setSlabs = (slabs: PtSlab[]) => setPt({ rule: { basis: rule?.basis ?? "monthly", ...(rule?.femaleSlabs ? { femaleSlabs: rule.femaleSlabs } : {}), slabs } });
  const slabs = rule?.slabs ?? [];
  const setSlab = (i: number, p: Partial<PtSlab>) => setSlabs(slabs.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = {
        ...form,
        pf: { ...form.pf, establishmentCode: form.pf.establishmentCode?.trim() || null },
        esi: { ...form.esi, employerCode: form.esi.employerCode?.trim() || null },
      };
      await api.put("/settings/payroll.statutory", { value });
      qc.setQueryData<Record<string, unknown>>(["settings"], (s) => (s ? { ...s, "payroll.statutory": value } : s));
      void qc.invalidateQueries({ queryKey: ["payroll"] });
      toast({ tone: "success", title: t("settings.saved"), body: t("settings.statutory.savedHint") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const section = "flex flex-col gap-3 border-b border-line py-4 last:border-b-0";
  return (
    <Card>
      <CardHeader title={t("settings.statutory.title")} subtitle={canEdit ? t("settings.statutory.hint") : t("settings.readOnly")} />
      <div className="px-4 pb-4 sm:px-5">
        {error ? <ErrorNote error={error} className="mt-3" /> : null}
        <section className={section} aria-label={t("payroll.statutory.pf")}>
          <Checkbox label={t("settings.statutory.pfOn")} checked={form.pf.enabled} disabled={!canEdit} onChange={(v) => setPf({ enabled: v })} />
          {form.pf.enabled && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("settings.statutory.establishmentCode")} htmlFor="pf-code" hint={t("common.optional")}>
                <Input id="pf-code" disabled={!canEdit} maxLength={30} className="[&_input]:font-mono [&_input]:uppercase" value={form.pf.establishmentCode ?? ""} onChange={(e) => setPf({ establishmentCode: e.target.value.toUpperCase().replace(/[^A-Z0-9/]/g, "") })} />
              </Field>
              <Field label={t("settings.statutory.pfWages")} htmlFor="pf-wages" hint={t(`settings.statutory.pfWagesHint.${form.pf.wagesRule}`)}>
                <Select id="pf-wages" disabled={!canEdit} value={form.pf.wagesRule} onChange={(e) => setPf({ wagesRule: e.target.value as "codes" | "basic_da" })}>
                  <option value="codes">{t("settings.statutory.pfWagesOptions.codes")}</option>
                  <option value="basic_da">{t("settings.statutory.pfWagesOptions.basic_da")}</option>
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Checkbox label={t("settings.statutory.ceiling")} checked={form.pf.restrictToCeiling} disabled={!canEdit} onChange={(v) => setPf({ restrictToCeiling: v })} />
              </div>
            </div>
          )}
        </section>
        <section className={section} aria-label={t("payroll.statutory.esi")}>
          <Checkbox label={t("settings.statutory.esiOn")} checked={form.esi.enabled} disabled={!canEdit} onChange={(v) => setEsi({ enabled: v })} />
          {form.esi.enabled && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("settings.statutory.esiCode")} htmlFor="esi-code" hint={t("settings.statutory.esiHint")}>
                <Input id="esi-code" disabled={!canEdit} inputMode="numeric" maxLength={20} className="[&_input]:font-mono" value={form.esi.employerCode ?? ""} onChange={(e) => setEsi({ employerCode: e.target.value.replace(/\D/g, "") })} />
              </Field>
            </div>
          )}
        </section>
        <section className={section} aria-label={t("payroll.statutory.pt")}>
          <Checkbox label={t("settings.statutory.ptOn")} checked={form.pt.enabled} disabled={!canEdit} onChange={(v) => setPt({ enabled: v })} />
          {form.pt.enabled && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("settings.statutory.ptState")} htmlFor="pt-state">
                  <Select id="pt-state" disabled={!canEdit} value={ptState} onChange={(e) => setPt({ stateCode: e.target.value === BUSINESS.stateCode ? null : e.target.value, rule: null })}>
                    {stateOptions(locale, { special: false }).map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("settings.statutory.ptBasis")} htmlFor="pt-basis">
                  <Select id="pt-basis" disabled={!canEdit} value={rule?.basis ?? "monthly"} onChange={(e) => setPt({ rule: { ...(rule ?? { slabs: [] }), basis: e.target.value as "monthly" | "annual" } })}>
                    <option value="monthly">{t("settings.statutory.ptBasisOptions.monthly")}</option>
                    <option value="annual">{t("settings.statutory.ptBasisOptions.annual")}</option>
                  </Select>
                </Field>
              </div>
              <p className="text-[12.5px] text-ink-3">
                {form.pt.rule ? t("settings.statutory.ptOwn") : builtIn ? t("settings.statutory.ptBuiltIn", { state: stateName(ptState, locale) }) : t("settings.statutory.ptNone", { state: stateName(ptState, locale) })}
              </p>
              <div className="scroll-x">
                <table className="num w-full min-w-[520px] text-[13px]">
                  <thead>
                    <tr className="text-left text-[12px] text-ink-3">
                      <th className="py-1 pr-2 font-medium">{t("settings.statutory.ptAbove")}</th>
                      <th className="py-1 pr-2 font-medium">{t("settings.statutory.ptAmount")}</th>
                      <th className="py-1 pr-2 font-medium">{t("settings.statutory.ptSpecialMonth")}</th>
                      <th className="py-1 pr-2 font-medium">{t("settings.statutory.ptSpecialAmount")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {slabs.map((s, i) => (
                      <tr key={i}>
                        <td className="py-1 pr-2">
                          <Input aria-label={`${t("settings.statutory.ptAbove")} ${i + 1}`} inputSize="sm" inputMode="numeric" disabled={!canEdit} value={String(s.above)} onChange={(e) => setSlab(i, { above: Number(e.target.value.replace(/\D/g, "")) || 0 })} leading={<span className="text-ink-3">₹</span>} />
                        </td>
                        <td className="py-1 pr-2">
                          <Input aria-label={`${t("settings.statutory.ptAmount")} ${i + 1}`} inputSize="sm" inputMode="numeric" disabled={!canEdit} value={String(s.amount)} onChange={(e) => setSlab(i, { amount: Math.min(2500, Number(e.target.value.replace(/\D/g, "")) || 0) })} leading={<span className="text-ink-3">₹</span>} />
                        </td>
                        <td className="py-1 pr-2">
                          <Select
                            aria-label={`${t("settings.statutory.ptSpecialMonth")} ${i + 1}`}
                            className="h-8 text-[13px]"
                            disabled={!canEdit}
                            value={s.special ? String(s.special.month) : ""}
                            onChange={(e) => {
                              const { special: _s, ...rest } = s;
                              setSlabs(slabs.map((x, j) => (j === i ? (e.target.value ? { ...rest, special: { month: Number(e.target.value), amount: s.special?.amount ?? s.amount } } : rest) : x)));
                            }}
                          >
                            <option value="">—</option>
                            {MONTHS.map((mo) => (
                              <option key={mo} value={mo}>
                                {new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "long" }).format(new Date(2026, mo - 1, 1))}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="py-1 pr-2">
                          {s.special && (
                            <Input aria-label={`${t("settings.statutory.ptSpecialAmount")} ${i + 1}`} inputSize="sm" inputMode="numeric" disabled={!canEdit} value={String(s.special.amount)} onChange={(e) => setSlab(i, { special: { month: s.special!.month, amount: Math.min(2500, Number(e.target.value.replace(/\D/g, "")) || 0) } })} leading={<span className="text-ink-3">₹</span>} />
                          )}
                        </td>
                        <td className="py-1 text-right">
                          {canEdit && (
                            <button type="button" className="rounded p-1.5 text-ink-3 hover:bg-surface-2 hover:text-danger" aria-label={t("common.remove")} onClick={() => setSlabs(slabs.filter((_, j) => j !== i))}>
                              <Trash2 size={15} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rule?.femaleSlabs && <p className="text-[12.5px] text-ink-3">{t("settings.statutory.ptWomen", { slabs: rule.femaleSlabs.map((s) => `> ₹${s.above}: ₹${s.amount}`).join(", ") })}</p>}
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={<Plus size={14} />} onClick={() => setSlabs([...slabs, { above: (slabs.at(-1)?.above ?? 0) + 5000, amount: 200 }])}>
                    {t("settings.statutory.ptAddSlab")}
                  </Button>
                  {form.pt.rule && builtIn && (
                    <Button size="sm" variant="ghost" onClick={() => setPt({ rule: null })}>
                      {t("settings.statutory.ptUseBuiltIn")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
        {canEdit && (
          <div className="flex justify-end pt-3">
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
