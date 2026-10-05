import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@digitalbahi/core";
import { Ban, CheckCircle2, FileText, Printer, Receipt, Truck } from "lucide-react";
import { useEffect, useState } from "react";
import type { LocaleCode } from "@digitalbahi/i18n";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { InvoiceDocument } from "../invoice/InvoiceDocument";
import { printableFromOrder, type ApiOrderForPrint } from "../invoice/printable";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { BackButton, DataTable, ErrorNote, PageHeader, Stat } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, WORKSPACE } from "../../data/db";
import { refreshCatalog, refreshCustomer } from "../../data/live";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { invalidateMoney, METHODS } from "../payments/PaymentDialog";
import { ORDER_TONE, type OrderStatus } from "./OrdersPage";

interface OrderItem {
  id: string;
  productName: string;
  unitId: string;
  qty: string;
  freeQty: string;
  rate: string;
  lineTotal: string;
  conversionFactor: string;
  invoicedQty: string;
  cancelledQty: string;
  remainingQty: string;
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  /** The quotation it started as (and still is, while a draft). */
  quotationNumber: string | null;
  validUntil: string | null;
  challanNumber: string | null;
  challanDate: string | null;
  status: OrderStatus;
  source: string;
  customerId: string;
  customer: { id: string; name: string; mobile: string | null } | null;
  taxableTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  grandTotal: string;
  notes: string | null;
  cancelReason: string | null;
  items: OrderItem[];
  invoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; grandTotal: string; status: string }>;
  history: Array<{ fromStatus: string | null; toStatus: string; note: string | null; createdAt: string }>;
  nextStatuses: OrderStatus[];
}

/** Which permission moves an order to a status (mirrors the API). */
const STATUS_PERMISSION: Record<string, string> = {
  pending: "order.update",
  confirmed: "order.confirm",
  packing: "packing.pack",
  packed: "packing.pack",
  dispatched: "dispatch.dispatch",
  delivered: "dispatch.deliver",
  cancelled: "order.cancel",
};
const INVOICEABLE = new Set<OrderStatus>(["confirmed", "packing", "packed", "dispatched", "delivered"]);

export function OrderViewPage({ orderId }: { orderId: string }) {
  const { t, money, number, dateMedium, dateTime } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [invoicing, setInvoicing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The quotation or the delivery challan, printed once it is on the page.
  const [printing, setPrinting] = useState<"quotation" | "delivery_challan" | null>(null);
  const q = useQuery({ queryKey: ["orders", "detail", orderId], queryFn: () => api.get<OrderDetail>(`/sales-orders/${orderId}`) });
  useEffect(() => {
    if (!printing) return;
    const timer = setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [printing]);

  if (q.isPending) return <Skeleton className="h-60 w-full" />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;

  const move = async (status: OrderStatus, note?: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/sales-orders/${o.id}/status`, { status, ...(note ? { note } : {}) });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: t(`status.order.${status}`), body: o.orderNumber });
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const quotation = o.status === "draft";
  // The challan is numbered the first time it is printed, the same after.
  const printChallan = async () => {
    setError(null);
    try {
      if (!o.challanNumber) {
        const fresh = await api.post<OrderDetail>(`/sales-orders/${o.id}/challan`, {});
        qc.setQueryData(["orders", "detail", orderId], fresh);
      }
      setPrinting("delivery_challan");
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  const canChallan = INVOICEABLE.has(o.status) && (allowed("order.update") || allowed("dispatch.dispatch"));

  const open = o.items.some((i) => Number(i.remainingQty) > 0);
  const moves = o.nextStatuses.filter((s) => s !== "cancelled" && allowed(STATUS_PERMISSION[s] ?? "order.update"));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        back={<BackButton onClick={() => navigate({ name: "planned", module: "orders" })} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {o.orderNumber} <Badge tone={ORDER_TONE[o.status]}>{t(`status.order.${o.status}`)}</Badge>
          </span>
        }
        subtitle={[
          o.customer?.name ?? "",
          dateMedium(o.orderDate),
          quotation ? (o.validUntil ? t("orders.quotation.validUntilShort", { date: dateMedium(o.validUntil) }) : null) : t(`orders.sources.${o.source as "counter"}`),
          !quotation && o.quotationNumber ? t("orders.quotation.from", { number: o.quotationNumber }) : null,
          o.challanNumber ? t("orders.challan.short", { number: o.challanNumber }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            {quotation && (
              <Button icon={<Printer size={16} />} onClick={() => setPrinting("quotation")}>
                {t("orders.quotation.print")}
              </Button>
            )}
            {canChallan && (
              <Button icon={<Truck size={16} />} onClick={() => void printChallan()}>
                {t("orders.challan.print")}
              </Button>
            )}
            {o.nextStatuses.includes("cancelled") && allowed("order.cancel") && !cancelling && (
              <Button variant="ghost" icon={<Ban size={16} />} onClick={() => setCancelling(true)}>
                {t("orders.cancel")}
              </Button>
            )}
            {moves.map((s) => (
              <Button key={s} variant={s === "confirmed" || quotation ? "primary" : "secondary"} icon={s === "confirmed" || quotation ? <CheckCircle2 size={16} /> : undefined} disabled={busy} onClick={() => void move(s)}>
                {quotation ? t("orders.quotation.accept") : t(`orders.moveTo.${s as "confirmed"}`)}
              </Button>
            ))}
            {INVOICEABLE.has(o.status) && open && allowed("invoice.create") && (
              <Button variant="primary" icon={<Receipt size={16} />} onClick={() => setInvoicing(true)}>
                {t("orders.makeInvoice")}
              </Button>
            )}
          </>
        }
      />
      {error ? <ErrorNote error={error} /> : null}
      {o.status === "pending" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("orders.pendingHint")}</p>}
      {quotation && (
        <p className="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-[13px] text-ink-2">
          <FileText size={15} className="mt-0.5 shrink-0 text-info" />
          {t("orders.quotation.hint")}
        </p>
      )}
      {cancelling && (
        <Card className="flex flex-col gap-3 border-danger/40 p-4">
          <Field label={t("common.reason")} htmlFor="so-cancel" hint={t("orders.cancelHint")}>
            <Input id="so-cancel" autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void move("cancelled", reason.trim())}>
              {t("orders.confirmCancel")}
            </Button>
            <Button onClick={() => setCancelling(false)}>{t("common.back")}</Button>
          </div>
        </Card>
      )}
      {o.cancelReason && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {t("common.cancelled")}: {o.cancelReason}
        </p>
      )}

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
        <Stat label={t("common.total")} value={money(o.grandTotal)} />
        <Stat label={t("invoice.taxableValue")} value={money(o.taxableTotal)} />
        <Stat label={t("orders.deliveryDate")} value={o.expectedDeliveryDate ? dateMedium(o.expectedDeliveryDate) : "—"} />
        <Stat label={t("orders.invoices")} value={o.invoices.length} />
      </Card>

      <DataTable
        rows={o.items}
        rowKey={(i) => i.id}
        minWidth={720}
        columns={[
          { key: "product", header: t("invoice.product"), render: (i) => <span className="font-medium text-ink">{i.productName}</span> },
          {
            key: "ordered",
            header: t("orders.ordered"),
            align: "right",
            render: (i) => (
              <span>
                {number(i.qty)} {WORKSPACE.units.get(i.unitId) ?? ""}
                {Number(i.freeQty) > 0 && <span className="block text-[12px] text-good">+{number(i.freeQty)} {t("invoice.free")}</span>}
              </span>
            ),
          },
          { key: "invoiced", header: t("orders.invoiced"), align: "right", render: (i) => number(Number(i.invoicedQty) / Number(i.conversionFactor)) },
          {
            key: "left",
            header: t("orders.left"),
            align: "right",
            render: (i) => (Number(i.remainingQty) > 0 ? <span className="font-semibold text-ink">{number(i.remainingQty)}</span> : Number(i.cancelledQty) > 0 ? <span className="text-ink-3">{t("common.cancelled")}</span> : "—"),
          },
          { key: "rate", header: t("invoice.rate"), align: "right", render: (i) => money(i.rate) },
          { key: "total", header: t("invoice.amount"), align: "right", render: (i) => money(i.lineTotal) },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("orders.invoices")} />
          <div className="p-4 sm:px-5">
            {o.invoices.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("orders.noInvoices")}</p>
            ) : (
              <ul className="num divide-y divide-line text-[13.5px]">
                {o.invoices.map((inv) => (
                  <li key={inv.id}>
                    <button type="button" onClick={() => navigate({ name: "invoice-view", invoiceId: inv.id })} className="flex w-full items-center justify-between py-2 text-left hover:text-accent">
                      <span className={inv.status === "cancelled" ? "text-ink-3 line-through" : "text-ink"}>
                        {inv.invoiceNumber} · {dateMedium(inv.invoiceDate)}
                      </span>
                      <span className="font-medium">{money(inv.grandTotal)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("orders.history")} />
          <ul className="flex flex-col gap-2 p-4 text-[13px] sm:px-5">
            {o.history.map((h, i) => (
              <li key={i} className="flex items-start justify-between gap-3">
                <span className="text-ink">
                  {t(`status.order.${h.toStatus as OrderStatus}`)}
                  {h.note && <span className="block text-[12px] text-ink-3">{h.note}</span>}
                </span>
                <span className="num shrink-0 text-[12px] text-ink-3">{dateTime(h.createdAt)}</span>
              </li>
            ))}
            {o.notes && <li className="border-t border-line pt-2 text-ink-2">{o.notes}</li>}
          </ul>
        </Card>
      </div>
      <InvoiceOrderDialog order={o} open={invoicing} onOpenChange={setInvoicing} />
      {printing && (
        <PrintPortal>
          <InvoiceDocument invoice={printableFromOrder(o as unknown as ApiOrderForPrint, printing)} locale={(WORKSPACE.printLocale as LocaleCode) || "en"} />
        </PrintPortal>
      )}
    </div>
  );
}

/** Invoice what is still open (all of it by default, or less per line), optionally with a payment. */
function InvoiceOrderDialog({ order, open, onOpenChange }: { order: OrderDetail; open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money, number } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [paid, setPaid] = useState({ amount: "", method: "cash" as PaymentMethod });
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const open_ = order.items.filter((i) => Number(i.remainingQty) > 0);

  useEffect(() => {
    if (!open) return;
    setQty(Object.fromEntries(open_.map((i) => [i.id, String(Number(i.remainingQty))])));
    setPaid({ amount: "", method: "cash" });
    setKey(newIdempotencyKey());
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const bad = open_.some((i) => qty[i.id] && (!/^\d{1,12}(\.\d{1,3})?$/.test(qty[i.id]!) || Number(qty[i.id]) > Number(i.remainingQty)));
  const chosen = open_.filter((i) => Number(qty[i.id]) > 0);
  const everything = chosen.length === open_.length && chosen.every((i) => Number(qty[i.id]) === Number(i.remainingQty));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ id: string; invoiceNumber: string; grandTotal: string; warnings?: Array<{ code: string }> }>(
        `/sales-orders/${order.id}/invoice`,
        {
          ...(everything ? {} : { lines: chosen.map((i) => ({ orderLineId: i.id, qty: qty[i.id] })) }),
          ...(paid.amount && Number(paid.amount) > 0 ? { payment: { amount: paid.amount, method: paid.method } } : {}),
        },
        { idempotencyKey: key },
      );
      await Promise.all([refreshCatalog(), refreshCustomer(order.customerId)]).catch(() => undefined);
      invalidateMoney(qc);
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: t("invoice.saved", { number: res.invoiceNumber }), body: money(res.grandTotal) });
      onOpenChange(false);
      navigate({ name: "invoice-view", invoiceId: res.id });
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
      title={t("orders.makeInvoice")}
      description={t("orders.makeInvoiceHint")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || bad || !chosen.length} onClick={() => void save()}>
            {busy ? t("common.saving") : t("invoice.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                <th className="py-2 pl-3 font-medium">{t("invoice.product")}</th>
                <th className="py-2 pl-3 text-right font-medium">{t("orders.left")}</th>
                <th className="py-2 pr-3 pl-3 text-right font-medium">{t("orders.invoiceNow")}</th>
              </tr>
            </thead>
            <tbody className="num">
              {open_.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-b-0">
                  <td className="py-1.5 pl-3 text-ink">{i.productName}</td>
                  <td className="py-1.5 pl-3 text-right text-ink-2">
                    {number(i.remainingQty)} {WORKSPACE.units.get(i.unitId) ?? ""}
                  </td>
                  <td className="py-1.5 pr-3 pl-3">
                    <Input
                      inputSize="sm"
                      inputMode="decimal"
                      aria-label={`${t("orders.invoiceNow")} ${i.productName}`}
                      className="ml-auto w-24 [&_input]:text-right"
                      value={qty[i.id] ?? ""}
                      onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value.trim() }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("invoice.amountReceived")} htmlFor="so-paid" hint={t("common.optional")}>
            <Input id="so-paid" inputMode="decimal" leading={<span className="text-[13px]">₹</span>} value={paid.amount} onChange={(e) => setPaid((p) => ({ ...p, amount: e.target.value.trim() }))} />
          </Field>
          <Field label={t("common.method")} htmlFor="so-method">
            <Select id="so-method" value={paid.method} onChange={(e) => setPaid((p) => ({ ...p, method: e.target.value as PaymentMethod }))}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`paymentMethod.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
