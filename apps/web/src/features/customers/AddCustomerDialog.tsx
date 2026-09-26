import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validateMobile, validatePincode, type IssueCode } from "@vyapaar/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { translateError } from "@vyapaar/i18n";
import { upsertCustomer, type CustomerRow } from "../../data/live";
import { BUSINESS } from "../../data/db";
import { LIVE } from "../../data/source";
import { api, ApiError } from "../../lib/api";
import { stateOptions } from "../../lib/states";

/**
 * Only the fields a counter clerk needs to start billing; everything else
 * (price level, route, credit terms...) has sensible defaults and lives on the
 * full profile. Validation runs as you type, with specific messages: a GSTIN
 * typo is caught by its check digit, and a GSTIN from another state is flagged.
 */
export function AddCustomerDialog({
  open,
  onOpenChange,
  onCreated,
  initial,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  onCreated?(id: string): void;
  /** What was typed in a search that found nobody: a mobile number, a GSTIN or the shop's name. */
  initial?: string;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const toast = useToast();
  const [type, setType] = useState<"b2b" | "b2c">("b2b");
  const blank = () => ({ businessName: "", name: "", mobile: "", gstin: "", stateCode: BUSINESS.stateCode || "23", pincode: "", creditLimit: "" });
  const [form, setForm] = useState(blank);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Opened from a search: start from what was typed.
  useEffect(() => {
    if (!open || !initial?.trim()) return;
    const typed = initial.trim();
    const digits = typed.replace(/\D/g, "");
    const gstin = normalizeGstin(typed);
    if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
      setType("b2b");
      setForm({ ...blank(), gstin, stateCode: GST_STATES.some((x) => x.code === stateCodeFromGstin(gstin)) ? stateCodeFromGstin(gstin) : blank().stateCode });
    } else if (digits.length >= 10 && digits.length === typed.replace(/[\s+-]/g, "").length) setForm({ ...blank(), mobile: digits.slice(-10) });
    else setForm({ ...blank(), businessName: typed });
    setTouched({});
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const issueText = (issues: IssueCode[], field: "mobile" | "pincode" | "gstin"): string | null => {
    const first = issues[0];
    if (!first) return null;
    if (first === "invalid_format" && field === "mobile") return t("validation.mobile");
    if (first === "invalid_format" && field === "pincode") return t("validation.pincode");
    return t(`validation.${first}`);
  };

  const gstinIssues = type === "b2b" ? validateGstin(form.gstin, { expectedStateCode: form.stateCode }) : [];
  const errors = {
    businessName: form.businessName.trim() ? null : t("validation.required"),
    mobile: issueText(validateMobile(form.mobile), "mobile"),
    pincode: form.pincode ? issueText(validatePincode(form.pincode), "pincode") : null,
    gstin: type === "b2b" ? issueText(gstinIssues, "gstin") : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const serverFieldError = (k: string) => (serverError && serverError.field === k ? translateError(i18n, serverError) : null);
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : null) ?? serverFieldError(k);

  /** Live mode: the server validates again (GSTIN checksum and state, duplicates) and assigns the code. */
  const create = async () => {
    setBusy(true);
    setServerError(null);
    try {
      const res = await api.post<CustomerRow & { summary: { overdue: string } }>("/customers", {
        name: form.name.trim() || form.businessName.trim(),
        businessName: form.businessName.trim(),
        customerType: type,
        mobile: form.mobile,
        stateCode: form.stateCode,
        ...(type === "b2b" && form.gstin ? { gstin: form.gstin } : {}),
        ...(form.pincode ? { pincode: form.pincode } : {}),
        ...(form.creditLimit ? { creditLimit: form.creditLimit } : {}),
      });
      const saved = upsertCustomer({ ...res, overdue: res.summary.overdue });
      toast({ tone: "success", title: t("customer.saved"), body: `${saved.code} · ${saved.businessName}` });
      onCreated?.(saved.id);
      onOpenChange(false);
      setForm({ businessName: "", name: "", mobile: "", gstin: "", stateCode: form.stateCode, pincode: "", creditLimit: "" });
      setTouched({});
    } catch (e) {
      setServerError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("customer.add")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setTouched({ businessName: true, mobile: true, pincode: true, gstin: true });
              if (!valid) return;
              if (LIVE) return void create();
              toast({ tone: "success", title: t("customer.saved"), body: form.businessName });
              onOpenChange(false);
            }}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
        {serverError && !serverError.field && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger sm:col-span-2" role="alert">
            {translateError(i18n, serverError)}
          </p>
        )}
        <div className="sm:col-span-2">
          <Segmented
            label={t("customer.type")}
            value={type}
            onChange={setType}
            options={[
              { value: "b2b", label: `${t("customer.b2b")} · GSTIN` },
              { value: "b2c", label: t("customer.b2c") },
            ]}
          />
        </div>
        <Field label={t("customer.businessName")} htmlFor="c-business" error={show("businessName")}>
          <Input id="c-business" value={form.businessName} onChange={(e) => set("businessName", e.target.value)} onBlur={() => setTouched((x) => ({ ...x, businessName: true }))} invalid={Boolean(show("businessName"))} />
        </Field>
        <Field label={t("customer.name")} htmlFor="c-name">
          <Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={t("customer.mobile")} htmlFor="c-mobile" error={show("mobile")}>
          <Input id="c-mobile" inputMode="tel" placeholder="98260 12345" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} onBlur={() => setTouched((x) => ({ ...x, mobile: true }))} invalid={Boolean(show("mobile"))} />
        </Field>
        {type === "b2b" && (
          <Field label={t("customer.gstin")} htmlFor="c-gstin" hint={t("customer.gstinHint")} error={show("gstin")}>
            <Input
              id="c-gstin"
              className="[&_input]:font-mono [&_input]:uppercase"
              maxLength={15}
              value={form.gstin}
              onChange={(e) => {
                const v = normalizeGstin(e.target.value);
                set("gstin", v);
                // The first two digits of a GSTIN are the state code: fill it in for the user.
                if (v.length >= 2 && GST_STATES.some((s) => s.code === stateCodeFromGstin(v))) set("stateCode", stateCodeFromGstin(v));
              }}
              onBlur={() => setTouched((x) => ({ ...x, gstin: true }))}
              invalid={Boolean(show("gstin"))}
            />
          </Field>
        )}
        <Field label={t("common.state")} htmlFor="c-state">
          <Select id="c-state" value={form.stateCode} onChange={(e) => set("stateCode", e.target.value)}>
            {stateOptions(locale).map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("customer.pincode")} htmlFor="c-pin" error={show("pincode")}>
          <Input id="c-pin" inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => set("pincode", e.target.value)} onBlur={() => setTouched((x) => ({ ...x, pincode: true }))} invalid={Boolean(show("pincode"))} />
        </Field>
        <Field label={t("customer.creditLimit")} htmlFor="c-credit" hint={t("common.optional")}>
          <Input id="c-credit" inputMode="numeric" leading={<span className="text-[13px]">₹</span>} value={form.creditLimit} onChange={(e) => set("creditLimit", e.target.value.replace(/[^0-9]/g, ""))} />
        </Field>
      </form>
    </Dialog>
  );
}
