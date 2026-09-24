import type { LocaleCode } from "@vyapaar/i18n";
import { ArrowLeft, Download, MessageCircle, Printer } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { customerById, INVOICES } from "../../data/mock";
import { useStoreVersion } from "../../data/store";
import { InvoiceDocument } from "./InvoiceDocument";

export function InvoiceViewPage({ invoiceId }: { invoiceId: string }) {
  const { t, locale, money } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  useStoreVersion();
  const [printLocale, setPrintLocale] = useState<LocaleCode>(locale);
  const invoice = INVOICES.find((i) => i.id === invoiceId);
  if (!invoice) return <EmptyState title={t("empty.generic")} />;
  const customer = customerById.get(invoice.customerId)!;
  const balance = invoice.total - invoice.paid;
  const status = balance <= 0.5 ? "paid" : invoice.paid > 0 ? "partial" : "unpaid";

  const print = () => {
    // Inside an embedded preview the browser refuses the print dialog; the installed app prints normally.
    if (window.self !== window.top) {
      toast({ tone: "info", title: t("common.print"), body: "Printing opens the system dialog in the installed app (web, Windows, Android)." });
      return;
    }
    window.print();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate({ name: "customer", customerId: customer.id })} className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink" aria-label={t("common.back")}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="font-mono text-[20px] font-semibold text-ink">{invoice.number}</h1>
            <p className="text-[13px] text-ink-3">
              {customer.businessName} · <span className="num">{money(invoice.total)}</span>
            </p>
          </div>
          <Badge tone={status === "paid" ? "good" : status === "partial" ? "warn" : "danger"} dot>
            {t(`status.payment.${status}`)}
          </Badge>
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
          <Button icon={<Printer size={16} />} onClick={print}>
            {t("common.print")}
          </Button>
          <Button icon={<Download size={16} />} onClick={() => toast({ tone: "info", title: "PDF", body: "The API renders this template to PDF (GET /invoices/:id/pdf)." })}>
            PDF
          </Button>
          <Button variant="primary" icon={<MessageCircle size={16} />} onClick={() => toast({ tone: "info", title: t("common.whatsapp"), body: "Sends the PDF link via the WhatsApp Business API adapter." })}>
            {t("common.share")}
          </Button>
        </div>
      </div>
      <div className="-mx-4 overflow-x-auto bg-surface-2 px-4 py-6 sm:mx-0 sm:rounded-[var(--radius-card)] sm:px-6">
        <InvoiceDocument invoice={invoice} locale={printLocale} />
      </div>
    </div>
  );
}
