import { useQuery, useQueryClient } from "@tanstack/react-query";
import { calculateTaxLine, determineSupplyType, isValidGstin, taxAt, type PaymentMethod } from "@digitalbahi/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { BUSINESS, TODAY } from "../../data/db";
import { EXPENSE_CATEGORIES } from "../../data/live";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { offlineScope, queueEntry, unreachable, workingOffline } from "../../offline/sync";
import { METHODS } from "../payments/PaymentDialog";

export interface ExpenseCategory {
  id: string;
  name: string;
  nameHi: string | null;
  isSystem: boolean;
  isActive: boolean;
}

const RATES = ["0", "5", "18", "40", "12", "28"] as const;
const ITC = ["input_services", "eligible", "capital_goods", "ineligible"] as const;
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

export function useExpenseCategories() {
  return useQuery({
    queryKey: ["expense-categories"],
    // Without a connection: the categories kept with the business on this device.
    queryFn: async () => {
      if (workingOffline()) return EXPENSE_CATEGORIES as ExpenseCategory[];
      try {
        return await api.get<{ data: ExpenseCategory[] }>("/expense-categories").then((r) => r.data);
      } catch (e) {
        if (unreachable(e)) return EXPENSE_CATEGORIES as ExpenseCategory[];
        throw e;
      }
    },
    networkMode: "always",
    staleTime: 60_000,
  });
}

/** Category name in the current language. */
export function useCategoryLabel() {
  const { locale } = useI18n();
  return (c: { name?: string | null; nameHi?: string | null; categoryName?: string | null; categoryNameHi?: string | null }) =>
    (locale === "hi" ? (c.nameHi ?? c.categoryNameHi) : null) || c.name || c.categoryName || "";
}

/** Enter an expense paid now. GST with the vendor's GSTIN is recorded for input tax credit. */
export function ExpenseDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const categories = useExpenseCategories();
  const label = useCategoryLabel();
  const [date, setDate] = useState(TODAY);
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [inclusive, setInclusive] = useState(false);
  const [rate, setRate] = useState<string>("0");
  const [gstin, setGstin] = useState("");
  const [itc, setItc] = useState<(typeof ITC)[number]>("input_services");
  const [paidTo, setPaidTo] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  useEffect(() => {
    if (!open) return;
    setDate(TODAY);
    setCategoryId("");
    setAmount("");
    setInclusive(false);
    setRate("0");
    setGstin("");
    setItc("input_services");
    setPaidTo("");
    setMethod("cash");
    setReference("");
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open]);

  const withGst = Number(rate) > 0;
  const gstinOk = !withGst || isValidGstin(gstin);
  const amountOk = AMOUNT.test(amount) && Number(amount) > 0;
  const breakdown = amountOk
    ? calculateTaxLine(
        { qty: 1, rate: amount, rateIncludesTax: inclusive, tax: taxAt(rate) },
        {
          supplyType: withGst && gstinOk && gstin.length === 15 && BUSINESS.stateCode ? determineSupplyType({ supplierStateCode: gstin.slice(0, 2), placeOfSupplyStateCode: BUSINESS.stateCode }) : "intra_state",
          chargeTax: withGst,
        },
      )
    : null;
  const ready = Boolean(categoryId) && amountOk && gstinOk && date <= TODAY;
  const active = (categories.data ?? []).filter((c) => c.isActive);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      expenseDate: date,
      categoryId,
      amount,
      amountIncludesTax: inclusive,
      gstRate: rate,
      ...(withGst ? { vendorGstin: gstin.trim().toUpperCase(), itcEligibility: itc } : {}),
      paymentMethod: method,
      ...(paidTo.trim() ? { paidTo: paidTo.trim() } : {}),
      ...(reference.trim() ? { referenceNumber: reference.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    /** Kept on this device with the same key, and sent when the connection is back. */
    const keep = async () => {
      const scope = offlineScope();
      const category = active.find((c) => c.id === categoryId);
      const total = breakdown ? Number(breakdown.taxable.plus(breakdown.taxTotal).toFixed(2)) : Number(amount);
      const kept =
        scope &&
        (await queueEntry({
          kind: "expense",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          categoryName: category ? label(category) : "",
          paidTo: paidTo.trim(),
          date,
          total,
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("expenses.saved")} · ${money(total)} · ${t("offline.sendsLater")}` });
      onOpenChange(false);
    };
    try {
      if (workingOffline()) return await keep();
      const res = await api.post<{ expenseNumber: string; totalAmount: string }>("/expenses", body, { idempotencyKey: key });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["reports"] });
      void qc.invalidateQueries({ queryKey: ["gst"] });
      toast({ tone: "success", title: t("expenses.saved"), body: `${res.expenseNumber} · ${money(res.totalAmount)}` });
      onOpenChange(false);
    } catch (e) {
      if (unreachable(e)) {
        await keep().catch((err: unknown) => setError(err instanceof ApiError ? err : new ApiError(0, "generic")));
        return;
      }
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("expenses.new")}
      description={t("expenses.newHint")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? t("common.saving") : breakdown ? `${t("common.save")} · ${money(breakdown.taxable.plus(breakdown.taxTotal).toFixed(2))}` : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("expenses.category")} htmlFor="ex-category" error={fieldError("categoryId")}>
            <Select id="ex-category" autoFocus value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t("expenses.chooseCategory")}</option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {label(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.date")} htmlFor="ex-date" error={fieldError("expenseDate")}>
            <Input id="ex-date" type="date" max={TODAY} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={inclusive ? t("expenses.billTotal") : t("expenses.amountBeforeGst")} htmlFor="ex-amount" error={fieldError("amount") ?? (amount && !amountOk ? t("validation.amount") : undefined)}>
            <Input id="ex-amount" inputMode="decimal" value={amount} invalid={Boolean(amount) && !amountOk} onChange={(e) => setAmount(e.target.value.trim())} leading={<span className="text-ink-3">₹</span>} />
          </Field>
          <Field label={t("expenses.gstRate")} htmlFor="ex-rate">
            <Select id="ex-rate" value={rate} onChange={(e) => setRate(e.target.value)}>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r === "0" ? t("expenses.noGst") : `${r}%`}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {withGst && (
          <div className="grid grid-cols-1 gap-4 rounded-lg border border-line bg-surface-2 p-3 sm:grid-cols-2">
            <Field label={t("expenses.vendorGstin")} htmlFor="ex-gstin" hint={t("expenses.gstinHint")} error={fieldError("vendorGstin") ?? (gstin.length === 15 && !gstinOk ? t("errors.INVALID_GSTIN") : undefined)}>
              <Input id="ex-gstin" maxLength={15} value={gstin} invalid={gstin.length === 15 && !gstinOk} onChange={(e) => setGstin(e.target.value.trim().toUpperCase())} className="[&_input]:uppercase" />
            </Field>
            <Field label={t("expenses.itc")} htmlFor="ex-itc">
              <Select id="ex-itc" value={itc} onChange={(e) => setItc(e.target.value as (typeof ITC)[number])}>
                {ITC.map((x) => (
                  <option key={x} value={x}>
                    {t(`expenses.itcTypes.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox className="sm:col-span-2" label={t("expenses.amountIncludesGst")} checked={inclusive} onChange={setInclusive} />
          </div>
        )}
        {breakdown && withGst && (
          <dl className="num grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line px-3 py-2 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-ink-3">{t("invoice.taxable")}</dt>
              <dd className="font-medium text-ink">{money(breakdown.taxable.toFixed(2))}</dd>
            </div>
            {breakdown.igst.gt(0) ? (
              <div>
                <dt className="text-ink-3">IGST</dt>
                <dd className="font-medium text-ink">{money(breakdown.igst.toFixed(2))}</dd>
              </div>
            ) : (
              <>
                <div>
                  <dt className="text-ink-3">CGST</dt>
                  <dd className="font-medium text-ink">{money(breakdown.cgst.toFixed(2))}</dd>
                </div>
                <div>
                  <dt className="text-ink-3">SGST</dt>
                  <dd className="font-medium text-ink">{money(breakdown.sgst.toFixed(2))}</dd>
                </div>
              </>
            )}
            <div>
              <dt className="text-ink-3">{t("common.total")}</dt>
              <dd className="font-semibold text-ink">{money(breakdown.taxable.plus(breakdown.taxTotal).toFixed(2))}</dd>
            </div>
          </dl>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("expenses.paidTo")} htmlFor="ex-paid-to" hint={t("common.optional")}>
            <Input id="ex-paid-to" maxLength={120} value={paidTo} onChange={(e) => setPaidTo(e.target.value)} />
          </Field>
          <Field label={t("common.method")} htmlFor="ex-method">
            <Select id="ex-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`paymentMethod.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("expenses.billNumber")} htmlFor="ex-ref" hint={t("common.optional")}>
            <Input id="ex-ref" maxLength={40} value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label={t("common.notes")} htmlFor="ex-notes" hint={t("common.optional")}>
            <Input id="ex-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
