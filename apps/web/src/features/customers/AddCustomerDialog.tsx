import { GST_STATES, normalizeGstin, stateCodeFromGstin, validateGstin, validateMobile, validatePincode, type IssueCode } from "@digitalbahi/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { translateError } from "@digitalbahi/i18n";
import { BUSINESS, WORKSPACE } from "../../data/db";
import { LIVE } from "../../data/source";
import type { Customer } from "../../data/types";
import { ApiError } from "../../lib/api";
import { stateOptions } from "../../lib/states";
import { useOffline } from "../../offline/sync";
import { customerKind as kindOf, type CustomerKind } from "./customerKind";
import { createCustomer, editCustomer, NotKeptOffline, type CustomerInput } from "./saveCustomer";

const REGISTRATION: Record<CustomerKind, string> = { b2b: "regular", b2c: "consumer", sez: "sez", export: "overseas" };
const FOREIGN = "96";

/**
 * Only the fields a counter clerk needs to start billing, and the selling
 * price list (Price A / B / C) the shop buys on; everything else (route,
 * credit terms...) has sensible defaults and lives on the full profile. Validation runs as you type, with specific messages: a GSTIN
 * typo is caught by its check digit, and a GSTIN from another state is flagged.
 * With `customer` it edits that customer's details (address and city too).
 * Without a connection both are kept on this device and sent later.
 */
export function AddCustomerDialog({
  open,
  onOpenChange,
  onCreated,
  initial,
  customer,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  onCreated?(id: string): void;
  /** What was typed in a search that found nobody: a mobile number, a GSTIN or the shop's name. */
  initial?: string;
  /** Edit this customer instead of adding one. */
  customer?: Customer;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const toast = useToast();
  const [kind, setKind] = useState<CustomerKind>("b2b");
  const type: "b2b" | "b2c" = kind === "b2b" || kind === "sez" ? "b2b" : "b2c";
  const abroad = kind === "export";
  const offline = useOffline();
  const workingOffline = offline.offlineMode || !offline.online;
  const blank = () => ({ businessName: "", name: "", mobile: "", gstin: "", stateCode: BUSINESS.stateCode || "23", pincode: "", creditLimit: "", priceLevelId: WORKSPACE.defaultPriceLevelId ?? "", address: "", city: "", messageLocale: "", pan: "" });
  const [form, setForm] = useState(blank);
  /** No payment reminders to this customer (editing). */
  const [optOut, setOptOut] = useState(false);
  /** No TCS on sales to them (a Form 27C declaration, a government body). */
  const [tcsExempt, setTcsExempt] = useState(false);
  /** PAN and TCS exemption are asked for when the business collects TCS (or the customer is exempt already). */
  const tcsOn = LIVE && (Boolean(WORKSPACE.tcs?.enabled) || Boolean(customer?.tcsExempt));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  /** The customer's details as the form shows them (edit mode). */
  const fromCustomer = (c: Customer) => ({
    businessName: c.businessName,
    name: c.name === c.businessName ? "" : c.name,
    mobile: c.mobile,
    gstin: c.gstin ?? "",
    stateCode: c.stateCode,
    pincode: c.pincode,
    creditLimit: c.creditLimit === null ? "" : String(Math.round(c.creditLimit)),
    priceLevelId: c.priceLevelId ?? WORKSPACE.defaultPriceLevelId ?? "",
    address: c.address,
    city: c.city,
    messageLocale: c.messageLocale ?? "",
    pan: c.pan ?? "",
  });

  // Editing: start from the customer as they are.
  useEffect(() => {
    if (!open || !customer) return;
    setKind(kindOf(customer));
    setForm(fromCustomer(customer));
    setOptOut(Boolean(customer.remindersOptOut));
    setTcsExempt(Boolean(customer.tcsExempt));
    setTouched({});
    setServerError(null);
  }, [open, customer]);

  // Opened from a search: start from what was typed.
  useEffect(() => {
    if (!open || !initial?.trim()) return;
    const typed = initial.trim();
    const digits = typed.replace(/\D/g, "");
    const gstin = normalizeGstin(typed);
    if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
      setKind("b2b");
      setForm({ ...blank(), gstin, stateCode: GST_STATES.some((x) => x.code === stateCodeFromGstin(gstin)) ? stateCodeFromGstin(gstin) : blank().stateCode });
    } else if (digits.length >= 10 && digits.length === typed.replace(/[\s+-]/g, "").length) setForm({ ...blank(), mobile: digits.slice(-10) });
    else setForm({ ...blank(), businessName: typed });
    setTouched({});
  }, [open, initial]);

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
    pincode: form.pincode && !abroad ? issueText(validatePincode(form.pincode), "pincode") : null,
    gstin: type === "b2b" ? issueText(gstinIssues, "gstin") : null,
    pan: form.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(form.pan) ? t("tcs.customer.panInvalid") : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const serverFieldError = (k: string) => (serverError && serverError.field === k ? translateError(i18n, serverError) : null);
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : null) ?? serverFieldError(k);

  /** Live mode: the server validates again (GSTIN checksum and state, duplicates) and assigns the code. */
  const input = (): CustomerInput => ({
    name: form.name.trim() || form.businessName.trim(),
    businessName: form.businessName.trim(),
    customerType: type,
    gstRegistration: REGISTRATION[kind],
    ...(form.mobile ? { mobile: form.mobile } : {}),
    stateCode: abroad ? FOREIGN : form.stateCode,
    ...(type === "b2b" && form.gstin ? { gstin: form.gstin } : {}),
    ...(form.pincode && !abroad ? { pincode: form.pincode } : {}),
    ...(form.creditLimit ? { creditLimit: form.creditLimit } : {}),
    ...(form.priceLevelId ? { priceLevelId: form.priceLevelId } : {}),
    ...(form.address.trim() ? { addressLine1: form.address.trim() } : {}),
    ...(form.city.trim() ? { city: form.city.trim() } : {}),
    ...(form.messageLocale === "en" || form.messageLocale === "hi" ? { messageLocale: form.messageLocale } : {}),
    ...(tcsOn && form.pan ? { pan: form.pan } : {}),
    ...(tcsOn && tcsExempt ? { tcsExempt: true } : {}),
  });
  /** Only what changed (edit mode); a cleared credit limit means no limit. */
  const changes = (c: Customer): Partial<CustomerInput> => {
    const now = input();
    const was = fromCustomer(c);
    const patch: Partial<CustomerInput> = {};
    if (now.businessName !== c.businessName) patch.businessName = now.businessName;
    if (now.name !== c.name) patch.name = now.name;
    if (type !== c.type) patch.customerType = type;
    if (kind !== kindOf(c)) patch.gstRegistration = now.gstRegistration!;
    if (form.mobile !== was.mobile && now.mobile) patch.mobile = now.mobile;
    if (now.stateCode !== was.stateCode) patch.stateCode = now.stateCode;
    if (type === "b2b" && form.gstin !== was.gstin && now.gstin) patch.gstin = now.gstin;
    if (form.pincode !== was.pincode && now.pincode) patch.pincode = now.pincode;
    if (form.creditLimit !== was.creditLimit) patch.creditLimit = form.creditLimit || null;
    if (form.priceLevelId !== was.priceLevelId && form.priceLevelId) patch.priceLevelId = form.priceLevelId;
    if (form.address.trim() !== was.address.trim()) patch.addressLine1 = form.address.trim();
    if (form.city.trim() !== was.city.trim()) patch.city = form.city.trim();
    if (form.messageLocale !== was.messageLocale) patch.messageLocale = form.messageLocale === "en" || form.messageLocale === "hi" ? form.messageLocale : null;
    if (optOut !== Boolean(c.remindersOptOut)) patch.remindersOptOut = optOut;
    if (tcsOn && form.pan && form.pan !== was.pan) patch.pan = form.pan;
    if (tcsOn && tcsExempt !== Boolean(c.tcsExempt)) patch.tcsExempt = tcsExempt;
    return patch;
  };

  const save = async () => {
    setBusy(true);
    setServerError(null);
    try {
      let result: Awaited<ReturnType<typeof createCustomer>>;
      if (customer) {
        const patch = changes(customer);
        if (Object.keys(patch).length === 0) {
          onOpenChange(false);
          return;
        }
        result = await editCustomer(customer.id, patch);
      } else {
        result = await createCustomer(input());
      }
      const saved = result.customer;
      if (result.queued) toast({ tone: "offline", title: t("offline.savedHere"), body: `${saved.businessName} · ${t("offline.sendsLater")}` });
      else toast({ tone: "success", title: customer ? t("customer.updated") : t("customer.saved"), body: `${saved.code} · ${saved.businessName}` });
      if (!customer) onCreated?.(saved.id);
      onOpenChange(false);
      if (!customer) setForm({ ...blank(), stateCode: form.stateCode, priceLevelId: form.priceLevelId });
      setTouched({});
    } catch (e) {
      setServerError(e instanceof ApiError ? e : e instanceof NotKeptOffline ? new ApiError(0, "OFFLINE_NOT_KEPT") : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={customer ? t("customer.edit") : t("customer.add")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setTouched({ businessName: true, mobile: true, pincode: true, gstin: true, pan: true });
              if (!valid) return;
              if (LIVE) return void save();
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
            {serverError.code === "OFFLINE_NOT_KEPT" ? t("offline.notReadyWork") : translateError(i18n, serverError)}
          </p>
        )}
        {LIVE && workingOffline && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn sm:col-span-2">{t("offline.customerNote")}</p>}
        <div className="sm:col-span-2">
          <Segmented
            label={t("customer.type")}
            value={kind}
            onChange={(k) => {
              setKind(k);
              // Back from export: a place in India again.
              if (k !== "export" && form.stateCode === FOREIGN) set("stateCode", BUSINESS.stateCode || "23");
            }}
            size="sm"
            options={[
              { value: "b2b", label: `${t("customer.b2b")} · GSTIN` },
              { value: "b2c", label: t("customer.b2c") },
              { value: "sez", label: t("customer.sez") },
              { value: "export", label: t("customer.export") },
            ]}
          />
          {(kind === "sez" || abroad) && <p className="mt-1.5 text-[12.5px] text-ink-3">{t(abroad ? "customer.exportHint" : "customer.sezHint")}</p>}
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
        {!abroad && (
          <>
            <Field label={t("common.state")} htmlFor="c-state">
              <Select id="c-state" value={form.stateCode} onChange={(e) => set("stateCode", e.target.value)}>
                {stateOptions(locale)
                  .filter((s) => s.code !== FOREIGN)
                  .map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("customer.pincode")} htmlFor="c-pin" error={show("pincode")}>
              <Input id="c-pin" inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => set("pincode", e.target.value)} onBlur={() => setTouched((x) => ({ ...x, pincode: true }))} invalid={Boolean(show("pincode"))} />
            </Field>
          </>
        )}
        {customer && (
          <>
            <Field label={t("customer.address")} htmlFor="c-address">
              <Input id="c-address" value={form.address} onChange={(e) => set("address", e.target.value)} />
            </Field>
            <Field label={t("common.city")} htmlFor="c-city">
              <Input id="c-city" value={form.city} onChange={(e) => set("city", e.target.value)} />
            </Field>
          </>
        )}
        <Field label={t("customer.creditLimit")} htmlFor="c-credit" hint={t("common.optional")}>
          <Input id="c-credit" inputMode="numeric" leading={<span className="text-[13px]">₹</span>} value={form.creditLimit} onChange={(e) => set("creditLimit", e.target.value.replace(/[^0-9]/g, ""))} />
        </Field>
        {WORKSPACE.priceLevels.length > 1 && (
          <Field label={t("customer.priceList")} htmlFor="c-price-list" hint={t("customer.priceListHint")} error={serverFieldError("priceLevelId")}>
            <Select id="c-price-list" value={form.priceLevelId} onChange={(e) => set("priceLevelId", e.target.value)}>
              {WORKSPACE.priceLevels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {LIVE && (
          <Field label={t("customer.messageLocale")} htmlFor="c-message-locale">
            <Select id="c-message-locale" value={form.messageLocale} onChange={(e) => set("messageLocale", e.target.value)}>
              <option value="">{t("customer.messageLocaleDefault")}</option>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </Select>
          </Field>
        )}
        {tcsOn && !abroad && (
          <>
            <Field label={t("tcs.customer.pan")} htmlFor="c-pan" hint={t("tcs.customer.panHint")} error={show("pan")}>
              <Input
                id="c-pan"
                className="[&_input]:font-mono [&_input]:uppercase"
                maxLength={10}
                value={form.pan}
                onChange={(e) => set("pan", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onBlur={() => setTouched((x) => ({ ...x, pan: true }))}
                invalid={Boolean(show("pan"))}
              />
            </Field>
            <div className="flex flex-col justify-end gap-1 pb-1">
              <Checkbox label={t("tcs.customer.exempt")} checked={tcsExempt} onChange={setTcsExempt} />
              <p className="text-[12px] text-ink-3">{t("tcs.customer.exemptHint")}</p>
            </div>
          </>
        )}
        {LIVE && customer && (
          <div className="flex flex-col justify-end gap-1 pb-1">
            <Checkbox label={t("customer.remindersOptOut")} checked={optOut} onChange={setOptOut} />
            <p className="text-[12px] text-ink-3">{t("customer.remindersOptOutHint")}</p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
