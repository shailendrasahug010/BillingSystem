import { ChevronRight, Download, FileSpreadsheet, FileText, MapPin, Phone, Printer, Search, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { Avatar, CountUp, EmptyState, Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { LIVE } from "../../data/source";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { downloadCsv, downloadReport } from "../../lib/download";
import { cityKey } from "../../lib/places";
import { applyFilters, placesOf, sumMoney, type Filters, type OutstandingRow, type Sort, useOutstandingRows } from "./data";
import { OutstandingDetailDialog, PromiseLine } from "./OutstandingDetailDialog";
import { OutstandingListPrint } from "./OutstandingPrint";

const SORTS: Sort[] = ["amount", "overdue", "oldest", "promise", "name"];

function Figure({ label, value, format, sub }: { label: string; value: number; format(v: number): string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      <span className="num truncate font-display text-[22px] leading-tight font-semibold tracking-tight text-ink sm:text-[28px]">
        <CountUp value={value} format={format} />
      </span>
      {sub && <span className="truncate text-[12px] text-ink-2">{sub}</span>}
    </div>
  );
}

/**
 * Outstanding: the money customers owe, for the people who go and collect
 * it. Pick a city (a chip per place, with its total) and the list narrows to
 * that place; it prints with a column to write in what was collected and
 * downloads as PDF, Excel or CSV. A row opens the customer's bills and
 * payments. Without a connection it works from the balances on the device.
 */
export function OutstandingPage() {
  const { t, money, date } = useI18n();
  const toast = useToast();
  const data = useOutstandingRows();
  const [filters, setFilters] = useState<Filters>({ place: null, route: "", q: "", overdueOnly: false, promiseDue: false, sort: "amount" });
  const [openRow, setOpenRow] = useState<OutstandingRow | null>(null);
  const [busy, setBusy] = useState<"pdf" | "xlsx" | "csv" | null>(null);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const places = useMemo(() => placesOf(data.rows), [data.rows]);
  const routes = useMemo(() => [...new Set(data.rows.filter((r) => filters.place === null || cityKey(r.city) === filters.place).map((r) => r.route).filter((r): r is string => Boolean(r)))].sort(), [data.rows, filters.place]);
  const rows = useMemo(() => applyFilters(data.rows, filters), [data.rows, filters]);
  const total = sumMoney(rows.map((r) => r.outstanding));
  const overdue = sumMoney(rows.map((r) => r.overdue));
  const overdueCount = rows.filter((r) => r.overdue > 0).length;

  const place = filters.place === null ? null : (places.find((p) => p.key === filters.place) ?? null);
  const placeLabel = place ? (place.label ?? t("collect.noCity")) : null;
  const filterLabels = [placeLabel, filters.route || null, filters.overdueOnly ? t("collect.onlyOverdue") : null, filters.promiseDue ? t("collect.promiseDue") : null, filters.q.trim() ? `“${filters.q.trim()}”` : null].filter((x): x is string => Boolean(x));
  const printTitle = placeLabel ? t("collect.printTitlePlace", { place: placeLabel }) : t("collect.printTitle");
  const fileName = `outstanding${place?.label ? `-${place.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}-${data.asOf}`;
  const remote = LIVE && data.source === "server";

  const download = (format: "pdf" | "xlsx" | "csv") => {
    if (!remote) {
      // From the device: the rows on screen as CSV.
      downloadCsv(
        `${fileName}.csv`,
        [
          { label: t("collect.customers"), value: (r: OutstandingRow) => r.name },
          { label: t("common.mobile"), value: (r) => r.mobile },
          { label: t("collect.place"), value: (r) => [r.city, r.route].filter(Boolean).join(" · ") },
          { label: t("collect.bills"), value: (r) => r.openBills },
          { label: t("collect.oldestDue"), value: (r) => r.oldestDueDate },
          { label: t("collect.promisedCol"), value: (r) => r.promise?.date },
          { label: t("collect.overdue"), value: (r) => r.overdue.toFixed(2) },
          { label: t("collect.toCollect"), value: (r) => r.outstanding.toFixed(2) },
        ],
        rows,
      );
      return;
    }
    const routeId = filters.route ? (data.rows.find((r) => r.route === filters.route)?.routeId ?? null) : null;
    const query: Record<string, string> = {
      sort: filters.sort,
      ...(place ? { city: place.label ?? "-" } : {}),
      ...(routeId ? { routeId } : {}),
      ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
      ...(filters.overdueOnly ? { overdue: "true" } : {}),
      ...(filters.promiseDue ? { promise: "due" } : {}),
    };
    setBusy(format);
    downloadReport("/collections/outstanding", query, fileName, format)
      .catch((e: unknown) => toast({ tone: "danger", title: t("collect.downloadFailed"), body: e instanceof ApiError ? e.code : undefined }))
      .finally(() => setBusy(null));
  };

  const chip = (key: string | null, label: string, count: number, amount: number) => {
    const active = filters.place === key;
    return (
      <button
        key={key ?? "all"}
        type="button"
        aria-pressed={active}
        onClick={() => set({ place: key, route: "" })}
        className={cn(
          "press flex shrink-0 flex-col items-start rounded-2xl border px-3.5 py-2 text-left transition-colors",
          active ? "border-accent bg-accent text-white shadow-card" : "border-line bg-surface text-ink hover:border-line-strong",
        )}
      >
        <span className="flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap">
          {key !== null && <MapPin size={13} className={active ? "text-white/80" : "text-ink-3"} aria-hidden />}
          {label}
          <span className={cn("rounded-full px-1.5 text-[11px] font-medium", active ? "bg-white/20" : "bg-surface-2 text-ink-3")}>{count}</span>
        </span>
        <span className={cn("num text-[12px]", active ? "text-white/85" : "text-ink-3")}>{money(amount, 0)}</span>
      </button>
    );
  };

  return (
    <div className="stagger flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight text-ink sm:text-[28px]">{t("collect.title")}</h1>
          <p className="text-[13px] text-ink-3">{t("collect.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label={t("common.download")}>
          <Button size="sm" icon={<Printer size={15} />} disabled={rows.length === 0} onClick={() => window.print()}>
            {t("common.print")}
          </Button>
          {remote && (
            <>
              <Button size="sm" icon={<FileText size={15} />} disabled={busy !== null || rows.length === 0} onClick={() => download("pdf")}>
                {busy === "pdf" ? t("reports.preparing") : t("reports.exportPdf")}
              </Button>
              <Button size="sm" icon={<FileSpreadsheet size={15} />} disabled={busy !== null || rows.length === 0} onClick={() => download("xlsx")}>
                {busy === "xlsx" ? t("reports.preparing") : t("reports.exportXlsx")}
              </Button>
            </>
          )}
          <Button size="sm" icon={<Download size={15} />} disabled={busy !== null || rows.length === 0} onClick={() => download("csv")}>
            {t("reports.exportCsv")}
          </Button>
        </div>
      </div>

      {LIVE && data.source === "device" && (
        <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
          <WifiOff size={15} className="mt-0.5 shrink-0" />
          {t("collect.offlineNote")}
        </p>
      )}

      {/* How much is out there, for the place and filters chosen. */}
      <section className="bg-hero on-dark relative overflow-hidden rounded-[26px] px-4 py-4 shadow-pop sm:px-6 sm:py-5" aria-label={t("collect.toCollect")}>
        <div className="dots pointer-events-none absolute inset-0 opacity-40" aria-hidden />
        <div className="relative grid grid-cols-2 gap-3 md:grid-cols-3">
          <div className="col-span-2 md:col-span-1">
            <Figure label={placeLabel ? `${t("collect.toCollect")} · ${placeLabel}` : t("collect.toCollect")} value={total} format={(v) => money(v, 0)} sub={t("collect.customersCount", { count: rows.length })} />
          </div>
          <Figure label={t("collect.overdue")} value={overdue} format={(v) => money(v, 0)} sub={t("collect.customersCount", { count: overdueCount })} />
          <Figure label={t("collect.notDue")} value={Math.max(0, total - overdue)} format={(v) => money(v, 0)} />
        </div>
      </section>

      {/* A chip per place, so the collector going to one town sees only that town. */}
      {places.length > 0 && (
        <div className="scroll-x -mx-4 px-4 sm:mx-0 sm:px-0" role="group" aria-label={t("collect.city")}>
          <div className="flex gap-2 pb-1">
            {chip(null, t("collect.allPlaces"), data.rows.length, sumMoney(data.rows.map((r) => r.outstanding)))}
            {places.map((p) => chip(p.key, p.label ?? t("collect.noCity"), p.customers, p.total))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-card md:flex-row md:items-center">
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("collect.search")} aria-label={t("collect.search")} value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        <div className="flex flex-wrap gap-2 md:flex-nowrap">
          {routes.length > 0 && (
            <Select aria-label={t("customer.route")} value={filters.route} onChange={(e) => set({ route: e.target.value })} className="min-w-[140px] flex-1 md:w-48 md:flex-none">
              <option value="">{t("collect.allRoutes")}</option>
              {routes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label={t("collect.sortBy")} value={filters.sort} onChange={(e) => set({ sort: e.target.value as Sort })} className="min-w-[140px] flex-1 md:w-56 md:flex-none">
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`collect.sort.${s}`)}
              </option>
            ))}
          </Select>
          <button
            type="button"
            aria-pressed={filters.overdueOnly}
            onClick={() => set({ overdueOnly: !filters.overdueOnly })}
            className={cn("h-10 shrink-0 rounded-full border px-4 text-[13px] font-medium", filters.overdueOnly ? "border-danger bg-danger-soft text-danger" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
          >
            {t("collect.onlyOverdue")}
          </button>
          {remote && (
            <button
              type="button"
              aria-pressed={filters.promiseDue}
              onClick={() => set({ promiseDue: !filters.promiseDue })}
              className={cn("h-10 shrink-0 rounded-full border px-4 text-[13px] font-medium", filters.promiseDue ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
            >
              {t("collect.promiseDue")}
            </button>
          )}
        </div>
      </div>

      <ErrorNote error={data.error} onRetry={() => void data.refetch()} />

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        {data.loading ? (
          <div className="flex flex-col gap-3 p-4" role="status" aria-label={t("common.loading")}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-9 w-9 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          data.rows.length === 0 ? (
            <EmptyState title={t("collect.empty")} hint={t("collect.emptyHint")} />
          ) : (
            <EmptyState title={t("collect.emptyFiltered")} action={<Button size="sm" onClick={() => setFilters({ place: null, route: "", q: "", overdueOnly: false, promiseDue: false, sort: filters.sort })}>{t("common.reset")}</Button>} />
          )
        ) : (
          <>
            {/* Desktop: a table. */}
            <table className="hidden w-full text-[13.5px] md:table">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-4 py-2.5 font-medium">{t("collect.customers")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("collect.place")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("collect.bills")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("collect.oldestDue")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("collect.lastPayment")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("collect.overdue")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("collect.toCollect")}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.customerId} onClick={() => setOpenRow(r)} className="cursor-pointer border-b border-line/70 transition-colors last:border-b-0 hover:bg-accent-soft/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={r.name} />
                        <div className="min-w-0">
                          <button type="button" className="text-left font-medium text-ink hover:underline" onClick={(e) => (e.stopPropagation(), setOpenRow(r))}>
                            {r.name}
                          </button>
                          <p className="num text-[12.5px] text-ink-3">{[r.contactName, r.mobile].filter(Boolean).join(" · ")}</p>
                          <VisitLine row={r} />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-ink-2">
                      {r.city ?? <span className="text-ink-3">{t("collect.noCity")}</span>}
                      {r.route && <span className="block text-[12px] text-ink-3">{r.route}</span>}
                    </td>
                    <td className="num px-3 py-3 text-right text-ink-2">{r.openBills ?? "—"}</td>
                    <td className="num px-3 py-3 text-ink-2">
                      {r.oldestDueDate ? (
                        <>
                          {date(r.oldestDueDate)}
                          {r.daysOverdue > 0 && <span className="block text-[12px] text-danger">{t("collect.daysLate", { count: r.daysOverdue })}</span>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num px-3 py-3 text-ink-2">
                      {r.lastPaymentDate ? (
                        <>
                          {date(r.lastPaymentDate)}
                          {r.lastPaymentAmount !== null && <span className="block text-[12px] text-ink-3">{money(r.lastPaymentAmount, 0)}</span>}
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={cn("num px-3 py-3 text-right", r.overdue > 0 ? "font-medium text-danger" : "text-ink-3")}>{r.overdue > 0 ? money(r.overdue, 0) : "—"}</td>
                    <td className="num px-4 py-3 text-right text-[14.5px] font-semibold text-ink">{money(r.outstanding, 0)}</td>
                    <td className="pr-3 text-ink-3">
                      <ChevronRight size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-2/60 font-semibold">
                  <td className="px-4 py-3 text-ink" colSpan={5}>
                    {t("collect.total")} · {t("collect.customersCount", { count: rows.length })}
                  </td>
                  <td className={cn("num px-3 py-3 text-right", overdue > 0 ? "text-danger" : "text-ink-3")}>{money(overdue, 0)}</td>
                  <td className="num px-4 py-3 text-right text-ink">{money(total, 0)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {/* Phone: cards, with a call button at the thumb. */}
            <ul className="divide-y divide-line md:hidden">
              {rows.map((r) => (
                <li key={r.customerId} className="flex items-center gap-1 pr-2">
                  <button type="button" onClick={() => setOpenRow(r)} className="press flex min-w-0 flex-1 items-center gap-3 py-3.5 pl-4 text-left active:bg-surface-2">
                    <Avatar name={r.name} className="size-10" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-ink">{r.name}</p>
                      <p className="truncate text-[12.5px] text-ink-3">{[r.city ?? t("collect.noCity"), r.route].filter(Boolean).join(" · ")}</p>
                      {(r.openBills !== null || r.daysOverdue > 0) && (
                        <p className="truncate text-[12px] text-ink-3">
                          {r.openBills !== null && t("collect.bills", { count: r.openBills })}
                          {r.openBills !== null && r.daysOverdue > 0 && " · "}
                          {r.daysOverdue > 0 && <span className="text-danger">{t("collect.daysLate", { count: r.daysOverdue })}</span>}
                        </p>
                      )}
                      <VisitLine row={r} />
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-[15px] font-semibold text-ink">{money(r.outstanding, 0)}</p>
                      {r.overdue > 0 && <p className="num text-[12px] text-danger">{t("dashboard.kpi.overdue", { amount: money(r.overdue, 0) })}</p>}
                    </div>
                  </button>
                  {r.mobile && (
                    <a href={`tel:${r.mobile.replace(/\s/g, "")}`} className="press inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-good-soft text-good" aria-label={`${t("common.call")} ${r.name}`}>
                      <Phone size={17} />
                    </a>
                  )}
                </li>
              ))}
              <li className="flex items-center justify-between bg-surface-2/60 px-4 py-3 text-[13.5px] font-semibold">
                <span className="text-ink">{t("collect.customersCount", { count: rows.length })}</span>
                <span className="num text-ink">{money(total, 0)}</span>
              </li>
            </ul>
          </>
        )}
      </div>

      {!openRow && rows.length > 0 && (
        <PrintPortal>
          <OutstandingListPrint rows={rows} title={printTitle} filters={filterLabels.filter((f) => f !== placeLabel)} asOf={data.asOf} />
        </PrintPortal>
      )}
      <OutstandingDetailDialog row={openRow} source={data.source} onOpenChange={(v) => !v && setOpenRow(null)} />
    </div>
  );
}

/** Under a customer's name: their open promise, or what the last visit noted. */
function VisitLine({ row }: { row: OutstandingRow }) {
  const { date } = useI18n();
  if (row.promise) return <PromiseLine promise={row.promise} className="text-[12px] font-medium" />;
  if (row.lastNote?.kind === "note" && row.lastNote.note)
    return (
      <p className="truncate text-[12px] text-ink-3 italic">
        {date(row.lastNote.date)} · {row.lastNote.note}
      </p>
    );
  return null;
}
