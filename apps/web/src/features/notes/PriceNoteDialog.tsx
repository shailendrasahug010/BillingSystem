import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { TODAY } from "../../data/db";
import { api, ApiError, newIdempotencyKey, QUICK_SAVE_MS } from "../../lib/api";
import { offlineScope, queueEntry, unreachable, workingOffline } from "../../offline/sync";
import { invalidateMoney } from "../payments/PaymentDialog";

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * A discount or rate difference after the bill (credit note to the customer),
 * the supplier's credit note for the same on a purchase, or (`debit`) a debit
 * note to the customer: a rate difference upward or a charge after the sale.
 * Only the value changes: no goods move. The server spreads the amount over
 * the bill's lines and applies each line's GST. Without a connection (given
 * the party and the bill's totals) it is kept on this device and sent later;
 * the balance moves here at once by an estimate.
 */
export function PriceNoteDialog({
  kind,
  documentId,
  documentNumber,
  open,
  onOpenChange,
  party,
  totals,
  debit = false,
}: {
  kind: "sale" | "purchase";
  documentId: string;
  documentNumber: string;
  open: boolean;
  onOpenChange(v: boolean): void;
  party?: { id: string; name: string };
  totals?: { grandTotal: number; taxable: number };
  /** A debit note on a sales bill: the customer owes more. */
  debit?: boolean;
}) {
  const { t, money } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<"discount" | "rate_difference" | "other">(debit ? "rate_difference" : "discount");
  const [date, setDate] = useState(TODAY);
  const [partyNote, setPartyNote] = useState("");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);
  useEffect(() => {
    if (!open) return;
    setMode(debit ? "amount" : "percent");
    setValue("");
    setReason(debit ? "rate_difference" : "discount");
    setDate(TODAY);
    setPartyNote("");
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open, debit]);
  const valid = AMOUNT.test(value) && Number(value) > 0 && (mode === "amount" || Number(value) <= 100);
  const body = {
    noteDate: date,
    reason,
    [mode]: value,
    ...(partyNote.trim() ? { partyNoteNumber: partyNote.trim() } : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  };
  /** Kept on this device with the same key; the estimate (GST included) moves the balance here until the server's note comes. */
  const keep = async () => {
    const scope = offlineScope();
    if (!scope || !party || !totals) throw new ApiError(0, "network");
    const n = Number(value);
    const estimate = Math.round((mode === "percent" ? (totals.grandTotal * n) / 100 : totals.taxable > 0 ? (n * totals.grandTotal) / totals.taxable : n) * 100) / 100;
    const base = { id: key, userId: scope.userId, businessId: scope.businessId, savedAt: new Date().toISOString(), status: "pending" as const, error: null };
    const note = { documentId, documentNumber, partyId: party.id, partyName: party.name, date, estimate, body };
    const kept = await queueEntry(debit ? { ...base, kind: "debit-note", ...note } : { ...base, kind: "price-note", side: kind, ...note });
    if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
    toast({ tone: "offline", title: t("offline.savedHere"), body: `${debit ? t("notes.debitSaved") : t("notes.priceSaved")} · ≈ ${money(estimate)} · ${t("offline.sendsLater")}` });
    onOpenChange(false);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (workingOffline()) return await keep();
      const path = debit ? `/invoices/${documentId}/debit-notes` : `/${kind === "sale" ? "invoices" : "purchases"}/${documentId}/price-notes`;
      const res = await api.post<{ noteNumber: string; grandTotal: string }>(path, body, { idempotencyKey: key, timeoutMs: QUICK_SAVE_MS });
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "purchase", "notes", "reports", "gst"]) void qc.invalidateQueries({ queryKey: [k] });
      toast({ tone: "success", title: debit ? t("notes.debitSaved") : t("notes.priceSaved"), body: `${res.noteNumber} · ${money(res.grandTotal)}` });
      onOpenChange(false);
    } catch (e) {
      if (unreachable(e) && party && totals) {
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
      title={debit ? t("notes.debitTitle") : kind === "sale" ? t("notes.priceNote") : t("notes.supplierCreditNote")}
      description={`${t("notes.against")} ${documentNumber} · ${debit ? t("notes.debitHint") : t("notes.priceHint")}`}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && error.field !== "amount" ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("common.reason")} htmlFor="pn-reason">
            <Select id="pn-reason" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
              {debit ? (
                <>
                  <option value="rate_difference">{t("notes.reasons.rate_difference")}</option>
                  <option value="other">{t("notes.charges")}</option>
                </>
              ) : (
                <>
                  <option value="discount">{t("notes.reasons.discount")}</option>
                  <option value="rate_difference">{t("notes.reasons.rate_difference")}</option>
                </>
              )}
            </Select>
          </Field>
          <Field label={t("common.date")} htmlFor="pn-date">
            <Input id="pn-date" type="date" max={TODAY} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Segmented
          size="sm"
          label={t("notes.priceMode")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "percent", label: t("notes.percentOfBill") },
            { value: "amount", label: t("notes.amountBeforeGst") },
          ]}
        />
        <Field label={mode === "percent" ? t("notes.percentOfBill") : t("notes.amountBeforeGst")} htmlFor="pn-value" hint={t("notes.priceSpread")} error={fieldError("amount")}>
          <Input id="pn-value" inputMode="decimal" autoFocus value={value} invalid={Boolean(value) && !valid} onChange={(e) => setValue(e.target.value.trim())} leading={<span className="text-ink-3">{mode === "percent" ? "%" : "₹"}</span>} />
        </Field>
        {kind === "purchase" && (
          <Field label={t("notes.supplierNoteNumber")} htmlFor="pn-party" hint={t("common.optional")}>
            <Input id="pn-party" maxLength={30} value={partyNote} onChange={(e) => setPartyNote(e.target.value)} />
          </Field>
        )}
        <Field label={t("common.notes")} htmlFor="pn-notes" hint={t("common.optional")}>
          <Input id="pn-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
