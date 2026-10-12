import { ClipboardList, CloudOff, Download, FileSpreadsheet, PackageCheck, Plus, Search, TrendingDown } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { hashFor, useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, QuickDates, RowCard, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { downloadCsv } from "../../lib/download";
import { usePaged } from "../../lib/usePaged";
import { WaitingStrip } from "../../components/offline/OfflineBills";
import { deviceDocuments, useDeviceDocuments } from "../../offline/documents";
import { unreachable, useOffline } from "../../offline/sync";
import { BillImportDialog } from "./BillImportDialog";
import { GoodsReceiptsList, PurchaseOrdersList } from "./BuyLists";

export interface PurchaseRow {
  id: string;
  purchaseNumber: string;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: string;
  supplierId: string;
  partyName: string;
  grandTotal: string;
  balanceDue: string;
  paymentStatus: "unpaid" | "partial" | "paid";
  status: "posted" | "cancelled";
}

export function PurchaseStatusBadge({ row }: { row: Pick<PurchaseRow, "status" | "paymentStatus"> }) {
  const { t } = useI18n();
  if (row.status === "cancelled") return <Badge tone="danger">{t("common.cancelled")}</Badge>;
  const tone = row.paymentStatus === "paid" ? "good" : row.paymentStatus === "partial" ? "warn" : "neutral";
  return <Badge tone={tone}>{t(`status.payment.${row.paymentStatus}`)}</Badge>;
}

/**
 * Purchases: the supplier bills, the orders placed with suppliers and the
 * goods received before their bill, each on its own tab.
 */
export function PurchasesPage({ initialTab = "bills" }: { initialTab?: "bills" | "orders" | "receipts" }) {
  const { t, money, amount, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const [tab, setTab] = useState<string>(initialTab);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "posted" | "cancelled">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [importing, setImporting] = useState(false);
  const list = usePaged<PurchaseRow>("purchases", "/purchases", { status, from, to, q: q.trim().length >= 2 ? q.trim() : undefined });
  // No connection: the purchase bills kept on this device (last 30 days), to open and return against.
  const offline = useOffline();
  useDeviceDocuments();
  const noServer = offline.offlineMode || !offline.online || (list.error !== null && unreachable(list.error));
  const needle = q.trim().toLowerCase();
  const rows = noServer
    ? deviceDocuments<PurchaseRow>("purchase").filter(
        (p) =>
          (status === "all" || p.status === status) &&
          (!from || p.supplierInvoiceDate >= from) &&
          (!to || p.supplierInvoiceDate <= to) &&
          (needle.length < 2 || `${p.supplierInvoiceNumber} ${p.purchaseNumber} ${p.partyName}`.toLowerCase().includes(needle)),
      )
    : list.rows;

  const columns: Column<PurchaseRow>[] = [
    { key: "date", header: t("purchase.billDate"), sortValue: (p) => p.supplierInvoiceDate, render: (p) => <span className="text-ink-2">{dateMedium(p.supplierInvoiceDate)}</span> },
    {
      key: "bill",
      header: t("purchase.billNumber"),
      sortValue: (p) => p.supplierInvoiceNumber,
      render: (p) => (
        <div>
          <p className="font-medium text-ink">{p.supplierInvoiceNumber}</p>
          <p className="text-[12px] text-ink-3">{p.purchaseNumber}</p>
        </div>
      ),
    },
    { key: "supplier", header: t("nav.suppliers"), sortValue: (p) => p.partyName, render: (p) => <span className="text-ink">{p.partyName}</span> },
    { key: "status", header: t("common.status"), sortValue: (p) => (p.status === "cancelled" ? p.status : p.paymentStatus), render: (p) => <PurchaseStatusBadge row={p} /> },
    { key: "total", header: t("common.total"), align: "right", sortValue: (p) => Number(p.grandTotal), render: (p) => <span className={p.status === "cancelled" ? "text-ink-3 line-through" : "font-medium text-ink"}>{amount(p.grandTotal)}</span> },
    { key: "due", header: t("common.balance"), align: "right", sortValue: (p) => (p.status === "posted" ? Number(p.balanceDue) : null), render: (p) => (p.status === "posted" && Number(p.balanceDue) > 0 ? <span className="font-semibold text-ink">{amount(p.balanceDue)}</span> : <span className="text-ink-3">—</span>) },
  ];

  const posted = rows.filter((p) => p.status === "posted");
  const total = posted.reduce((s, p) => s + Number(p.grandTotal), 0);
  const due = posted.reduce((s, p) => s + Number(p.balanceDue), 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("purchase.title")}
        subtitle={
          tab === "bills" ? (
            <>
              {t("common.total")} {money(total, 0)} · {t("common.balance")} {money(due, 0)}
            </>
          ) : undefined
        }
        actions={
          tab === "orders" ? (
            <>
              <Button icon={<TrendingDown size={16} />} onClick={() => navigate({ name: "purchase-reorder" })}>
                {t("buying.reorder.button")}
              </Button>
              {allowed("purchase.order") && (
                <Button variant="primary" icon={<ClipboardList size={16} />} onClick={() => navigate({ name: "purchase-order-new" })}>
                  {t("buying.order.new")}
                </Button>
              )}
            </>
          ) : tab === "receipts" ? (
            allowed("purchase.receive") ? (
              <Button variant="primary" icon={<PackageCheck size={16} />} onClick={() => navigate({ name: "goods-receipt-new" })}>
                {t("buying.receipt.new")}
              </Button>
            ) : undefined
          ) : (
            <>
              <Button
                icon={<Download size={16} />}
                onClick={() =>
                  downloadCsv(
                    "purchases.csv",
                    [
                      { label: t("purchase.billDate"), value: (p) => p.supplierInvoiceDate },
                      { label: t("purchase.billNumber"), value: (p) => p.supplierInvoiceNumber },
                      { label: t("purchase.number"), value: (p) => p.purchaseNumber },
                      { label: t("nav.suppliers"), value: (p) => p.partyName },
                      { label: t("common.status"), value: (p) => (p.status === "cancelled" ? p.status : p.paymentStatus) },
                      { label: t("common.total"), value: (p) => p.grandTotal },
                      { label: t("common.balance"), value: (p) => p.balanceDue },
                    ],
                    rows,
                  )
                }
              >
                {t("common.export")}
              </Button>
              {allowed("purchase.create") && (
                <Button icon={<FileSpreadsheet size={16} />} onClick={() => setImporting(true)}>
                  {t("billImport.button")}
                </Button>
              )}
              {allowed("purchase.create") && (
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate({ name: "purchase-new" })}>
                  {t("purchase.new")}
                </Button>
              )}
            </>
          )
        }
      />
      <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("purchase.title")}>
          <Tabs.Trigger value="bills" className={TAB_TRIGGER}>
            {t("buying.tabs.bills")}
          </Tabs.Trigger>
          <Tabs.Trigger value="orders" className={TAB_TRIGGER} data-tab="orders">
            {t("buying.tabs.orders")}
          </Tabs.Trigger>
          <Tabs.Trigger value="receipts" className={TAB_TRIGGER} data-tab="receipts">
            {t("buying.tabs.receipts")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="orders">
          <PurchaseOrdersList />
        </Tabs.Content>
        <Tabs.Content value="receipts">
          <GoodsReceiptsList />
        </Tabs.Content>
        <Tabs.Content value="bills" className="flex flex-col gap-4">
          <FilterBar quick={<QuickDates from={from} to={to} onChange={(f, x) => (setFrom(f), setTo(x))} />}>
            <Input className="flex-1" leading={<Search size={16} />} placeholder={t("purchase.search")} aria-label={t("purchase.search")} value={q} onChange={(e) => setQ(e.target.value)} />
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
          </FilterBar>
          <WaitingStrip kinds={["purchase", "return"]} />
          {noServer ? (
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">
              <CloudOff size={15} className="mt-0.5 shrink-0" />
              {t("offline.keptPurchases")}
            </p>
          ) : list.error ? (
            <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
          ) : null}
          <DataTable
            id="purchases"
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            loading={!noServer && list.loading}
            onRowClick={(p) => navigate({ name: "purchase-view", purchaseId: p.id })}
            rowHref={(p) => hashFor({ name: "purchase-view", purchaseId: p.id })}
            mobile={(p) => (
              <RowCard
                title={p.partyName}
                sub={`${p.supplierInvoiceNumber} · ${dateMedium(p.supplierInvoiceDate)}`}
                value={amount(p.grandTotal)}
                tone={p.status === "cancelled" ? "muted" : undefined}
                valueSub={p.status === "posted" && Number(p.balanceDue) > 0 ? `${t("common.balance")} ${amount(p.balanceDue)}` : <PurchaseStatusBadge row={p} />}
              />
            )}
            empty={
              <EmptyState
                title={t("purchase.empty")}
                hint={t("purchase.emptyHint")}
                {...(allowed("purchase.create")
                  ? {
                      action: (
                        <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate({ name: "purchase-new" })}>
                          {t("purchase.new")}
                        </Button>
                      ),
                    }
                  : {})}
              />
            }
          />
          {!noServer && <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />}
        </Tabs.Content>
      </Tabs.Root>
      <BillImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}
