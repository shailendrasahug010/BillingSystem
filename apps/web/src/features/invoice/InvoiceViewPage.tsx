import { createTranslator, formatCurrency, formatDate, translateError, type LocaleCode } from "@digitalbahi/i18n";
import { ArrowLeft, Ban, CloudOff, Copy, Printer, SearchX, Wallet } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorState, Segmented } from "../../components/ui/misc";
import { SendButton } from "../../components/messaging/SendDialog";
import { PdfActions } from "../../components/ui/PdfActions";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { allowed, BUSINESS, customerById, INVOICES, WORKSPACE } from "../../data/db";
import { LIVE } from "../../data/source";
import { useStoreVersion } from "../../data/store";
import { serverOrDevice } from "../../offline/documents";
import { api, ApiError } from "../../lib/api";
import { shareOnWhatsApp } from "../../lib/share";
import { printableFromApi, printableFromDemo, type ApiInvoice, type PrintableInvoice } from "./printable";
import { EMBEDDED } from "../../lib/embedded";
import { findOfflineBill, kindOf, useOffline, type CancelEntry } from "../../offline/sync";
import { ReturnsCard, type ReturnRow } from "../notes/NoteDialog";
import { InvoiceDocument } from "./InvoiceDocument";
import { InvoiceStatusBadge } from "./InvoicesPage";
import { EInvoiceCard } from "./EInvoiceCard";
import { ShippingBillCard } from "./ShippingBillCard";
import { InvoiceReviewCard } from "./InvoiceReview";
import { CancelInvoiceDialog, type CancellableBill } from "./CancelInvoiceDialog";
import { ThermalPrintButton } from "../../components/thermal/ThermalPrint";
import { invoiceReceipt } from "../../lib/thermal/receipts";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";
import { copyBill, type CopiedLine } from "./copyBill";
import { RepeatBillButton } from "./RepeatBill";
import { PaymentDialog } from "../payments/PaymentDialog";
import { loadKeptDraft, type KeptDraft } from "./keptDraft";

/** Bills already sent to the printer from Save & print (going back to one does not print it again). */
const printed = new Set<string>();

export function InvoiceViewPage({ invoiceId, print = false }: { invoiceId: string; print?: boolean }) {
  const i18n = useI18n();
  const { t, locale, money } = i18n;
  const { navigate } = useRouter();
  useStoreVersion();
  const [printLocale, setPrintLocale] = useState<LocaleCode>(LIVE ? (WORKSPACE.printLocale as LocaleCode) || locale : locale);
  // A bill made offline ("offline:<key>") prints from the copy on this device until the server has it.
  const offlineKey = invoiceId.startsWith("offline:") ? invoiceId.slice("offline:".length) : null;
  const offline = useOffline();
  const [cancelling, setCancelling] = useState(false);
  const [collecting, setCollecting] = useState(false);
  // Copying over a bill left half made asks first.
  const [replacing, setReplacing] = useState<KeptDraft | null>(null);
  const kept = offlineKey ? findOfflineBill(offlineKey) : {};
  const syncedId = kept.synced?.serverId;
  useEffect(() => {
    if (syncedId) navigate({ name: "invoice-view", invoiceId: syncedId }, { replace: true });
  }, [syncedId, navigate]);
  const live = useQuery({
    queryKey: ["invoice-raw", invoiceId],
    // From the server, or the copy kept on this device when there is no connection.
    queryFn: () => serverOrDevice("invoice", invoiceId, () => api.get<ApiInvoice & { returns: ReturnRow[] }>(`/invoices/${invoiceId}`)),
    enabled: LIVE && !offlineKey,
    networkMode: "always",
  });
  const deviceCopyAt = live.data?.deviceCopyAt;
  const demo = LIVE ? undefined : INVOICES.find((i) => i.id === invoiceId);
  const invoice: PrintableInvoice | undefined = offlineKey ? kept.entry?.printable : LIVE ? live.data && printableFromApi(live.data) : demo && printableFromDemo(demo);
  // Save & print: the print dialog once the bill is on screen, with its fonts.
  const shown = Boolean(invoice);
  useEffect(() => {
    if (!print || !shown || printed.has(invoiceId) || EMBEDDED || !allowed("invoice.print")) return;
    let active = true;
    void document.fonts.ready.then(() =>
      setTimeout(() => {
        if (!active || printed.has(invoiceId)) return;
        printed.add(invoiceId);
        window.print();
      }, 150),
    );
    return () => {
      active = false;
    };
  }, [print, shown, invoiceId]);
  if (LIVE && !offlineKey && live.isPending) return <p className="text-[14px] text-ink-3" role="status">{t("common.loading")}</p>;
  if (!invoice) {
    // Not found, or (with no copy on this device) could not be loaded: say which, and how to go on.
    const missing = !live.error || (live.error instanceof ApiError && live.error.status === 404);
    return missing ? (
      <EmptyState icon={<SearchX size={24} />} title={t("invoice.notFound")} hint={t("invoice.notFoundHint")} action={<Button onClick={() => navigate({ name: "invoices" })}>{t("invoice.backToList")}</Button>} />
    ) : (
      <ErrorState title={t("empty.error")} hint={translateError(i18n, live.error instanceof ApiError ? live.error : null)} retryLabel={t("common.retry")} onRetry={() => void live.refetch()} />
    );
  }
  const status = invoice.status;
  // An unpaid or part-paid bill takes its payment right here, against this bill first.
  const collectable = LIVE && !offlineKey && Boolean(live.data) && status !== "cancelled" && invoice.balance > 0.5 && allowed("payment.collect");
  const tr = createTranslator(printLocale).t;
  const m = (v: number) => formatCurrency(v, printLocale);
  const shareText = tr(invoice.balance > 0 && status !== "cancelled" ? "share.invoiceDue" : "share.invoice", {
    party: invoice.buyer.businessName,
    number: invoice.number,
    date: formatDate(invoice.date),
    amount: m(invoice.grandTotal),
    balance: m(invoice.balance),
    due: formatDate(invoice.dueDate),
    business: BUSINESS.name,
  });
  const mobile = customerById.get(invoice.customerId)?.mobile;
  // Cancelled on this device and not sent yet.
  const cancelWaiting = offline.entries.some((e) => kindOf(e) === "invoice-cancel" && (e as CancelEntry).documentId === (offlineKey ?? invoice.id));
  const cancellable: CancellableBill | null = !LIVE || status === "cancelled" || cancelWaiting || !allowed("invoice.cancel")
    ? null
    : offlineKey && kept.entry
      ? { id: offlineKey, number: kept.entry.number, customerId: kept.entry.customerId, customerName: kept.entry.customerName, grandTotal: kept.entry.total, stock: kept.entry.stock, notSent: true }
      : live.data
        ? {
            id: live.data.id,
            number: live.data.invoiceNumber,
            customerId: live.data.customerId,
            customerName: live.data.partyName,
            grandTotal: Number(live.data.grandTotal),
            stock: live.data.items.map((i) => ({ productId: i.productId, qty: Number(i.qtyBase ?? i.qty) + Number(i.freeQty ?? 0) * Number(i.conversionFactor ?? 1) })),
            notSent: false,
          }
        : null;

  // What the bill sold, to start a new bill from (the server's bill, or the demo's).
  const copyLines: CopiedLine[] | null = !allowed("invoice.create")
    ? null
    : LIVE
      ? (live.data?.items.map((i) => ({ productId: i.productId, unitId: i.unitId, qty: Number(i.qty), freeQty: Number(i.freeQty ?? 0), rate: Number(i.rate), discountPercent: Number(i.discountPercent) })) ?? null)
      : (demo?.lines.map((l) => ({ productId: l.productId, unitId: null, qty: l.qty, rate: l.rate, discountPercent: l.discountPercent })) ?? null);
  const openCopy = () => {
    if (!copyLines) return;
    setReplacing(null);
    copyBill(invoice.number, invoice.customerId, copyLines);
    navigate({ name: "invoice-new", customerId: invoice.customerId });
  };
  const startCopy = () =>
    void loadKeptDraft()
      .catch(() => null)
      .then((kept) => (kept && kept.draft.lines.length > 0 ? setReplacing(kept) : openCopy()));

  return (
    <div className="flex flex-col gap-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate({ name: "customer", customerId: invoice.customerId })} className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink" aria-label={t("common.back")}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="font-mono text-[20px] font-semibold text-ink">{invoice.number}</h1>
            <p className="text-[13px] text-ink-3">
              {invoice.buyer.businessName} · <span className="num">{money(invoice.grandTotal)}</span>
            </p>
          </div>
          {/* The same chip as in the list of bills: due soon, overdue, paid... */}
          <InvoiceStatusBadge
            row={{
              status: status === "cancelled" ? "cancelled" : "posted",
              paymentStatus: status === "cancelled" ? "unpaid" : status,
              dueDate: invoice.dueDate || null,
              balanceDue: String(invoice.balance),
            }}
          />
          {invoice.zeroRated && <Badge tone="accent">{t(`invoice.export.types.${invoice.zeroRated.type}`)}</Badge>}
          {offlineKey && (
            <Badge tone="warn" icon={<CloudOff size={13} />}>
              {kept.entry?.status === "failed" ? t("offline.failed") : t("offline.notSynced")}
            </Badge>
          )}
          {deviceCopyAt && (
            <Badge tone="warn" icon={<CloudOff size={13} />}>
              {t("offline.deviceCopy")}
            </Badge>
          )}
          {cancelWaiting && (
            <Badge tone="warn" icon={<CloudOff size={13} />}>
              {t("offline.cancelWaiting")}
            </Badge>
          )}
          {live.data?.reviewStatus === "needs_review" && (
            <Badge tone="warn" icon={<CloudOff size={13} />}>
              {t("invoice.review.badge")}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            label={t("settings.language")}
            value={printLocale}
            onChange={setPrintLocale}
            options={[
              { value: "en", label: "English" },
              { value: "hi", label: "हिन्दी" },
            ]}
          />
          {collectable && (
            <Button icon={<Wallet size={16} />} onClick={() => setCollecting(true)}>
              {t("dashboard.actions.receivePayment")}
            </Button>
          )}
          {copyLines && copyLines.length > 0 && (
            <Button icon={<Copy size={16} />} title={t("invoice.copy.title")} onClick={startCopy}>
              {t("invoice.copy.button")}
            </Button>
          )}
          {LIVE && !offlineKey && !deviceCopyAt && live.data && live.data.status === "posted" && !live.data.zeroRatedType && allowed("invoice.create") && (
            <RepeatBillButton invoiceId={live.data.id} number={live.data.invoiceNumber} />
          )}
          {cancellable && (
            <Button variant="ghost" icon={<Ban size={16} />} onClick={() => setCancelling(true)}>
              {t("invoice.cancel.button")}
            </Button>
          )}
          {/* Embedded previews cannot print or download; the installed app and the web app can. */}
          {!EMBEDDED && allowed("invoice.print") && (
            <Button icon={<Printer size={16} />} title={t("share.pdfHint")} onClick={() => window.print()}>
              {t("share.printPdf")}
            </Button>
          )}
          {/* A small Bluetooth receipt printer (shown where the device can reach one). */}
          {!EMBEDDED && allowed("invoice.print") && <ThermalPrintButton receipt={() => invoiceReceipt(invoice, printLocale)} />}
          {/* The PDF is made on the server; a bill still waiting on this device shares as text. */}
          {LIVE && !offlineKey && !deviceCopyAt ? (
            <>
              {(allowed("invoice.print") || allowed("invoice.share")) && <PdfActions path={`/invoices/${invoice.id}/pdf`} locale={printLocale} number={invoice.number} shareText={shareText} mobile={mobile} primaryShare />}
              <SendButton documentType="invoice" documentId={invoice.id} number={invoice.number} party={{ name: invoice.buyer.businessName, mobile}} locale={printLocale} />
            </>
          ) : (
            allowed("invoice.share") && (
              <Button variant="primary" icon={<WhatsAppIcon size={16} mono />} onClick={() => shareOnWhatsApp(shareText, mobile)}>
                {t("common.whatsapp")}
              </Button>
            )
          )}
        </div>
      </div>
      {LIVE && live.data?.reviewStatus && !deviceCopyAt && (
        <div className="no-print">
          <InvoiceReviewCard invoice={live.data} cancelled={status === "cancelled"} />
        </div>
      )}
      {LIVE && live.data && !deviceCopyAt && (
        <div className="no-print">
          <EInvoiceCard invoice={live.data} cancelled={status === "cancelled"} />
        </div>
      )}
      {LIVE && live.data?.zeroRatedType?.startsWith("EXP") && !deviceCopyAt && (
        <div className="no-print">
          <ShippingBillCard invoice={live.data} cancelled={status === "cancelled"} />
        </div>
      )}
      <div className="-mx-4 overflow-x-auto bg-surface-2 px-4 py-6 sm:mx-0 sm:rounded-[var(--radius-card)] sm:px-6">
        <InvoiceDocument invoice={invoice} locale={printLocale} />
      </div>
      {LIVE && live.data && (
        <div className="no-print">
          <ReturnsCard
            kind="sale"
            documentId={invoice.id}
            documentNumber={invoice.number}
            returns={live.data.returns ?? []}
            canReturn={status !== "cancelled" && !cancelWaiting}
            deviceCopy={Boolean(deviceCopyAt)}
            party={{ id: live.data.customerId, name: live.data.partyName }}
            totals={{ grandTotal: Number(live.data.grandTotal), taxable: Number(live.data.taxableTotal) }}
          />
        </div>
      )}
      {cancellable && <CancelInvoiceDialog bill={cancellable} open={cancelling} onOpenChange={setCancelling} />}
      {collectable && live.data && (
        <PaymentDialog direction="in" partyId={live.data.customerId} initialAmount={invoice.balance.toFixed(2)} documentId={live.data.id} open={collecting} onOpenChange={setCollecting} />
      )}
      <Dialog
        open={replacing !== null}
        onOpenChange={(v) => !v && setReplacing(null)}
        title={t("invoice.copy.replaceTitle")}
        description={t("invoice.copy.replaceBody", {
          bill: [replacing?.draft.customerId ? customerById.get(replacing.draft.customerId)?.businessName : null, t("common.items", { count: replacing?.draft.lines.length ?? 0 })].filter(Boolean).join(" · "),
        })}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <>
            <Button onClick={() => setReplacing(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" icon={<Copy size={16} />} onClick={openCopy}>
              {t("invoice.copy.button")}
            </Button>
          </>
        }
      />
      <PrintPortal>
        <InvoiceDocument invoice={invoice} locale={printLocale} />
      </PrintPortal>
    </div>
  );
}
