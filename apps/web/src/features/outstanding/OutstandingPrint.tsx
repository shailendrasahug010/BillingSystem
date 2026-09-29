import { FirmHeader, MadeWithDigitalBahi } from "../../components/brand/Brand";
import { useI18n } from "../../app/i18n";
import { sumMoney, type OutstandingDetail, type OutstandingRow } from "./data";

const cellL = "border-b border-[#d5dbe7] px-2 py-1.5 text-left align-top";
const cellR = "border-b border-[#d5dbe7] px-2 py-1.5 text-right align-top whitespace-nowrap";
const head = "border-b-2 border-[#0e1a33] px-2 py-1.5 font-semibold";

/**
 * The list a collector carries: who owes what, where, with a blank column to
 * write what was collected and a line to sign. Paper look in both themes.
 */
export function OutstandingListPrint({ rows, title, filters, asOf }: { rows: OutstandingRow[]; title: string; filters: string[]; asOf: string }) {
  const { t, money, date, locale } = useI18n();
  const total = sumMoney(rows.map((r) => r.outstanding));
  const overdue = sumMoney(rows.map((r) => r.overdue));
  return (
    <article className="mx-auto w-full max-w-[1000px] bg-white p-6 text-[12px] leading-snug text-[#0e1a33]" style={{ fontFamily: "var(--font-sans)" }} lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-3">
        <FirmHeader detail="short" />
        <div className="text-right">
          <p className="text-[16px] font-bold text-[#1450b4]">{title}</p>
          <p>{t("collect.asOf", { date: date(asOf) })}</p>
          {filters.length > 0 && <p className="text-[#4a5570]">{filters.join(" · ")}</p>}
        </div>
      </header>
      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr>
            <th className={`${head} w-8 text-left`}>#</th>
            <th className={`${head} text-left`}>{t("collect.customers")}</th>
            <th className={`${head} text-left`}>{t("collect.place")}</th>
            <th className={`${head} text-right`}>{t("collect.bills")}</th>
            <th className={`${head} text-left`}>{t("collect.oldestDue")}</th>
            <th className={`${head} text-right`}>{t("collect.overdue")}</th>
            <th className={`${head} text-right`}>{t("collect.toCollect")}</th>
            <th className={`${head} w-36 text-left`}>{t("collect.collected")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.customerId} style={{ breakInside: "avoid" }}>
              <td className={cellL}>{i + 1}</td>
              <td className={cellL}>
                <span className="font-semibold">{r.name}</span>
                {r.mobile && <span className="block text-[#4a5570]">{r.mobile}</span>}
                {r.promise && (
                  <span className="block text-[#1450b4]">
                    {r.promise.amount !== null ? t("collect.promised", { amount: money(r.promise.amount, 0), date: date(r.promise.date) }) : t("collect.promisedFull", { date: date(r.promise.date) })}
                  </span>
                )}
              </td>
              <td className={cellL}>{[r.city, r.route].filter(Boolean).join(" · ")}</td>
              <td className={cellR}>{r.openBills ?? ""}</td>
              <td className={cellL}>{r.oldestDueDate ? date(r.oldestDueDate) : ""}</td>
              <td className={cellR}>{r.overdue > 0 ? money(r.overdue) : ""}</td>
              <td className={`${cellR} font-semibold`}>{money(r.outstanding)}</td>
              <td className={`${cellL} border-l border-[#d5dbe7]`} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td className="px-2 py-2" colSpan={5}>
              {t("collect.total")} · {t("collect.customersCount", { count: rows.length })}
            </td>
            <td className="px-2 py-2 text-right whitespace-nowrap">{money(overdue)}</td>
            <td className="px-2 py-2 text-right whitespace-nowrap">{money(total)}</td>
            <td className="border-l border-[#d5dbe7]" />
          </tr>
        </tfoot>
      </table>
      <footer className="mt-10 flex justify-end text-[12px]">
        <p className="w-56 border-t border-[#0e1a33] pt-1 text-center">{t("collect.signature")}</p>
      </footer>
      <MadeWithDigitalBahi />
    </article>
  );
}

/** One customer's dues on paper: open bills, totals, and room to note the payment. */
export function OutstandingStatementPrint({ detail: d }: { detail: OutstandingDetail }) {
  const { t, money, date, locale } = useI18n();
  const c = d.customer;
  return (
    <article className="mx-auto w-full max-w-[820px] bg-white p-6 text-[12.5px] leading-snug text-[#0e1a33]" style={{ fontFamily: "var(--font-sans)" }} lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-3">
        <FirmHeader />
        <div className="text-right">
          <p className="text-[16px] font-bold text-[#1450b4]">{t("collect.printTitle")}</p>
          <p>{t("collect.asOf", { date: date(d.asOf) })}</p>
        </div>
      </header>
      <section className="mt-3">
        <p className="text-[15px] font-bold">{c.name}</p>
        {c.contactName && <p>{c.contactName}</p>}
        {c.address && <p>{c.address}</p>}
        <p>{[c.city, c.pincode, c.route].filter(Boolean).join(" · ")}</p>
        {c.mobile && <p>{c.mobile}</p>}
        {c.gstin && <p className="font-mono">GSTIN: {c.gstin}</p>}
      </section>
      {d.bills && d.bills.length > 0 && (
        <table className="mt-3 w-full border-collapse">
          <thead>
            <tr>
              <th className={`${head} text-left`}>{t("collect.billNo")}</th>
              <th className={`${head} text-left`}>{t("collect.billDate")}</th>
              <th className={`${head} text-left`}>{t("collect.dueDate")}</th>
              <th className={`${head} text-right`}>{t("collect.total")}</th>
              <th className={`${head} text-right`}>{t("collect.paid")}</th>
              <th className={`${head} text-right`}>{t("collect.balance")}</th>
            </tr>
          </thead>
          <tbody>
            {d.bills.map((b) => (
              <tr key={b.id}>
                <td className={`${cellL} font-mono`}>{b.number}</td>
                <td className={cellL}>{date(b.date)}</td>
                <td className={cellL}>
                  {date(b.dueDate)}
                  {b.daysOverdue > 0 && <span className="block text-[#b42318]">{t("collect.daysLate", { count: b.daysOverdue })}</span>}
                </td>
                <td className={cellR}>{money(b.total)}</td>
                <td className={cellR}>{money(b.paid)}</td>
                <td className={`${cellR} font-semibold`}>{money(b.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3 ml-auto flex w-full max-w-[320px] flex-col">
        {Number(d.other) > 0 && (
          <p className="flex justify-between border-b border-dashed border-[#c8d1e0] py-1">
            <span>{t("collect.other")}</span>
            <span>{money(d.other)}</span>
          </p>
        )}
        <p className="flex justify-between border-b border-dashed border-[#c8d1e0] py-1">
          <span>{t("collect.overdue")}</span>
          <span>{money(d.overdue)}</span>
        </p>
        <p className="flex justify-between py-1.5 text-[15px] font-bold">
          <span>{t("collect.toCollect")}</span>
          <span>{money(d.outstanding)}</span>
        </p>
      </div>
      <footer className="mt-10 flex items-end justify-between gap-6 text-[12px]">
        <p className="w-56 border-t border-[#0e1a33] pt-1">{t("collect.collected")}</p>
        <p className="w-56 border-t border-[#0e1a33] pt-1 text-right">{t("collect.signature")}</p>
      </footer>
      <MadeWithDigitalBahi />
    </article>
  );
}
