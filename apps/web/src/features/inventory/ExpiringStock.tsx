import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarX2 } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Select } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, RowCard } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";

interface BatchRow {
  batchId: string;
  productId: string;
  code: string;
  name: string;
  unit: string;
  batchNumber: string;
  expiryDate: string;
  expired: boolean;
  warehouseId: string;
  warehouse: string;
  qty: string;
  value?: string;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * Batches that are past expiry or about to be, soonest first: what to sell
 * first, send back to the supplier or throw away. Expired batches are
 * written off in one step (an "Expired" adjustment per godown, batch-wise).
 */
export function ExpiringStock() {
  const { t, money, number, dateMedium } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"expiring" | "expired">("expiring");
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ["stock", "batches", status, warehouseId],
    queryFn: () => api.get<{ today: string; warningDays: number; data: BatchRow[] }>("/stock/batches", { status, ...(warehouseId ? { warehouseId } : {}) }),
  });
  const rows = q.data?.data ?? [];
  const today = q.data?.today ?? "";
  const expired = rows.filter((r) => r.expired);
  const showValue = rows.some((r) => r.value !== undefined);
  const totalValue = rows.reduce((s, r) => s + Number(r.value ?? 0), 0);
  const left = (r: BatchRow) => {
    const days = daysBetween(today, r.expiryDate);
    return r.expired ? t("inventory.expiry.expiredAgo", { count: -days }) : days === 0 ? t("inventory.expiry.today") : t("inventory.expiry.daysLeft", { count: days });
  };

  const writeOff = async () => {
    const qty = expired.reduce((s, r) => s + Number(r.qty), 0);
    const ok = await confirm({
      title: t("inventory.expiry.writeOffTitle", { count: expired.length }),
      body: t("inventory.expiry.writeOffBody", { qty: number(qty), value: money(expired.reduce((s, r) => s + Number(r.value ?? 0), 0)) }),
      confirmLabel: t("inventory.expiry.writeOff"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // One adjustment per godown (an adjustment belongs to one), 300 lines at most each.
      const byGodown = new Map<string, BatchRow[]>();
      for (const r of expired) byGodown.set(r.warehouseId, [...(byGodown.get(r.warehouseId) ?? []), r]);
      const numbers: string[] = [];
      for (const [wh, list] of byGodown) {
        for (let i = 0; i < list.length; i += 300) {
          const res = await api.post<{ adjustmentNumber: string }>("/stock/adjustments", {
            reason: "expiry",
            warehouseId: wh,
            notes: t("inventory.expiry.note"),
            lines: list.slice(i, i + 300).map((r) => ({ productId: r.productId, batchId: r.batchId, qtyChange: `-${r.qty}`, note: `${t("invoice.batch")} ${r.batchNumber}` })),
          });
          numbers.push(res.adjustmentNumber);
        }
      }
      await refreshCatalog().catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("inventory.expiry.writtenOff", { count: expired.length }), body: numbers.join(", ") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        quick={
          allowed("inventory.adjust") && expired.length > 0 ? (
            <Button variant="danger" size="sm" icon={<CalendarX2 size={15} />} disabled={busy} onClick={() => void writeOff()}>
              {t("inventory.expiry.writeOffCount", { count: expired.length })}
            </Button>
          ) : undefined
        }
      >
        <Segmented
          size="sm"
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "expiring", label: t("inventory.expiry.soon") },
            { value: "expired", label: t("inventory.expiry.expired") },
          ]}
        />
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
      </FilterBar>
      {q.data && (
        <p className="text-[13px] text-ink-3">
          {status === "expiring" ? t("inventory.expiry.soonHint", { days: q.data.warningDays }) : t("inventory.expiry.expiredHint")}
          {showValue && rows.length > 0 && ` · ${t("product.stockValue")} ${money(totalValue)}`}
        </p>
      )}
      {error ? <ErrorNote error={error} /> : null}
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable
        rows={rows}
        loading={q.isPending}
        rowKey={(r) => `${r.batchId}:${r.warehouseId}`}
        minWidth={720}
        empty={<EmptyState icon={<CalendarX2 size={24} />} title={status === "expired" ? t("inventory.expiry.noneExpired") : t("inventory.expiry.none")} />}
        columns={[
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
          { key: "batch", header: t("invoice.batch"), render: (r) => <span className="font-mono">{r.batchNumber}</span> },
          ...(godowns.length > 1 ? [{ key: "godown", header: t("godowns.godown"), render: (r: BatchRow) => r.warehouse }] : []),
          {
            key: "expiry",
            header: t("invoice.expiry"),
            render: (r) => (
              <div className="flex flex-wrap items-center gap-2">
                <span>{dateMedium(r.expiryDate)}</span>
                <Badge tone={r.expired ? "danger" : "warn"}>{left(r)}</Badge>
              </div>
            ),
          },
          { key: "qty", header: t("invoice.qty"), align: "right", render: (r) => <span className="font-semibold">{`${number(r.qty)} ${r.unit}`}</span> },
          ...(showValue ? [{ key: "value", header: t("product.stockValue"), align: "right" as const, render: (r: BatchRow) => money(r.value ?? 0) }] : []),
        ]}
        mobile={(r) => (
          <RowCard
            title={r.name}
            sub={[`${t("invoice.batch")} ${r.batchNumber}`, dateMedium(r.expiryDate), godowns.length > 1 ? r.warehouse : null].filter(Boolean).join(" · ")}
            value={`${number(r.qty)} ${r.unit}`}
            valueSub={left(r)}
            tone={r.expired ? "danger" : "warn"}
          />
        )}
      />
    </div>
  );
}
