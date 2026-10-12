import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validateMobile, validatePincode } from "@digitalbahi/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { BUSINESS } from "../../data/db";
import { upsertSupplier, type SupplierRow } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { stateOptions } from "../../lib/states";

export interface SupplierDetail extends SupplierRow {
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  pincode: string | null;
  pan: string | null;
  creditLimit: string | null;
  bankAccountName: string | null;
  bankAccountNumberMasked: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  upiId: string | null;
  /** No TDS on purchases from this supplier. */
  tdsExempt?: boolean;
  notes: string | null;
  isActive: boolean;
  summary: { balance: string; totalPurchases: string; purchaseCount: number; lastPurchaseDate: string | null; lastPaymentDate: string | null };
}

const REGISTRATIONS = ["regular", "composition", "unregistered"] as const;

const blank = () => ({
  companyName: "",
  name: "",
  mobile: "",
  email: "",
  gstRegistration: "regular" as string,
  gstin: "",
  stateCode: BUSINESS.stateCode || "23",
  city: "",
  addressLine1: "",
  pincode: "",
  pan: "",
  creditDays: "",
  openingBalance: "",
  bankAccountName: "",
  bankAccountNumber: "",
  bankIfsc: "",
  bankName: "",
  upiId: "",
  notes: "",
});

type Form = ReturnType<typeof blank>;

/**
 * Add or edit a supplier (company / stockist you buy from). GSTIN is checked
 * as you type and fills the state; the bank account number is stored
 * encrypted and only its last four digits are ever shown again.
 */
export function SupplierDialog({
  supplierId,
  open,
  onOpenChange,
  onSaved,
  prefill,
}: {
  supplierId: string | null;
  open: boolean;
  onOpenChange(v: boolean): void;
  onSaved?(id: string): void;
  /** A new supplier's details already known (from their bill, or the name typed in a search). */
  prefill?: { name?: string; gstin?: string };
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(blank);
  // A nil or lower deduction certificate: no TDS is kept back on this supplier's bills.
  const [noTds, setNoTds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const fieldError = useFieldError(error);
  const detail = useQuery({
    queryKey: ["supplier-detail", supplierId],
    queryFn: () => api.get<SupplierDetail>(`/suppliers/${supplierId}`),
    enabled: open && Boolean(supplierId),
  });
  const s = detail.data;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTouched(false);
    setNoTds(Boolean(supplierId && s?.tdsExempt));
    if (!supplierId) {
      // A GSTIN on the bill gives the state too.
      const gstin = prefill?.gstin ? normalizeGstin(prefill.gstin) : "";
      const state = gstin && /^\d{2}$/.test(stateCodeFromGstin(gstin)) ? stateCodeFromGstin(gstin) : null;
      setForm({ ...blank(), ...(prefill?.name ? { name: prefill.name } : {}), ...(gstin ? { gstin, gstRegistration: "regular" } : {}), ...(state ? { stateCode: state } : {}) });
    }
    else if (s)
      setForm({
        ...blank(),
        companyName: s.companyName ?? "",
        name: s.name,
        mobile: s.mobile ?? "",
        email: s.email ?? "",
        gstRegistration: s.gstRegistration,
        gstin: s.gstin ?? "",
        stateCode: s.stateCode,
        city: s.city ?? "",
        addressLine1: s.addressLine1 ?? "",
        pincode: s.pincode ?? "",
        pan: s.pan ?? "",
        creditDays: s.creditDays ? String(s.creditDays) : "",
        bankAccountName: s.bankAccountName ?? "",
        bankIfsc: s.bankIfsc ?? "",
        bankName: s.bankName ?? "",
        upiId: s.upiId ?? "",
        notes: s.notes ?? "",
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, supplierId, s]);

  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const registered = form.gstRegistration !== "unregistered";
  const gstIssue = registered && form.gstin ? validateGstin(form.gstin, { expectedStateCode: form.stateCode })[0] : undefined;
  const problems: Partial<Record<keyof Form, string>> = {
    ...(!form.name.trim() ? { name: t("validation.required") } : {}),
    ...(form.mobile && validateMobile(form.mobile).length ? { mobile: t("validation.mobile") } : {}),
    ...(form.pincode && validatePincode(form.pincode).length ? { pincode: t("validation.pincode") } : {}),
    ...(gstIssue ? { gstin: t(`validation.${gstIssue}`) } : {}),
    ...(form.openingBalance && !/^\d{1,13}(\.\d{1,2})?$/.test(form.openingBalance) ? { openingBalance: t("validation.amount") } : {}),
    ...(form.bankAccountNumber && !/^\d{6,20}$/.test(form.bankAccountNumber) ? { bankAccountNumber: t("validation.amount") } : {}),
    ...(form.bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(form.bankIfsc) ? { bankIfsc: t("validation.ifsc") } : {}),
  };
  const show = (k: keyof Form) => (touched ? problems[k] : undefined) ?? fieldError(k) ?? undefined;

  const save = async () => {
    setTouched(true);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setError(null);
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const body = {
      name: form.name.trim(),
      companyName: opt(form.companyName),
      gstRegistration: form.gstRegistration,
      mobile: opt(form.mobile),
      email: opt(form.email),
      stateCode: form.stateCode,
      city: opt(form.city),
      addressLine1: opt(form.addressLine1),
      pincode: opt(form.pincode),
      gstin: registered ? opt(form.gstin) : undefined,
      pan: opt(form.pan.toUpperCase()),
      creditDays: Number(form.creditDays) || 0,
      bankAccountName: opt(form.bankAccountName),
      bankAccountNumber: opt(form.bankAccountNumber),
      bankIfsc: opt(form.bankIfsc),
      bankName: opt(form.bankName),
      upiId: opt(form.upiId),
      notes: opt(form.notes),
      tdsExempt: noTds,
    };
    try {
      const saved = supplierId
        ? await api.patch<SupplierDetail>(`/suppliers/${supplierId}`, body)
        : await api.post<SupplierDetail>("/suppliers", { ...body, ...(form.openingBalance ? { openingBalance: form.openingBalance } : {}) });
      upsertSupplier(saved);
      void qc.invalidateQueries({ queryKey: ["supplier-detail"] });
      toast({ tone: "success", title: t("supplier.saved"), body: `${saved.code} · ${saved.name}` });
      onSaved?.(saved.id);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={supplierId ? t("supplier.edit") : t("supplier.add")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || (Boolean(supplierId) && !s)} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      {supplierId && detail.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <form className="flex flex-col gap-5" onSubmit={(e) => (e.preventDefault(), void save())}>
          {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t("supplier.displayName")} htmlFor="s-name" error={show("name")}>
              <Input id="s-name" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} invalid={Boolean(show("name"))} />
            </Field>
            <Field label={t("supplier.companyName")} htmlFor="s-company" hint={t("supplier.companyNameHint")} error={show("companyName")}>
              <Input id="s-company" value={form.companyName} onChange={(e) => set("companyName", e.target.value)} />
            </Field>
            <Field label={t("customer.mobile")} htmlFor="s-mobile" error={show("mobile")}>
              <Input id="s-mobile" inputMode="tel" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} invalid={Boolean(show("mobile"))} />
            </Field>
            <Field label={t("supplier.gstRegistration")} htmlFor="s-reg">
              <Select id="s-reg" value={form.gstRegistration} onChange={(e) => set("gstRegistration", e.target.value)}>
                {REGISTRATIONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`supplier.registration.${r}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {registered && (
              <Field label={t("customer.gstin")} htmlFor="s-gstin" error={show("gstin")} hint={t("customer.gstinHint")}>
                <Input
                  id="s-gstin"
                  maxLength={15}
                  className="[&_input]:font-mono [&_input]:uppercase"
                  value={form.gstin}
                  onChange={(e) => {
                    const v = normalizeGstin(e.target.value);
                    set("gstin", v);
                    if (v.length >= 2 && GST_STATES.some((x) => x.code === stateCodeFromGstin(v))) set("stateCode", stateCodeFromGstin(v));
                  }}
                  invalid={Boolean(show("gstin"))}
                />
              </Field>
            )}
            <Field label={t("common.state")} htmlFor="s-state" error={show("stateCode")}>
              <Select id="s-state" value={form.stateCode} onChange={(e) => set("stateCode", e.target.value)}>
                {stateOptions(locale).map((x) => (
                  <option key={x.code} value={x.code}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("common.city")} htmlFor="s-city">
              <Input id="s-city" value={form.city} onChange={(e) => set("city", e.target.value)} />
            </Field>
            <Field label={t("customer.address")} htmlFor="s-address">
              <Input id="s-address" value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} />
            </Field>
            <Field label={t("customer.pincode")} htmlFor="s-pin" error={show("pincode")}>
              <Input id="s-pin" inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => set("pincode", e.target.value)} />
            </Field>
            <Field label={t("customer.creditDays")} htmlFor="s-days">
              <Input id="s-days" inputMode="numeric" value={form.creditDays} onChange={(e) => set("creditDays", e.target.value.replace(/\D/g, "").slice(0, 3))} />
            </Field>
            {!supplierId && (
              <Field label={t("supplier.openingPayable")} htmlFor="s-opening" error={show("openingBalance")} hint={t("common.optional")}>
                <Input id="s-opening" inputMode="decimal" leading={<span className="text-[13px]">₹</span>} value={form.openingBalance} onChange={(e) => set("openingBalance", e.target.value.trim())} />
              </Field>
            )}
            <Field label={t("customer.email")} htmlFor="s-email" error={show("email")}>
              <Input id="s-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label={t("customer.pan")} htmlFor="s-pan" error={show("pan")}>
              <Input id="s-pan" maxLength={10} className="[&_input]:font-mono [&_input]:uppercase" value={form.pan} onChange={(e) => set("pan", e.target.value)} />
            </Field>
            <div className="flex flex-col justify-end gap-1 pb-1 sm:col-span-2">
              <Checkbox checked={noTds} onChange={setNoTds} label={t("tds.supplier.exempt")} />
              <p className="text-[12px] text-ink-3">{t("tds.supplier.exemptHint")}</p>
            </div>
          </div>

          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("supplier.bankDetails")}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t("supplier.accountName")} htmlFor="s-acname">
                <Input id="s-acname" value={form.bankAccountName} onChange={(e) => set("bankAccountName", e.target.value)} />
              </Field>
              <Field
                label={t("supplier.accountNumber")}
                htmlFor="s-acno"
                error={show("bankAccountNumber")}
                hint={s?.bankAccountNumberMasked ? t("supplier.accountOnFile", { masked: s.bankAccountNumberMasked }) : undefined}
              >
                <Input id="s-acno" inputMode="numeric" autoComplete="off" value={form.bankAccountNumber} onChange={(e) => set("bankAccountNumber", e.target.value.replace(/\D/g, ""))} />
              </Field>
              <Field label="IFSC" htmlFor="s-ifsc" error={show("bankIfsc")}>
                <Input id="s-ifsc" maxLength={11} className="[&_input]:font-mono [&_input]:uppercase" value={form.bankIfsc} onChange={(e) => set("bankIfsc", e.target.value.toUpperCase())} />
              </Field>
              <Field label={t("payment.chequeBank")} htmlFor="s-bank">
                <Input id="s-bank" value={form.bankName} onChange={(e) => set("bankName", e.target.value)} />
              </Field>
              <Field label="UPI" htmlFor="s-upi">
                <Input id="s-upi" value={form.upiId} onChange={(e) => set("upiId", e.target.value)} />
              </Field>
              <Field label={t("common.notes")} htmlFor="s-notes">
                <Input id="s-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
              </Field>
            </div>
          </section>
        </form>
      )}
    </Dialog>
  );
}
