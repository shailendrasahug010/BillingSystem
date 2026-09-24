import { amountInWords, type PaymentMethod } from "@vyapaar/core";
import { createTranslator, formatCurrency, formatDate, type LocaleCode } from "@vyapaar/i18n";
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
  const row = "flex justify-between gap-4 border-b border-dashed border-[#c9d2d3] py-1.5";
  return (
    <article className="mx-auto w-full max-w-[820px] bg-white p-6 text-[13px] leading-snug text-[#10201f] shadow-pop sm:p-8" style={{ fontFamily: "var(--font-sans)" }} lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#0b6e82] pb-3">
        <div className="min-w-0">
          <h2 className="text-[20px] leading-tight font-bold text-[#0b3b44]" style={{ fontFamily: "var(--font-display)" }}>
            {BUSINESS.name}
          </h2>
          {BUSINESS.address && <p>{BUSINESS.address}</p>}
          {BUSINESS.city && <p>{BUSINESS.city}</p>}
          {BUSINESS.phone && <p>{BUSINESS.phone}</p>}
          {BUSINESS.gstin && <p className="font-mono">GSTIN: {BUSINESS.gstin}</p>}
        </div>
        <div className="text-right">
          <p className="text-[17px] font-bold tracking-wide text-[#0b6e82]">{(p.direction === "in" ? t("receipt.title") : t("receipt.voucher")).toUpperCase()}</p>
          <p className="font-mono font-semibold">{p.paymentNumber}</p>
          <p>{formatDate(p.paymentDate)}</p>
          {p.status === "cancelled" && <p className="mt-1 font-bold text-[#b42318]">{t("status.document.cancelled").toUpperCase()}</p>}
        </div>
      </header>

      <div className="mt-4 flex flex-col">
        <div className={row}>
          <span className="text-[#4a5f62]">{p.direction === "in" ? t("receipt.receivedFrom") : t("receipt.paidTo")}</span>
          <span className="text-right font-semibold">{p.partyName}</span>
        </div>
        <div className={row}>
          <span className="text-[#4a5f62]">{t("receipt.amount")}</span>
          <span className="text-right text-[16px] font-bold">{m(p.amount)}</span>
        </div>
        <div className={row}>
          <span className="text-[#4a5f62]">{t("invoice.amountInWords")}</span>
          <span className="text-right">{amountInWords(p.amount, locale)}</span>
        </div>
        <div className={row}>
          <span className="text-[#4a5f62]">{t("receipt.mode")}</span>
          <span className="text-right">
            {t(`paymentMethod.${p.method}`)}
            {p.referenceNumber && ` · ${p.referenceNumber}`}
            {p.chequeDate && ` · ${formatDate(p.chequeDate)}`}
            {p.chequeBank && ` · ${p.chequeBank}`}
          </span>
        </div>
        {bills.length > 0 && (
          <div className={row}>
            <span className="text-[#4a5f62]">{t("receipt.against")}</span>
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
            <span className="text-[#4a5f62]">{t("receipt.onAccount")}</span>
            <span className="text-right">{m(p.unallocatedAmount)}</span>
          </div>
        )}
        {p.notes && <p className="mt-2 text-[#4a5f62]">{p.notes}</p>}
        {p.method === "cheque" && p.direction === "in" && <p className="mt-2 text-[11.5px] text-[#4a5f62]">{t("receipt.chequeNote")}</p>}
      </div>

      <footer className="mt-10 flex items-end justify-between gap-4 text-[12px]">
        <p className="text-[#4a5f62]">{t("receipt.computerGenerated")}</p>
        <div className="text-right">
          <p>{t("invoice.print.for", { business: BUSINESS.name })}</p>
          <p className="mt-8 border-t border-[#10201f] pt-1">{t("invoice.print.signatory")}</p>
        </div>
      </footer>
    </article>
  );
}
