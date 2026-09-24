import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { TODAY, WORKSPACE } from "../../data/db";
import { refreshCatalog, refreshCustomer, refreshSupplier } from "../../data/live";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { invalidateMoney } from "../payments/PaymentDialog";

interface DocLine {
  id: string;
  productName: string;
  unitId: string;
  qty: string;
  returnedQty: string;
  lineTotal: string;
}

interface DocForReturn {
  id: string;
  customerId?: string;
  supplierId?: string;
  invoiceNumber?: string;
  supplierInvoiceNumber?: string;
  items: DocLine[];
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;

/**
 * Goods coming back from a customer (credit note against the invoice) or
 * going back to a supplier (debit note against their bill). Pick quantities
 * per line; values follow the original bill, so the server works out the
 * exact amounts and the GST.
 */
export function ReturnDialog({ kind, documentId, open, onOpenChange }: { kind: "sale" | "purchase"; documentId: string; open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money, number } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState(kind === "sale" ? "sales_return" : "purchase_return");
  const [partyNote, setPartyNote] = useState("");
  const [date, setDate] = useState(TODAY);
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const doc = useQuery({
    queryKey: [kind === "sale" ? "invoice-raw" : "purchase", documentId],
    queryFn: () => api.get<DocForReturn>(kind === "sale" ? `/invoices/${documentId}` : `/purchases/${documentId}`),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setQty({});
    setRestock(true);
    setReason(kind === "sale" ? "sales_return" : "purchase_return");
    setPartyNote("");
    setDate(TODAY);
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open, kind]);

  const lines = (doc.data?.items ?? []).map((l) => ({ ...l, left: Math.round((Number(l.qty) - Number(l.returnedQty)) * 1000) / 1000 }));
  const invalid = lines.find((l) => qty[l.id] && (!QTY.test(qty[l.id]!) || Number(qty[l.id]) > l.left));
  const chosen = lines.filter((l) => Number(qty[l.id]) > 0);
  // Estimate only: the server applies the exact share of every amount and the round-off rule.
  const estimate = chosen.reduce((s, l) => s + (Number(l.lineTotal) * Number(qty[l.id])) / Number(l.qty), 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ noteNumber: string; grandTotal: string; warnings?: Array<{ code: string }> }>(
        `/${kind === "sale" ? "invoices" : "purchases"}/${documentId}/returns`,
        {
          noteDate: date,
          reason,
          restock,
          lines: chosen.map((l) => ({ lineId: l.id, qty: qty[l.id] })),
          ...(partyNote.trim() ? { partyNoteNumber: partyNote.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
        { idempotencyKey: key },
      );
      const d = doc.data!;
      await Promise.all([
        restock ? refreshCatalog() : Promise.resolve(),
        d.customerId ? refreshCustomer(d.customerId) : d.supplierId ? refreshSupplier(d.supplierId) : Promise.resolve(),
      ]).catch(() => undefined);
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "purchase", "stock", "notes"]) void qc.invalidateQueries({ queryKey: [k] });
      toast({ tone: "success", title: kind === "sale" ? t("notes.creditSaved") : t("notes.debitSaved"), body: `${res.noteNumber} · ${money(res.grandTotal)}` });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const reasons = kind === "sale" ? ["sales_return", "damage", "rate_difference", "other"] : ["purchase_return", "damage", "rate_difference", "other"];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind === "sale" ? t("notes.salesReturn") : t("notes.purchaseReturn")}
      description={doc.data ? `${t("notes.against")} ${doc.data.invoiceNumber ?? doc.data.supplierInvoiceNumber ?? ""}` : undefined}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !chosen.length || Boolean(invalid)} onClick={() => void save()}>
            {busy ? t("common.saving") : chosen.length ? `${t("common.save")} · ≈ ${money(estimate)}` : t("common.save")}
          </Button>
        </>
      }
    >
      {doc.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : doc.error ? (
        <ErrorNote error={doc.error} />
      ) : (
        <div className="flex flex-col gap-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-[12px] text-ink-3">
                  <th className="py-2 pl-3 font-medium">{t("invoice.product")}</th>
                  <th className="py-2 pl-3 text-right font-medium">{t("notes.billed")}</th>
                  <th className="py-2 pl-3 text-right font-medium">{t("notes.canReturn")}</th>
                  <th className="py-2 pr-3 pl-3 text-right font-medium">{t("notes.returnQty")}</th>
                </tr>
              </thead>
              <tbody className="num">
                {lines.map((l) => {
                  const unit = WORKSPACE.units.get(l.unitId) ?? "";
                  const bad = qty[l.id] && (!QTY.test(qty[l.id]!) || Number(qty[l.id]) > l.left);
                  return (
                    <tr key={l.id} className="border-b border-line last:border-b-0">
                      <td className="py-1.5 pl-3 text-ink">{l.productName}</td>
                      <td className="py-1.5 pl-3 text-right text-ink-2">
                        {number(l.qty)} {unit}
                      </td>
                      <td className="py-1.5 pl-3 text-right text-ink-2">{l.left > 0 ? number(l.left) : "—"}</td>
                      <td className="py-1.5 pr-3 pl-3">
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            inputSize="sm"
                            inputMode="decimal"
                            aria-label={`${t("notes.returnQty")} ${l.productName}`}
                            disabled={l.left <= 0}
                            invalid={Boolean(bad)}
                            className="w-20 [&_input]:text-right"
                            value={qty[l.id] ?? ""}
                            onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value.trim() }))}
                          />
                          <Button size="sm" variant="ghost" disabled={l.left <= 0} onClick={() => setQty((q) => ({ ...q, [l.id]: String(l.left) }))}>
                            {t("common.all")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {invalid && (
            <p className="text-[12px] text-danger" role="alert">
              {t("errors.RETURN_QTY_EXCEEDS", { product: invalid.productName, max: number(invalid.left) })}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("common.reason")} htmlFor="ret-reason">
              <Select id="ret-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                {reasons.map((r) => (
                  <option key={r} value={r}>
                    {t(`notes.reasons.${r as "damage"}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("common.date")} htmlFor="ret-date">
              <Input id="ret-date" type="date" max={TODAY} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            {kind === "purchase" && (
              <Field label={t("notes.supplierNoteNumber")} htmlFor="ret-party" hint={t("common.optional")}>
                <Input id="ret-party" maxLength={30} value={partyNote} onChange={(e) => setPartyNote(e.target.value)} />
              </Field>
            )}
            <Field label={t("common.notes")} htmlFor="ret-notes" hint={t("common.optional")}>
              <Input id="ret-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <Checkbox label={kind === "sale" ? t("notes.restockSale") : t("notes.restockPurchase")} checked={restock} onChange={setRestock} />
        </div>
      )}
    </Dialog>
  );
}
