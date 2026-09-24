import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validateMobile, validatePincode, type IssueCode } from "@vyapaar/core";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";

/**
 * Only the fields a counter clerk needs to start billing; everything else
 * (price level, route, credit terms...) has sensible defaults and lives on the
 * full profile. Validation runs as you type, with specific messages: a GSTIN
 * typo is caught by its check digit, and a GSTIN from another state is flagged.
 */
export function AddCustomerDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [type, setType] = useState<"b2b" | "b2c">("b2b");
  const [form, setForm] = useState({ businessName: "", name: "", mobile: "", gstin: "", stateCode: "23", pincode: "", creditLimit: "" });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

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
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : null);

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
            onClick={() => {
              setTouched({ businessName: true, mobile: true, pincode: true, gstin: true });
              if (!valid) return;
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
            {GST_STATES.filter((s) => !s.legacy).map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} – {locale === "hi" ? s.nameHi : s.name}
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
