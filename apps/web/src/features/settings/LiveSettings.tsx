import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse } from "@digitalbahi/contracts";
import { GST_STATES, normalizeGstin, stateCodeFromGstin, UPI_ID, validateGstin, validatePincode } from "@digitalbahi/core";
import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { FirmHeader } from "../../components/brand/Brand";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { Badge } from "../../components/ui/Badge";
import { allowed, BUSINESS, TODAY, WORKSPACE } from "../../data/db";
import { applyMe, refreshCatalog, refreshWarehouses } from "../../data/live";
import { touch, useStoreVersion } from "../../data/store";
import { api, ApiError } from "../../lib/api";
import { prepareLogo } from "./firmLogo";
import { PayrollStatutoryCard } from "./PayrollStatutoryCard";
import { stateOptions } from "../../lib/states";
import { PrinterPanel } from "../../components/thermal/ThermalPrint";
import { serverOrigin } from "../../platform/server";
import { DEFAULT_START_SYMBOL } from "../invoice/units";

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
  "invoice.terms": string;
  "reports.aging_buckets": number[];
  "offline.wipe_after_days"?: number;
  "gst.lut"?: { arn: string; validUntil: string } | null;
  "einvoice.enabled"?: boolean;
  "ewaybill.threshold"?: number;
  "invoice.payment_details"?: PaymentDetails;
  "invoice.unit_letters"?: Record<string, string> | null;
  "invoice.default_unit"?: string | null;
}
type PaymentDetails = { bankName: string; accountNumber: string; ifsc: string; upiId: string };

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
    <div className="flex flex-col gap-2 border-b border-line py-3">
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
      <PayrollStatutoryCard />
      <WarehousesCard />
      <PriceListsCard />
      <SeriesCard />
      <MessagingCard />
      <DevicesCard />
      <PrinterCard />
    </>
  );
}

/** The Bluetooth receipt printer of this device (kept on the device, not the server). */
function PrinterCard() {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader title={t("thermal.title")} subtitle={t("thermal.hint")} />
      <div className="p-4 sm:p-5">
        <PrinterPanel />
      </div>
    </Card>
  );
}

/** The firm's logo: preview as it prints (logo, name, address, contact), upload, change or remove. */
function LogoField({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const hasLogo = Boolean(BUSINESS.logoFileId);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const image = await prepareLogo(file).catch((e: Error) => {
        throw new ApiError(400, e.message === "IMAGE_TOO_LARGE" ? "IMAGE_TOO_LARGE" : "INVALID_IMAGE", { maxKb: 300 });
      });
      await api.put("/business/logo", { image });
      await reloadMe();
      toast({ tone: "success", title: t("settings.logoSaved") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.delete("/business/logo");
      await reloadMe();
      toast({ tone: "success", title: t("settings.logoRemoved") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3 sm:p-4">
      <div>
        <p className="text-[14px] font-semibold text-ink">{t("settings.logo")}</p>
        <p className="text-[12.5px] text-ink-3">{t("settings.logoHint")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1 rounded-lg border border-dashed border-line-strong bg-white p-3 text-[12px] text-[#0e1a33]" aria-label={t("settings.logoPreview")}>
          <FirmHeader />
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="soft" icon={<ImageUp size={16} />} disabled={busy} onClick={() => input.current?.click()}>
              {hasLogo ? t("settings.changeLogo") : t("settings.uploadLogo")}
            </Button>
            {hasLogo && (
              <Button variant="ghost" icon={<Trash2 size={16} />} disabled={busy} onClick={() => void remove()}>
                {t("settings.removeLogo")}
              </Button>
            )}
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              aria-label={t("settings.uploadLogo")}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </div>
        )}
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </div>
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
        <LogoField canEdit={canEdit} />
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
              {stateOptions(locale).map((x) => (
                <option key={x.code} value={x.code}>
                  {x.name}
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

interface MessagingView {
  driver: "live" | "log";
  platformEmail: boolean;
  whatsapp: {
    provider: "none" | "meta" | "webhook";
    number: string | null;
    phoneNumberId: string | null;
    webhookUrl: string | null;
    hasSecret: boolean;
    /** Delivery ticks: the key in the callback address, and whether Meta's app secret is saved. */
    statusKey: string | null;
    hasAppSecret: boolean;
    documentTemplate: string | null;
    reminderTemplate: string | null;
    templateLanguage: string;
    /** The same templates' language code in Hindi, for customers who get messages in Hindi. */
    templateLanguageHi: string | null;
    ready: boolean;
  };
  sms: {
    provider: "none" | "webhook";
    webhookUrl: string | null;
    hasSecret: boolean;
    senderId: string | null;
    reminderTemplate: string | null;
    reminderTemplateHi: string | null;
    ready: boolean;
  };
  email: {
    mode: "none" | "platform" | "smtp";
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecure: boolean;
    smtpUser: string | null;
    hasPassword: boolean;
    fromName: string | null;
    fromAddress: string | null;
    replyTo: string | null;
    ready: boolean;
  };
}

type MessagingForm = Record<string, string | boolean>;

function formOf(v: MessagingView): MessagingForm {
  return {
    whatsappProvider: v.whatsapp.provider,
    whatsappNumber: v.whatsapp.number ?? "",
    whatsappPhoneNumberId: v.whatsapp.phoneNumberId ?? "",
    whatsappWebhookUrl: v.whatsapp.webhookUrl ?? "",
    whatsappSecret: "",
    whatsappAppSecret: "",
    whatsappDocumentTemplate: v.whatsapp.documentTemplate ?? "",
    whatsappReminderTemplate: v.whatsapp.reminderTemplate ?? "",
    whatsappTemplateLanguage: v.whatsapp.templateLanguage,
    whatsappTemplateLanguageHi: v.whatsapp.templateLanguageHi ?? "",
    smsProvider: v.sms.provider,
    smsWebhookUrl: v.sms.webhookUrl ?? "",
    smsSecret: "",
    smsSenderId: v.sms.senderId ?? "",
    smsReminderTemplate: v.sms.reminderTemplate ?? "",
    smsReminderTemplateHi: v.sms.reminderTemplateHi ?? "",
    emailMode: v.email.mode,
    smtpHost: v.email.smtpHost ?? "",
    smtpPort: v.email.smtpPort ? String(v.email.smtpPort) : "",
    smtpSecure: v.email.smtpSecure,
    smtpUser: v.email.smtpUser ?? "",
    smtpPassword: "",
    emailFromName: v.email.fromName ?? "",
    emailFromAddress: v.email.fromAddress ?? "",
    emailReplyTo: v.email.replyTo ?? "",
  };
}

/**
 * The business's own WhatsApp Business number (Meta Cloud API or a
 * provider's webhook), its SMS gateway (for payment reminders) and email
 * (the platform's mail server or its own SMTP). Tokens and passwords are
 * write-only: the server keeps them encrypted.
 */
function MessagingCard() {
  const { t } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["messaging-settings"], queryFn: () => api.get<MessagingView>("/messaging/settings") });
  const [form, setForm] = useState<MessagingForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testChannel, setTestChannel] = useState<"whatsapp" | "sms" | "email">("whatsapp");
  useEffect(() => {
    if (q.data) setForm(formOf(q.data));
  }, [q.data]);
  if (!q.data || !form) return null;
  const v = q.data;
  const set = (k: string, value: string | boolean) => setForm((f) => ({ ...f!, [k]: value }));
  const text = (k: string, label: string, opts: { type?: string; placeholder?: string; hint?: string; mono?: boolean } = {}) => (
    <Field label={label} htmlFor={`msg-${k}`} {...(opts.hint ? { hint: opts.hint } : {})}>
      <Input id={`msg-${k}`} type={opts.type ?? "text"} disabled={!canEdit} placeholder={opts.placeholder} className={opts.mono ? "[&_input]:font-mono" : undefined} value={String(form[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const secret = (k: "whatsappSecret" | "whatsappAppSecret" | "smsSecret" | "smtpPassword", label: string, has: boolean) =>
    text(k, label, { type: "password", ...(has ? { placeholder: "••••••••", hint: t("messages.settings.secretSet") } : {}) });

  const save = async () => {
    setBusy(true);
    setError(null);
    const f = form;
    const orNull = (k: string) => (String(f[k]).trim() === "" ? null : String(f[k]).trim());
    const body: Record<string, unknown> = {
      whatsappProvider: f.whatsappProvider,
      whatsappNumber: orNull("whatsappNumber"),
      whatsappPhoneNumberId: orNull("whatsappPhoneNumberId"),
      whatsappWebhookUrl: orNull("whatsappWebhookUrl"),
      whatsappDocumentTemplate: orNull("whatsappDocumentTemplate"),
      whatsappReminderTemplate: orNull("whatsappReminderTemplate"),
      whatsappTemplateLanguage: String(f.whatsappTemplateLanguage).trim() || "en",
      whatsappTemplateLanguageHi: orNull("whatsappTemplateLanguageHi"),
      smsProvider: f.smsProvider,
      smsWebhookUrl: orNull("smsWebhookUrl"),
      smsSenderId: orNull("smsSenderId")?.toUpperCase() ?? null,
      smsReminderTemplate: orNull("smsReminderTemplate"),
      smsReminderTemplateHi: orNull("smsReminderTemplateHi"),
      emailMode: f.emailMode,
      smtpHost: orNull("smtpHost"),
      smtpPort: String(f.smtpPort).trim() ? Number(f.smtpPort) : null,
      smtpSecure: Boolean(f.smtpSecure),
      smtpUser: orNull("smtpUser"),
      emailFromName: orNull("emailFromName"),
      emailFromAddress: orNull("emailFromAddress"),
      emailReplyTo: orNull("emailReplyTo"),
      // Secrets only when typed: an empty box keeps the saved one.
      ...(String(f.whatsappSecret) ? { whatsappSecret: String(f.whatsappSecret) } : {}),
      ...(String(f.whatsappAppSecret) ? { whatsappAppSecret: String(f.whatsappAppSecret) } : {}),
      ...(String(f.smsSecret) ? { smsSecret: String(f.smsSecret) } : {}),
      ...(String(f.smtpPassword) ? { smtpPassword: String(f.smtpPassword) } : {}),
    };
    try {
      await api.put("/messaging/settings", body);
      await q.refetch();
      toast({ tone: "success", title: t("settings.saved"), body: t("messages.settings.title") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/messaging/test", { channel: testChannel, to: testTo.trim() });
      toast({ tone: "success", title: t("messages.settings.testSent") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("messages.settings.title")} subtitle={t("messages.settings.hint")} />
      <div className="flex flex-col gap-5 p-4 sm:p-5">
        {v.driver === "log" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("messages.testMode")}</p>}
        {error ? <ErrorNote error={error} /> : null}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{t("messages.whatsapp")}</h3>
            <Badge tone={v.whatsapp.ready ? "good" : "neutral"} dot>
              {v.whatsapp.ready ? t("messages.settings.ready") : t("messages.settings.off")}
            </Badge>
          </div>
          <Field label={t("messages.settings.provider")} htmlFor="msg-provider">
            <Select id="msg-provider" disabled={!canEdit} value={String(form.whatsappProvider)} onChange={(e) => set("whatsappProvider", e.target.value)}>
              <option value="none">{t("messages.settings.providers.none")}</option>
              <option value="meta">{t("messages.settings.providers.meta")}</option>
              <option value="webhook">{t("messages.settings.providers.webhook")}</option>
            </Select>
          </Field>
          {form.whatsappProvider !== "none" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {text("whatsappNumber", t("messages.settings.number"), { placeholder: "+91 98260 00000" })}
              {form.whatsappProvider === "meta" ? (
                <>
                  {text("whatsappPhoneNumberId", t("messages.settings.phoneNumberId"), { mono: true })}
                  {secret("whatsappSecret", t("messages.settings.accessToken"), v.whatsapp.hasSecret)}
                </>
              ) : (
                <>
                  {text("whatsappWebhookUrl", t("messages.settings.webhookUrl"), { placeholder: "https://", mono: true })}
                  {secret("whatsappSecret", t("messages.settings.webhookSecret"), v.whatsapp.hasSecret)}
                </>
              )}
              {text("whatsappDocumentTemplate", t("messages.settings.documentTemplate"), { mono: true, placeholder: "bill_with_pdf" })}
              {text("whatsappReminderTemplate", t("messages.settings.reminderTemplate"), { mono: true, placeholder: "payment_reminder" })}
              {text("whatsappTemplateLanguage", t("messages.settings.templateLanguage"), { mono: true, placeholder: "en" })}
              {text("whatsappTemplateLanguageHi", t("messages.settings.templateLanguageHi"), { mono: true, placeholder: "hi", hint: t("messages.settings.templateLanguageHiHint") })}
              <p className="text-[12.5px] text-ink-3 sm:col-span-2">{t("messages.settings.templateHelp")}</p>
            </div>
          )}
          {/* Delivered / read ticks: the address Meta (or the provider) reports message statuses to. */}
          {v.whatsapp.provider !== "none" && form.whatsappProvider === v.whatsapp.provider && v.whatsapp.statusKey && (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
              <div>
                <p className="text-[13px] font-semibold text-ink">{t("messages.settings.ticksTitle")}</p>
                <p className="text-[12.5px] text-ink-3">{v.whatsapp.provider === "meta" ? t("messages.settings.ticksMeta") : t("messages.settings.ticksProvider")}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("messages.settings.callbackUrl")} htmlFor="msg-callback">
                  <Input id="msg-callback" readOnly className="[&_input]:font-mono" value={`${serverOrigin() || window.location.origin}/api/v1/webhooks/whatsapp/${v.whatsapp.statusKey}`} onFocus={(e) => e.currentTarget.select()} />
                </Field>
                {v.whatsapp.provider === "meta" && (
                  <>
                    <Field label={t("messages.settings.verifyToken")} htmlFor="msg-verify">
                      <Input id="msg-verify" readOnly className="[&_input]:font-mono" value={v.whatsapp.statusKey} onFocus={(e) => e.currentTarget.select()} />
                    </Field>
                    {secret("whatsappAppSecret", t("messages.settings.appSecret"), v.whatsapp.hasAppSecret)}
                  </>
                )}
              </div>
            </div>
          )}
        </section>
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{t("messages.settings.smsTitle")}</h3>
            <Badge tone={v.sms.ready ? "good" : "neutral"} dot>
              {v.sms.ready ? t("messages.settings.ready") : t("messages.settings.off")}
            </Badge>
          </div>
          <p className="text-[12.5px] text-ink-3">{t("messages.settings.smsHint")}</p>
          <Field label={t("messages.settings.smsProvider")} htmlFor="msg-sms-provider">
            <Select id="msg-sms-provider" disabled={!canEdit} value={String(form.smsProvider)} onChange={(e) => set("smsProvider", e.target.value)}>
              <option value="none">{t("messages.settings.smsProviders.none")}</option>
              <option value="webhook">{t("messages.settings.smsProviders.webhook")}</option>
            </Select>
          </Field>
          {form.smsProvider === "webhook" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {text("smsWebhookUrl", t("messages.settings.smsUrl"), { placeholder: "https://", mono: true })}
              {secret("smsSecret", t("messages.settings.smsSecret"), v.sms.hasSecret)}
              {text("smsSenderId", t("messages.settings.smsSenderId"), { mono: true, placeholder: "DGBAHI" })}
              <span className="hidden sm:block" aria-hidden />
              {text("smsReminderTemplate", t("messages.settings.smsTemplate"), { mono: true, placeholder: "1207161234567890123" })}
              {text("smsReminderTemplateHi", t("messages.settings.smsTemplateHi"), { mono: true, placeholder: "1207161234567890124" })}
            </div>
          )}
        </section>
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{t("messages.email")}</h3>
            <Badge tone={v.email.ready ? "good" : "neutral"} dot>
              {v.email.ready ? t("messages.settings.ready") : t("messages.settings.off")}
            </Badge>
          </div>
          <Field label={t("messages.settings.emailMode")} htmlFor="msg-email-mode" {...(form.emailMode === "platform" && !v.platformEmail ? { hint: t("messages.settings.platformMissing") } : {})}>
            <Select id="msg-email-mode" disabled={!canEdit} value={String(form.emailMode)} onChange={(e) => set("emailMode", e.target.value)}>
              <option value="none">{t("messages.settings.emailModes.none")}</option>
              <option value="platform">{t("messages.settings.emailModes.platform")}</option>
              <option value="smtp">{t("messages.settings.emailModes.smtp")}</option>
            </Select>
          </Field>
          {form.emailMode !== "none" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {form.emailMode === "smtp" && (
                <>
                  {text("smtpHost", t("messages.settings.smtpHost"), { mono: true, placeholder: "smtp.gmail.com" })}
                  {text("smtpPort", t("messages.settings.smtpPort"), { placeholder: "587" })}
                  {text("smtpUser", t("messages.settings.smtpUser"))}
                  {secret("smtpPassword", t("messages.settings.smtpPassword"), v.email.hasPassword)}
                  {text("emailFromAddress", t("messages.settings.fromAddress"), { type: "email" })}
                  <Checkbox label={t("messages.settings.smtpSecure")} checked={Boolean(form.smtpSecure)} disabled={!canEdit} onChange={(value) => set("smtpSecure", value)} className="self-end pb-2" />
                </>
              )}
              {text("emailFromName", t("messages.settings.fromName"), { placeholder: BUSINESS.name })}
              {text("emailReplyTo", t("messages.settings.replyTo"), { type: "email", placeholder: BUSINESS.email || "accounts@…" })}
            </div>
          )}
        </section>
        {canEdit && (
          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-end gap-2">
              <Segmented
                size="sm"
                label={t("messages.channel")}
                value={testChannel}
                onChange={setTestChannel}
                options={[
                  { value: "whatsapp", label: "WhatsApp" },
                  { value: "sms", label: t("messages.sms") },
                  { value: "email", label: t("messages.email") },
                ]}
              />
              <Input aria-label={t("messages.settings.testTo")} placeholder={t("messages.settings.testTo")} className="w-56" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <Button disabled={busy || testTo.trim().length < 3} onClick={() => void test()}>
                {t("messages.settings.sendTest")}
              </Button>
            </div>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  seriesCode: string | null;
  userName: string;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  revokedAt: string | null;
  wipedAt: string | null;
  offlineBills: number;
  /** Work waiting on the device, as it last reported (it can only while online). */
  queueWaiting: number;
  queueRefused: number;
  queueOldestAt: string | null;
  queueReportedAt: string | null;
}

/** Phones and PCs that keep a copy of the business (those that bill, with their own series); a lost one can be removed. */
function DevicesCard() {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["devices"], queryFn: () => api.get<{ data: DeviceRow[] }>("/devices").then((r) => r.data) });
  const [error, setError] = useState<unknown>(null);

  const revoke = async (d: DeviceRow) => {
    if (!window.confirm(t("offline.devices.removeConfirm", { name: d.name, code: d.seriesCode ?? "" }))) return;
    setError(null);
    try {
      await api.post(`/devices/${d.id}/revoke`);
      await q.refetch();
      toast({ tone: "success", title: t("offline.devices.removedToast"), body: [d.name, d.seriesCode].filter(Boolean).join(" · ") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };

  return (
    <Card>
      <CardHeader title={t("offline.devices.title")} subtitle={t("offline.devices.help")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        <DataTable
          rows={q.data ?? []}
          loading={q.isPending}
          rowKey={(d) => d.id}
          minWidth={680}
          empty={<p className="p-4 text-[13.5px] text-ink-3">{t("offline.devices.empty")}</p>}
          columns={[
            {
              key: "name",
              header: t("offline.devices.name"),
              render: (d) => (
                <span className={d.revokedAt ? "text-ink-3 line-through" : "font-medium text-ink"}>
                  {d.name}
                  <span className="block text-[12px] font-normal text-ink-3 no-underline">{d.userName}</span>
                </span>
              ),
            },
            { key: "series", header: t("offline.devices.series"), render: (d) => (d.seriesCode ? <span className="font-mono">{d.seriesCode}</span> : <span className="text-ink-3">{t("offline.devices.noSeries")}</span>) },
            { key: "seen", header: t("offline.devices.lastSeen"), render: (d) => <span className="text-ink-2">{d.lastSeenAt ? dateTime(d.lastSeenAt) : "—"}</span> },
            { key: "bills", header: t("offline.devices.bills"), align: "right", render: (d) => d.offlineBills },
            {
              key: "waiting",
              header: t("offline.devices.waiting"),
              render: (d) =>
                d.revokedAt || (d.queueWaiting === 0 && d.queueRefused === 0) ? (
                  <span className="text-ink-3">{d.queueReportedAt ? t("offline.devices.allSent") : "—"}</span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    {d.queueWaiting > 0 && (
                      <span className={d.queueRefused > 0 ? "text-ink-2" : "text-warn"}>
                        {t("offline.devices.waitingSince", { count: d.queueWaiting, when: d.queueOldestAt ? dateTime(d.queueOldestAt) : "—" })}
                      </span>
                    )}
                    {d.queueRefused > 0 && <span className="text-danger">{t("offline.devices.refused", { count: d.queueRefused })}</span>}
                    {d.queueReportedAt && <span className="text-[11.5px] text-ink-3">{t("offline.devices.reportedAt", { when: dateTime(d.queueReportedAt) })}</span>}
                  </span>
                ),
            },
            {
              key: "action",
              header: "",
              align: "right",
              render: (d) =>
                d.revokedAt ? (
                  <span className="flex flex-col items-end gap-0.5">
                    <Badge tone="neutral">{t("offline.devices.removed")}</Badge>
                    <span className="text-[11.5px] text-ink-3">{d.wipedAt ? t("offline.devices.wipedOn", { when: dateTime(d.wipedAt) }) : t("offline.devices.wipePending")}</span>
                  </span>
                ) : canEdit ? (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(d)}>
                    {t("offline.devices.remove")}
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
    </Card>
  );
}

/** Godowns: where stock is kept. Purchases, adjustments and transfers pick one; the default is used for billing. */
/**
 * Selling price lists (Price A / B / C, or Retail, Wholesale...): each
 * customer buys on one. The default list is the product's selling price and
 * is what new customers get; the others have their own price on each product.
 */
function PriceListsCard() {
  const { t } = useI18n();
  const toast = useToast();
  useStoreVersion();
  const canEdit = allowed("product.update_price");
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshCatalog();
      touch();
      toast({ tone: "success", title: done });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const rename = async (id: string) => {
    const name = names[id]?.trim();
    if (!name) return;
    if (await run(() => api.patch(`/price-levels/${id}`, { name }), t("priceLists.renamed", { name }))) {
      setNames((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== id)));
    }
  };
  const add = async () => {
    const name = newName.trim();
    if (await run(() => api.post("/price-levels", { name }), t("priceLists.added", { name }))) setNewName("");
  };

  return (
    <Card>
      <CardHeader title={t("priceLists.title")} subtitle={t("priceLists.hint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {WORKSPACE.priceLevels.map((l) => {
            const draft = names[l.id];
            const changed = draft !== undefined && draft.trim() !== "" && draft.trim() !== l.name;
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[14px]">
                {canEdit ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (changed) void rename(l.id);
                    }}
                  >
                    <Input aria-label={`${t("priceLists.name")} ${l.name}`} className="max-w-60" value={draft ?? l.name} maxLength={50} onChange={(e) => setNames((n) => ({ ...n, [l.id]: e.target.value }))} />
                    {changed && (
                      <Button size="sm" type="submit" disabled={busy}>
                        {t("common.save")}
                      </Button>
                    )}
                  </form>
                ) : (
                  <span className="font-medium text-ink">{l.name}</span>
                )}
                <span className="flex items-center gap-2">
                  {l.isDefault && <Badge tone="accent">{t("priceLists.default")}</Badge>}
                  {canEdit && !l.isDefault && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/price-levels/${l.id}`, { isDefault: true }), t("priceLists.madeDefault", { name: l.name }))}>
                      {t("godowns.makeDefault")}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {canEdit && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) void add();
            }}
          >
            <Field label={t("priceLists.newName")} htmlFor="pl-name" error={fieldError("name")}>
              <Input id="pl-name" maxLength={50} placeholder="Price D" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy || !newName.trim()}>
              {t("priceLists.add")}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function WarehousesCard() {
  const { t } = useI18n();
  const toast = useToast();
  useStoreVersion();
  const canEdit = allowed("settings.update");
  const [form, setForm] = useState({ name: "", code: "", city: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshWarehouses();
      toast({ tone: "success", title: done });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const ok = await run(() => api.post("/warehouses", { name: form.name.trim(), code: form.code.trim(), ...(form.city.trim() ? { city: form.city.trim() } : {}) }), t("godowns.added"));
    if (ok) setForm({ name: "", code: "", city: "" });
  };

  return (
    <Card>
      <CardHeader title={t("godowns.title")} subtitle={t("godowns.hint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {WORKSPACE.warehouses.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[14px]">
              <span className="min-w-0">
                <span className="font-medium text-ink">{w.name}</span> <span className="font-mono text-[12px] text-ink-3">{w.code}</span>
                {w.city && <span className="text-[12.5px] text-ink-3"> · {w.city}</span>}
              </span>
              <span className="flex items-center gap-2">
                {w.isDefault && <Badge tone="accent">{t("godowns.default")}</Badge>}
                {!w.isActive && <Badge tone="danger">{t("common.inactive")}</Badge>}
                {canEdit && !w.isDefault && w.isActive && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/warehouses/${w.id}`, { isDefault: true }), t("godowns.madeDefault"))}>
                    {t("godowns.makeDefault")}
                  </Button>
                )}
                {canEdit && !w.isDefault && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/warehouses/${w.id}`, { isActive: !w.isActive }), t("settings.saved"))}>
                    {w.isActive ? t("users.deactivate") : t("users.activate")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_120px_1fr_auto]">
            <Field label={t("godowns.name")} htmlFor="wh-name" error={fieldError("name")}>
              <Input id="wh-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label={t("common.code")} htmlFor="wh-code" error={fieldError("code")}>
              <Input id="wh-code" maxLength={20} className="[&_input]:font-mono [&_input]:uppercase" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/[^A-Za-z0-9/_-]/g, "") }))} />
            </Field>
            <Field label={t("common.city")} htmlFor="wh-city">
              <Input id="wh-city" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
            </Field>
            <Button disabled={busy || !form.name.trim() || !form.code.trim()} onClick={() => void add()}>
              {t("godowns.add")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
