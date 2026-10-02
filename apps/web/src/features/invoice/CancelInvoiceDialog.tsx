import { useQueryClient } from "@tanstack/react-query";
import { translateError } from "@digitalbahi/i18n";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { refreshCatalog, refreshCustomer } from "../../data/live";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { updateDeviceDocument } from "../../offline/documents";
import { offlineScope, queueEntry, unreachable, workingOffline } from "../../offline/sync";
import { invalidateMoney } from "../payments/PaymentDialog";

/** The bill being cancelled, as the invoice screen has it. */
export interface CancellableBill {
  /** The server's id, or the key of a bill made on this device and not sent yet. */
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  grandTotal: number;
  /** What goes back on the shelf (base units). */
  stock: Array<{ productId: string; qty: number }>;
  /** Made on this device and not sent yet. */
  notSent: boolean;
}

/**
 * Cancels a bill with a reason. Online the server does it at once; without a
 * connection it is kept on this device (the goods back in stock and the
 * balance down here at once) and sent after the bill itself, in order.
 */
export function CancelInvoiceDialog({ bill, open, onOpenChange }: { bill: CancellableBill; open: boolean; onOpenChange(v: boolean): void }) {
  const i18n = useI18n();
  const { t, money } = i18n;
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open) return;
    setReason("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open]);

  const keep = async () => {
    const scope = offlineScope();
    const kept =
      scope &&
      (await queueEntry({
        kind: "invoice-cancel",
        id: key,
        userId: scope.userId,
        businessId: scope.businessId,
        savedAt: new Date().toISOString(),
        status: "pending",
        error: null,
        documentId: bill.id,
        documentNumber: bill.number,
        customerId: bill.customerId,
        customerName: bill.customerName,
        amount: bill.grandTotal,
        stock: bill.stock,
        body: { reason: reason.trim() },
      }));
    if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
    if (!bill.notSent) updateDeviceDocument<{ id: string; status: string }>("invoice", bill.id, (x) => ({ ...x, status: "cancelled" }));
    void qc.invalidateQueries({ queryKey: ["invoice-raw", bill.id] });
    toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("invoice.cancel.done", { number: bill.number })} · ${t("offline.sendsLater")}` });
    onOpenChange(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (workingOffline() || bill.notSent) return await keep();
      await api.post(`/invoices/${bill.id}/cancel`, { reason: reason.trim() }, { idempotencyKey: key });
      await Promise.all([refreshCatalog(), refreshCustomer(bill.customerId)]).catch(() => undefined);
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "stock", "reports"]) void qc.invalidateQueries({ queryKey: [k] });
      toast({ tone: "success", title: t("invoice.cancel.done", { number: bill.number }), body: money(bill.grandTotal) });
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
      title={t("invoice.cancel.title", { number: bill.number })}
      description={t("invoice.cancel.hint")}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
          <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void save()}>
            {busy ? t("common.saving") : t("invoice.cancel.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError ? (error.code === "OFFLINE_NOT_KEPT" ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{t("offline.notReadyWork")}</p> : <ErrorNote error={error} />) : null}
        <p className="text-[13.5px] text-ink-2">
          {bill.customerName} · {money(bill.grandTotal)}
        </p>
        <Field label={t("common.reason")} htmlFor="cancel-reason" hint={t("invoice.cancel.reasonHint")}>
          <Input id="cancel-reason" autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error instanceof ApiError && error.code !== "OFFLINE_NOT_KEPT" && error.field ? <p className="text-[12.5px] text-danger">{translateError(i18n, error)}</p> : null}
      </div>
    </Dialog>
  );
}
