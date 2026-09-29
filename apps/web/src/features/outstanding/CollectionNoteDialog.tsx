import { useQueryClient } from "@tanstack/react-query";
import { addDays } from "@vyapaar/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { TODAY } from "../../data/db";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { cn } from "../../lib/cn";
import { isWaitingCustomer, offlineScope, queueEntry, unreachable, useOffline } from "../../offline/sync";

const MONEY = /^\d{1,13}(\.\d{1,2})?$/;
const REASONS = ["closed", "away", "later", "noCash", "dispute"] as const;

/**
 * What happened on a visit when the money did not come: the customer's
 * promise to pay by a date (and how much, if they said), or a note. Kept on
 * the phone and sent later without a connection.
 */
export function CollectionNoteDialog({
  customer,
  open,
  onOpenChange,
}: {
  customer: { id: string; name: string } | null;
  open: boolean;
  onOpenChange(v: boolean): void;
}) {
  const { t, money, date } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const offline = useOffline();
  const [kind, setKind] = useState<"promise" | "note">("promise");
  const [on, setOn] = useState(addDays(TODAY, 1));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const fieldError = useFieldError(error);

  useEffect(() => {
    if (!open) return;
    setKind("promise");
    setOn(addDays(TODAY, 1));
    setAmount("");
    setNote("");
    setKey(newIdempotencyKey());
    setError(null);
    setTouched(false);
  }, [open]);

  const problems = {
    promisedOn: kind === "promise" && (!on || on < TODAY) ? t("errors.PROMISE_DATE_PAST") : null,
    promisedAmount: kind === "promise" && amount && (!MONEY.test(amount) || Number(amount) <= 0) ? t("validation.amount") : null,
    note: kind === "note" && !note.trim() ? t("errors.NOTE_REQUIRED") : null,
  };
  const show = (k: keyof typeof problems) => (touched ? problems[k] : null) ?? fieldError(k);

  const save = async () => {
    setTouched(true);
    if (!customer || Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError(null);
    const body = {
      customerId: customer.id,
      kind,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(kind === "promise" ? { promisedOn: on, ...(amount ? { promisedAmount: Number(amount).toFixed(2) } : {}) } : {}),
    };
    const done = (here: boolean) => {
      const title = kind === "promise" ? t("collect.promiseSaved") : t("collect.noteSaved");
      const detail = kind === "promise" ? (amount ? t("collect.promised", { amount: money(amount), date: date(on) }) : t("collect.promisedFull", { date: date(on) })) : note.trim();
      toast(here ? { tone: "offline", title: t("offline.savedHere"), body: `${title} · ${t("offline.sendsLater")}` } : { tone: "success", title, body: `${customer.name} · ${detail}` });
      void qc.invalidateQueries({ queryKey: ["collections"] });
      onOpenChange(false);
    };
    /** Kept on this device with the same key, so an attempt that did reach the server is never counted twice. */
    const keep = async () => {
      const scope = offlineScope();
      const kept =
        scope &&
        (await queueEntry({
          kind: "collection-note",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          customerId: customer.id,
          customerName: customer.name,
          noteKind: kind,
          date: kind === "promise" ? on : TODAY,
          amount: kind === "promise" && amount ? Number(amount) : null,
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      done(true);
    };
    try {
      if (offline.offlineMode || !offline.online || isWaitingCustomer(customer.id)) return await keep();
      await api.post("/collections/notes", body, { idempotencyKey: key });
      done(false);
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

  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn("press h-8 rounded-full border px-3 text-[12.5px] font-medium", active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
    >
      {label}
    </button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("collect.noteTitle")}
      description={customer?.name}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
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
        <Segmented
          label={t("collect.noteTitle")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "promise", label: t("collect.kindPromise") },
            { value: "note", label: t("collect.kindNote") },
          ]}
        />
        {kind === "promise" ? (
          <>
            <Field label={t("collect.promisedOn")} htmlFor="note-on" error={show("promisedOn")}>
              <div className="flex flex-col gap-2">
                <Input id="note-on" type="date" min={TODAY} value={on} onChange={(e) => setOn(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  {chip(on === addDays(TODAY, 1), t("collect.when.tomorrow"), () => setOn(addDays(TODAY, 1)))}
                  {chip(on === addDays(TODAY, 3), t("collect.when.in3"), () => setOn(addDays(TODAY, 3)))}
                  {chip(on === addDays(TODAY, 7), t("collect.when.nextWeek"), () => setOn(addDays(TODAY, 7)))}
                </div>
              </div>
            </Field>
            <Field label={t("collect.promisedAmount")} htmlFor="note-amount" hint={t("collect.amountHint")} error={show("promisedAmount")}>
              <Input id="note-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" />
            </Field>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">{REASONS.map((r) => chip(note === t(`collect.reasons.${r}`), t(`collect.reasons.${r}`), () => setNote(t(`collect.reasons.${r}`))))}</div>
        )}
        <Field label={kind === "promise" ? t("collect.noteOptional") : t("collect.noteText")} htmlFor="note-text" error={show("note")}>
          <textarea
            id="note-text"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none"
          />
        </Field>
      </form>
    </Dialog>
  );
}
