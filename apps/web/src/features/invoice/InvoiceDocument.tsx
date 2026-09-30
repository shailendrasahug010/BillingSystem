import { amountInWords, findState, zeroRatedDeclaration } from "@vyapaar/core";
import { createTranslator, formatAmount, formatCurrency, formatDate, type LocaleCode } from "@vyapaar/i18n";
import { FirmHeader, MadeWithDigitalBahi } from "../../components/brand/Brand";
import { BUSINESS, WORKSPACE } from "../../data/db";
import type { PrintableInvoice, ZeroRatedPrint } from "./printable";

/**
 * Printable A4 tax invoice. It is paper, so it keeps a fixed black-on-white
 * look in both themes. The print language is chosen per invoice (a Hindi UI
 * can print English invoices and vice versa). In production the same template
 * renders to PDF on the server (headless Chromium, correct Devanagari shaping).
 */
/** An export or SEZ invoice's declaration, in capitals as the rules word it, with the LUT and the shipping bill. */
function ZeroRatedLines({ z, locale }: { z: ZeroRatedPrint; locale: LocaleCode }) {
  const { t } = createTranslator(locale);
  const sb = [z.shippingBill.number, z.shippingBill.date ? formatDate(z.shippingBill.date) : null, z.shippingBill.portCode].filter(Boolean).join(" · ");
  const more = [z.lutArn ? t("invoice.export.lutLine", { arn: z.lutArn }) : null, sb ? t("invoice.export.shippingBillLine", { bill: sb }) : null].filter(Boolean);
  return (
    <section className="border-b border-[#c8d1e0] py-2.5 text-center">
      <p className="text-[11.5px] font-bold tracking-wide">{zeroRatedDeclaration(z.type)}</p>
      {more.length > 0 && <p className="mt-0.5 text-[11px] text-[#4a5570]">{more.join("   ·   ")}</p>}
    </section>
  );
}

export function InvoiceDocument({ invoice, locale }: { invoice: PrintableInvoice; locale: LocaleCode }) {
  const { t } = createTranslator(locale);
  const customer = invoice.buyer;
  const totals = invoice;
  const intra = invoice.intraState;
  const pos = findState(invoice.placeOfSupply);
  const stateName = (code: string) => {
    const s = findState(code);
    // Printed GST documents give the state code after the name, as bills usually do.
    return s ? t("common.stateWithCode", { name: locale === "hi" ? s.nameHi : s.name, code: s.code }) : code;
  };
  const m = (v: number) => formatCurrency(v, locale);
  const n = (v: number) => formatAmount(v, locale);
  const balance = invoice.balance;
  const stateLabel = pos?.component === "UTGST" ? "UTGST" : "SGST";
  const isNote = invoice.kind === "credit_note" || invoice.kind === "debit_note";

  const th = "border border-[#c8d1e0] bg-[#eef2f9] px-2 py-1.5 text-left font-semibold";
  const td = "border border-[#c8d1e0] px-2 py-1.5 align-top";

  return (
    <article
      className="mx-auto w-full max-w-[820px] bg-white p-6 text-[12px] leading-snug text-[#0e1a33] shadow-pop sm:p-8 print:shadow-none"
      style={{ fontFamily: "var(--font-sans)" }}
      lang={locale}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-4">
        <FirmHeader />
        <div className="text-right">
          <p className="text-[18px] font-bold tracking-wide text-[#1450b4]">
            {(isNote ? t(invoice.kind === "credit_note" ? "notes.creditNote" : "notes.debitNote") : invoice.billOfSupply ? t("invoice.billOfSupply") : t("invoice.taxInvoice")).toUpperCase()}
          </p>
          <p className="text-[11px] text-[#4a5570]">{t("invoice.print.original")}</p>
          <table className="mt-2 ml-auto text-left text-[12px]">
            <tbody>
              <tr>
                <td className="pr-3 text-[#4a5570]">{isNote ? t("notes.number") : t("invoice.number")}</td>
                <td className="font-mono font-semibold">{invoice.number}</td>
              </tr>
              <tr>
                <td className="pr-3 text-[#4a5570]">{isNote ? t("notes.date") : t("invoice.date")}</td>
                <td>{formatDate(invoice.date)}</td>
              </tr>
              {isNote ? (
                invoice.against && (
                  <tr>
                    <td className="pr-3 text-[#4a5570]">{t("notes.against")}</td>
                    <td>
                      <span className="font-mono">{invoice.against.number}</span> · {formatDate(invoice.against.date)}
                    </td>
                  </tr>
                )
              ) : (
                <tr>
                  <td className="pr-3 text-[#4a5570]">{t("invoice.dueDate")}</td>
                  <td>{formatDate(invoice.dueDate)}</td>
                </tr>
              )}
              <tr>
                <td className="pr-3 text-[#4a5570]">{t("invoice.placeOfSupply")}</td>
                <td>{stateName(invoice.placeOfSupply)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-[#4a5570]">{t("invoice.print.reverseCharge")}</td>
                <td>{invoice.reverseCharge ? t("common.yes") : t("invoice.print.no")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </header>

      {invoice.zeroRated && <ZeroRatedLines z={invoice.zeroRated} locale={locale} />}

      <section className="grid grid-cols-1 gap-4 border-b border-[#c8d1e0] py-3 sm:grid-cols-2">
        {[t("invoice.print.billTo"), t("invoice.print.shipTo")].map((label) => (
          <div key={label}>
            <p className="text-[10.5px] font-semibold tracking-wider text-[#4a5570] uppercase">{label}</p>
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
              const r = l;
              return (
                <tr key={`${l.name}-${i}`}>
                  <td className={td}>{i + 1}</td>
                  <td className={td}>
                    {locale === "hi" ? l.nameLocal : l.name}
                    {l.batch && (
                      <span className="block text-[10.5px] text-[#4a5570]">
                        {t("invoice.batch")} {l.batch.split(" · ")[0]}
                        {l.batch.includes(" · ") && (
                          <>
                            {" "}· {t("invoice.expiry")} {formatDate(l.batch.split(" · ")[1]!)}
                          </>
                        )}
                      </span>
                    )}
                  </td>
                  <td className={`${td} font-mono`}>{l.hsn}</td>
                  <td className={`${td} text-right`}>
                    {l.qty} {l.unit}
                  </td>
                  <td className={`${td} text-right`}>{n(l.rate)}</td>
                  <td className={`${td} text-right`}>{l.discountPercent ? `${l.discountPercent}%` : "—"}</td>
                  <td className={`${td} text-right`}>{n(r.taxable)}</td>
                  <td className={`${td} text-right`}>{r.gstRate}%</td>
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
            <p className="mb-1 text-[10.5px] font-semibold tracking-wider text-[#4a5570] uppercase">{t("invoice.print.taxSummary")}</p>
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
                  <tr key={`${h.hsn}-${h.gstRate}`}>
                    <td className={`${td} font-mono`}>{h.hsn}</td>
                    <td className={`${td} text-right`}>{n(h.taxable)}</td>
                    <td className={`${td} text-right`}>{h.gstRate}%</td>
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
            <p className="text-[10.5px] font-semibold tracking-wider text-[#4a5570] uppercase">{t("invoice.amountInWords")}</p>
            <p className="font-medium">{amountInWords(totals.grandTotal.toFixed(2), locale)}</p>
          </div>
          {BUSINESS.bank.name && (
            <div>
              <p className="text-[10.5px] font-semibold tracking-wider text-[#4a5570] uppercase">{t("invoice.print.bankDetails")}</p>
              <p>
                {BUSINESS.bank.name} · A/c {BUSINESS.bank.account} · IFSC <span className="font-mono">{BUSINESS.bank.ifsc}</span>
              </p>
              {BUSINESS.bank.upi && (
                <p>
                  UPI: <span className="font-mono">{BUSINESS.bank.upi}</span>
                </p>
              )}
            </div>
          )}
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
            ...(totals.cessTotal > 0 ? [[t("invoice.cess"), m(totals.cessTotal)]] : []),
            [t("invoice.roundOff"), m(totals.roundOff)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-[#4a5570]">{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
          <div className="mt-1 flex justify-between gap-3 border-t-2 border-[#1450b4] pt-1.5 text-[15px] font-bold">
            <dt>{t("invoice.grandTotal")}</dt>
            <dd className="num">{m(totals.grandTotal)}</dd>
          </div>
          {!isNote && (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-[#4a5570]">{t("invoice.print.paid")}</dt>
                <dd className="num">{m(invoice.paid)}</dd>
              </div>
              {(invoice.credited ?? 0) > 0 && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#4a5570]">{t("notes.lessReturns")}</dt>
                  <dd className="num">{m(invoice.credited ?? 0)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3 font-semibold">
                <dt>{t("invoice.balance")}</dt>
                <dd className="num">{m(Math.max(0, balance))}</dd>
              </div>
            </>
          )}
        </dl>
      </div>

      <footer className="mt-6 flex flex-wrap items-end justify-between gap-4 border-t border-[#c8d1e0] pt-3">
        <div className="max-w-md text-[10.5px] text-[#4a5570]">
          {WORKSPACE.invoiceTerms && !isNote && (
            <>
              <p className="font-semibold text-[#0e1a33]">{t("invoice.print.terms")}</p>
              <p className="whitespace-pre-line">{WORKSPACE.invoiceTerms}</p>
            </>
          )}
          <p className="mt-2">{isNote ? t("notes.computerGenerated") : t("invoice.print.computerGenerated")}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{t("invoice.print.for", { business: BUSINESS.name })}</p>
          <div className="h-10" />
          <p className="text-[#4a5570]">{t("invoice.print.signatory")}</p>
        </div>
      </footer>
      <MadeWithDigitalBahi />
    </article>
  );
}
