import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse } from "@vyapaar/contracts";
import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validatePincode } from "@vyapaar/core";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { applyMe } from "../../data/live";
import { touch } from "../../data/store";
import { api, ApiError } from "../../lib/api";

interface BusinessRow {
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  pan: string | null;
  gstRegistration: "regular" | "composition" | "unregistered";
  stateCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  financialYearStartMonth: number;
}

type Policy = "allow" | "warn" | "block";
interface Settings {
  "stock.negative_policy": Policy;
  "stock.expiry_warning_days": number;
  "invoice.round_off": { mode: "none" | "nearest" | "up" | "down"; step: number };
  "invoice.default_print_locale": "en" | "hi";
  "credit.policy": { onLimitExceeded: Policy; onOverdue: Policy; overdueGraceDays: number };
  "payments.allocation": "oldest_first" | "manual";
  "reports.aging_buckets": number[];
}

/** Business header, rules and permissions in the running app follow the saved values at once. */
async function reloadMe() {
  applyMe(await api.get<MeResponse>("/me"));
  touch();
}

export function LiveSettings() {
  return (
    <>
      <BusinessProfileCard />
      <RulesCard />
      <SeriesCard />
    </>
  );
}

function BusinessProfileCard() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["business"], queryFn: () => api.get<BusinessRow>("/business") });
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  useEffect(() => {
    const b = q.data;
    if (!b) return;
    setForm({
      legalName: b.legalName,
      tradeName: b.tradeName ?? "",
      gstRegistration: b.gstRegistration,
      gstin: b.gstin ?? "",
      pan: b.pan ?? "",
      stateCode: b.stateCode,
      addressLine1: b.addressLine1 ?? "",
      addressLine2: b.addressLine2 ?? "",
      city: b.city ?? "",
      pincode: b.pincode ?? "",
      phone: b.phone ?? "",
      email: b.email ?? "",
    });
  }, [q.data]);

  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.error) return <ErrorNote error={q.error} />;

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const registered = form.gstRegistration !== "unregistered";
  const gstIssue = registered && form.gstin ? validateGstin(form.gstin, { expectedStateCode: form.stateCode })[0] : undefined;
  const pinBad = Boolean(form.pincode) && validatePincode(form.pincode ?? "").length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    const b = q.data;
    const nul = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
    const body: Record<string, unknown> = {
      legalName: form.legalName?.trim(),
      tradeName: nul(form.tradeName),
      gstRegistration: form.gstRegistration,
      gstin: registered ? nul(form.gstin) : null,
      pan: nul(form.pan?.toUpperCase()),
      stateCode: form.stateCode,
      addressLine1: nul(form.addressLine1),
      addressLine2: nul(form.addressLine2),
      city: nul(form.city),
      pincode: nul(form.pincode),
      phone: nul(form.phone),
      email: nul(form.email),
    };
    const patch = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== (b as unknown as Record<string, unknown>)[k]));
    try {
      if (Object.keys(patch).length) await api.patch("/business", patch);
      await q.refetch();
      await reloadMe();
      toast({ tone: "success", title: t("settings.saved") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const input = (k: string, label: string, props: { mono?: boolean; hint?: string; error?: string | null; max?: number; inputMode?: "numeric" | "tel" | "email" } = {}) => (
    <Field label={label} htmlFor={`b-${k}`} hint={props.hint} error={props.error ?? fieldError(k)}>
      <Input
        id={`b-${k}`}
        disabled={!canEdit}
        maxLength={props.max}
        inputMode={props.inputMode}
        className={props.mono ? "[&_input]:font-mono [&_input]:uppercase" : undefined}
        value={form[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
      />
    </Field>
  );

  return (
    <Card>
      <CardHeader title={t("settings.business")} subtitle={t("settings.businessHint")} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {input("legalName", t("settings.legalName"))}
          {input("tradeName", t("settings.tradeName"), { hint: t("common.optional") })}
          <Field label={t("supplier.gstRegistration")} htmlFor="b-reg" hint={t("settings.registrationHint")}>
            <Select id="b-reg" disabled={!canEdit} value={form.gstRegistration ?? "regular"} onChange={(e) => set("gstRegistration", e.target.value)}>
              {(["regular", "composition", "unregistered"] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`supplier.registration.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          {registered && (
            <Field label="GSTIN" htmlFor="b-gstin" error={gstIssue ? t(`validation.${gstIssue}`) : fieldError("gstin")}>
              <Input
                id="b-gstin"
                disabled={!canEdit}
                maxLength={15}
                className="[&_input]:font-mono [&_input]:uppercase"
                value={form.gstin ?? ""}
                onChange={(e) => {
                  const v = normalizeGstin(e.target.value);
                  set("gstin", v);
                  if (v.length >= 2 && GST_STATES.some((x) => x.code === stateCodeFromGstin(v))) set("stateCode", stateCodeFromGstin(v));
                }}
              />
            </Field>
          )}
          <Field label={t("common.state")} htmlFor="b-state" error={fieldError("stateCode")}>
            <Select id="b-state" disabled={!canEdit} value={form.stateCode ?? ""} onChange={(e) => set("stateCode", e.target.value)}>
              {GST_STATES.filter((x) => !x.legacy).map((x) => (
                <option key={x.code} value={x.code}>
                  {x.code} – {locale === "hi" ? x.nameHi : x.name}
                </option>
              ))}
            </Select>
          </Field>
          {input("pan", t("customer.pan"), { mono: true, max: 10 })}
          {input("addressLine1", t("customer.address"))}
          {input("addressLine2", t("settings.addressLine2"), { hint: t("common.optional") })}
          {input("city", t("common.city"))}
          {input("pincode", t("customer.pincode"), { max: 6, inputMode: "numeric", error: pinBad ? t("validation.pincode") : null })}
          {input("phone", t("common.mobile"), { inputMode: "tel" })}
          {input("email", t("common.email"), { inputMode: "email" })}
        </div>
        {canEdit && (
          <div>
            <Button variant="primary" disabled={busy || Boolean(gstIssue) || pinBad || !form.legalName?.trim()} onClick={() => void save()}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function RulesCard() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") });
  const [error, setError] = useState<unknown>(null);

  const put = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setError(null);
    try {
      await api.put(`/settings/${key}`, { value });
      qc.setQueryData<Settings>(["settings"], (s) => (s ? { ...s, [key]: value } : s));
      await reloadMe();
      toast({ tone: "success", title: t("settings.saved") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };

  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data;
  const policy = (label: string, value: Policy, onChange: (v: Policy) => void) => (
    <Segmented
      size="sm"
      label={label}
      value={value}
      onChange={(v) => canEdit && onChange(v)}
      options={[
        { value: "allow", label: t("settings.stockPolicyOptions.allow") },
        { value: "warn", label: t("settings.stockPolicyOptions.warn") },
        { value: "block", label: t("settings.stockPolicyOptions.block") },
      ]}
    />
  );
  const row = (title: string, hint: string, control: ReactNode) => (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );

  return (
    <Card>
      <CardHeader title={t("settings.invoiceSettings")} subtitle={canEdit ? undefined : t("settings.readOnly")} />
      <div className="px-4 pb-2 sm:px-5">
        {error ? <ErrorNote error={error} className="mt-3" /> : null}
        {row(t("settings.stockPolicy"), t("settings.stockPolicyHint"), policy(t("settings.stockPolicy"), s["stock.negative_policy"], (v) => void put("stock.negative_policy", v)))}
        {row(
          t("settings.creditLimit"),
          t("settings.creditLimitHint"),
          policy(t("settings.creditLimit"), s["credit.policy"].onLimitExceeded, (v) => void put("credit.policy", { ...s["credit.policy"], onLimitExceeded: v })),
        )}
        {row(t("settings.overdue"), t("settings.overdueHint"), policy(t("settings.overdue"), s["credit.policy"].onOverdue, (v) => void put("credit.policy", { ...s["credit.policy"], onOverdue: v })))}
        {row(
          t("invoice.roundOff"),
          t("settings.roundOffHint"),
          <Select
            aria-label={t("invoice.roundOff")}
            disabled={!canEdit}
            className="h-9 w-56"
            value={`${s["invoice.round_off"].mode}:${s["invoice.round_off"].step}`}
            onChange={(e) => {
              const [mode, step] = e.target.value.split(":");
              void put("invoice.round_off", { mode: mode as Settings["invoice.round_off"]["mode"], step: Number(step) });
            }}
          >
            {["none:1", "nearest:1", "nearest:0.5", "nearest:0.1", "up:1", "down:1", ...(["none:1", "nearest:1", "nearest:0.5", "nearest:0.1", "up:1", "down:1"].includes(`${s["invoice.round_off"].mode}:${s["invoice.round_off"].step}`) ? [] : [`${s["invoice.round_off"].mode}:${s["invoice.round_off"].step}`])].map((v) => {
              const [mode, step] = v.split(":");
              return (
                <option key={v} value={v}>
                  {t(`settings.roundOffModes.${mode as "none"}`)}
                  {mode !== "none" ? ` · ₹${step}` : ""}
                </option>
              );
            })}
          </Select>,
        )}
        {row(
          t("settings.printLanguage"),
          t("settings.printLanguageHint"),
          <Segmented
            size="sm"
            label={t("settings.printLanguage")}
            value={s["invoice.default_print_locale"]}
            onChange={(v) => canEdit && void put("invoice.default_print_locale", v)}
            options={[
              { value: "en", label: "English" },
              { value: "hi", label: "हिन्दी" },
            ]}
          />,
        )}
        {row(
          t("settings.allocation"),
          t("settings.allocationHint"),
          <Segmented
            size="sm"
            label={t("settings.allocation")}
            value={s["payments.allocation"]}
            onChange={(v) => canEdit && void put("payments.allocation", v)}
            options={[
              { value: "oldest_first", label: t("settings.allocationOptions.oldest_first") },
              { value: "manual", label: t("settings.allocationOptions.manual") },
            ]}
          />,
        )}
        {row(
          t("settings.expiryWarning"),
          t("settings.expiryWarningHint"),
          <Input
            aria-label={t("settings.expiryWarning")}
            disabled={!canEdit}
            inputSize="sm"
            inputMode="numeric"
            className="w-24 [&_input]:text-right"
            defaultValue={s["stock.expiry_warning_days"]}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0 && v <= 365 && v !== s["stock.expiry_warning_days"]) void put("stock.expiry_warning_days", v);
            }}
          />,
        )}
      </div>
    </Card>
  );
}

interface Series {
  id: string;
  docType: string;
  name: string;
  financialYear: string;
  pattern: string;
  nextNumber: number;
  isActive: boolean;
}

function SeriesCard() {
  const { t } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["document-series"], queryFn: () => api.get<{ data: Series[] }>("/document-series").then((r) => r.data) });
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  const save = async (s: Series) => {
    setError(null);
    try {
      await api.patch(`/document-series/${s.id}`, { pattern: editing[s.id] });
      await q.refetch();
      setEditing(({ [s.id]: _, ...rest }) => rest);
      toast({ tone: "success", title: t("settings.saved"), body: s.name });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };

  return (
    <Card>
      <CardHeader title={t("settings.series")} subtitle={t("settings.seriesHint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        <DataTable
          rows={q.data ?? []}
          loading={q.isPending}
          rowKey={(s) => s.id}
          minWidth={560}
          columns={[
            { key: "name", header: t("common.name"), render: (s) => <span className="font-medium text-ink">{s.name}</span> },
            { key: "fy", header: t("settings.financialYear"), render: (s) => <span className="text-ink-2">{s.financialYear}</span> },
            {
              key: "pattern",
              header: t("settings.pattern"),
              render: (s) =>
                canEdit ? (
                  <div className="flex items-center gap-2">
                    <Input
                      inputSize="sm"
                      aria-label={`${t("settings.pattern")} ${s.name}`}
                      className="w-48 [&_input]:font-mono"
                      value={editing[s.id] ?? s.pattern}
                      onChange={(e) => setEditing((x) => ({ ...x, [s.id]: e.target.value }))}
                    />
                    {editing[s.id] !== undefined && editing[s.id] !== s.pattern && (
                      <Button size="sm" variant="primary" onClick={() => void save(s)}>
                        {t("common.save")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="font-mono">{s.pattern}</span>
                ),
            },
            { key: "next", header: t("settings.nextNumber"), align: "right", render: (s) => s.nextNumber },
          ]}
        />
        <p className="text-[12.5px] text-ink-3">{t("settings.patternHint")}</p>
      </div>
    </Card>
  );
}
