import type { LocaleCode } from "@vyapaar/i18n";
import { ArrowLeft, Download, MessageCircle, Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { INVOICES } from "../../data/db";
import { LIVE } from "../../data/source";
import { useStoreVersion } from "../../data/store";
import { api } from "../../lib/api";
import { printableFromApi, printableFromDemo, type ApiInvoice, type PrintableInvoice } from "./printable";
import { EMBEDDED } from "../../lib/embedded";
import { InvoiceDocument } from "./InvoiceDocument";

export function InvoiceViewPage({ invoiceId }: { invoiceId: string }) {
  const { t, locale, money } = useI18n();
  const { navigate } = useRouter();
  const toast = useToast();
  useStoreVersion();
  const [printLocale, setPrintLocale] = useState<LocaleCode>(locale);
  const live = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () => api.get<ApiInvoice>(`/invoices/${invoiceId}`).then(printableFromApi),
    enabled: LIVE,
  });
  const demo = LIVE ? undefined : INVOICES.find((i) => i.id === invoiceId);
  const invoice: PrintableInvoice | undefined = LIVE ? live.data : demo && printableFromDemo(demo);
  if (LIVE && live.isPending) return <p className="text-[14px] text-ink-3" role="status">{t("common.loading")}</p>;
  if (!invoice) return <EmptyState title={t("empty.generic")} />;
  const status = invoice.status;

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
          <Badge tone={status === "paid" ? "good" : status === "partial" ? "warn" : status === "cancelled" ? "neutral" : "danger"} dot>
            {status === "cancelled" ? t("status.document.cancelled") : t(`status.payment.${status}`)}
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
          {/* Embedded previews cannot print or download; the installed app and the web app can. */}
          {!EMBEDDED && (
            <Button icon={<Printer size={16} />} onClick={() => window.print()}>
              {t("common.print")}
            </Button>
          )}
          {!EMBEDDED && (
            <Button icon={<Download size={16} />} onClick={() => toast({ tone: "info", title: "PDF", body: "The API renders this template to PDF (GET /invoices/:id/pdf)." })}>
              PDF
            </Button>
          )}
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
