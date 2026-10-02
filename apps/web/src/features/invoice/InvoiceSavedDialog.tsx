import { Check, CircleCheck, CloudOff, Copy, Eye, Plus, Printer, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { allowed } from "../../data/db";
import { shareOnWhatsApp } from "../../lib/share";

/** A bill just saved, for the popup that says so. */
export interface SavedNotice {
  id: string;
  number: string;
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
 * WhatsApp to the customer, or the bill itself. The bill screen behind is
 * already empty for the next one.
 */
export function InvoiceSavedDialog({ notice, onClose, onNext }: { notice: SavedNotice | null; onClose(): void; onNext(): void }) {
  const { t, money } = useI18n();
  const { navigate } = useRouter();
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  const balance = notice ? Math.max(0, notice.total - notice.paid) : 0;
  const go = (print: boolean) => {
    if (!notice) return;
    onClose();
    navigate({ name: "invoice-view", invoiceId: notice.id, ...(print ? { print: true } : {}) });
  };
  return (
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
        onNext();
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
          <span className="flex size-14 items-center justify-center rounded-full bg-good-soft text-good" aria-hidden>
            <CircleCheck size={32} />
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
                <Button className="flex-1" variant={notice.share ? "primary" : "secondary"} icon={<WhatsAppIcon size={17} mono={notice.share} />} onClick={() => shareOnWhatsApp(notice.shareText, notice.mobile)} autoFocus={notice.share}>
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
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
