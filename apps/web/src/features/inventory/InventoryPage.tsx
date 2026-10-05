import { useQuery, useQueryClient } from "@tanstack/react-query";
import { searchProducts } from "@digitalbahi/core";
import type { TranslationKey } from "@digitalbahi/i18n";
import { ArrowLeftRight, ClipboardCheck, Download, Search, Trash2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, RowCard, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { allowed, productById, TODAY, WORKSPACE } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { downloadCsv } from "../../lib/download";
import { stockInPacks } from "../../lib/packs";
import { usePaged } from "../../lib/usePaged";
import { TransferDialog } from "./TransferDialog";

interface StockRow {
  productId: string;
  code: string;
  name: string;
  unit: string;
  qty: string;
  minStock: string | null;
  reorderQty: string | null;
  level: "ok" | "low" | "out";
  avgCost?: string;
  value?: string;
}

const REASONS = ["count_correction", "damage", "expiry", "theft", "sample", "internal_use", "other"] as const;
type Reason = (typeof REASONS)[number];
const MOVEMENTS = new Set(["opening", "purchase", "purchase_return", "sale", "sale_return", "adjustment_in", "adjustment_out", "transfer_in", "transfer_out", "damaged", "expired", "free_in", "free_out", "consumption"]);

export function InventoryPage() {
  const { t, money, number } = useI18n();
  const [q, setQ] = useState("");
  const [level, setLevel] = useState<"all" | "low" | "out">("all");
  const [ledgerFor, setLedgerFor] = useState<StockRow | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [warehouseId, setWarehouseId] = useState("");
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const list = usePaged<StockRow>("stock", "/stock", { level, warehouseId, q: q.trim() || undefined }, { pageSize: 100 });
  const transfers = useQuery({
    queryKey: ["stock", "transfers"],
    queryFn: () => api.get<{ data: Array<{ id: string; transferNumber: string; transferDate: string; from: string; to: string; notes: string | null; lines: number; qty: string }> }>("/stock/transfers").then((r) => r.data),
    enabled: godowns.length > 1,
  });
  const adjustments = useQuery({
    queryKey: ["stock", "adjustments"],
    queryFn: () => api.get<{ data: Array<{ id: string; adjustmentNumber: string; adjustmentDate: string; reason: Reason; notes: string | null }> }>("/stock/adjustments").then((r) => r.data),
  });
  const showValue = list.rows.some((r) => r.value !== undefined);
  const packs = (r: StockRow) => stockInPacks(r.qty, productById.get(r.productId), (n) => number(n));
  const qtyTone = (r: StockRow) => (r.level === "out" ? "danger" : r.level === "low" ? "warn" : undefined);
  const totalValue = list.rows.reduce((s, r) => s + Number(r.value ?? 0), 0);

  const columns: Column<StockRow>[] = [
    {
      key: "name",
      header: t("product.name"),
      render: (r) => (
        <div>
          <p className="font-medium text-ink">{r.name}</p>
          <p className="font-mono text-[12px] text-ink-3">{r.code}</p>
        </div>
      ),
    },
    {
      key: "level",
      header: t("common.status"),
      render: (r) => (r.level === "ok" ? <span className="text-ink-3">{t("status.stock.ok")}</span> : <Badge tone={r.level === "out" ? "danger" : "warn"}>{t(r.level === "out" ? "status.stock.out_of_stock" : "status.stock.low")}</Badge>),
    },
    { key: "min", header: t("product.minStock"), align: "right", render: (r) => <span className="text-ink-2">{r.minStock ? number(r.minStock) : "—"}</span> },
    {
      key: "qty",
      header: t("product.currentStock"),
      align: "right",
      render: (r) => (
        <div>
          <p className={r.level === "out" ? "font-semibold text-danger" : r.level === "low" ? "font-semibold text-warn" : "font-semibold text-ink"}>{packs(r) ?? `${number(r.qty)} ${r.unit}`}</p>
          {packs(r) && (
            <p className="text-[12px] text-ink-3">
              = {number(r.qty)} {r.unit}
            </p>
          )}
        </div>
      ),
    },
    ...(showValue
      ? [
          { key: "cost", header: t("inventory.avgCost"), align: "right" as const, render: (r: StockRow) => <span className="text-ink-2">{money(r.avgCost ?? 0)}</span> },
          { key: "value", header: t("product.stockValue"), align: "right" as const, render: (r: StockRow) => money(r.value ?? 0) },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("inventory.title")}
        subtitle={showValue ? `${t("product.stockValue")} ${money(totalValue, 0)}` : undefined}
        actions={
          <>
            <Button
              icon={<Download size={16} />}
              onClick={() =>
                downloadCsv(
                  `stock-${TODAY}.csv`,
                  [
                    { label: t("product.code"), value: (r) => r.code },
                    { label: t("product.name"), value: (r) => r.name },
                    { label: t("product.unit"), value: (r) => r.unit },
                    { label: t("product.currentStock"), value: (r) => r.qty },
                    { label: t("product.minStock"), value: (r) => r.minStock },
                    ...(showValue ? [{ label: t("inventory.avgCost"), value: (r: StockRow) => r.avgCost }, { label: t("product.stockValue"), value: (r: StockRow) => r.value }] : []),
                  ],
                  list.rows,
                )
              }
            >
              {t("common.export")}
            </Button>
            {allowed("inventory.transfer") && godowns.length > 1 && (
              <Button icon={<ArrowLeftRight size={16} />} onClick={() => setTransferring(true)}>
                {t("godowns.transfer")}
              </Button>
            )}
            {allowed("inventory.adjust") && (
              <Button variant="primary" icon={<ClipboardCheck size={16} />} onClick={() => setAdjusting(true)}>
                {t("inventory.adjust")}
              </Button>
            )}
          </>
        }
      />
      <Tabs.Root defaultValue="stock" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("inventory.title")}>
          <Tabs.Trigger value="stock" className={TAB_TRIGGER}>
            {t("inventory.stock")}
          </Tabs.Trigger>
          <Tabs.Trigger value="adjustments" className={TAB_TRIGGER}>
            {t("inventory.adjustments")}
          </Tabs.Trigger>
          {godowns.length > 1 && (
            <Tabs.Trigger value="transfers" className={TAB_TRIGGER}>
              {t("godowns.transfers")}
            </Tabs.Trigger>
          )}
        </Tabs.List>
        <Tabs.Content value="stock" className="flex flex-col gap-4">
          <FilterBar>
            <Input className="flex-1" leading={<Search size={16} />} placeholder={t("product.search")} aria-label={t("product.search")} value={q} onChange={(e) => setQ(e.target.value)} />
            {godowns.length > 1 && (
              <Select aria-label={t("godowns.godown")} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="md:w-48">
                <option value="">{t("godowns.allGodowns")}</option>
                {godowns.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
            <Segmented
              size="sm"
              label={t("common.status")}
              value={level}
              onChange={setLevel}
              options={[
                { value: "all", label: t("common.all") },
                { value: "low", label: t("product.filters.lowStock") },
                { value: "out", label: t("product.filters.outOfStock") },
              ]}
            />
          </FilterBar>
          {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
          <DataTable
            columns={columns}
            rows={list.rows}
            rowKey={(r) => r.productId}
            loading={list.loading}
            onRowClick={(r) => setLedgerFor(r)}
            minWidth={720}
            mobile={(r) => (
              <RowCard
                title={r.name}
                sub={[r.code, r.level === "ok" ? null : t(r.level === "out" ? "status.stock.out_of_stock" : "status.stock.low"), showValue && r.value !== undefined ? `${t("product.stockValue")} ${money(r.value)}` : null].filter(Boolean).join(" · ")}
                value={packs(r) ?? `${number(r.qty)} ${r.unit}`}
                tone={qtyTone(r)}
                valueSub={packs(r) ? `= ${number(r.qty)} ${r.unit}` : undefined}
              />
            )}
          />
          <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
        </Tabs.Content>
        <Tabs.Content value="adjustments">
          <DataTable
            rows={adjustments.data ?? []}
            loading={adjustments.isPending}
            rowKey={(a) => a.id}
            columns={[
              { key: "date", header: t("common.date"), render: (a) => a.adjustmentDate },
              { key: "number", header: t("common.number"), render: (a) => <span className="font-medium text-ink">{a.adjustmentNumber}</span> },
              { key: "reason", header: t("common.reason"), render: (a) => t(`inventory.reasons.${a.reason}`) },
              { key: "notes", header: t("common.notes"), render: (a) => <span className="text-ink-2">{a.notes ?? ""}</span> },
            ]}
          />
        </Tabs.Content>
        {godowns.length > 1 && (
          <Tabs.Content value="transfers">
            <DataTable
              rows={transfers.data ?? []}
              loading={transfers.isPending}
              rowKey={(x) => x.id}
              columns={[
                { key: "date", header: t("common.date"), render: (x) => x.transferDate },
                { key: "number", header: t("common.number"), render: (x) => <span className="font-medium text-ink">{x.transferNumber}</span> },
                { key: "route", header: `${t("godowns.from")} → ${t("godowns.to")}`, render: (x) => `${x.from} → ${x.to}` },
                { key: "lines", header: t("invoice.items"), align: "right", render: (x) => x.lines },
                { key: "notes", header: t("common.notes"), render: (x) => <span className="text-ink-2">{x.notes ?? ""}</span> },
              ]}
            />
          </Tabs.Content>
        )}
      </Tabs.Root>
      <StockLedgerDialog row={ledgerFor} onClose={() => setLedgerFor(null)} />
      <TransferDialog open={transferring} onOpenChange={setTransferring} />
      <AdjustmentDialog open={adjusting} onOpenChange={setAdjusting} />
    </div>
  );
}

function StockLedgerDialog({ row, onClose }: { row: StockRow | null; onClose(): void }) {
  const { t, number, dateMedium } = useI18n();
  const q = useQuery({
    queryKey: ["stock", "ledger", row?.productId],
    enabled: Boolean(row),
    queryFn: () =>
      api.get<{
        opening: string;
        closing: string;
        entries: Array<{ id: number; date: string; type: string; qtyIn: string; qtyOut: string; balance: string; refNumber: string | null; reason: string | null }>;
      }>("/stock/ledger", { productId: row!.productId, limit: 500 }),
  });
  return (
    <Dialog open={Boolean(row)} onOpenChange={(v) => !v && onClose()} title={row?.name ?? ""} description={row ? `${row.code} · ${t("product.currentStock")} ${number(row.qty)} ${row.unit}` : undefined} size="lg" closeLabel={t("common.close")}>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          rows={[...q.data.entries].reverse()}
          rowKey={(e) => String(e.id)}
          minWidth={560}
          columns={[
            { key: "date", header: t("common.date"), render: (e) => <span className="text-ink-2">{dateMedium(e.date)}</span> },
            {
              key: "doc",
              header: t("customer.ledger.particulars"),
              render: (e) => (
                <span className="text-ink">
                  {MOVEMENTS.has(e.type) ? t(`inventory.movement.${e.type}` as TranslationKey) : e.type}
                  {e.refNumber && <span className="text-ink-3"> · {e.refNumber}</span>}
                </span>
              ),
            },
            { key: "in", header: t("inventory.in"), align: "right", render: (e) => (Number(e.qtyIn) ? <span className="text-good">+{number(e.qtyIn)}</span> : "") },
            { key: "out", header: t("inventory.out"), align: "right", render: (e) => (Number(e.qtyOut) ? <span className="text-danger">−{number(e.qtyOut)}</span> : "") },
            { key: "bal", header: t("customer.ledger.runningBalance"), align: "right", render: (e) => <span className="font-medium">{number(e.balance)}</span> },
          ]}
        />
      )}
    </Dialog>
  );
}

interface AdjLine {
  productId: string;
  value: string;
}

/**
 * Stock is never edited directly: a count correction, damage or expiry is a
 * numbered adjustment whose lines become ledger rows. For a count, enter what
 * is on the shelf and the difference is posted.
 */
function AdjustmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, number } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const searchable = useSearchableProducts();
  const [reason, setReason] = useState<Reason>("count_correction");
  const [notes, setNotes] = useState("");
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState("");
  // With several godowns a count is compared with that godown's stock, not the total.
  const [byGodown, setByGodown] = useState<Record<string, Record<string, number>>>({});
  const godownId = warehouseId || (godowns.find((w) => w.isDefault)?.id ?? "");
  const systemQty = (productId: string) =>
    godowns.length > 1 ? (byGodown[productId]?.[godownId] ?? 0) : (productById.get(productId)?.stock ?? 0);
  const addLine = (id: string) => {
    if (lines.some((l) => l.productId === id)) return;
    setLines((ls) => [...ls, { productId: id, value: "" }]);
    if (godowns.length > 1) {
      void api.get<{ stock: { byWarehouse: Array<{ warehouseId: string; qty: string }> } }>(`/products/${id}`).then((d) =>
        setByGodown((m) => ({ ...m, [id]: Object.fromEntries(d.stock.byWarehouse.map((w) => [w.warehouseId, Number(w.qty)])) })),
      );
    }
  };
  const [lines, setLines] = useState<AdjLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setReason("count_correction");
      setNotes("");
      setLines([]);
      setByGodown({});
      setWarehouseId("");
      setError(null);
    }
  }, [open]);

  const signed = reason === "other";
  const change = (l: AdjLine): number | null => {
    if (!/^-?\d{1,12}(\.\d{1,3})?$/.test(l.value)) return null;
    const v = Number(l.value);
    if (reason === "count_correction") return Math.round((v - systemQty(l.productId)) * 1000) / 1000;
    if (signed) return v;
    return -Math.abs(v);
  };
  const ready = lines.length > 0 && lines.every((l) => {
    const c = change(l);
    return c !== null && c !== 0;
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ adjustmentNumber: string; lines: unknown[] }>("/stock/adjustments", {
        reason,
        ...(warehouseId ? { warehouseId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.map((l) => ({ productId: l.productId, qtyChange: String(change(l)) })),
      });
      await refreshCatalog().catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("inventory.adjusted"), body: `${res.adjustmentNumber} · ${t("common.items", { count: res.lines.length })}` });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("inventory.adjust")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("common.reason")} htmlFor="adj-reason" hint={t(`inventory.reasonHints.${reason === "count_correction" ? "count" : signed ? "signed" : "out"}`)}>
            <Select id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`inventory.reasons.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          {godowns.length > 1 && (
            <Field label={t("godowns.godown")} htmlFor="adj-godown">
              <Select id="adj-godown" value={warehouseId || (godowns.find((w) => w.isDefault)?.id ?? "")} onChange={(e) => setWarehouseId(e.target.value)}>
                {godowns.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("common.notes")} htmlFor="adj-notes" hint={t("common.optional")}>
            <Input id="adj-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <SearchSelect
          value={null}
          onChange={(id) => id && addLine(id)}
          placeholder={t("invoice.searchProduct")}
          clearLabel={t("common.clear")}
          emptyText={t("empty.products")}
          search={(q) => (q.trim() ? searchProducts(q, searchable, { limit: 8 }).map((h) => h.product) : []).map((p) => ({ id: p.id, label: p.name, sub: p.code, trailing: `${number(p.stock)} ${p.unit}` }))}
        />
        {lines.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {lines.map((l) => {
              const p = productById.get(l.productId);
              const c = change(l);
              return (
                <li key={l.productId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-ink">{p?.name}</p>
                    <p className="num text-[12px] text-ink-3">
                      {t("inventory.system")}: {number(systemQty(l.productId))} {p?.unit}
                      {c !== null && c !== 0 && (
                        <span className={c > 0 ? "text-good" : "text-danger"}>
                          {" "}
                          → {c > 0 ? "+" : ""}
                          {number(c)}
                        </span>
                      )}
                    </p>
                  </div>
                  <Input
                    inputSize="sm"
                    inputMode="decimal"
                    aria-label={reason === "count_correction" ? t("inventory.counted") : t("invoice.qty")}
                    placeholder={reason === "count_correction" ? t("inventory.counted") : t("invoice.qty")}
                    className="w-28 [&_input]:text-right"
                    value={l.value}
                    onChange={(e) => setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, value: e.target.value.trim() } : x)))}
                  />
                  <IconButton label={t("invoice.remove")} onClick={() => setLines((ls) => ls.filter((x) => x.productId !== l.productId))}>
                    <Trash2 size={16} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
