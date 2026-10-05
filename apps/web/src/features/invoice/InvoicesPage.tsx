import { CloudOff, Download, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, type Column } from "../../components/ui/Page";
import { allowed, customerById, INVOICES, TODAY } from "../../data/db";
import { LIVE } from "../../data/source";
import { useStoreVersion } from "../../data/store";
import { downloadCsv } from "../../lib/download";
import { usePaged } from "../../lib/usePaged";
import { WaitingStrip } from "../../components/offline/OfflineBills";
import { deviceDocuments, useDeviceDocuments } from "../../offline/documents";
import { unreachable, useOffline } from "../../offline/sync";

/** One sales bill on the list, as `GET /invoices` gives it. */
export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  customerId: string;
  partyName: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
  paymentStatus: "unpaid" | "partial" | "paid";
  status: "posted" | "cancelled";
  reviewStatus?: "needs_review" | "reviewed" | null;
}

type Payment = "all" | "open" | "unpaid" | "partial" | "paid";
type Status = "all" | "posted" | "cancelled";

const isOverdue = (r: InvoiceRow) => r.status === "posted" && Number(r.balanceDue) > 0.5 && Boolean(r.dueDate) && r.dueDate! < TODAY;

export function InvoiceStatusBadge({ row }: { row: InvoiceRow }) {
  const { t } = useI18n();
  if (row.status === "cancelled") return <Badge tone="neutral">{t("common.cancelled")}</Badge>;
  if (isOverdue(row)) return <Badge tone="danger" dot>{t("status.payment.overdue")}</Badge>;
  const tone = row.paymentStatus === "paid" ? "good" : row.paymentStatus === "partial" ? "warn" : "neutral";
  return (
    <Badge tone={tone} dot>
      {t(`status.payment.${row.paymentStatus}`)}
    </Badge>
  );
}

/** The demo's bills in the same shape as the server's list. */
function demoRows(): InvoiceRow[] {
  return [...INVOICES]
    .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number))
    .map((i) => {
      const balance = Math.max(0, i.total - i.paid);
      return {
        id: i.id,
        invoiceNumber: i.number,
        invoiceDate: i.date,
        dueDate: i.dueDate,
        customerId: i.customerId,
        partyName: customerById.get(i.customerId)?.businessName ?? "—",
        grandTotal: String(i.total),
        amountPaid: String(i.paid),
        balanceDue: String(balance),
        paymentStatus: balance <= 0.5 ? "paid" : i.paid > 0 ? "partial" : "unpaid",
        status: "posted",
      };
    });
}

/** Rows kept on this device or from the demo, filtered here as the server would. */
function filterHere(rows: InvoiceRow[], f: { q: string; payment: Payment; status: Status; from: string; to: string; held: boolean }): InvoiceRow[] {
  const needle = f.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.status === "all" || r.status === f.status) &&
      (f.payment === "all" || (f.payment === "open" ? r.status === "posted" && Number(r.balanceDue) > 0 : r.paymentStatus === f.payment)) &&
      (!f.from || r.invoiceDate >= f.from) &&
      (!f.to || r.invoiceDate <= f.to) &&
      (!f.held || r.reviewStatus === "needs_review") &&
      (needle.length < 2 || `${r.invoiceNumber} ${r.partyName}`.toLowerCase().includes(needle)),
  );
}

/** Every sales bill: search, filter by date, payment and status, export, open one. */
export function InvoicesPage() {
  const { t, money, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const version = useStoreVersion();
  const [q, setQ] = useState("");
  const [payment, setPayment] = useState<Payment>("all");
  const [status, setStatus] = useState<Status>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [held, setHeld] = useState(false);
  const filters = { q, payment, status, from, to, held };

  const list = usePaged<InvoiceRow>(
    "invoices",
    "/invoices",
    { status, paymentStatus: payment, from, to, q: q.trim().length >= 2 ? q.trim() : undefined, review: held ? "needs_review" : undefined },
    { enabled: LIVE },
  );
  // No connection: the bills kept on this device, to open, print and share.
  const offline = useOffline();
  useDeviceDocuments();
  const noServer = LIVE && (offline.offlineMode || !offline.online || (list.error !== null && unreachable(list.error)));
  const demo = useMemo(() => (LIVE ? [] : demoRows()), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = !LIVE ? filterHere(demo, filters) : noServer ? filterHere(deviceDocuments<InvoiceRow>("invoice"), filters) : list.rows;

  const posted = rows.filter((r) => r.status === "posted");
  const total = posted.reduce((s, r) => s + Number(r.grandTotal), 0);
  const due = posted.reduce((s, r) => s + Number(r.balanceDue), 0);

  const columns: Column<InvoiceRow>[] = [
    {
      key: "bill",
      header: t("invoice.number"),
      sortValue: (r) => r.invoiceNumber,
      render: (r) => (
        <div>
          <p className="font-mono text-[12.5px] font-medium whitespace-nowrap text-accent">{r.invoiceNumber}</p>
          {r.reviewStatus === "needs_review" && <p className="text-[12px] text-warn">{t("bills.onlyHeld")}</p>}
        </div>
      ),
    },
    { key: "date", header: t("common.date"), sortValue: (r) => r.invoiceDate, render: (r) => <span className="text-ink-2">{dateMedium(r.invoiceDate)}</span> },
    { key: "customer", header: t("invoice.customer"), sortValue: (r) => r.partyName, render: (r) => <span className="text-ink">{r.partyName}</span> },
    {
      key: "dueDate",
      header: t("invoice.dueDate"),
      sortValue: (r) => r.dueDate,
      render: (r) => (r.dueDate ? <span className={isOverdue(r) ? "text-danger" : "text-ink-2"}>{dateMedium(r.dueDate)}</span> : <span className="text-ink-3">—</span>),
    },
    { key: "status", header: t("common.status"), render: (r) => <InvoiceStatusBadge row={r} /> },
    { key: "total", header: t("common.total"), align: "right", sortValue: (r) => Number(r.grandTotal), render: (r) => <span className={r.status === "cancelled" ? "text-ink-3 line-through" : "font-medium text-ink"}>{money(r.grandTotal)}</span> },
    {
      key: "balance",
      header: t("invoice.balance"),
      align: "right",
      sortValue: (r) => (r.status === "posted" ? Number(r.balanceDue) : null),
      render: (r) => (r.status === "posted" && Number(r.balanceDue) > 0.5 ? <span className="font-semibold text-ink">{money(r.balanceDue)}</span> : <span className="text-ink-3">—</span>),
    },
  ];

  const exportCsv = () =>
    downloadCsv(
      "sales-bills.csv",
      [
        { label: t("invoice.number"), value: (r) => r.invoiceNumber },
        { label: t("common.date"), value: (r) => r.invoiceDate },
        { label: t("invoice.customer"), value: (r) => r.partyName },
        { label: t("invoice.dueDate"), value: (r) => r.dueDate ?? "" },
        { label: t("common.status"), value: (r) => (r.status === "cancelled" ? r.status : r.paymentStatus) },
        { label: t("common.total"), value: (r) => r.grandTotal },
        { label: t("invoice.balance"), value: (r) => r.balanceDue },
      ],
      rows,
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("bills.title")}
        subtitle={
          <>
            {t("common.total")} {money(total, 0)} · {t("bills.openOnly")} {money(due, 0)}
          </>
        }
        actions={
          <>
            {allowed("invoice.export") && (
              <Button icon={<Download size={16} />} onClick={exportCsv} disabled={rows.length === 0}>
                {t("common.export")}
              </Button>
            )}
            {allowed("invoice.create") && (
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate({ name: "invoice-new" })}>
                {t("nav.newInvoice")}
              </Button>
            )}
          </>
        }
      />
      <FilterBar>
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("bills.search")} aria-label={t("bills.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t("bills.payment")} value={payment} onChange={(e) => setPayment(e.target.value as Payment)} className="md:w-44">
          <option value="all">
            {t("bills.payment")}: {t("common.all")}
          </option>
          <option value="open">{t("bills.openOnly")}</option>
          <option value="unpaid">{t("status.payment.unpaid")}</option>
          <option value="partial">{t("status.payment.partial")}</option>
          <option value="paid">{t("status.payment.paid")}</option>
        </Select>
        <Segmented
          size="sm"
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: t("common.all") },
            { value: "posted", label: t("status.document.posted") },
            { value: "cancelled", label: t("common.cancelled") },
          ]}
        />
        <Input type="date" aria-label={t("common.from")} value={from} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
        <Input type="date" aria-label={t("common.to")} value={to} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
        {LIVE && allowed("invoice.review") && (
          <button
            type="button"
            aria-pressed={held}
            onClick={() => setHeld((h) => !h)}
            className={
              held
                ? "h-9 rounded-full border border-accent bg-accent-soft px-3.5 text-[13px] font-medium text-accent-ink"
                : "h-9 rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink-2 hover:border-line-strong"
            }
          >
            {t("bills.onlyHeld")}
          </button>
        )}
      </FilterBar>
      {LIVE && <WaitingStrip kinds={["invoice", "invoice-cancel"]} />}
      {noServer ? (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">
          <CloudOff size={15} className="mt-0.5 shrink-0" />
          {t("bills.keptBills")}
        </p>
      ) : LIVE && list.error ? (
        <ErrorNote error={list.error} />
      ) : null}
      <DataTable
        id="sales-bills"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={LIVE && !noServer && list.loading}
        minWidth={760}
        onRowClick={(r) => navigate({ name: "invoice-view", invoiceId: r.id })}
        empty={
          <EmptyState
            title={t("bills.empty")}
            hint={t("bills.emptyHint")}
            {...(allowed("invoice.create")
              ? {
                  action: (
                    <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate({ name: "invoice-new" })}>
                      {t("nav.newInvoice")}
                    </Button>
                  ),
                }
              : {})}
          />
        }
      />
      {LIVE && !noServer && <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />}
    </div>
  );
}
