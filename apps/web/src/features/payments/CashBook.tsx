import { useQuery } from "@tanstack/react-query";
import type { CashBookKind, PaymentMethod } from "@digitalbahi/core";
import { translateError } from "@digitalbahi/i18n";
import { Download, FileSpreadsheet, FileText, Printer } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { FirmHeader, MadeWithDigitalBahi } from "../../components/brand/Brand";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, RowCard, Stat } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { rangeDates, type RangeKey } from "../../data/store";
import { api, ApiError } from "../../lib/api";
import { downloadReport } from "../../lib/download";

interface CashBookRow {
  id: string;
  kind: "payment" | "expense" | "transfer";
  date: string;
  number: string | null;
  direction: "in" | "out";
  party: string | null;
  /** "transfer" for money moved between the cash drawer and a bank. */
  method: PaymentMethod | "transfer";
  reference: string | null;
  in: string;
  out: string;
  balance: string;
}

interface CashBookData {
  book: CashBookKind;
  from: string;
  to: string;
  includesExpenses: boolean;
  truncated: boolean;
  opening: string;
  in: string;
  out: string;
  closing: string;
  rows: CashBookRow[];
  days: Array<{ date: string; opening: string; in: string; out: string; closing: string }>;
}

const PRESETS: RangeKey[] = ["today", "yesterday", "last7", "thisMonth", "lastMonth"];

/**
 * The day's money: opening balance, every receipt, payment and expense with
 * a running balance, and the closing, for cash or for the bank (UPI,
 * transfers, cheques, cards). Prints, and downloads as PDF or Excel.
 */
export function CashBook() {
  const i18n = useI18n();
  const { t, money, dateMedium } = i18n;
  const toast = useToast();
  const [book, setBook] = useState<CashBookKind>("cash");
  const [preset, setPreset] = useState<RangeKey | "custom">("today");
  const [range, setRange] = useState(() => rangeDates("today"));
  const [busy, setBusy] = useState<"pdf" | "xlsx" | "csv" | null>(null);
  const choose = (p: RangeKey | "custom") => {
    setPreset(p);
    if (p !== "custom") setRange(rangeDates(p));
  };
  const valid = Boolean(range.from && range.to && range.from <= range.to);
  const q = useQuery({
    queryKey: ["cash-book", book, range.from, range.to],
    queryFn: () => api.get<CashBookData>("/payments/cash-book", { book, from: range.from, to: range.to }),
    enabled: valid,
  });
  const d = q.data;
  const file = (format: "pdf" | "xlsx" | "csv") => {
    setBusy(format);
    downloadReport("/payments/cash-book", { book, from: range.from, to: range.to }, `${book === "cash" ? "cash-book" : "bank-book"}-${range.from}-${range.to}`, format)
      .catch((e: unknown) => toast({ tone: "danger", title: t("errors.exportFailed"), body: translateError(i18n, e instanceof ApiError ? e : null) }))
      .finally(() => setBusy(null));
  };
  const particulars = (r: CashBookRow) => (r.kind === "expense" ? `${t("cashBook.expense")} · ${r.party ?? ""}` : r.kind === "transfer" ? `${t("cashBook.transfer")} · ${r.party ?? ""}` : (r.party ?? ""));
  const mode = (r: CashBookRow) => `${r.method === "transfer" ? t("cashBook.transfer") : t(`paymentMethod.${r.method}`)}${r.reference ? ` · ${r.reference}` : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        quick={
          <Segmented
            size="sm"
            label={t("cashBook.book")}
            value={book}
            onChange={setBook}
            options={[
              { value: "cash", label: t("cashBook.cash") },
              { value: "bank", label: t("cashBook.bank") },
              { value: "all", label: t("common.all") },
            ]}
          />
        }
      >
        <Select aria-label={t("common.period")} value={preset} onChange={(e) => choose(e.target.value as RangeKey | "custom")} className="flex-1 md:w-48 md:flex-none">
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(`dashboard.range.${p}`)}
            </option>
          ))}
          <option value="custom">{t("dashboard.range.custom")}</option>
        </Select>
        <Input type="date" aria-label={t("common.from")} value={range.from} max={range.to} onChange={(e) => (setPreset("custom"), setRange((r) => ({ ...r, from: e.target.value })))} className="md:w-40" />
        <Input type="date" aria-label={t("common.to")} value={range.to} min={range.from} onChange={(e) => (setPreset("custom"), setRange((r) => ({ ...r, to: e.target.value })))} className="md:w-40" />
      </FilterBar>

      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
        <Stat label={t("cashBook.opening")} value={d ? money(d.opening) : "—"} />
        <Stat label={t("cashBook.in")} value={d ? money(d.in) : "—"} tone="good" />
        <Stat label={t("cashBook.out")} value={d ? money(d.out) : "—"} tone="warn" />
        <Stat label={t("cashBook.closing")} value={d ? money(d.closing) : "—"} tone={d && Number(d.closing) < 0 ? "danger" : undefined} />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-ink-3">
          {t(book === "cash" ? "cashBook.cashHint" : book === "bank" ? "cashBook.bankHint" : "cashBook.allHint")}
          {d && !d.includesExpenses && ` ${t("cashBook.noExpenses")}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Printer size={15} />} disabled={!d} onClick={() => window.print()}>
            {t("common.print")}
          </Button>
          <Button size="sm" icon={<FileText size={15} />} disabled={!d || busy !== null} onClick={() => file("pdf")}>
            {busy === "pdf" ? t("reports.preparing") : t("reports.exportPdf")}
          </Button>
          <Button size="sm" icon={<FileSpreadsheet size={15} />} disabled={!d || busy !== null} onClick={() => file("xlsx")}>
            {busy === "xlsx" ? t("reports.preparing") : t("reports.exportXlsx")}
          </Button>
          <Button size="sm" icon={<Download size={15} />} disabled={!d || busy !== null} onClick={() => file("csv")}>
            {t("reports.exportCsv")}
          </Button>
        </div>
      </div>

      {d && d.days.length > 1 && (
        <DataTable
          rows={d.days}
          rowKey={(x) => x.date}
          minWidth={560}
          columns={[
            { key: "date", header: t("common.date"), render: (x) => <span className="text-ink">{dateMedium(x.date)}</span> },
            { key: "opening", header: t("cashBook.opening"), align: "right", render: (x) => <span className="text-ink-2">{money(x.opening)}</span> },
            { key: "in", header: t("cashBook.in"), align: "right", render: (x) => <span className="text-good">{money(x.in)}</span> },
            { key: "out", header: t("cashBook.out"), align: "right", render: (x) => money(x.out) },
            { key: "closing", header: t("cashBook.closing"), align: "right", render: (x) => <span className="font-semibold text-ink">{money(x.closing)}</span> },
          ]}
          mobile={(x) => <RowCard title={dateMedium(x.date)} sub={`${t("cashBook.in")} ${money(x.in)} · ${t("cashBook.out")} ${money(x.out)}`} value={money(x.closing)} valueSub={t("cashBook.closing")} />}
        />
      )}

      <DataTable
        rows={d?.rows ?? []}
        loading={valid && q.isPending}
        rowKey={(r) => `${r.kind}-${r.id}`}
        minWidth={820}
        empty={<p className="px-4 py-8 text-center text-[13.5px] text-ink-3">{t("cashBook.empty")}</p>}
        columns={[
          { key: "date", header: t("common.date"), render: (r) => <span className="text-ink-2">{dateMedium(r.date)}</span> },
          { key: "particulars", header: t("customer.ledger.particulars"), render: (r) => <span className="text-ink">{particulars(r)}</span> },
          { key: "number", header: t("common.number"), render: (r) => <span className="text-ink-2">{r.number ?? ""}</span> },
          { key: "mode", header: t("common.method"), render: (r) => <span className="text-ink-2">{mode(r)}</span> },
          { key: "in", header: t("cashBook.in"), align: "right", render: (r) => (Number(r.in) ? <span className="font-medium text-good">{money(r.in)}</span> : "") },
          { key: "out", header: t("cashBook.out"), align: "right", render: (r) => (Number(r.out) ? <span className="font-medium text-ink">{money(r.out)}</span> : "") },
          { key: "balance", header: t("customer.ledger.runningBalance"), align: "right", render: (r) => <span className="font-semibold text-ink">{money(r.balance)}</span> },
        ]}
        mobile={(r) => (
          <RowCard
            title={particulars(r)}
            sub={`${dateMedium(r.date)} · ${r.number ?? ""} · ${mode(r)}`}
            value={Number(r.in) ? `+${money(r.in)}` : `−${money(r.out)}`}
            tone={Number(r.in) ? "good" : undefined}
            valueSub={money(r.balance)}
          />
        )}
      />
      {d?.truncated && <p className="text-[12.5px] text-warn">{t("cashBook.truncated")}</p>}

      {d && (
        <PrintPortal>
          <CashBookPrint data={d} particulars={particulars} mode={mode} />
        </PrintPortal>
      )}
    </div>
  );
}

const cellL = "border-b border-[#d5dbe7] px-2 py-1.5 text-left align-top";
const cellR = "border-b border-[#d5dbe7] px-2 py-1.5 text-right align-top whitespace-nowrap";
const head = "border-b-2 border-[#0e1a33] px-2 py-1.5 font-semibold";

/** The cash book on paper: letterhead, period, opening, entries with balance, closing and a line to sign. */
function CashBookPrint({ data: d, particulars, mode }: { data: CashBookData; particulars(r: CashBookRow): string; mode(r: CashBookRow): string }) {
  const { t, money, date, locale } = useI18n();
  const title = t(d.book === "cash" ? "cashBook.cashTitle" : d.book === "bank" ? "cashBook.bankTitle" : "cashBook.allTitle");
  return (
    <article className="mx-auto w-full max-w-[1000px] bg-white p-6 text-[12px] leading-snug text-[#0e1a33]" style={{ fontFamily: "var(--font-sans)" }} lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-3">
        <FirmHeader detail="short" />
        <div className="text-right">
          <p className="text-[16px] font-bold text-[#1450b4]">{title}</p>
          <p>{d.from === d.to ? date(d.from) : `${date(d.from)} – ${date(d.to)}`}</p>
        </div>
      </header>
      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr>
            <th className={`${head} text-left`}>{t("common.date")}</th>
            <th className={`${head} text-left`}>{t("customer.ledger.particulars")}</th>
            <th className={`${head} text-left`}>{t("common.number")}</th>
            <th className={`${head} text-left`}>{t("common.method")}</th>
            <th className={`${head} text-right`}>{t("cashBook.in")}</th>
            <th className={`${head} text-right`}>{t("cashBook.out")}</th>
            <th className={`${head} text-right`}>{t("customer.ledger.runningBalance")}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="font-semibold">
            <td className={cellL}>{date(d.from)}</td>
            <td className={cellL} colSpan={5}>
              {t("cashBook.opening")}
            </td>
            <td className={cellR}>{money(d.opening)}</td>
          </tr>
          {d.rows.map((r) => (
            <tr key={`${r.kind}-${r.id}`} style={{ breakInside: "avoid" }}>
              <td className={cellL}>{date(r.date)}</td>
              <td className={cellL}>{particulars(r)}</td>
              <td className={cellL}>{r.number ?? ""}</td>
              <td className={cellL}>{mode(r)}</td>
              <td className={cellR}>{Number(r.in) ? money(r.in) : ""}</td>
              <td className={cellR}>{Number(r.out) ? money(r.out) : ""}</td>
              <td className={cellR}>{money(r.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td className="px-2 py-2" colSpan={4}>
              {t("cashBook.closing")}
            </td>
            <td className="px-2 py-2 text-right whitespace-nowrap">{money(d.in)}</td>
            <td className="px-2 py-2 text-right whitespace-nowrap">{money(d.out)}</td>
            <td className="px-2 py-2 text-right whitespace-nowrap">{money(d.closing)}</td>
          </tr>
        </tfoot>
      </table>
      <footer className="mt-10 flex justify-end text-[12px]">
        <p className="w-56 border-t border-[#0e1a33] pt-1 text-center">{t("cashBook.signature")}</p>
      </footer>
      <MadeWithDigitalBahi />
    </article>
  );
}
