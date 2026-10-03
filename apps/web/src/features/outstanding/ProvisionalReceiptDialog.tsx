import { Printer } from "lucide-react";
import { createTranslator, formatCurrency, formatDate, type LocaleCode } from "@digitalbahi/i18n";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Stat } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { BUSINESS, WORKSPACE } from "../../data/db";
import { shareOnWhatsApp, whatsappNumber } from "../../lib/share";
import type { SavedPayment } from "../payments/PaymentDialog";
import { ReceiptDocument, type PrintablePayment } from "../payments/ReceiptDocument";
import { ThermalPrintButton } from "../../components/thermal/ThermalPrint";
import { paymentReceipt } from "../../lib/thermal/receipts";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";

type Kept = Extract<SavedPayment, { offline: unknown }>["offline"];

/**
 * A payment taken without a connection: the customer can have a receipt now
 * (printed, or as a WhatsApp message) marked provisional; the numbered one
 * comes once the phone syncs.
 */
export function ProvisionalReceiptDialog({ payment, mobile, onClose }: { payment: Kept | null; mobile: string | null; onClose(): void }) {
  const { t, money, date, locale } = useI18n();
  const printLocale = ((WORKSPACE.printLocale as LocaleCode) || locale) as LocaleCode;
  if (!payment) return null;
  const pending = createTranslator(printLocale).t("collect.pendingNumber");
  const printable: PrintablePayment = {
    paymentNumber: pending,
    paymentDate: payment.date,
    direction: "in",
    amount: payment.amount.toFixed(2),
    method: payment.method,
    referenceNumber: payment.referenceNumber,
    chequeDate: null,
    chequeBank: null,
    unallocatedAmount: "0",
    status: "posted",
    notes: createTranslator(printLocale).t("collect.provisional"),
    partyName: payment.partyName,
    allocations: [],
  };
  const share = () => {
    const tr = createTranslator(printLocale).t;
    const text = tr("share.receipt", {
      party: payment.partyName,
      amount: formatCurrency(payment.amount, printLocale),
      method: tr(`paymentMethod.${payment.method}`) + (payment.referenceNumber ? ` (${payment.referenceNumber})` : ""),
      date: formatDate(payment.date),
      number: pending,
      bills: "—",
      business: BUSINESS.name,
    });
    shareOnWhatsApp(`${tr("collect.provisional")}: ${text}`, mobile);
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={t("collect.provisional")}
      description={`${payment.partyName} · ${date(payment.date)}`}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button icon={<Printer size={16} />} onClick={() => window.print()}>
            {t("receipt.print")}
          </Button>
          <ThermalPrintButton receipt={() => paymentReceipt(printable, printLocale)} />
          <Button icon={<WhatsAppIcon size={16} />} disabled={!whatsappNumber(mobile)} onClick={share}>
            {t("collect.shareReceipt")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.done")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("collect.provisionalHint")}</p>
        <div className="grid grid-cols-2 gap-4">
          <Stat label={t("common.amount")} value={money(payment.amount)} tone="good" />
          <Stat label={t("common.method")} value={t(`paymentMethod.${payment.method}`)} />
          {payment.referenceNumber && <Stat label={t("payment.reference")} value={payment.referenceNumber} />}
        </div>
      </div>
      <PrintPortal>
        <ReceiptDocument locale={printLocale} payment={printable} />
      </PrintPortal>
    </Dialog>
  );
}
