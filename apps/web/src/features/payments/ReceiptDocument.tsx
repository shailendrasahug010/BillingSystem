import { amountInWords, type PaymentMethod } from "@vyapaar/core";
import { createTranslator, formatCurrency, formatDate, type LocaleCode } from "@vyapaar/i18n";
import { FirmHeader, MadeWithDigitalBahi } from "../../components/brand/Brand";
import { BUSINESS } from "../../data/db";

export interface PrintablePayment {
  paymentNumber: string;
  paymentDate: string;
  direction: "in" | "out";
  amount: string;
  method: PaymentMethod;
  referenceNumber: string | null;
  chequeDate: string | null;
  chequeBank: string | null;
  unallocatedAmount: string;
  status: "posted" | "cancelled";
  notes: string | null;
  partyName: string;
  allocations: Array<{ id: string; documentNumber: string | null; amount: string; reversedAt: string | null }>;
}

/**
 * Money receipt (customer paid us) or payment voucher (we paid a supplier),
 * half an A4 page, in the chosen print language. Paper look in both themes.
 */
export function ReceiptDocument({ payment: p, locale }: { payment: PrintablePayment; locale: LocaleCode }) {
  const { t } = createTranslator(locale);
  const m = (v: string | number) => formatCurrency(v, locale);
  const bills = p.allocations.filter((a) => !a.reversedAt);
  const row = "flex justify-between gap-4 border-b border-dashed border-[#c8d1e0] py-1.5";
  return (
    <article className="mx-auto w-full max-w-[820px] bg-white p-6 text-[13px] leading-snug text-[#0e1a33] shadow-pop sm:p-8" style={{ fontFamily: "var(--font-sans)" }} lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-3">
        <FirmHeader />
        <div className="text-right">
          <p className="text-[17px] font-bold tracking-wide text-[#1450b4]">{(p.direction === "in" ? t("receipt.title") : t("receipt.voucher")).toUpperCase()}</p>
          <p className="font-mono font-semibold">{p.paymentNumber}</p>
          <p>{formatDate(p.paymentDate)}</p>
          {p.status === "cancelled" && <p className="mt-1 font-bold text-[#b42318]">{t("status.document.cancelled").toUpperCase()}</p>}
        </div>
      </header>

      <div className="mt-4 flex flex-col">
        <div className={row}>
          <span className="text-[#4a5570]">{p.direction === "in" ? t("receipt.receivedFrom") : t("receipt.paidTo")}</span>
          <span className="text-right font-semibold">{p.partyName}</span>
        </div>
        <div className={row}>
          <span className="text-[#4a5570]">{t("receipt.amount")}</span>
          <span className="text-right text-[16px] font-bold">{m(p.amount)}</span>
        </div>
        <div className={row}>
          <span className="text-[#4a5570]">{t("invoice.amountInWords")}</span>
          <span className="text-right">{amountInWords(p.amount, locale)}</span>
        </div>
        <div className={row}>
          <span className="text-[#4a5570]">{t("receipt.mode")}</span>
          <span className="text-right">
            {t(`paymentMethod.${p.method}`)}
            {p.referenceNumber && ` · ${p.referenceNumber}`}
            {p.chequeDate && ` · ${formatDate(p.chequeDate)}`}
            {p.chequeBank && ` · ${p.chequeBank}`}
          </span>
        </div>
        {bills.length > 0 && (
          <div className={row}>
            <span className="text-[#4a5570]">{t("receipt.against")}</span>
            <span className="text-right">
              {bills.map((a) => (
                <span key={a.id} className="block">
                  {a.documentNumber ?? "—"}: {m(a.amount)}
                </span>
              ))}
            </span>
          </div>
        )}
        {Number(p.unallocatedAmount) > 0 && (
          <div className={row}>
            <span className="text-[#4a5570]">{t("receipt.onAccount")}</span>
            <span className="text-right">{m(p.unallocatedAmount)}</span>
          </div>
        )}
        {p.notes && <p className="mt-2 text-[#4a5570]">{p.notes}</p>}
        {p.method === "cheque" && p.direction === "in" && <p className="mt-2 text-[11.5px] text-[#4a5570]">{t("receipt.chequeNote")}</p>}
      </div>

      <footer className="mt-10 flex items-end justify-between gap-4 text-[12px]">
        <p className="text-[#4a5570]">{t("receipt.computerGenerated")}</p>
        <div className="text-right">
          <p>{t("invoice.print.for", { business: BUSINESS.name })}</p>
          <p className="mt-8 border-t border-[#0e1a33] pt-1">{t("invoice.print.signatory")}</p>
        </div>
      </footer>
      <MadeWithDigitalBahi />
    </article>
  );
}
