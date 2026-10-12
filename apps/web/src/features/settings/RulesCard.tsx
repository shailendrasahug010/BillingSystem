import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UPI_ID } from "@digitalbahi/core";
import { useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY, WORKSPACE } from "../../data/db";
import { useStoreVersion } from "../../data/store";
import { api, ApiError } from "../../lib/api";
import { DEFAULT_START_SYMBOL } from "../invoice/units";
import { type Policy, type Settings, type PaymentDetails, reloadMe } from "./shared";

/** The last day of the financial year a date falls in (an LUT is filed for one year). */
function yearEnd(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y + 1 : y}-03-31`;
}

/**
 * The letter of undertaking (form RFD-11) that lets exports and supplies to
 * SEZ go without IGST: its ARN and the day it runs out. Bills made while it
 * is valid default to "under LUT".
 */
function LutRow({ value, canEdit, onSave }: { value: Settings["gst.lut"]; canEdit: boolean; onSave(v: Settings["gst.lut"]): Promise<void> }) {
  const { t } = useI18n();
  const [arn, setArn] = useState(value?.arn ?? "");
  const [until, setUntil] = useState(value?.validUntil ?? yearEnd(TODAY));
  const [busy, setBusy] = useState(false);
  const arnOk = /^[A-Za-z0-9/-]{5,20}$/.test(arn.trim());
  const changed = arn.trim() !== (value?.arn ?? "") || until !== (value?.validUntil ?? "");
  const run = async (v: Settings["gst.lut"]) => {
    setBusy(true);
    try {
      await onSave(v);
      if (!v) {
        setArn("");
        setUntil(yearEnd(TODAY));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3">
      <div>
        <p className="text-[14px] font-medium text-ink">{t("settings.lut")}</p>
        <p className="text-[12.5px] text-ink-3">{t("settings.lutHint")}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("settings.lutArn")} htmlFor="lut-arn">
          <Input id="lut-arn" inputSize="sm" disabled={!canEdit} maxLength={20} className="w-52 [&_input]:font-mono [&_input]:uppercase" placeholder="AD2303260001234" value={arn} onChange={(e) => setArn(e.target.value.toUpperCase().replace(/\s/g, ""))} />
        </Field>
        <Field label={t("settings.lutValidUntil")} htmlFor="lut-until">
          <Input id="lut-until" inputSize="sm" type="date" disabled={!canEdit} className="w-40" value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        {canEdit && (
          <>
            <Button size="sm" variant="primary" disabled={busy || !arnOk || !until || !changed} onClick={() => void run({ arn: arn.trim(), validUntil: until })}>
              {t("common.save")}
            </Button>
            {value && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(null)}>
                {t("settings.lutClear")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Where customers pay: the bank account and UPI ID printed on invoices, with
 * a UPI code for what a bill still owes on the PDF and on thermal receipts.
 */
function PaymentDetailsRow({ value, canEdit, onSave }: { value: PaymentDetails | undefined; canEdit: boolean; onSave(v: PaymentDetails): Promise<void> }) {
  const { t } = useI18n();
  const empty: PaymentDetails = { bankName: "", accountNumber: "", ifsc: "", upiId: "" };
  const [form, setForm] = useState<PaymentDetails>(value ?? empty);
  const [busy, setBusy] = useState(false);
  const clean: PaymentDetails = { bankName: form.bankName.trim(), accountNumber: form.accountNumber.trim(), ifsc: form.ifsc.trim().toUpperCase(), upiId: form.upiId.trim() };
  const bad = {
    accountNumber: !/^\d{0,20}$/.test(clean.accountNumber),
    ifsc: !/^([A-Z]{4}0[A-Z0-9]{6})?$/.test(clean.ifsc),
    upiId: Boolean(clean.upiId) && !UPI_ID.test(clean.upiId),
  };
  const changed = JSON.stringify(clean) !== JSON.stringify(value ?? empty);
  const field = (key: keyof PaymentDetails, label: string, extra: { placeholder?: string; mono?: boolean; inputMode?: "numeric" } = {}) => (
    <Field label={label} htmlFor={`pay-${key}`} error={bad[key as keyof typeof bad] ? t("settings.paymentInvalid") : undefined}>
      <Input
        id={`pay-${key}`}
        inputSize="sm"
        disabled={!canEdit}
        maxLength={key === "upiId" ? 100 : key === "accountNumber" ? 20 : key === "ifsc" ? 11 : 100}
        className={extra.mono ? "[&_input]:font-mono" : undefined}
        placeholder={extra.placeholder}
        inputMode={extra.inputMode}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: key === "ifsc" ? e.target.value.toUpperCase() : e.target.value }))}
      />
    </Field>
  );
  return (
    <div id="settings-payment" className="flex scroll-mt-20 flex-col gap-2 border-b border-line py-3">
      <div>
        <p className="text-[14px] font-medium text-ink">{t("settings.paymentDetails")}</p>
        <p className="text-[12.5px] text-ink-3">{t("settings.paymentDetailsHint")}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field("bankName", t("settings.bankName"), { placeholder: "State Bank of India" })}
        {field("accountNumber", t("settings.accountNumber"), { mono: true, inputMode: "numeric" })}
        {field("ifsc", "IFSC", { mono: true, placeholder: "SBIN0001234" })}
        {field("upiId", t("settings.upiId"), { mono: true, placeholder: "yourshop@okhdfcbank" })}
      </div>
      {canEdit && (
        <div>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !changed || Object.values(bad).some(Boolean)}
            onClick={() => {
              setBusy(true);
              void onSave(clean).finally(() => setBusy(false));
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Units on a bill's lines: the unit new lines start in (strips, for products
 * sold by the strip, until set) and the letter each unit is picked with (its
 * symbol's first until set).
 */
function BillUnitsRow({
  letters,
  startIn,
  canEdit,
  onSaveLetters,
  onSaveStart,
}: {
  letters: Record<string, string> | null | undefined;
  startIn: string | null | undefined;
  canEdit: boolean;
  onSaveLetters(v: Record<string, string> | null): Promise<void>;
  onSaveStart(v: string): Promise<void>;
}) {
  const { t } = useI18n();
  useStoreVersion();
  const units = WORKSPACE.unitList;
  const first = (symbol: string) => (Array.from(symbol)[0] ?? "").toUpperCase();
  const saved = letters ?? {};
  // The letters as typed, by unit id, over what is saved ("": the unit's first letter).
  const [edited, setEdited] = useState<Record<string, string>>({});
  const shown = (id: string) => edited[id] ?? saved[id] ?? "";
  const [busy, setBusy] = useState(false);
  const bad = units.some((u) => shown(u.id) !== "" && !/^\p{L}$/u.test(shown(u.id)));
  // Only letters other than the unit's first are kept.
  const clean = Object.fromEntries(units.flatMap((u) => (shown(u.id) && shown(u.id) !== first(u.symbol) ? [[u.id, shown(u.id)]] : [])));
  const sorted = (r: Record<string, string>) => JSON.stringify(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  const changed = sorted(clean) !== sorted(saved);
  const startValue = startIn ?? units.find((u) => u.symbol === DEFAULT_START_SYMBOL)?.id ?? "own";
  const run = (job: Promise<void>, after?: () => void) => {
    setBusy(true);
    void job.finally(() => {
      setBusy(false);
      after?.();
    });
  };
  return (
    <div className="flex flex-col gap-3 border-b border-line py-3" role="group" aria-labelledby="bill-units-h">
      <div>
        <p id="bill-units-h" className="text-[14px] font-medium text-ink">
          {t("settings.billUnits")}
        </p>
        <p className="text-[12.5px] text-ink-3">{t("settings.billUnitsHint")}</p>
      </div>
      <div className="max-w-sm">
        <Field label={t("settings.startUnit")} hint={t("settings.startUnitHint")} htmlFor="start-unit">
          <Select id="start-unit" disabled={!canEdit || busy} value={startValue} onChange={(e) => e.target.value !== startValue && run(onSaveStart(e.target.value))}>
            <option value="own">{t("settings.startUnitOwn")}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.symbol} — {u.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div>
        <p className="text-[13px] font-medium text-ink-2">{t("settings.unitLetters")}</p>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
          {units.map((u) => (
            <label key={u.id} className="flex items-center gap-2 rounded-lg border border-line py-1 pr-1 pl-2.5">
              <span className="min-w-0 flex-1 truncate text-[13px]">
                <span className="font-medium text-ink">{u.symbol}</span> <span className="text-ink-3">{u.name}</span>
              </span>
              <input
                aria-label={t("settings.unitLetterFor", { unit: u.symbol })}
                disabled={!canEdit}
                maxLength={1}
                placeholder={first(u.symbol)}
                value={shown(u.id)}
                onChange={(e) => setEdited((all) => ({ ...all, [u.id]: e.target.value.trim().toUpperCase() }))}
                className="h-8 w-9 shrink-0 rounded-md border border-line bg-surface text-center text-[14px] font-semibold text-ink uppercase placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none disabled:bg-surface-2"
              />
            </label>
          ))}
        </div>
      </div>
      {bad && <p className="text-[12.5px] text-danger">{t("settings.unitLettersInvalid")}</p>}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy || bad || !changed} onClick={() => run(onSaveLetters(Object.keys(clean).length ? clean : null), () => setEdited({}))}>
            {t("common.save")}
          </Button>
          {Object.keys(saved).length > 0 && (
            <Button size="sm" disabled={busy} onClick={() => run(onSaveLetters(null), () => setEdited({}))}>
              {t("settings.unitLettersDefault")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function RulesCard() {
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
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
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
          t("tds.settings.title"),
          t("tds.settings.hint"),
          <Segmented
            size="sm"
            label={t("tds.settings.title")}
            value={s["tds.purchases"]?.enabled ? "on" : "off"}
            onChange={(v) => canEdit && void put("tds.purchases", { ...(s["tds.purchases"] ?? { threshold: 5_000_000, rate: 0.1, noPanRate: 5 }), enabled: v === "on" })}
            options={[
              { value: "off", label: t("tds.settings.off") },
              { value: "on", label: t("tds.settings.on") },
            ]}
          />,
        )}
        {row(
          t("tcs.settings.title"),
          t("tcs.settings.hint"),
          <Segmented
            size="sm"
            label={t("tcs.settings.title")}
            value={s["tcs.sales"]?.enabled ? "on" : "off"}
            onChange={(v) => canEdit && void put("tcs.sales", { ...(s["tcs.sales"] ?? { rates: {}, threshold: 1_000_000 }), enabled: v === "on" })}
            options={[
              { value: "off", label: t("tcs.settings.off") },
              { value: "on", label: t("tcs.settings.on") },
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
        <div className="flex flex-col gap-2 border-b border-line py-3">
          <div>
            <p className="text-[14px] font-medium text-ink">{t("invoice.print.terms")}</p>
            <p className="text-[12.5px] text-ink-3">{t("settings.termsHint")}</p>
          </div>
          <textarea
            aria-label={t("invoice.print.terms")}
            disabled={!canEdit}
            rows={3}
            maxLength={1000}
            defaultValue={s["invoice.terms"]}
            onBlur={(e) => e.target.value.trim() !== s["invoice.terms"] && void put("invoice.terms", e.target.value.trim())}
            className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none disabled:bg-surface-2"
          />
        </div>
        <PaymentDetailsRow value={s["invoice.payment_details"]} canEdit={canEdit} onSave={(v) => put("invoice.payment_details", v)} />
        <BillUnitsRow
          letters={s["invoice.unit_letters"]}
          startIn={s["invoice.default_unit"]}
          canEdit={canEdit}
          onSaveLetters={(v) => put("invoice.unit_letters", v)}
          onSaveStart={(v) => put("invoice.default_unit", v)}
        />
        {WORKSPACE.chargeTax && <LutRow value={s["gst.lut"] ?? null} canEdit={canEdit} onSave={(v) => put("gst.lut", v)} />}
        {WORKSPACE.chargeTax &&
          row(
            t("settings.einvoice"),
            t("settings.einvoiceHint"),
            <Segmented
              size="sm"
              label={t("settings.einvoice")}
              value={s["einvoice.enabled"] ? "on" : "off"}
              onChange={(v) => canEdit && void put("einvoice.enabled", v === "on")}
              options={[
                { value: "off", label: t("settings.einvoiceOptions.off") },
                { value: "on", label: t("settings.einvoiceOptions.on") },
              ]}
            />,
          )}
        {row(
          t("settings.ewayThreshold"),
          t("settings.ewayThresholdHint"),
          <Input
            aria-label={t("settings.ewayThreshold")}
            disabled={!canEdit}
            inputSize="sm"
            inputMode="numeric"
            className="w-32 [&_input]:text-right"
            leading={<span className="text-[13px]">₹</span>}
            defaultValue={s["ewaybill.threshold"] ?? 50000}
            onBlur={(e) => {
              const v = Number(e.target.value.replace(/\D/g, ""));
              if (Number.isInteger(v) && v >= 0 && v !== (s["ewaybill.threshold"] ?? 50000)) void put("ewaybill.threshold", v);
            }}
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
        {row(
          t("settings.offlineWipe"),
          t("settings.offlineWipeHint"),
          <Input
            aria-label={t("settings.offlineWipe")}
            disabled={!canEdit}
            inputSize="sm"
            inputMode="numeric"
            className="w-24 [&_input]:text-right"
            defaultValue={s["offline.wipe_after_days"] ?? 30}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0 && v <= 365 && v !== (s["offline.wipe_after_days"] ?? 30)) void put("offline.wipe_after_days", v);
            }}
          />,
        )}
      </div>
    </Card>
  );
}
