import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@vyapaar/core";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { customerById, supplierById, TODAY } from "../../data/db";
import { refreshCustomer, refreshSupplier } from "../../data/live";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { cn } from "../../lib/cn";
import { isWaitingCustomer, offlineScope, queueEntry, unreachable, useOffline, workingOffline } from "../../offline/sync";
import { searchCustomers } from "../invoice/CustomerPicker";
import { searchSuppliers, supplierLabel } from "../suppliers/search";

export const METHODS: PaymentMethod[] = ["cash", "upi", "bank_transfer", "cheque", "card", "other"];
const MONEY = /^\d{1,13}(\.\d{1,2})?$/;

export interface OpenDoc {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  balance: number;
}

/** Open (unpaid / part-paid) bills of a party, oldest due first. */
export function useOpenDocuments(direction: "in" | "out", partyId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["open-docs", direction, partyId],
    enabled: enabled && Boolean(partyId),
    queryFn: async (): Promise<OpenDoc[]> => {
      const docs =
        direction === "in"
          ? (
              await api.get<{ data: Array<{ id: string; invoiceNumber: string; invoiceDate: string; dueDate: string | null; balanceDue: string }> }>("/invoices", {
                customerId: partyId,
                paymentStatus: "open",
                limit: 200,
              })
            ).data.map((i) => ({ id: i.id, number: i.invoiceNumber, date: i.invoiceDate, dueDate: i.dueDate ?? i.invoiceDate, balance: Number(i.balanceDue) }))
          : (
              await api.get<{ data: Array<{ id: string; purchaseNumber: string; supplierInvoiceNumber: string; supplierInvoiceDate: string; balanceDue: string; status: string }> }>("/purchases", {
                supplierId: partyId,
                status: "posted",
                limit: 200,
              })
            ).data
              .filter((p) => Number(p.balanceDue) > 0)
              .map((p) => ({ id: p.id, number: p.supplierInvoiceNumber, date: p.supplierInvoiceDate, dueDate: p.supplierInvoiceDate, balance: Number(p.balanceDue) }));
      return docs.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date));
    },
  });
}

/** Oldest bill first, the same rule the server uses when no allocation is given. */
export function oldestFirst(amount: number, docs: OpenDoc[]): Record<string, number> {
  let left = Math.round(amount * 100);
  const out: Record<string, number> = {};
  for (const d of docs) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(d.balance * 100));
    if (take > 0) out[d.id] = take / 100;
    left -= take;
  }
  return out;
}

/** Everything that shows a party's money must re-read after a payment. */
export function invalidateMoney(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ["payments", "open-docs", "customer-invoices", "customer-payments", "customer-ledger", "supplier-detail", "supplier-ledger", "purchases", "purchase", "invoice-raw", "dashboard", "reports"]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * Money in from a customer or out to a supplier. The amount is applied to the
 * oldest open bills first (editable per bill); anything left over stays on the
 * party's account as an advance. Cheques need a number and start as pending.
 */
export function PaymentDialog({
  direction,
  partyId: initialParty,
  open,
  onOpenChange,
}: {
  direction: "in" | "out";
  partyId?: string | null;
  open: boolean;
  onOpenChange(v: boolean): void;
}) {
  const { t, money, dateMedium } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [party, setParty] = useState<string | null>(initialParty ?? null);
  const [form, setForm] = useState({ amount: "", method: "cash" as PaymentMethod, date: TODAY, reference: "", chequeDate: "", chequeBank: "", notes: "" });
  const [manual, setManual] = useState<Record<string, string> | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const fieldError = useFieldError(error);
  const offline = useOffline();
  // Without a connection (or for a customer not sent yet) the server applies it to the oldest bills when it arrives.
  const keepHere = offline.offlineMode || !offline.online || (direction === "in" && Boolean(party) && isWaitingCustomer(party!));
  const docs = useOpenDocuments(direction, party, !keepHere);

  useEffect(() => {
    if (!open) return;
    setParty(initialParty ?? null);
    setForm({ amount: "", method: "cash", date: TODAY, reference: "", chequeDate: "", chequeBank: "", notes: "" });
    setManual(null);
    setKey(newIdempotencyKey());
    setError(null);
    setTouched(false);
  }, [open, initialParty]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const amount = MONEY.test(form.amount) ? Number(form.amount) : 0;
  const auto = useMemo(() => oldestFirst(amount, docs.data ?? []), [amount, docs.data]);
  const applied = keepHere ? {} : manual ? Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, Number(v) || 0])) : auto;
  const allocated = Object.values(applied).reduce((s, v) => s + v, 0);
  const advance = Math.round((amount - allocated) * 100) / 100;

  const partyInfo =
    direction === "in"
      ? (() => {
          const c = party ? customerById.get(party) : undefined;
          return c ? { label: c.businessName, sub: [c.code, c.city].filter(Boolean).join(" · "), balance: c.balance ?? 0 } : null;
        })()
      : (() => {
          const s = party ? supplierById.get(party) : undefined;
          return s ? { label: supplierLabel(s), sub: `${s.code}${s.city ? ` · ${s.city}` : ""}`, balance: s.balance } : null;
        })();

  const problems = {
    party: party ? null : t("validation.required"),
    amount: !form.amount ? t("validation.required") : !MONEY.test(form.amount) ? t("validation.amount") : amount <= 0 ? t("validation.positive") : null,
    reference: form.method === "cheque" && !form.reference.trim() ? t("validation.required") : null,
    allocations: allocated - amount > 0.001 ? t("errors.ALLOCATION_EXCEEDS_PAYMENT") : manual && Object.values(manual).some((v) => v && !MONEY.test(v)) ? t("validation.amount") : null,
    date: form.date > TODAY ? t("errors.FUTURE_DATE_NOT_ALLOWED") : null,
  };
  const show = (k: keyof typeof problems) => (touched ? problems[k] : null) ?? fieldError(k === "party" ? (direction === "in" ? "customerId" : "supplierId") : k === "date" ? "paymentDate" : k === "reference" ? "referenceNumber" : k);

  const save = async () => {
    setTouched(true);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError(null);
    const body = {
      direction,
      ...(direction === "in" ? { customerId: party } : { supplierId: party }),
      paymentDate: form.date,
      amount: amount.toFixed(2),
      method: form.method,
      ...(form.reference.trim() ? { referenceNumber: form.reference.trim() } : {}),
      ...(form.method === "cheque" && form.chequeDate ? { chequeDate: form.chequeDate } : {}),
      ...(form.method === "cheque" && form.chequeBank.trim() ? { chequeBank: form.chequeBank.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };
    /** Kept on this device with the same key, so an attempt that did reach the server is never counted twice. */
    const keep = async () => {
      const scope = offlineScope();
      const name = direction === "in" ? customerById.get(party!)?.businessName : supplierById.get(party!) && supplierLabel(supplierById.get(party!)!);
      const kept =
        scope &&
        (await queueEntry({
          kind: "payment",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          direction,
          partyId: party!,
          partyName: name ?? "",
          date: form.date,
          amount,
          method: form.method,
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("payment.saved")} · ${money(amount)} · ${t("offline.sendsLater")}` });
      onOpenChange(false);
    };
    try {
      if (keepHere || workingOffline()) return await keep();
      const res = await api.post<{ paymentNumber: string; amount: string }>(
        "/payments",
        {
          ...body,
          allocations: Object.entries(applied)
            .filter(([, v]) => v > 0)
            .map(([documentId, v]) => ({ documentId, amount: v.toFixed(2) })),
        },
        { idempotencyKey: key },
      );
      await (direction === "in" ? refreshCustomer(party!) : refreshSupplier(party!)).catch(() => undefined);
      invalidateMoney(qc);
      toast({ tone: "success", title: t("payment.saved"), body: `${res.paymentNumber} · ${money(res.amount)}` });
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
      title={direction === "in" ? t("payment.receive") : t("payment.pay")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : amount > 0 ? `${t("common.save")} · ${money(amount)}` : t("common.save")}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void save())}>
        {error instanceof ApiError && error.code === "OFFLINE_NOT_KEPT" ? (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {t("offline.notReadyWork")}
          </p>
        ) : error instanceof ApiError && !error.field ? (
          <ErrorNote error={error} />
        ) : null}
        {keepHere && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{t("offline.paymentNote")}</p>}
        <Field label={direction === "in" ? t("customer.name") : t("supplier.name")} htmlFor="pay-party" error={show("party")}>
          <SearchSelect
            id="pay-party"
            autoFocus={!initialParty}
            value={party}
            onChange={(id) => (setParty(id), setManual(null))}
            invalid={Boolean(show("party"))}
            placeholder={direction === "in" ? t("customer.search") : t("supplier.search")}
            clearLabel={t("common.clear")}
            emptyText={t("search.noResults")}
            selectedLabel={partyInfo ? `${partyInfo.label} · ${partyInfo.sub}` : null}
            search={(q) =>
              direction === "in"
                ? searchCustomers(q).map((c) => ({ id: c.id, label: c.businessName, sub: [c.code, c.city, c.mobile].filter(Boolean).join(" · "), trailing: c.balance ? money(c.balance) : undefined }))
                : searchSuppliers(q).map((s) => ({ id: s.id, label: supplierLabel(s), sub: [s.code, s.city, s.mobile].filter(Boolean).join(" · "), trailing: s.balance ? money(s.balance) : undefined }))
            }
          />
          {partyInfo && (
            <p className="num text-[13px] text-ink-3">
              {direction === "in" ? t("customer.outstanding") : t("supplier.outstandingPayable")}: <span className="font-semibold text-ink">{money(partyInfo.balance)}</span>
            </p>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("common.amount")} htmlFor="pay-amount" error={show("amount")}>
            <Input
              id="pay-amount"
              inputMode="decimal"
              autoFocus={Boolean(initialParty)}
              leading={<span className="text-[13px]">₹</span>}
              value={form.amount}
              onChange={(e) => (set("amount", e.target.value.replace(/[^\d.]/g, "")), setManual(null))}
              invalid={Boolean(show("amount"))}
            />
          </Field>
          <Field label={t("common.method")} htmlFor="pay-method">
            <Select id="pay-method" value={form.method} onChange={(e) => set("method", e.target.value as PaymentMethod)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`paymentMethod.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.date")} htmlFor="pay-date" error={show("date")}>
            <Input id="pay-date" type="date" max={TODAY} value={form.date} onChange={(e) => set("date", e.target.value)} />
          </Field>
          <Field label={form.method === "cheque" ? t("payment.chequeNumber") : t("payment.reference")} htmlFor="pay-ref" error={show("reference")} hint={form.method === "cheque" ? undefined : t("common.optional")}>
            <Input id="pay-ref" value={form.reference} onChange={(e) => set("reference", e.target.value)} invalid={Boolean(show("reference"))} />
          </Field>
          {form.method === "cheque" && (
            <>
              <Field label={t("payment.chequeDate")} htmlFor="pay-cdate">
                <Input id="pay-cdate" type="date" value={form.chequeDate} onChange={(e) => set("chequeDate", e.target.value)} />
              </Field>
              <Field label={t("payment.chequeBank")} htmlFor="pay-cbank">
                <Input id="pay-cbank" value={form.chequeBank} onChange={(e) => set("chequeBank", e.target.value)} />
              </Field>
            </>
          )}
        </div>

        {party && !keepHere && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("payment.openBills")}</h3>
              {manual && (
                <Button size="sm" variant="ghost" onClick={() => setManual(null)}>
                  {t("payment.autoAllocate")}
                </Button>
              )}
            </div>
            {docs.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : docs.error ? (
              <ErrorNote error={docs.error} />
            ) : (docs.data ?? []).length === 0 ? (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-3">{t("payment.noOpenBills")}</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-surface-2 text-left text-[12px] text-ink-3">
                      <th className="py-2 pl-3 font-medium">{t("common.number")}</th>
                      <th className="py-2 pl-3 font-medium">{t("invoice.dueDate")}</th>
                      <th className="py-2 pl-3 text-right font-medium">{t("common.balance")}</th>
                      <th className="py-2 pr-3 pl-3 text-right font-medium">{t("payment.apply")}</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {docs.data!.map((d) => {
                      const overdue = d.dueDate < TODAY;
                      return (
                        <tr key={d.id} className="border-b border-line last:border-b-0">
                          <td className="py-1.5 pl-3 font-medium text-ink">{d.number}</td>
                          <td className={cn("py-1.5 pl-3", overdue ? "text-danger" : "text-ink-2")}>{dateMedium(d.dueDate)}</td>
                          <td className="py-1.5 pl-3 text-right">{money(d.balance)}</td>
                          <td className="py-1.5 pr-3 pl-3 text-right">
                            <Input
                              inputSize="sm"
                              inputMode="decimal"
                              aria-label={`${t("payment.apply")} ${d.number}`}
                              className="ml-auto w-28 [&_input]:text-right"
                              value={manual ? (manual[d.id] ?? "") : applied[d.id] ? applied[d.id]!.toFixed(2) : ""}
                              onChange={(e) => {
                                const v = e.target.value.replace(/[^\d.]/g, "");
                                const base = manual ?? Object.fromEntries(Object.entries(auto).map(([k, x]) => [k, x.toFixed(2)]));
                                setManual({ ...base, [d.id]: v });
                              }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {show("allocations") && (
              <p className="text-[12px] text-danger" role="alert">
                {show("allocations")}
              </p>
            )}
            {amount > 0 && (
              <p className="num text-[13px] text-ink-2">
                {t("payment.allocated")}: <span className="font-semibold text-ink">{money(allocated)}</span>
                {advance > 0 && <span> · {t("payment.advance", { amount: money(advance) })}</span>}
              </p>
            )}
          </div>
        )}

        <Field label={t("common.notes")} htmlFor="pay-notes" hint={t("common.optional")}>
          <Input id="pay-notes" maxLength={500} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
