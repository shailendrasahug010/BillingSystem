import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@digitalbahi/core";
import { formatDate } from "@digitalbahi/i18n";
import { Ban, CloudOff, PencilLine, Wallet } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { BackButton, DataTable, ErrorNote, PageHeader, Stat } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { PdfActions } from "../../components/ui/PdfActions";
import { allowed, BUSINESS, supplierById, WORKSPACE } from "../../data/db";
import { refreshCatalog, refreshSupplier } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { serverOrDevice } from "../../offline/documents";
import { invalidateMoney, PaymentDialog } from "../payments/PaymentDialog";
import { ReturnsCard, type ReturnRow } from "../notes/NoteDialog";
import { PurchaseStatusBadge } from "./PurchasesPage";

export interface PurchaseDetail {
  id: string;
  purchaseNumber: string;
  supplierId: string;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: string;
  receivedDate: string;
  dueDate: string | null;
  partyName: string;
  partyGstin: string | null;
  supplyType: "intra_state" | "inter_state";
  isReverseCharge: boolean;
  itcEligibility: string;
  status: "posted" | "cancelled";
  warehouseId?: string | null;
  paymentStatus: "unpaid" | "partial" | "paid";
  grossTotal: string;
  discountTotal: string;
  taxableTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  cessTotal: string;
  charges: Array<{ key: string; label: string; taxable: string; gstRate: string; total: string }>;
  chargesTotal: string;
  roundOff: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
  /** TDS kept back on the bill (paid to the government, not the supplier), its base and rate; 0.00 when none. */
  tdsAmount?: string;
  tdsBase?: string;
  tdsRate?: string | null;
  tdsChallanId?: string | null;
  notes: string | null;
  cancelReason: string | null;
  items: Array<{
    id: string;
    lineNo: number;
    productId: string;
    productName: string;
    hsnCode: string | null;
    unitId: string;
    qty: string;
    freeQty: string;
    rate: string;
    discountPercent: string;
    taxableValue: string;
    gstRate: string;
    lineTotal: string;
    returnedQty: string;
    batchNumber: string | null;
    expiryDate: string | null;
    mfgDate?: string | null;
    mrp?: string | null;
    /** The goods receipt line it billed, or the order line its goods came for. */
    goodsReceiptItemId?: string | null;
    purchaseOrderItemId?: string | null;
  }>;
  /** Goods received before the bill that it paid for, and the orders its goods came against. */
  receipts?: Array<{ id: string; receiptNumber: string; receivedDate: string }>;
  orders?: Array<{ id: string; orderNumber: string }>;
  returns: ReturnRow[];
  payments: Array<{ paymentId: string; paymentNumber: string; paymentDate: string; method: PaymentMethod; amount: string; reversedAt: string | null }>;
}

export function PurchaseViewPage({ purchaseId }: { purchaseId: string }) {
  const { t, locale, money, number, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // From the server, or the copy kept on this device when there is no connection.
  const q = useQuery({
    queryKey: ["purchase", purchaseId],
    queryFn: () => serverOrDevice("purchase", purchaseId, () => api.get<PurchaseDetail>(`/purchases/${purchaseId}`)),
    networkMode: "always",
  });

  if (q.isPending) return <Skeleton className="h-60 w-full" />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/purchases/${p.id}/cancel`, { reason: reason.trim() });
      await Promise.all([refreshCatalog(), refreshSupplier(p.supplierId)]).catch(() => undefined);
      invalidateMoney(qc);
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("purchase.cancelledDone"), body: p.purchaseNumber });
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const posted = p.status === "posted";
  const deviceCopy = Boolean(p.deviceCopyAt);
  const returned = (p.returns ?? []).filter((r) => r.status === "posted").reduce((s, r) => s + Number(r.amountSettled), 0);
  const tax = (v: string) => (Number(v) ? money(v) : null);
  // Entered wrong: enter it again, prefilled; the wrong one is cancelled when the new one is saved. Not once goods went back.
  const correctable = posted && !deviceCopy && allowed("purchase.cancel") && allowed("purchase.create") && !(p.returns ?? []).some((r) => r.status === "posted");
  const shareText = t("share.purchase", { party: p.partyName, number: p.supplierInvoiceNumber, date: formatDate(p.supplierInvoiceDate), amount: money(p.grandTotal), balance: money(p.balanceDue), business: BUSINESS.name });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        back={<BackButton onClick={() => navigate({ name: "planned", module: "purchases" })} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.supplierInvoiceNumber} <PurchaseStatusBadge row={p} />
            {deviceCopy && (
              <Badge tone="warn" icon={<CloudOff size={13} />}>
                {t("offline.deviceCopy")}
              </Badge>
            )}
          </span>
        }
        subtitle={`${p.purchaseNumber} · ${p.partyName}${p.partyGstin ? ` · ${p.partyGstin}` : ""}`}
        actions={
          !deviceCopy ? (
            <>
              <PdfActions path={`/purchases/${p.id}/pdf`} locale={WORKSPACE.printLocale || locale} number={`purchase-${p.supplierInvoiceNumber}`} shareText={shareText} mobile={supplierById.get(p.supplierId)?.mobile} print />
              {correctable && !cancelling && (
                <Button icon={<PencilLine size={16} />} onClick={() => navigate({ name: "purchase-new", correctsId: p.id })}>
                  {t("purchase.correct")}
                </Button>
              )}
              {posted && allowed("purchase.cancel") && !cancelling && (
                <Button variant="ghost" icon={<Ban size={16} />} onClick={() => setCancelling(true)}>
                  {t("purchase.cancel")}
                </Button>
              )}
              {posted && allowed("payment.pay") && Number(p.balanceDue) > 0 && (
                <Button variant="primary" icon={<Wallet size={16} />} onClick={() => setPaying(true)}>
                  {t("payment.pay")}
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {error ? <ErrorNote error={error} /> : null}
      {((p.receipts?.length ?? 0) > 0 || (p.orders?.length ?? 0) > 0) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2" data-bill-sources>
          {(p.receipts ?? []).map((r) => (
            <button key={r.id} type="button" className="text-accent hover:underline" onClick={() => navigate({ name: "goods-receipt-view", goodsReceiptId: r.id })}>
              {t("buying.fromSources.fromReceipt", { number: r.receiptNumber })}
            </button>
          ))}
          {(p.orders ?? []).map((o) => (
            <button key={o.id} type="button" className="text-accent hover:underline" onClick={() => navigate({ name: "purchase-order-view", purchaseOrderId: o.id })}>
              {t("buying.fromSources.fromOrder", { number: o.orderNumber })}
            </button>
          ))}
        </p>
      )}
      {cancelling && (
        <Card className="flex flex-col gap-3 border-danger/40 p-4">
          <p className="text-[13.5px] text-ink-2">{(p.receipts?.length ?? 0) > 0 ? t("buying.fromSources.cancelHint") : t("purchase.cancelHint")}</p>
          <Field label={t("common.reason")} htmlFor="pu-cancel">
            <Input id="pu-cancel" autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void cancel()}>
              {t("purchase.confirmCancel")}
            </Button>
            <Button onClick={() => setCancelling(false)}>{t("common.back")}</Button>
          </div>
        </Card>
      )}
      {p.cancelReason && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {t("common.cancelled")}: {p.cancelReason}
        </p>
      )}

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 sm:p-5 lg:grid-cols-7">
        <Stat label={t("purchase.billDate")} value={dateMedium(p.supplierInvoiceDate)} />
        <Stat label={t("purchase.receivedDate")} value={dateMedium(p.receivedDate)} />
        <Stat label={t("invoice.dueDate")} value={p.dueDate ? dateMedium(p.dueDate) : "—"} />
        <Stat label={t("common.total")} value={money(p.grandTotal)} />
        <Stat label={t("purchase.paid")} value={money(Number(p.amountPaid) - returned)} tone={Number(p.amountPaid) - returned > 0 ? "good" : undefined} />
        {returned > 0 && <Stat label={t("notes.lessReturns")} value={money(returned)} />}
        <Stat label={t("common.balance")} value={money(p.balanceDue)} tone={posted && Number(p.balanceDue) > 0 ? "danger" : undefined} />
      </Card>

      <DataTable
        rows={p.items}
        rowKey={(i) => i.id}
        minWidth={820}
        columns={[
          {
            key: "product",
            header: t("invoice.product"),
            render: (i) => (
              <div>
                <p className="font-medium text-ink">{i.productName}</p>
                <p className="text-[12px] text-ink-3">
                  {i.hsnCode && `HSN ${i.hsnCode}`}
                  {i.batchNumber && ` · ${t("invoice.batch")} ${i.batchNumber}`}
                  {i.expiryDate && ` · ${t("invoice.expiry")} ${dateMedium(i.expiryDate)}`}
                </p>
              </div>
            ),
          },
          {
            key: "qty",
            header: t("invoice.qty"),
            align: "right",
            render: (i) => (
              <span>
                {number(i.qty)} {WORKSPACE.units.get(i.unitId) ?? ""}
                {Number(i.freeQty) > 0 && <span className="block text-[12px] text-good">+{number(i.freeQty)} {t("invoice.free")}</span>}
                {Number(i.returnedQty) > 0 && (
                  <span className="block text-[12px] text-warn">
                    −{number(i.returnedQty)} {t("notes.returned")}
                  </span>
                )}
              </span>
            ),
          },
          { key: "rate", header: t("invoice.rate"), align: "right", render: (i) => money(i.rate) },
          { key: "disc", header: t("invoice.discount"), align: "right", render: (i) => (Number(i.discountPercent) ? number(i.discountPercent, 2) : "—") },
          { key: "taxable", header: t("invoice.taxable"), align: "right", render: (i) => money(i.taxableValue) },
          { key: "gst", header: t("invoice.gstRate"), align: "right", render: (i) => `${number(i.gstRate, 2)}%` },
          { key: "total", header: t("invoice.amount"), align: "right", render: (i) => <span className="font-medium text-ink">{money(i.lineTotal)}</span> },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("nav.payments")} />
          <div className="p-4 sm:px-5">
            {p.payments.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("payment.noAllocations")}</p>
            ) : (
              <ul className="num divide-y divide-line text-[13.5px]">
                {p.payments.map((x) => (
                  <li key={x.paymentId + x.amount} className="flex items-center justify-between py-2">
                    <span className={x.reversedAt ? "text-ink-3 line-through" : "text-ink"}>
                      {x.paymentNumber} · {dateMedium(x.paymentDate)} · {t(`paymentMethod.${x.method}`)}
                    </span>
                    <span className={x.reversedAt ? "text-ink-3 line-through" : "font-medium"}>{money(x.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card className="p-4 sm:p-5">
          <dl className="num flex flex-col gap-1.5 text-[14px]">
            {(
              [
                [t("invoice.taxableValue"), money(p.taxableTotal)],
                [t("invoice.cgst"), tax(p.cgstTotal)],
                [t("invoice.sgst"), tax(p.sgstTotal)],
                [t("invoice.igst"), tax(p.igstTotal)],
                [t("invoice.cess"), tax(p.cessTotal)],
                ...p.charges.map((c) => [c.label, money(c.total)] as const),
                [t("invoice.roundOff"), tax(p.roundOff)],
              ] as Array<readonly [string, string | null]>
            )
              .filter(([, v]) => v !== null)
              .map(([label, v]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="text-ink">{v}</dd>
                </div>
              ))}
            <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-[18px] font-semibold">
              <dt>{t("invoice.grandTotal")}</dt>
              <dd>{money(p.grandTotal)}</dd>
            </div>
            {Number(p.tdsAmount ?? 0) > 0 && (
              <>
                <div className="flex justify-between gap-3 text-[13px] text-ink-2" data-tds>
                  <dt>
                    {t("tds.purchase.line", { rate: number(Number(p.tdsRate ?? 0)), base: money(p.tdsBase ?? "0") })}
                    {p.tdsChallanId ? ` · ${t("tds.purchase.paid")}` : ""}
                  </dt>
                  <dd>−{money(p.tdsAmount!)}</dd>
                </div>
                <div className="flex justify-between gap-3 text-[14px] font-medium text-ink">
                  <dt>{t("tds.purchase.payable")}</dt>
                  <dd>{money(Number(p.grandTotal) - Number(p.tdsAmount))}</dd>
                </div>
              </>
            )}
            <p className="mt-1 text-[12px] text-ink-3">
              {p.supplyType === "inter_state" ? t("gst.interState") : t("gst.intraState")} · {t("purchase.itc")}: {t(`purchase.itcOptions.${p.itcEligibility as "eligible"}`)}
              {p.isReverseCharge && ` · ${t("purchase.reverseCharge")}`}
            </p>
            {p.notes && <p className="text-[13px] text-ink-2">{p.notes}</p>}
          </dl>
        </Card>
      </div>
      <ReturnsCard kind="purchase" documentId={p.id} documentNumber={p.supplierInvoiceNumber} returns={p.returns ?? []} canReturn={posted} deviceCopy={deviceCopy} reverseCharge={p.isReverseCharge} />
      <PaymentDialog direction="out" partyId={p.supplierId} open={paying} onOpenChange={setPaying} />
    </div>
  );
}
