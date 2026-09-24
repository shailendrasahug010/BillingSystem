import { amountInWords, type PaymentMethod } from "@vyapaar/core";
import { createTranslator, formatCurrency, formatDate, formatNumber, type LocaleCode } from "@vyapaar/i18n";
import { BUSINESS } from "../../data/db";

export interface PrintableSlip {
  month: string;
  workingDays: string;
  paidDays: string;
  unpaidLeaveDays: string;
  overtimeHours: string;
  grossEarnings: string;
  totalDeductions: string;
  netPay: string;
  employee: { employeeCode: string; name: string; designation: string | null; department: string | null; joiningDate: string; bankAccountLast4: string | null; bankIfsc: string | null; panMasked: string | null };
  lines: Array<{ label: string; type: "earning" | "deduction"; amount: string; nameHi: string | null; code: string | null; componentId: string | null; advanceId: string | null }>;
  payment: { number: string | null; date: string; method: PaymentMethod } | null;
}

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_HI = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];

/** Salary slip on half an A4 page in the chosen print language; paper look in both themes. */
export function SalarySlipDocument({ slip: s, locale }: { slip: PrintableSlip; locale: LocaleCode }) {
  const { t } = createTranslator(locale);
  const m = (v: string) => formatCurrency(v, locale);
  const n = (v: string) => formatNumber(v, locale, 1);
  const month = `${(locale === "hi" ? MONTHS_HI : MONTHS_EN)[Number(s.month.slice(5, 7)) - 1]} ${s.month.slice(0, 4)}`;
  const label = (l: PrintableSlip["lines"][number]) => (l.advanceId ? t(l.label.startsWith("Loan") ? "payroll.slip.loanRecovery" : "payroll.slip.advanceRecovery") : (locale === "hi" && l.nameHi) || l.label);
  const earnings = s.lines.filter((l) => l.type === "earning");
  const deductions = s.lines.filter((l) => l.type === "deduction");
  const rows = Math.max(earnings.length, deductions.length);
  const cell = "border border-[#c9d2d3] px-2 py-1";
  return (
    <article className="mx-auto w-full max-w-[820px] bg-white p-6 text-[13px] leading-snug text-[#10201f] shadow-pop sm:p-8" style={{ fontFamily: "var(--font-sans)" }} lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#0b6e82] pb-3">
        <div className="min-w-0">
          <h2 className="text-[20px] leading-tight font-bold text-[#0b3b44]" style={{ fontFamily: "var(--font-display)" }}>
            {BUSINESS.name}
          </h2>
          {BUSINESS.address && <p>{BUSINESS.address}</p>}
          {BUSINESS.city && <p>{BUSINESS.city}</p>}
        </div>
        <div className="text-right">
          <p className="text-[17px] font-bold tracking-wide text-[#0b6e82]">{t("payroll.slip.title").toUpperCase()}</p>
          <p className="font-semibold">{month}</p>
        </div>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        {[
          [t("payroll.slip.employee"), `${s.employee.name} (${s.employee.employeeCode})`],
          [t("people.designation"), s.employee.designation ?? "—"],
          [t("people.department"), s.employee.department ?? "—"],
          [t("people.joiningDate"), formatDate(s.employee.joiningDate)],
          [t("payroll.slip.paidDays"), `${n(s.paidDays)} / ${n(s.workingDays)}`],
          [t("payroll.slip.lop"), n(s.unpaidLeaveDays)],
          ...(Number(s.overtimeHours) ? [[t("people.overtime"), `${n(s.overtimeHours)} h`]] : []),
          ...(s.employee.bankAccountLast4 ? [[t("people.bank"), `•••• ${s.employee.bankAccountLast4}${s.employee.bankIfsc ? ` · ${s.employee.bankIfsc}` : ""}`]] : []),
          ...(s.employee.panMasked ? [["PAN", s.employee.panMasked]] : []),
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11.5px] text-[#4a5f62]">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>

      <table className="num mt-4 w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="bg-[#eef4f5] text-left">
            <th className={cell}>{t("payroll.slip.earnings")}</th>
            <th className={`${cell} text-right`}>{t("common.amount")}</th>
            <th className={cell}>{t("payroll.slip.deductions")}</th>
            <th className={`${cell} text-right`}>{t("common.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td className={cell}>{earnings[i] ? label(earnings[i]) : ""}</td>
              <td className={`${cell} text-right`}>{earnings[i] ? m(earnings[i].amount) : ""}</td>
              <td className={cell}>{deductions[i] ? label(deductions[i]) : ""}</td>
              <td className={`${cell} text-right`}>{deductions[i] ? m(deductions[i].amount) : ""}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className={cell}>{t("payroll.slip.gross")}</td>
            <td className={`${cell} text-right`}>{m(s.grossEarnings)}</td>
            <td className={cell}>{t("payroll.slip.totalDeductions")}</td>
            <td className={`${cell} text-right`}>{m(s.totalDeductions)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 rounded bg-[#eef4f5] px-3 py-2">
        <span className="font-semibold">{t("payroll.slip.net")}</span>
        <span className="text-[17px] font-bold">{m(s.netPay)}</span>
        <span className="w-full text-[12px] text-[#4a5f62]">{amountInWords(s.netPay, locale)}</span>
      </div>
      {s.payment && (
        <p className="mt-2 text-[12px] text-[#4a5f62]">
          {t("payroll.slip.paidOn", { date: formatDate(s.payment.date), method: t(`paymentMethod.${s.payment.method}`), number: s.payment.number ?? "" })}
        </p>
      )}

      <footer className="mt-10 flex items-end justify-between gap-4 text-[12px]">
        <div>
          <p className="mt-8 border-t border-[#10201f] pt-1">{t("payroll.slip.employeeSign")}</p>
        </div>
        <div className="text-right">
          <p>{t("invoice.print.for", { business: BUSINESS.name })}</p>
          <p className="mt-8 border-t border-[#10201f] pt-1">{t("invoice.print.signatory")}</p>
        </div>
      </footer>
    </article>
  );
}
