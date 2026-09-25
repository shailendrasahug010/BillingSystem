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
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { invalidateMoney } from "../payments/PaymentDialog";

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * A discount or rate difference after the bill (credit note to the customer),
 * or the supplier's credit note for the same on a purchase. Only the value
 * changes: no goods move. The server spreads the amount over the bill's lines
 * and applies each line's GST.
 */
export function PriceNoteDialog({ kind, documentId, documentNumber, open, onOpenChange }: { kind: "sale" | "purchase"; documentId: string; documentNumber: string; open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<"discount" | "rate_difference">("discount");
  const [date, setDate] = useState(TODAY);
  const [partyNote, setPartyNote] = useState("");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);
  useEffect(() => {
    if (!open) return;
    setMode("percent");
    setValue("");
    setReason("discount");
    setDate(TODAY);
    setPartyNote("");
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open]);
  const valid = AMOUNT.test(value) && Number(value) > 0 && (mode === "amount" || Number(value) <= 100);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ noteNumber: string; grandTotal: string }>(
        `/${kind === "sale" ? "invoices" : "purchases"}/${documentId}/price-notes`,
        {
          noteDate: date,
          reason,
          [mode]: value,
          ...(partyNote.trim() ? { partyNoteNumber: partyNote.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
        { idempotencyKey: key },
      );
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "purchase", "notes", "reports", "gst"]) void qc.invalidateQueries({ queryKey: [k] });
      toast({ tone: "success", title: t("notes.priceSaved"), body: `${res.noteNumber} · ${money(res.grandTotal)}` });
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
      title={kind === "sale" ? t("notes.priceNote") : t("notes.supplierCreditNote")}
      description={`${t("notes.against")} ${documentNumber} · ${t("notes.priceHint")}`}
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
              <option value="discount">{t("notes.reasons.discount")}</option>
              <option value="rate_difference">{t("notes.reasons.rate_difference")}</option>
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
