import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { customerById, supplierById, TODAY, WORKSPACE } from "../../data/db";
import { refreshCatalog, refreshCustomer, refreshSupplier } from "../../data/live";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { serverOrDevice, updateDeviceDocument } from "../../offline/documents";
import { offlineScope, queueEntry, unreachable, workingOffline } from "../../offline/sync";
import { invalidateMoney } from "../payments/PaymentDialog";

interface DocLine {
  id: string;
  productId: string;
  productName: string;
  conversionFactor: string;
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
  const docKind = kind === "sale" ? "invoice" : "purchase";
  // The bill from the server, or the copy kept on this device without a connection.
  const doc = useQuery({
    queryKey: [kind === "sale" ? "invoice-raw" : "purchase", documentId],
    queryFn: () => serverOrDevice(docKind, documentId, () => api.get<DocForReturn>(kind === "sale" ? `/invoices/${documentId}` : `/purchases/${documentId}`)),
    enabled: open,
    networkMode: "always",
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
    const body = {
      noteDate: date,
      reason,
      restock,
      lines: chosen.map((l) => ({ lineId: l.id, qty: qty[l.id] })),
      ...(partyNote.trim() ? { partyNoteNumber: partyNote.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const d = doc.data!;
    /** Kept on this device with the same key: stock and the balance move now, the note comes when it syncs. */
    const keep = async () => {
      const scope = offlineScope();
      const partyId = (d.customerId ?? d.supplierId)!;
      const kept =
        scope &&
        (await queueEntry({
          kind: "return",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          side: kind,
          documentId,
          documentNumber: d.invoiceNumber ?? d.supplierInvoiceNumber ?? "",
          partyId,
          partyName: (kind === "sale" ? customerById.get(partyId)?.businessName : supplierById.get(partyId)?.name) ?? "",
          date,
          estimate: Math.round(estimate * 100) / 100,
          // Goods back in from a customer, or out to a supplier, when they go back on the shelf.
          stock: restock ? chosen.map((l) => ({ productId: l.productId, qty: Math.round(Number(qty[l.id]) * Number(l.conversionFactor || 1) * 1000) / 1000 * (kind === "sale" ? 1 : -1) })) : [],
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      // The kept bill shows what is already coming back, so it is not returned twice.
      updateDeviceDocument<DocForReturn & { id: string }>(docKind, documentId, (x) => ({
        ...x,
        items: x.items.map((l) => (qty[l.id] ? { ...l, returnedQty: String(Number(l.returnedQty) + Number(qty[l.id])) } : l)),
      }));
      void qc.invalidateQueries({ queryKey: [kind === "sale" ? "invoice-raw" : "purchase", documentId] });
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${kind === "sale" ? t("notes.creditSaved") : t("notes.debitSaved")} · ≈ ${money(estimate)} · ${t("offline.sendsLater")}` });
      onOpenChange(false);
    };
    try {
      if (workingOffline()) return await keep();
      const res = await api.post<{ noteNumber: string; grandTotal: string; warnings?: Array<{ code: string }> }>(`/${kind === "sale" ? "invoices" : "purchases"}/${documentId}/returns`, body, { idempotencyKey: key });
      await Promise.all([
        restock ? refreshCatalog() : Promise.resolve(),
        d.customerId ? refreshCustomer(d.customerId) : d.supplierId ? refreshSupplier(d.supplierId) : Promise.resolve(),
      ]).catch(() => undefined);
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "purchase", "stock", "notes"]) void qc.invalidateQueries({ queryKey: [k] });
      toast({ tone: "success", title: kind === "sale" ? t("notes.creditSaved") : t("notes.debitSaved"), body: `${res.noteNumber} · ${money(res.grandTotal)}` });
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

  const reasons = kind === "sale" ? ["sales_return", "damage", "other"] : ["purchase_return", "damage", "other"];

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
        <ErrorNote error={doc.error} onRetry={() => void doc.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
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
