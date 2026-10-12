import type { GoodsReceiptRow, PurchaseOrderRow } from "@digitalbahi/contracts";
import { Search } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { hashFor, useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Input } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, RowCard, type Column } from "../../components/ui/Page";
import { usePaged } from "../../lib/usePaged";
import { ORDER_STATUS_TONE, RECEIPT_STATUS_TONE } from "./buying";

/** Orders to suppliers: those still to come first by default. */
export function PurchaseOrdersList() {
  const { t, amount, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"pending" | "received" | "all">("pending");
  const list = usePaged<PurchaseOrderRow>("purchase-orders", "/purchase-orders", { status, q: q.trim().length >= 2 ? q.trim() : undefined });
  const columns: Column<PurchaseOrderRow>[] = [
    { key: "date", header: t("buying.order.date"), sortValue: (o) => o.orderDate, render: (o) => <span className="text-ink-2">{dateMedium(o.orderDate)}</span> },
    { key: "number", header: t("buying.order.number"), sortValue: (o) => o.orderNumber, render: (o) => <span className="font-medium text-ink">{o.orderNumber}</span> },
    { key: "supplier", header: t("nav.suppliers"), sortValue: (o) => o.partyName, render: (o) => <span className="text-ink">{o.partyName}</span> },
    { key: "status", header: t("common.status"), sortValue: (o) => o.status, render: (o) => <Badge tone={ORDER_STATUS_TONE[o.status]}>{t(`buying.order.status.${o.status}`)}</Badge> },
    { key: "left", header: t("buying.order.left"), align: "right", sortValue: (o) => o.pendingLines, render: (o) => (o.pendingLines ? t("common.items", { count: o.pendingLines }) : <span className="text-ink-3">—</span>) },
    { key: "wanted", header: t("buying.order.expected"), sortValue: (o) => o.expectedDate, render: (o) => (o.expectedDate ? dateMedium(o.expectedDate) : <span className="text-ink-3">—</span>) },
    { key: "total", header: t("common.total"), align: "right", sortValue: (o) => Number(o.grandTotal), render: (o) => <span className={o.status === "cancelled" ? "text-ink-3 line-through" : "font-medium text-ink"}>{amount(o.grandTotal)}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        quick={
          <Segmented
            size="sm"
            label={t("common.status")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "pending", label: t("buying.order.pending") },
              { value: "received", label: t("buying.order.status.received") },
              { value: "all", label: t("common.all") },
            ]}
          />
        }
      >
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("buying.order.search")} aria-label={t("buying.order.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <DataTable
        id="purchase-orders"
        columns={columns}
        rows={list.rows}
        rowKey={(o) => o.id}
        loading={list.loading}
        onRowClick={(o) => navigate({ name: "purchase-order-view", purchaseOrderId: o.id })}
        rowHref={(o) => hashFor({ name: "purchase-order-view", purchaseOrderId: o.id })}
        mobile={(o) => (
          <RowCard
            title={o.partyName}
            sub={`${o.orderNumber} · ${dateMedium(o.orderDate)}`}
            value={amount(o.grandTotal)}
            tone={o.status === "cancelled" ? "muted" : undefined}
            valueSub={<Badge tone={ORDER_STATUS_TONE[o.status]}>{t(`buying.order.status.${o.status}`)}</Badge>}
          />
        )}
        empty={<EmptyState title={t("buying.order.empty")} hint={t("buying.order.emptyHint")} />}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}

/** Goods received before their bill: those waiting for it first by default. */
export function GoodsReceiptsList() {
  const { t, amount, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"received" | "billed" | "all">("received");
  const list = usePaged<GoodsReceiptRow>("goods-receipts", "/goods-receipts", { status, q: q.trim().length >= 2 ? q.trim() : undefined });
  const columns: Column<GoodsReceiptRow>[] = [
    { key: "date", header: t("buying.receipt.date"), sortValue: (g) => g.receivedDate, render: (g) => <span className="text-ink-2">{dateMedium(g.receivedDate)}</span> },
    {
      key: "number",
      header: t("buying.receipt.number"),
      sortValue: (g) => g.receiptNumber,
      render: (g) => (
        <div>
          <p className="font-medium text-ink">{g.receiptNumber}</p>
          {g.challanNumber && <p className="text-[12px] text-ink-3">{g.challanNumber}</p>}
        </div>
      ),
    },
    { key: "supplier", header: t("nav.suppliers"), sortValue: (g) => g.partyName, render: (g) => <span className="text-ink">{g.partyName}</span> },
    { key: "order", header: t("buying.receipt.order"), sortValue: (g) => g.orderNumber, render: (g) => g.orderNumber ?? <span className="text-ink-3">—</span> },
    { key: "status", header: t("common.status"), sortValue: (g) => g.status, render: (g) => <Badge tone={RECEIPT_STATUS_TONE[g.status]}>{t(`buying.receipt.status.${g.status}`)}</Badge> },
    { key: "value", header: t("buying.receipt.value"), align: "right", sortValue: (g) => Number(g.totalValue), render: (g) => <span className={g.status === "cancelled" ? "text-ink-3 line-through" : "font-medium text-ink"}>{amount(g.totalValue)}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        quick={
          <Segmented
            size="sm"
            label={t("common.status")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "received", label: t("buying.receipt.status.received") },
              { value: "billed", label: t("buying.receipt.status.billed") },
              { value: "all", label: t("common.all") },
            ]}
          />
        }
      >
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("buying.receipt.search")} aria-label={t("buying.receipt.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <DataTable
        id="goods-receipts"
        columns={columns}
        rows={list.rows}
        rowKey={(g) => g.id}
        loading={list.loading}
        onRowClick={(g) => navigate({ name: "goods-receipt-view", goodsReceiptId: g.id })}
        rowHref={(g) => hashFor({ name: "goods-receipt-view", goodsReceiptId: g.id })}
        mobile={(g) => (
          <RowCard
            title={g.partyName}
            sub={`${g.receiptNumber} · ${dateMedium(g.receivedDate)}`}
            value={amount(g.totalValue)}
            tone={g.status === "cancelled" ? "muted" : undefined}
            valueSub={<Badge tone={RECEIPT_STATUS_TONE[g.status]}>{t(`buying.receipt.status.${g.status}`)}</Badge>}
          />
        )}
        empty={<EmptyState title={t("buying.receipt.empty")} hint={t("buying.receipt.emptyHint")} />}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}
