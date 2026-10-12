import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GoodsReceiptView, PurchaseOrderView } from "@digitalbahi/contracts";
import { Ban, MessageCircle, PackageCheck, Receipt, XCircle } from "lucide-react";
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
import { allowed, BUSINESS, supplierById, WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { shareOnWhatsApp } from "../../lib/share";
import { leftOnOrderLine, ORDER_STATUS_TONE, orderMessage, RECEIPT_STATUS_TONE } from "./buying";

const unitSymbol = (unitId: string) => WORKSPACE.units.get(unitId) ?? "";

/** Closing or cancelling with a reason, in a card under the header. */
function StopCard({ id, label, hint, confirm, busy, minLength, onConfirm, onBack }: { id: string; label: string; hint: string; confirm: string; busy: boolean; minLength: number; onConfirm(reason: string): void; onBack(): void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <Card className="flex flex-col gap-3 border-danger/40 p-4">
      <Field label={label} htmlFor={id} hint={hint}>
        <Input id={id} autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={busy || reason.trim().length < minLength} onClick={() => onConfirm(reason.trim())}>
          {confirm}
        </Button>
        <Button onClick={onBack}>{t("common.back")}</Button>
      </div>
    </Card>
  );
}

/** An order to a supplier: what came against it, what is still to come, and the next steps. */
export function PurchaseOrderViewPage({ purchaseOrderId }: { purchaseOrderId: string }) {
  const { t, money, number, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [stopping, setStopping] = useState<"close" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ["purchase-order", purchaseOrderId], queryFn: () => api.get<PurchaseOrderView>(`/purchase-orders/${purchaseOrderId}`) });
  if (q.isPending) return <Skeleton className="h-60 w-full" />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const open = o.status === "open" || o.status === "partly_received";
  const nothingCame = o.items.every((i) => Number(i.receivedBase) === 0) && o.receipts.every((r) => r.status === "cancelled");
  const left = o.items.filter((i) => Number(i.remainingBase) > 0).length;

  const stop = async (action: "close" | "cancel", reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<PurchaseOrderView>(`/purchase-orders/${o.id}/${action}`, reason ? { reason } : {});
      qc.setQueryData(["purchase-order", purchaseOrderId], res);
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      toast({ tone: "success", title: action === "close" ? t("buying.order.closed") : t("buying.order.cancelled"), body: o.orderNumber });
      setStopping(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const share = () =>
    shareOnWhatsApp(
      orderMessage(o, {
        unitSymbol,
        number: (n) => number(n),
        heading: t("buying.order.message", { number: o.orderNumber, business: BUSINESS.name }),
        deliverBy: o.expectedDate ? t("buying.order.deliverBy", { date: dateMedium(o.expectedDate) }) : null,
        free: t("invoice.free"),
      }),
      supplierById.get(o.supplierId)?.mobile ?? null,
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        back={<BackButton onClick={() => navigate({ name: "purchase-list", tab: "orders" })} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {o.orderNumber} <Badge tone={ORDER_STATUS_TONE[o.status]}>{t(`buying.order.status.${o.status}`)}</Badge>
          </span>
        }
        subtitle={[o.partyName, dateMedium(o.orderDate), o.expectedDate ? `${t("buying.order.expected")} ${dateMedium(o.expectedDate)}` : null].filter(Boolean).join(" · ")}
        actions={
          <>
            {o.status !== "cancelled" && (
              <Button icon={<MessageCircle size={16} />} onClick={share}>
                {t("buying.order.share")}
              </Button>
            )}
            {open && allowed("purchase.order") && !stopping && (
              <Button variant="ghost" icon={nothingCame ? <Ban size={16} /> : <XCircle size={16} />} onClick={() => setStopping(nothingCame ? "cancel" : "close")}>
                {nothingCame ? t("buying.order.cancel") : t("buying.order.close")}
              </Button>
            )}
            {open && allowed("purchase.receive") && (
              <Button icon={<PackageCheck size={16} />} onClick={() => navigate({ name: "goods-receipt-new", orderId: o.id })}>
                {t("buying.order.receive")}
              </Button>
            )}
            {open && allowed("purchase.create") && (
              <Button variant="primary" icon={<Receipt size={16} />} onClick={() => navigate({ name: "purchase-new", supplierId: o.supplierId, orderId: o.id })}>
                {t("buying.order.makeBill")}
              </Button>
            )}
          </>
        }
      />
      {error ? <ErrorNote error={error} /> : null}
      {stopping && (
        <StopCard
          id="po-stop"
          label={t("common.reason")}
          hint={stopping === "close" ? t("buying.order.closeHint") : t("buying.order.cancelHint")}
          confirm={stopping === "close" ? t("buying.order.confirmClose") : t("buying.order.confirmCancel")}
          busy={busy}
          minLength={0}
          onConfirm={(reason) => void stop(stopping, reason)}
          onBack={() => setStopping(null)}
        />
      )}
      {o.cancelReason && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
          {o.status === "cancelled" ? t("common.cancelled") : t("buying.order.status.closed")}: {o.cancelReason}
        </p>
      )}

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
        <Stat label={t("buying.order.estimate")} value={money(o.grandTotal)} />
        <Stat label={t("invoice.taxableValue")} value={money(o.taxableTotal)} />
        <Stat label={t("buying.order.expected")} value={o.expectedDate ? dateMedium(o.expectedDate) : "—"} />
        <Stat label={t("buying.order.left")} value={open ? t("common.items", { count: left }) : "—"} tone={open && left ? "warn" : undefined} />
      </Card>

      <DataTable
        rows={o.items}
        rowKey={(i) => i.id}
        minWidth={720}
        columns={[
          { key: "product", header: t("invoice.product"), render: (i) => <span className="font-medium text-ink">{i.productName}</span> },
          {
            key: "ordered",
            header: t("buying.order.ordered"),
            align: "right",
            render: (i) => (
              <span>
                {number(i.qty)} {unitSymbol(i.unitId)}
                {Number(i.freeQty) > 0 && <span className="block text-[12px] text-good">+{number(i.freeQty)} {t("invoice.free")}</span>}
              </span>
            ),
          },
          { key: "received", header: t("buying.order.received"), align: "right", render: (i) => `${number(Number(i.receivedBase) / Number(i.conversionFactor))} ${unitSymbol(i.unitId)}` },
          {
            key: "left",
            header: t("buying.order.left"),
            align: "right",
            render: (i) => {
              const l = leftOnOrderLine(i);
              if (!open || l.qty + l.free <= 0) return "—";
              return (
                <span className="font-semibold text-ink">
                  {number(l.qty + l.free)} {unitSymbol(i.unitId)}
                </span>
              );
            },
          },
          { key: "rate", header: t("invoice.rate"), align: "right", render: (i) => money(i.rate) },
          { key: "total", header: t("invoice.amount"), align: "right", render: (i) => money(i.lineTotal) },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("buying.order.receipts")} />
          <div className="p-4 sm:px-5">
            {o.receipts.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("buying.order.noReceipts")}</p>
            ) : (
              <ul className="num divide-y divide-line text-[13.5px]">
                {o.receipts.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => navigate({ name: "goods-receipt-view", goodsReceiptId: r.id })} className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-accent">
                      <span className={r.status === "cancelled" ? "text-ink-3 line-through" : "text-ink"}>
                        {r.receiptNumber} · {dateMedium(r.receivedDate)}
                      </span>
                      <Badge tone={RECEIPT_STATUS_TONE[r.status]}>{t(`buying.receipt.status.${r.status}`)}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("buying.order.bills")} />
          <div className="p-4 sm:px-5">
            {o.bills.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("buying.order.noBills")}</p>
            ) : (
              <ul className="num divide-y divide-line text-[13.5px]">
                {o.bills.map((b) => (
                  <li key={b.id}>
                    <button type="button" onClick={() => navigate({ name: "purchase-view", purchaseId: b.id })} className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-accent">
                      <span className={b.status === "cancelled" ? "text-ink-3 line-through" : "text-ink"}>
                        {b.supplierInvoiceNumber} · {dateMedium(b.supplierInvoiceDate)}
                      </span>
                      <span className="text-ink-3">{b.purchaseNumber}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {o.notes && <p className="mt-3 border-t border-line pt-2 text-[13px] text-ink-2">{o.notes}</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Goods received before their bill: what came, at what expected rate, and the bill once it is made. */
export function GoodsReceiptViewPage({ goodsReceiptId }: { goodsReceiptId: string }) {
  const { t, money, number, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ["goods-receipt", goodsReceiptId], queryFn: () => api.get<GoodsReceiptView>(`/goods-receipts/${goodsReceiptId}`) });
  if (q.isPending) return <Skeleton className="h-60 w-full" />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const g = q.data;
  const waiting = g.status === "received";

  const cancel = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<GoodsReceiptView>(`/goods-receipts/${g.id}/cancel`, { reason });
      qc.setQueryData(["goods-receipt", goodsReceiptId], res);
      await refreshCatalog().catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      void qc.invalidateQueries({ queryKey: ["purchase-order"] });
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("buying.receipt.cancelled"), body: g.receiptNumber });
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        back={<BackButton onClick={() => navigate({ name: "purchase-list", tab: "receipts" })} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {g.receiptNumber} <Badge tone={RECEIPT_STATUS_TONE[g.status]}>{t(`buying.receipt.status.${g.status}`)}</Badge>
          </span>
        }
        subtitle={[g.partyName, dateMedium(g.receivedDate), g.challanNumber ? `${t("buying.receipt.challan")} ${g.challanNumber}` : null].filter(Boolean).join(" · ")}
        actions={
          <>
            {waiting && allowed("purchase.receive") && !cancelling && (
              <Button variant="ghost" icon={<Ban size={16} />} onClick={() => setCancelling(true)}>
                {t("buying.receipt.cancel")}
              </Button>
            )}
            {waiting && allowed("purchase.create") && (
              <Button variant="primary" icon={<Receipt size={16} />} onClick={() => navigate({ name: "purchase-new", supplierId: g.supplierId, receiptId: g.id })}>
                {t("buying.receipt.makeBill")}
              </Button>
            )}
          </>
        }
      />
      {error ? <ErrorNote error={error} /> : null}
      {cancelling && (
        <StopCard
          id="gr-cancel"
          label={t("common.reason")}
          hint={t("buying.receipt.cancelHint")}
          confirm={t("buying.receipt.confirmCancel")}
          busy={busy}
          minLength={3}
          onConfirm={(reason) => void cancel(reason)}
          onBack={() => setCancelling(false)}
        />
      )}
      {g.cancelReason && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {t("common.cancelled")}: {g.cancelReason}
        </p>
      )}
      {waiting && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("buying.receipt.waitingHint")}</p>}

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
        <Stat label={t("buying.receipt.value")} value={money(g.totalValue)} />
        <Stat label={t("invoice.items")} value={g.items.length} />
        <Stat
          label={t("buying.receipt.order")}
          value={
            g.purchaseOrderId && g.orderNumber ? (
              <button type="button" className="text-accent hover:underline" onClick={() => navigate({ name: "purchase-order-view", purchaseOrderId: g.purchaseOrderId! })}>
                {g.orderNumber}
              </button>
            ) : (
              "—"
            )
          }
        />
        <Stat
          label={t("buying.receipt.bill")}
          value={
            g.purchase ? (
              <button type="button" className="text-accent hover:underline" onClick={() => navigate({ name: "purchase-view", purchaseId: g.purchase!.id })}>
                {g.purchase.supplierInvoiceNumber}
              </button>
            ) : (
              "—"
            )
          }
        />
      </Card>

      <DataTable
        rows={g.items}
        rowKey={(i) => i.id}
        minWidth={680}
        columns={[
          {
            key: "product",
            header: t("invoice.product"),
            render: (i) => (
              <span>
                <span className="font-medium text-ink">{i.productName}</span>
                {(i.batchNumber || i.expiryDate) && <span className="block text-[12px] text-ink-3">{[i.batchNumber, i.expiryDate ? dateMedium(i.expiryDate) : null].filter(Boolean).join(" · ")}</span>}
              </span>
            ),
          },
          {
            key: "qty",
            header: t("invoice.qty"),
            align: "right",
            render: (i) => (
              <span>
                {number(i.qty)} {unitSymbol(i.unitId)}
                {Number(i.freeQty) > 0 && <span className="block text-[12px] text-good">+{number(i.freeQty)} {t("invoice.free")}</span>}
              </span>
            ),
          },
          { key: "rate", header: t("buying.receipt.expectedRate"), align: "right", render: (i) => `${money(i.rate)}${Number(i.discountPercent) > 0 ? ` −${number(i.discountPercent)}%` : ""}` },
          { key: "value", header: t("buying.receipt.value"), align: "right", render: (i) => money(Number(i.qty) * Number(i.rate) * (1 - Number(i.discountPercent) / 100)) },
        ]}
      />
      {g.notes && <p className="text-[13px] text-ink-2">{g.notes}</p>}
    </div>
  );
}
