import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse } from "@vyapaar/contracts";
import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validatePincode } from "@vyapaar/core";
import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { FirmHeader } from "../../components/brand/Brand";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { Badge } from "../../components/ui/Badge";
import { allowed, BUSINESS, WORKSPACE } from "../../data/db";
import { applyMe, refreshWarehouses } from "../../data/live";
import { touch, useStoreVersion } from "../../data/store";
import { api, ApiError } from "../../lib/api";
import { prepareLogo } from "./firmLogo";

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
      <WarehousesCard />
      <SeriesCard />
    </>
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

/** Godowns: where stock is kept. Purchases, adjustments and transfers pick one; the default is used for billing. */
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
