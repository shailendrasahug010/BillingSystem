import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, TDS_SECTIONS, type PaymentMethod, type TdsSection } from "@digitalbahi/core";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { customerById, supplierById, TODAY } from "../../data/db";
import { refreshCustomer, refreshSupplier } from "../../data/live";
import { api, ApiError, newIdempotencyKey, QUICK_SAVE_MS } from "../../lib/api";
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
  for (const key of ["payments", "open-docs", "customer-invoices", "customer-payments", "customer-ledger", "supplier-detail", "supplier-ledger", "purchases", "purchase", "invoice-raw", "dashboard", "reports", "collections", "home"]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * Money in from a customer or out to a supplier. The amount is applied to the
 * oldest open bills first (editable per bill); anything left over stays on the
 * party's account as an advance. Cheques need a number and start as pending.
 */
/** What was saved: the server's payment, or one kept on this device to send later. */
export type SavedPayment =
  | { id: string; paymentNumber: string }
  | { offline: { partyName: string; date: string; amount: number; method: PaymentMethod; referenceNumber: string | null } };

export function PaymentDialog({
  direction,
  partyId: initialParty,
  initialAmount,
  documentId,
  open,
  onOpenChange,
  onSaved,
}: {
  direction: "in" | "out";
  partyId?: string | null;
  /** The amount to start with (e.g. what is overdue); editable. */
  initialAmount?: string;
  /** Taken against this bill first (paying from the bill itself), then the oldest. */
  documentId?: string;
  open: boolean;
  onOpenChange(v: boolean): void;
  /** Called once the payment is saved, before the dialog closes (to show its receipt). */
  onSaved?(saved: SavedPayment): void;
}) {
  const { t, money, dateMedium } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [party, setParty] = useState<string | null>(initialParty ?? null);
  const [form, setForm] = useState({ amount: "", method: "cash" as PaymentMethod, date: TODAY, reference: "", chequeDate: "", chequeBank: "", notes: "" });
  // A receipt the customer kept TDS back on: the TDS settles their bills with the money.
  const [tds, setTds] = useState({ on: false, amount: "", section: "goods" as TdsSection, certificate: "" });
  const [manual, setManual] = useState<Record<string, string> | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  // Part payment: the day the customer says they will pay the rest (kept as a promise to pay).
  const [promiseOn, setPromiseOn] = useState("");
  const [promiseKey, setPromiseKey] = useState(newIdempotencyKey);
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
    setForm({ amount: initialAmount ?? "", method: "cash", date: TODAY, reference: "", chequeDate: "", chequeBank: "", notes: "" });
    setTds({ on: false, amount: "", section: "goods", certificate: "" });
    setManual(null);
    setKey(newIdempotencyKey());
    setPromiseOn("");
    setPromiseKey(newIdempotencyKey());
    setError(null);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialParty]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const amount = MONEY.test(form.amount) ? Number(form.amount) : 0;
  const tdsOn = direction === "in" && tds.on;
  const tdsValue = tdsOn && MONEY.test(tds.amount) ? Number(tds.amount) : 0;
  // What the receipt settles: the money and the TDS kept back.
  const settles = Math.round((amount + tdsValue) * 100) / 100;
  const auto = useMemo(() => {
    const openDocs = docs.data ?? [];
    const first = documentId ? openDocs.filter((d) => d.id === documentId) : [];
    return oldestFirst(settles, [...first, ...openDocs.filter((d) => d.id !== documentId)]);
  }, [settles, docs.data, documentId]);
  const applied = keepHere ? {} : manual ? Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, Number(v) || 0])) : auto;
  const allocated = Object.values(applied).reduce((s, v) => s + v, 0);
  const advance = Math.round((settles - allocated) * 100) / 100;

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

  // What the customer still owes after this payment; a date for it can be noted as a promise.
  const rest = direction === "in" && partyInfo ? Math.round((partyInfo.balance - settles) * 100) / 100 : 0;
  const askPromise = direction === "in" && amount > 0 && rest > 0.5;

  const problems = {
    promiseOn: askPromise && promiseOn && promiseOn < TODAY ? t("errors.PROMISE_DATE_PAST") : null,
    party: party ? null : t("validation.required"),
    amount: !form.amount ? t("validation.required") : !MONEY.test(form.amount) ? t("validation.amount") : amount <= 0 ? t("validation.positive") : null,
    reference: form.method === "cheque" && !form.reference.trim() ? t("validation.required") : null,
    allocations: allocated - settles > 0.001 ? t("errors.ALLOCATION_EXCEEDS_PAYMENT") : manual && Object.values(manual).some((v) => v && !MONEY.test(v)) ? t("validation.amount") : null,
    date: form.date > TODAY ? t("errors.FUTURE_DATE_NOT_ALLOWED") : null,
    tds: tdsOn && !tds.amount ? t("validation.required") : tdsOn && !MONEY.test(tds.amount) ? t("validation.amount") : null,
  };
  const show = (k: keyof typeof problems) =>
    (touched ? problems[k] : null) ?? fieldError(k === "party" ? (direction === "in" ? "customerId" : "supplierId") : k === "date" ? "paymentDate" : k === "reference" ? "referenceNumber" : k === "tds" ? "tdsAmount" : k);

  const save = async () => {
    setTouched(true);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError(null);
    const promise = askPromise && promiseOn ? { on: promiseOn, amount: rest } : null;
    // The receipt says it too: "Rest ₹570 promised by 5 Oct 2026".
    const notes = [form.notes.trim(), promise ? t("collect.restNote", { amount: money(promise.amount), date: dateMedium(promise.on) }) : ""].filter(Boolean).join(" · ");
    const promiseBody = promise ? { customerId: party!, kind: "promise", promisedOn: promise.on, promisedAmount: promise.amount.toFixed(2) } : null;
    const keepPromise = async (customerName: string) => {
      const scope = offlineScope();
      if (!promiseBody || !scope) return;
      await queueEntry({
        kind: "collection-note",
        id: promiseKey,
        userId: scope.userId,
        businessId: scope.businessId,
        savedAt: new Date().toISOString(),
        status: "pending",
        error: null,
        customerId: party!,
        customerName,
        noteKind: "promise",
        date: promise!.on,
        amount: promise!.amount,
        body: promiseBody,
      });
    };
    const body = {
      direction,
      ...(direction === "in" ? { customerId: party } : { supplierId: party }),
      paymentDate: form.date,
      amount: amount.toFixed(2),
      method: form.method,
      ...(form.reference.trim() ? { referenceNumber: form.reference.trim() } : {}),
      ...(form.method === "cheque" && form.chequeDate ? { chequeDate: form.chequeDate } : {}),
      ...(form.method === "cheque" && form.chequeBank.trim() ? { chequeBank: form.chequeBank.trim() } : {}),
      ...(notes ? { notes } : {}),
      ...(tdsValue > 0 ? { tdsAmount: tdsValue.toFixed(2), tdsSection: tds.section, ...(tds.certificate.trim() ? { tdsCertificate: tds.certificate.trim() } : {}) } : {}),
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
      // After the payment in the queue, so the server takes the promise as made after it.
      await keepPromise(name ?? "");
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("payment.saved")} · ${money(amount)} · ${t("offline.sendsLater")}` });
      onSaved?.({ offline: { partyName: name ?? "", date: form.date, amount, method: form.method, referenceNumber: form.reference.trim() || null } });
      onOpenChange(false);
    };
    try {
      if (keepHere || workingOffline()) return await keep();
      const res = await api.post<{ id: string; paymentNumber: string; amount: string }>(
        "/payments",
        {
          ...body,
          allocations: Object.entries(applied)
            .filter(([, v]) => v > 0)
            .map(([documentId, v]) => ({ documentId, amount: v.toFixed(2) })),
        },
        { idempotencyKey: key, timeoutMs: QUICK_SAVE_MS },
      );
      if (promiseBody) {
        try {
          await api.post("/collections/notes", promiseBody, { idempotencyKey: promiseKey, timeoutMs: QUICK_SAVE_MS });
        } catch (e) {
          if (unreachable(e)) await keepPromise(customerById.get(party!)?.businessName ?? "").catch(() => undefined);
          else toast({ tone: "danger", title: t("collect.promiseNotSaved") });
        }
      }
      await (direction === "in" ? refreshCustomer(party!) : refreshSupplier(party!)).catch(() => undefined);
      invalidateMoney(qc);
      toast({ tone: "success", title: t("payment.saved"), body: `${res.paymentNumber} · ${money(res.amount)}` });
      onSaved?.({ id: res.id, paymentNumber: res.paymentNumber });
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

        {direction === "in" && (
          <div className="flex flex-col gap-3" data-tds>
            <Checkbox checked={tds.on} onChange={(v) => (setTds((x) => ({ ...x, on: v })), setManual(null))} label={t("tds.receipt.toggle")} />
            {tds.on && (
              <div className="grid grid-cols-1 gap-4 rounded-2xl border border-line bg-surface-2/60 p-3 sm:grid-cols-3">
                <Field label={t("tds.receipt.amount")} htmlFor="pay-tds" error={show("tds")}>
                  <Input
                    id="pay-tds"
                    inputMode="decimal"
                    leading={<span className="text-[13px]">₹</span>}
                    value={tds.amount}
                    onChange={(e) => (setTds((x) => ({ ...x, amount: e.target.value.replace(/[^\d.]/g, "") })), setManual(null))}
                    invalid={Boolean(show("tds"))}
                  />
                </Field>
                <Field label={t("tds.section")} htmlFor="pay-tds-section">
                  <Select id="pay-tds-section" value={tds.section} onChange={(e) => setTds((x) => ({ ...x, section: e.target.value as TdsSection }))}>
                    {TDS_SECTIONS.map((sec) => (
                      <option key={sec} value={sec}>
                        {t(`tds.sections.${sec}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("tds.receipt.certificate")} htmlFor="pay-tds-cert" hint={t("common.optional")}>
                  <Input id="pay-tds-cert" maxLength={40} value={tds.certificate} onChange={(e) => setTds((x) => ({ ...x, certificate: e.target.value }))} />
                </Field>
                {tdsValue > 0 && amount > 0 && (
                  <p className="num text-[13px] text-ink-2 sm:col-span-3">{t("tds.receipt.settles", { total: money(settles), received: money(amount), tds: money(tdsValue) })}</p>
                )}
              </div>
            )}
          </div>
        )}

        {askPromise && (
          <div className="flex flex-col gap-2 rounded-2xl border border-accent/25 bg-accent-soft/50 px-3.5 py-3">
            <p className="num text-[13px] font-medium text-ink">{t("collect.restAfter", { amount: money(rest) })}</p>
            <Field label={t("collect.restBy")} htmlFor="pay-promise" hint={t("common.optional")} error={show("promiseOn")}>
              <div className="flex flex-wrap items-center gap-2">
                <Input id="pay-promise" type="date" min={TODAY} value={promiseOn} onChange={(e) => setPromiseOn(e.target.value)} className="w-auto" />
                {([
                  [1, "collect.when.tomorrow"],
                  [3, "collect.when.in3"],
                  [7, "collect.when.nextWeek"],
                ] as const).map(([days, label]) => {
                  const on = addDays(TODAY, days);
                  return (
                    <button
                      key={days}
                      type="button"
                      aria-pressed={promiseOn === on}
                      onClick={() => setPromiseOn(promiseOn === on ? "" : on)}
                      className={cn("press h-8 rounded-full border px-3 text-[12.5px] font-medium", promiseOn === on ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
                    >
                      {t(label)}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        )}

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
              <ErrorNote error={docs.error} onRetry={() => void docs.refetch()} />
            ) : (docs.data ?? []).length === 0 ? (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-3">{t("payment.noOpenBills")}</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
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
