import { Check, CircleCheck, CloudOff, Copy, Eye, Plus, Printer, TriangleAlert, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toast";
import { allowed, WORKSPACE } from "../../data/db";
import { LIVE } from "../../data/source";
import { api } from "../../lib/api";
import { whatsAppWithPdf } from "../../lib/sendPdf";
import { pdfFileName, shareOnWhatsApp } from "../../lib/share";
import { PaymentDialog } from "../payments/PaymentDialog";

/** A bill just saved, for the popup that says so. */
export interface SavedNotice {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  mobile: string | null;
  total: number;
  paid: number;
  /** Kept on this device until it reaches the server. */
  offline: boolean;
  /** What the server warned about (stock, credit), in words. */
  warning: string | null;
  /** The bill as a WhatsApp message. */
  shareText: string;
  /** Saved with the WhatsApp button: the message comes first. */
  share: boolean;
}

/**
 * Says a new bill was saved, with what comes next: a new bill (Enter), print,
 * WhatsApp to the customer with the bill's PDF, or the bill itself. The bill
 * screen behind is already empty for the next one.
 */
export function InvoiceSavedDialog({ notice, onClose, onNext }: { notice: SavedNotice | null; onClose(): void; onNext(): void }) {
  const { t, money } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  // The money for this bill, taken from the popup: the popup closes and the payment opens against the bill.
  const [collect, setCollect] = useState<{ customerId: string; documentId: string; amount: string } | null>(null);
  const collecting = useRef(false);
  collecting.current = collect !== null;
  const text = useRef<HTMLTextAreaElement>(null);
  // The PDF is made by the server: none yet for a bill still waiting on this device (or in the demo).
  const withPdf = LIVE && notice !== null && !notice.offline;
  const pdf = useRef<{ id: string; blob: Promise<Blob> } | null>(null);
  const loadPdf = () => {
    if (!notice) return Promise.reject(new Error("no bill"));
    if (pdf.current?.id !== notice.id) {
      const blob = api.blob(`/invoices/${notice.id}/pdf`, { locale: WORKSPACE.printLocale });
      // A failed fetch is tried again on the next tap.
      blob.catch(() => pdf.current?.blob === blob && (pdf.current = null));
      pdf.current = { id: notice.id, blob };
    }
    return pdf.current.blob;
  };
  // Saved with the WhatsApp button: the PDF is fetched at once, so the share sheet opens on the tap.
  useEffect(() => {
    if (withPdf && notice?.share) loadPdf().catch(() => undefined);
    // Once per bill: loadPdf is a new function each render and keeps its own cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.id, withPdf]);
  const sendOnWhatsApp = async () => {
    if (!notice) return;
    if (!withPdf) return shareOnWhatsApp(notice.shareText, notice.mobile);
    setSending(true);
    try {
      const name = pdfFileName(notice.number);
      if ((await whatsAppWithPdf(loadPdf, name, notice.shareText, notice.mobile)) === "downloaded") toast({ tone: "info", title: t("share.attachPdf", { name }) });
    } catch (e) {
      // The browser may want a fresh tap once the file is ready.
      if ((e as Error).name === "NotAllowedError") toast({ tone: "info", title: t("share.tapAgain") });
      else toast({ tone: "danger", title: t("share.pdfFailed") });
    } finally {
      setSending(false);
    }
  };
  const balance = notice ? Math.max(0, notice.total - notice.paid) : 0;
  const go = (print: boolean) => {
    if (!notice) return;
    onClose();
    navigate({ name: "invoice-view", invoiceId: notice.id, ...(print ? { print: true } : {}) });
  };
  return (
    <>
      <Dialog
        open={notice !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCopied(false);
            onClose();
          }
        }}
        onCloseAutoFocus={(e) => {
          // On to the next bill, not back to a button of the one just saved.
          e.preventDefault();
          // Not while the payment for this bill is open on top.
          if (!collecting.current) onNext();
        }}
        title={t("invoice.added")}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          notice && (
            <>
              {allowed("invoice.print") && (
                <Button className="flex-1" icon={<Printer size={16} />} onClick={() => go(true)}>
                  {t("common.print")}
                </Button>
              )}
              <Button className="flex-1" icon={<Eye size={16} />} onClick={() => go(false)}>
                {t("invoice.viewBill")}
              </Button>
              <Button className="basis-full" variant="primary" icon={<Plus size={16} />} onClick={onClose} autoFocus={!notice.share}>
                {t("invoice.nextBill")}
              </Button>
            </>
          )
        }
      >
        {notice && (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-good-soft text-good tick-ring" aria-hidden>
              <CircleCheck size={32} className="tick-draw" />
            </span>
            <div>
              <p className="font-mono text-[15px] font-semibold text-ink">{notice.number}</p>
              <p className="mt-0.5 text-[14px] text-ink-2">{notice.customerName}</p>
              <p className="num mt-1.5 font-display text-[24px] font-semibold text-ink">{money(notice.total)}</p>
              <p className="num text-[13px] text-ink-3">
                {notice.paid > 0 && `${t("invoice.receivedAmount", { amount: money(notice.paid) })} · `}
                {balance > 0 ? t("invoice.balanceAmount", { amount: money(balance) }) : t("invoice.paidInFull")}
              </p>
            </div>
            {LIVE && balance > 0.5 && allowed("payment.collect") && (
              <Button
                size="sm"
                icon={<Wallet size={16} />}
                onClick={() => {
                  collecting.current = true;
                setCollect({ customerId: notice.customerId, documentId: notice.id, amount: balance.toFixed(2) });
                  onClose();
                }}
              >
                {t("dashboard.actions.receivePayment")}
              </Button>
            )}
            {notice.offline && (
              <p className="flex w-full items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-left text-[12.5px] text-ink-2">
                <CloudOff size={15} className="mt-0.5 shrink-0" />
                {t("invoice.savedOffline")}
              </p>
            )}
            {notice.warning && (
              <p className="flex w-full items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-left text-[12.5px] text-warn" role="status">
                <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                {notice.warning}
              </p>
            )}
            {allowed("invoice.share") && (
              <div className="flex w-full flex-col gap-2">
                {notice.share && <textarea ref={text} readOnly value={notice.shareText} rows={7} aria-label={t("invoice.saveAndShare")} className="w-full rounded-lg border border-line bg-surface-2 p-2.5 text-left font-mono text-[12px] text-ink" />}
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    variant={notice.share ? "primary" : "secondary"}
                    icon={<WhatsAppIcon size={17} mono={notice.share} />}
                    disabled={sending}
                    onPointerEnter={() => withPdf && void loadPdf().catch(() => undefined)}
                    onFocus={() => withPdf && void loadPdf().catch(() => undefined)}
                    onClick={() => void sendOnWhatsApp()}
                    autoFocus={notice.share}
                  >
                    {t("invoice.sendOnWhatsApp")}
                  </Button>
                  {notice.share && (
                    <Button
                      icon={copied ? <Check size={16} /> : <Copy size={16} />}
                      onClick={() => {
                        // No clipboard on a page that is not secure (plain http at a network address): select it to copy by hand.
                        if (!navigator.clipboard) return text.current?.select();
                        navigator.clipboard
                          .writeText(notice.shareText)
                          .then(() => setCopied(true))
                          .catch(() => text.current?.select());
                      }}
                    >
                      {copied ? t("invoice.copied") : t("invoice.copyMessage")}
                    </Button>
                  )}
                </div>
                {(withPdf || notice.offline) && <p className="text-[12px] text-ink-3">{withPdf ? t("invoice.whatsAppWithPdf") : t("invoice.whatsAppPdfLater")}</p>}
              </div>
            )}
          </div>
        )}
      </Dialog>
      {collect && (
        <PaymentDialog
          direction="in"
          partyId={collect.customerId}
          initialAmount={collect.amount}
          documentId={collect.documentId}
          open
          onOpenChange={(v) => {
            if (v) return;
            setCollect(null);
            onNext();
          }}
        />
      )}
    </>
  );
}
