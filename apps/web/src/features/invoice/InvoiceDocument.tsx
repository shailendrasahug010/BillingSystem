import { amountInWords, findState } from "@vyapaar/core";
import { createTranslator, formatAmount, formatCurrency, formatDate, type LocaleCode } from "@vyapaar/i18n";
import { BUSINESS, customerById, invoiceTotals, productById } from "../../data/mock";
import type { Invoice } from "../../data/types";

/**
 * Printable A4 tax invoice. It is paper, so it keeps a fixed black-on-white
 * look in both themes. The print language is chosen per invoice (a Hindi UI
 * can print English invoices and vice versa). In production the same template
 * renders to PDF on the server (headless Chromium, correct Devanagari shaping).
 */
export function InvoiceDocument({ invoice, locale }: { invoice: Invoice; locale: LocaleCode }) {
  const { t } = createTranslator(locale);
  const customer = customerById.get(invoice.customerId)!;
  const totals = invoiceTotals(invoice.lines, invoice.date, customer);
  const intra = customer.stateCode === BUSINESS.stateCode;
  const pos = findState(customer.stateCode);
  const stateName = (code: string) => {
    const s = findState(code);
    return s ? `${s.code} – ${locale === "hi" ? s.nameHi : s.name}` : code;
  };
  const m = (v: { toNumber(): number } | number) => formatCurrency(typeof v === "number" ? v : v.toNumber(), locale);
  const n = (v: { toNumber(): number } | number) => formatAmount(typeof v === "number" ? v : v.toNumber(), locale);
  const balance = invoice.total - invoice.paid;
  const stateLabel = pos?.component === "UTGST" ? "UTGST" : "SGST";

  const th = "border border-[#c9d2d3] bg-[#eef3f3] px-2 py-1.5 text-left font-semibold";
  const td = "border border-[#c9d2d3] px-2 py-1.5 align-top";

  return (
    <article
      className="mx-auto w-full max-w-[820px] bg-white p-6 text-[12px] leading-snug text-[#10201f] shadow-pop sm:p-8 print:shadow-none"
      style={{ fontFamily: "var(--font-sans)" }}
      lang={locale}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#0b6e82] pb-4">
        <div className="min-w-0">
          <h2 className="text-[22px] leading-tight font-bold text-[#0b3b44]" style={{ fontFamily: "var(--font-display)" }}>
            {BUSINESS.name}
          </h2>
          <p>{BUSINESS.address}</p>
          <p>{BUSINESS.city}</p>
          <p>
            {BUSINESS.phone} · {BUSINESS.email}
          </p>
          <p className="mt-1 font-mono font-medium">GSTIN: {BUSINESS.gstin}</p>
        </div>
        <div className="text-right">
          <p className="text-[18px] font-bold tracking-wide text-[#0b6e82]">{t("invoice.taxInvoice").toUpperCase()}</p>
          <p className="text-[11px] text-[#4a5f62]">{t("invoice.print.original")}</p>
          <table className="mt-2 ml-auto text-left text-[12px]">
            <tbody>
              <tr>
                <td className="pr-3 text-[#4a5f62]">{t("invoice.number")}</td>
                <td className="font-mono font-semibold">{invoice.number}</td>
              </tr>
              <tr>
                <td className="pr-3 text-[#4a5f62]">{t("invoice.date")}</td>
                <td>{formatDate(invoice.date)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-[#4a5f62]">{t("invoice.dueDate")}</td>
                <td>{formatDate(invoice.dueDate)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-[#4a5f62]">{t("invoice.placeOfSupply")}</td>
                <td>{stateName(customer.stateCode)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-[#4a5f62]">{t("invoice.print.reverseCharge")}</td>
                <td>{t("invoice.print.no")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 border-b border-[#c9d2d3] py-3 sm:grid-cols-2">
        {[t("invoice.print.billTo"), t("invoice.print.shipTo")].map((label) => (
          <div key={label}>
            <p className="text-[10.5px] font-semibold tracking-wider text-[#4a5f62] uppercase">{label}</p>
            <p className="text-[13px] font-semibold">{customer.businessName}</p>
            <p>{customer.name}</p>
            <p>
              {customer.address} {customer.pincode}
            </p>
            <p>{stateName(customer.stateCode)}</p>
            {customer.gstin && <p className="font-mono">GSTIN: {customer.gstin}</p>}
          </div>
        ))}
      </section>

      <div className="scroll-x mt-3">
        <table className="w-full min-w-[640px] border-collapse text-[11.5px]">
          <thead>
            <tr>
              <th className={th}>{t("invoice.print.sn")}</th>
              <th className={th}>{t("invoice.print.description")}</th>
              <th className={th}>{t("invoice.hsn")}</th>
              <th className={`${th} text-right`}>{t("invoice.qty")}</th>
              <th className={`${th} text-right`}>{t("invoice.rate")}</th>
              <th className={`${th} text-right`}>{t("invoice.discount")}</th>
              <th className={`${th} text-right`}>{t("invoice.taxable")}</th>
              <th className={`${th} text-right`}>GST</th>
              {intra ? (
                <>
                  <th className={`${th} text-right`}>CGST</th>
                  <th className={`${th} text-right`}>{stateLabel}</th>
                </>
              ) : (
                <th className={`${th} text-right`}>IGST</th>
              )}
              <th className={`${th} text-right`}>{t("invoice.amount")}</th>
            </tr>
          </thead>
          <tbody className="num">
            {invoice.lines.map((l, i) => {
              const p = productById.get(l.productId)!;
              const r = totals.lines[i]!;
              return (
                <tr key={`${l.productId}-${i}`}>
                  <td className={td}>{i + 1}</td>
                  <td className={td}>
                    {locale === "hi" ? p.nameHi : p.name}
                    {p.batch && (
                      <span className="block text-[10.5px] text-[#4a5f62]">
                        {t("invoice.batch")} {p.batch.number} · {t("invoice.expiry")} {formatDate(p.batch.expiry)}
                      </span>
                    )}
                  </td>
                  <td className={`${td} font-mono`}>{p.hsn}</td>
                  <td className={`${td} text-right`}>
                    {l.qty} {p.unit}
                  </td>
                  <td className={`${td} text-right`}>{n(l.rate)}</td>
                  <td className={`${td} text-right`}>{l.discountPercent ? `${l.discountPercent}%` : "—"}</td>
                  <td className={`${td} text-right`}>{n(r.taxable)}</td>
                  <td className={`${td} text-right`}>{r.gstRate.toNumber()}%</td>
                  {intra ? (
                    <>
                      <td className={`${td} text-right`}>{n(r.cgst)}</td>
                      <td className={`${td} text-right`}>{n(r.sgst)}</td>
                    </>
                  ) : (
                    <td className={`${td} text-right`}>{n(r.igst)}</td>
                  )}
                  <td className={`${td} text-right font-semibold`}>{n(r.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_260px]">
        <div className="flex flex-col gap-3">
          <div className="scroll-x">
            <p className="mb-1 text-[10.5px] font-semibold tracking-wider text-[#4a5f62] uppercase">{t("invoice.print.taxSummary")}</p>
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className={th}>HSN</th>
                  <th className={`${th} text-right`}>{t("invoice.taxable")}</th>
                  <th className={`${th} text-right`}>GST</th>
                  {intra ? (
                    <>
                      <th className={`${th} text-right`}>CGST</th>
                      <th className={`${th} text-right`}>{stateLabel}</th>
                    </>
                  ) : (
                    <th className={`${th} text-right`}>IGST</th>
                  )}
                </tr>
              </thead>
              <tbody className="num">
                {totals.hsnSummary.map((h) => (
                  <tr key={`${h.hsnCode}-${h.gstRate.toString()}`}>
                    <td className={`${td} font-mono`}>{h.hsnCode}</td>
                    <td className={`${td} text-right`}>{n(h.taxable)}</td>
                    <td className={`${td} text-right`}>{h.gstRate.toNumber()}%</td>
                    {intra ? (
                      <>
                        <td className={`${td} text-right`}>{n(h.cgst)}</td>
                        <td className={`${td} text-right`}>{n(h.sgst)}</td>
                      </>
                    ) : (
                      <td className={`${td} text-right`}>{n(h.igst)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <p className="text-[10.5px] font-semibold tracking-wider text-[#4a5f62] uppercase">{t("invoice.amountInWords")}</p>
            <p className="font-medium">{amountInWords(totals.grandTotal, locale)}</p>
          </div>
          <div>
            <p className="text-[10.5px] font-semibold tracking-wider text-[#4a5f62] uppercase">{t("invoice.print.bankDetails")}</p>
            <p>
              {BUSINESS.bank.name} · A/c {BUSINESS.bank.account} · IFSC <span className="font-mono">{BUSINESS.bank.ifsc}</span>
            </p>
            <p>
              UPI: <span className="font-mono">{BUSINESS.bank.upi}</span>
            </p>
          </div>
        </div>
        <dl className="flex flex-col gap-1 text-[12px]">
          {[
            [t("invoice.taxableValue"), m(totals.taxableTotal)],
            ...(intra
              ? [
                  ["CGST", m(totals.cgstTotal)],
                  [stateLabel, m(totals.sgstTotal)],
                ]
              : [["IGST", m(totals.igstTotal)]]),
            ...(totals.cessTotal.gt(0) ? [[t("invoice.cess"), m(totals.cessTotal)]] : []),
            [t("invoice.roundOff"), m(totals.roundOff)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-[#4a5f62]">{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
          <div className="mt-1 flex justify-between gap-3 border-t-2 border-[#0b6e82] pt-1.5 text-[15px] font-bold">
            <dt>{t("invoice.grandTotal")}</dt>
            <dd className="num">{m(totals.grandTotal)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[#4a5f62]">{t("invoice.print.paid")}</dt>
            <dd className="num">{m(invoice.paid)}</dd>
          </div>
          <div className="flex justify-between gap-3 font-semibold">
            <dt>{t("invoice.balance")}</dt>
            <dd className="num">{m(Math.max(0, balance))}</dd>
          </div>
        </dl>
      </div>

      <footer className="mt-6 flex flex-wrap items-end justify-between gap-4 border-t border-[#c9d2d3] pt-3">
        <div className="max-w-md text-[10.5px] text-[#4a5f62]">
          <p className="font-semibold text-[#10201f]">{t("invoice.print.terms")}</p>
          <p>1. Goods once sold will be taken back only as per company return policy. 2. Interest @18% p.a. on payments beyond the due date. 3. Subject to Bhopal jurisdiction.</p>
          <p className="mt-2">{t("invoice.print.computerGenerated")}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{t("invoice.print.for", { business: BUSINESS.name })}</p>
          <div className="h-10" />
          <p className="text-[#4a5f62]">{t("invoice.print.signatory")}</p>
        </div>
      </footer>
    </article>
  );
}
