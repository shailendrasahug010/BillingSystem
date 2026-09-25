import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createTranslator, formatCurrency, formatDate, type LocaleCode } from "@vyapaar/i18n";
import { Percent, Printer, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { PdfActions } from "../../components/ui/PdfActions";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS, customerById, supplierById, WORKSPACE } from "../../data/db";
import { refreshCatalog, refreshCustomer, refreshSupplier } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { InvoiceDocument } from "../invoice/InvoiceDocument";
import { printableFromNote, type ApiNote } from "../invoice/printable";
import { invalidateMoney } from "../payments/PaymentDialog";
import { PriceNoteDialog } from "./PriceNoteDialog";
import { ReturnDialog } from "./ReturnDialog";

export interface ReturnRow {
  id: string;
  noteNumber: string | null;
  noteDate: string;
  noteType: "credit" | "debit";
  grandTotal: string;
  /** Part of the note applied to this document's balance. */
  amountSettled: string;
  status: "posted" | "cancelled";
  restock: boolean;
}

/** A credit / debit note: the document as printed, print, and cancel with a reason. */
export function NoteDialog({ noteId, onClose }: { noteId: string | null; onClose(): void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [printLocale, setPrintLocale] = useState<LocaleCode>((WORKSPACE.printLocale as LocaleCode) || locale);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ["notes", noteId], queryFn: () => api.get<ApiNote>(`/notes/${noteId}`), enabled: Boolean(noteId) });

  useEffect(() => {
    setCancelling(false);
    setReason("");
    setError(null);
  }, [noteId]);

  const note = q.data;
  const cancel = async () => {
    if (!note) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/notes/${note.id}/cancel`, { reason: reason.trim() });
      await Promise.all([refreshCatalog(), note.customerId ? refreshCustomer(note.customerId) : note.supplierId ? refreshSupplier(note.supplierId) : Promise.resolve()]).catch(() => undefined);
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "purchase", "stock", "notes"]) void qc.invalidateQueries({ queryKey: [k] });
      toast({ tone: "success", title: t("notes.cancelled"), body: note.noteNumber });
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const printable = note ? printableFromNote(note) : null;
  return (
    <Dialog
      open={Boolean(noteId)}
      onOpenChange={(v) => !v && onClose()}
      title={note ? `${note.noteType === "credit" ? t("notes.creditNote") : t("notes.debitNote")} ${note.noteNumber}` : t("common.loading")}
      description={note ? `${note.partyName}${note.partyNoteNumber ? ` · ${t("notes.supplierNoteNumber")} ${note.partyNoteNumber}` : ""}` : undefined}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        note && note.status === "posted" && allowed("note.cancel") ? (
          cancelling ? (
            <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void cancel()}>
              {t("notes.confirmCancel")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              {t("notes.cancel")}
            </Button>
          )
        ) : undefined
      }
    >
      {q.isPending ? (
        <Skeleton className="h-60 w-full" />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : note && printable ? (
        <div className="flex flex-col gap-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            {note.status === "cancelled" ? <Badge tone="danger">{t("common.cancelled")}</Badge> : <Badge tone="good">{t("status.document.posted")}</Badge>}
            <Badge>{t(`notes.reasons.${note.reason as "damage"}`)}</Badge>
            {!note.affectsStock && <Badge tone="warn">{t("notes.noStock")}</Badge>}
            <span className="ml-auto" />
            <Segmented
              size="sm"
              label={t("settings.printLanguage")}
              value={printLocale}
              onChange={setPrintLocale}
              options={[
                { value: "en", label: "English" },
                { value: "hi", label: "हिन्दी" },
              ]}
            />
            <Button size="sm" icon={<Printer size={14} />} onClick={() => window.print()}>
              {t("share.printPdf")}
            </Button>
            <PdfActions
              size="sm"
              path={`/notes/${note.id}/pdf`}
              locale={printLocale}
              number={note.noteNumber}
              shareText={createTranslator(printLocale).t("share.note", {
                party: note.partyName,
                kind: createTranslator(printLocale).t(note.noteType === "credit" ? "notes.creditNote" : "notes.debitNote"),
                number: note.noteNumber,
                date: formatDate(note.noteDate),
                amount: formatCurrency(note.grandTotal, printLocale),
                business: BUSINESS.name,
              })}
              mobile={note.customerId ? customerById.get(note.customerId)?.mobile : note.supplierId ? supplierById.get(note.supplierId)?.mobile : null}
            />
          </div>
          {note.cancelReason && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {t("common.reason")}: {note.cancelReason}
            </p>
          )}
          {cancelling && (
            <Field label={t("common.reason")} htmlFor="note-reason" hint={t("notes.cancelHint")}>
              <Input id="note-reason" autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          <div className="-mx-5 overflow-x-auto bg-surface-2 px-4 py-4">
            <InvoiceDocument invoice={printable} locale={printLocale} />
          </div>
          <PrintPortal>
            <InvoiceDocument invoice={printable} locale={printLocale} />
          </PrintPortal>
        </div>
      ) : null}
    </Dialog>
  );
}

/** Returns recorded against an invoice or purchase, with the action to record one. */
export function ReturnsCard({ kind, documentId, documentNumber, returns, canReturn }: { kind: "sale" | "purchase"; documentId: string; documentNumber: string; returns: ReturnRow[]; canReturn: boolean }) {
  const { t, money, dateMedium } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [pricing, setPricing] = useState(false);
  return (
    <Card>
      <CardHeader
        title={t("notes.returns")}
        action={
          canReturn && allowed("note.create") ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Percent size={14} />} onClick={() => setPricing(true)}>
                {kind === "sale" ? t("notes.priceNote") : t("notes.supplierCreditNote")}
              </Button>
              <Button size="sm" icon={<Undo2 size={14} />} onClick={() => setRecording(true)}>
                {kind === "sale" ? t("notes.salesReturn") : t("notes.purchaseReturn")}
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="p-4 sm:px-5">
        {returns.length === 0 ? (
          <p className="text-[13px] text-ink-3">{t("notes.none")}</p>
        ) : (
          <ul className="num divide-y divide-line text-[13.5px]">
            {returns.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r.id)} className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-accent">
                  <span className={r.status === "cancelled" ? "text-ink-3 line-through" : "text-ink"}>
                    {r.noteNumber} · {dateMedium(r.noteDate)}
                  </span>
                  <span className={r.status === "cancelled" ? "text-ink-3 line-through" : "font-medium"}>{money(r.grandTotal)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NoteDialog noteId={open} onClose={() => setOpen(null)} />
      <ReturnDialog kind={kind} documentId={documentId} open={recording} onOpenChange={setRecording} />
      <PriceNoteDialog kind={kind} documentId={documentId} documentNumber={documentNumber} open={pricing} onOpenChange={setPricing} />
    </Card>
  );
}
