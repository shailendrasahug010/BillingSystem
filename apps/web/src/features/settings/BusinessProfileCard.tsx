import { useQuery } from "@tanstack/react-query";
import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validatePincode } from "@digitalbahi/core";
import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { FirmHeader } from "../../components/brand/Brand";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { prepareLogo } from "./firmLogo";
import { stateOptions } from "../../lib/states";
import { type BusinessRow, reloadMe } from "./shared";

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

export function BusinessProfileCard() {
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
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;

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
    <Card id="settings-business" className="scroll-mt-20">
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
