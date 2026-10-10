import { useQuery } from "@tanstack/react-query";
import { ClipboardPlus, FileText, Search } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { hashFor, useRouter } from "../../app/router";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { EmptyState, ProgressBar, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, RowCard, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { allowed, TODAY } from "../../data/db";
import { api } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { OrderEntryDialog } from "./OrderEntryDialog";

export type OrderStatus = "draft" | "pending" | "confirmed" | "packing" | "packed" | "dispatched" | "delivered" | "cancelled";

export const ORDER_TONE: Record<OrderStatus, Tone> = {
  draft: "neutral",
  pending: "warn",
  confirmed: "accent",
  packing: "accent",
  packed: "accent",
  dispatched: "accent",
  delivered: "good",
  cancelled: "danger",
};

interface OrderRow {
  id: string;
  orderNumber: string;
  quotationNumber?: string | null;
  validUntil?: string | null;
  orderDate: string;
  expectedDeliveryDate: string | null;
  customerId: string;
  partyName: string;
  status: OrderStatus;
  source: string;
  grandTotal: string;
  lines: number;
  invoiced: string;
}

export function OrdersPage({ newOrder, customerId }: { newOrder?: boolean; customerId?: string }) {
  const { t, money, dateMedium, number } = useI18n();
  const { navigate } = useRouter();
  const [status, setStatus] = useState<"open" | "pending" | "confirmed" | "all">("open");
  const [q, setQ] = useState("");
  const [entering, setEntering] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const list = usePaged<OrderRow>("orders", "/sales-orders", { status, q: q.trim().length >= 2 ? q.trim() : undefined });
  // Quotations: priced like orders, waiting on the customer's yes.
  const quotes = usePaged<OrderRow>("orders", "/sales-orders", { status: "draft", q: q.trim().length >= 2 ? q.trim() : undefined });
  const demand = useQuery({
    queryKey: ["orders", "demand"],
    queryFn: () => api.get<{ data: Array<{ productId: string; name: string; qty: string; stock: string; orders: number; short: boolean }> }>("/sales-orders/demand").then((r) => r.data),
  });

  useEffect(() => {
    if (newOrder) setEntering(true);
  }, [newOrder]);

  const columns: Column<OrderRow>[] = [
    { key: "date", header: t("common.date"), sortValue: (o) => o.orderDate, render: (o) => <span className="text-ink-2">{dateMedium(o.orderDate)}</span> },
    {
      key: "number",
      header: t("common.number"),
      sortValue: (o) => o.orderNumber,
      render: (o) => (
        <div>
          <p className="font-medium text-ink">{o.orderNumber}</p>
          <p className="text-[12px] text-ink-3">{t(`orders.sources.${o.source as "counter"}`, {})}</p>
        </div>
      ),
    },
    { key: "customer", header: t("customer.name"), sortValue: (o) => o.partyName, render: (o) => <span className="text-ink">{o.partyName}</span> },
    { key: "status", header: t("common.status"), sortValue: (o) => t(`status.order.${o.status}`), render: (o) => <Badge tone={ORDER_TONE[o.status]}>{t(`status.order.${o.status}`)}</Badge> },
    {
      key: "invoiced",
      header: t("orders.invoiced"),
      sortValue: (o) => Number(o.invoiced),
      render: (o) => (
        <div className="flex w-28 items-center gap-2">
          <ProgressBar value={Number(o.invoiced)} tone={Number(o.invoiced) >= 1 ? "good" : "accent"} label={t("orders.invoiced")} />
          <span className="num text-[12px] text-ink-3">{Math.round(Number(o.invoiced) * 100)}%</span>
        </div>
      ),
    },
    { key: "delivery", header: t("orders.deliveryDate"), sortValue: (o) => o.expectedDeliveryDate, render: (o) => <span className="text-ink-2">{o.expectedDeliveryDate ? dateMedium(o.expectedDeliveryDate) : "—"}</span> },
    { key: "total", header: t("common.total"), align: "right", sortValue: (o) => Number(o.grandTotal), render: (o) => <span className={o.status === "cancelled" ? "text-ink-3 line-through" : "font-medium text-ink"}>{money(o.grandTotal)}</span> },
  ];
  // On a phone: a card a row, the shop and its amount first (the table would need sideways scrolling).
  const card = (o: OrderRow, label: string, note: string) => (
    <RowCard
      title={o.partyName}
      sub={`${label} · ${note}`}
      value={money(o.grandTotal)}
      {...(o.status === "cancelled" ? { tone: "muted" as const } : {})}
      valueSub={<Badge tone={ORDER_TONE[o.status]}>{t(`status.order.${o.status}`)}</Badge>}
    />
  );
  const open = (o: OrderRow) => navigate({ name: "order-view", orderId: o.id });
  const href = (o: OrderRow) => hashFor({ name: "order-view", orderId: o.id });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("orders.title")}
        subtitle={t("orders.subtitle")}
        actions={
          allowed("order.create") ? (
            <>
              <Button icon={<FileText size={16} />} onClick={() => setQuoting(true)}>
                {t("orders.quotation.new")}
              </Button>
              <Button variant="primary" icon={<ClipboardPlus size={16} />} onClick={() => setEntering(true)}>
                {t("orders.new")}
              </Button>
            </>
          ) : undefined
        }
      />
      <Tabs.Root defaultValue="orders" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("orders.title")}>
          <Tabs.Trigger value="orders" className={TAB_TRIGGER}>
            {t("orders.title")}
          </Tabs.Trigger>
          <Tabs.Trigger value="quotes" className={TAB_TRIGGER}>
            {t("orders.quotation.tab")}
            {quotes.rows.length > 0 && <span className="num ml-1.5 text-ink-3">{quotes.rows.length}{quotes.hasMore ? "+" : ""}</span>}
          </Tabs.Trigger>
          <Tabs.Trigger value="demand" className={TAB_TRIGGER}>
            {t("orders.demand")}
            {demand.data?.some((d) => d.short) && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-danger align-middle" aria-hidden />}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="orders" className="flex flex-col gap-4">
          <FilterBar>
            <Input className="flex-1" leading={<Search size={16} />} placeholder={t("orders.search")} aria-label={t("orders.search")} value={q} onChange={(e) => setQ(e.target.value)} />
            <Segmented
              size="sm"
              label={t("common.status")}
              value={status}
              onChange={setStatus}
              options={[
                { value: "open", label: t("orders.open") },
                { value: "pending", label: t("status.order.pending") },
                { value: "confirmed", label: t("status.order.confirmed") },
                { value: "all", label: t("common.all") },
              ]}
            />
          </FilterBar>
          {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
          <DataTable
            id="orders"
            columns={columns}
            rows={list.rows}
            rowKey={(o) => o.id}
            loading={list.loading}
            onRowClick={open}
            rowHref={href}
            mobile={(o) => card(o, o.orderNumber, dateMedium(o.orderDate))}
            minWidth={820}
            empty={<EmptyState title={t("orders.empty")} hint={t("orders.emptyHint")} />}
          />
          <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
        </Tabs.Content>
        <Tabs.Content value="quotes" className="flex flex-col gap-4">
          <p className="text-[13px] text-ink-3">{t("orders.quotation.listHint")}</p>
          {quotes.error ? <ErrorNote error={quotes.error} onRetry={() => void quotes.refetch()} /> : null}
          <DataTable
            id="quotations"
            columns={[
              columns[0]!,
              { key: "number", header: t("common.number"), sortValue: (o) => o.quotationNumber ?? o.orderNumber, render: (o) => <span className="font-medium text-ink">{o.quotationNumber ?? o.orderNumber}</span> },
              columns[2]!,
              {
                key: "valid",
                header: t("orders.quotation.validUntil"),
                sortValue: (o) => o.validUntil,
                render: (o) => (o.validUntil ? <span className={o.validUntil < TODAY ? "text-danger" : "text-ink-2"}>{dateMedium(o.validUntil)}</span> : <span className="text-ink-3">—</span>),
              },
              columns[columns.length - 1]!,
            ]}
            rows={quotes.rows}
            rowKey={(o) => o.id}
            loading={quotes.loading}
            onRowClick={open}
            rowHref={href}
            mobile={(o) => card(o, o.quotationNumber ?? o.orderNumber, o.validUntil ? t("orders.quotation.validUntilShort", { date: dateMedium(o.validUntil) }) : dateMedium(o.orderDate))}
            minWidth={680}
            empty={<EmptyState title={t("orders.quotation.empty")} hint={t("orders.quotation.emptyHint")} />}
          />
          <LoadMore hasMore={quotes.hasMore} loading={quotes.loadingMore} onClick={quotes.loadMore} />
        </Tabs.Content>
        <Tabs.Content value="demand">
          <p className="mb-3 text-[13px] text-ink-3">{t("orders.demandHint")}</p>
          <DataTable
            id="order-demand"
            rows={demand.data ?? []}
            loading={demand.isPending}
            rowKey={(d) => d.productId}
            empty={<EmptyState title={t("orders.noDemand")} hint={t("orders.noDemandHint")} />}
            columns={[
              { key: "name", header: t("product.name"), sortValue: (d) => d.name, render: (d) => <span className="font-medium text-ink">{d.name}</span> },
              { key: "orders", header: t("orders.title"), align: "right", sortValue: (d) => d.orders, render: (d) => d.orders },
              { key: "qty", header: t("orders.toSupply"), align: "right", sortValue: (d) => Number(d.qty), render: (d) => number(d.qty) },
              { key: "stock", header: t("product.currentStock"), align: "right", sortValue: (d) => Number(d.stock), render: (d) => number(d.stock) },
              { key: "short", header: t("common.status"), sortValue: (d) => (d.short ? Number(d.qty) - Number(d.stock) : 0), render: (d) => (d.short ? <Badge tone="danger">{t("orders.short", { qty: number(Number(d.qty) - Number(d.stock)) })}</Badge> : <Badge tone="good">{t("status.stock.ok")}</Badge>) },
            ]}
          />
        </Tabs.Content>
      </Tabs.Root>
      <OrderEntryDialog
        open={entering}
        onOpenChange={(v) => {
          setEntering(v);
          if (!v && newOrder) navigate({ name: "planned", module: "orders" });
        }}
        {...(customerId ? { customerId } : {})}
      />
      <OrderEntryDialog open={quoting} onOpenChange={setQuoting} quotation {...(customerId ? { customerId } : {})} />
    </div>
  );
}
