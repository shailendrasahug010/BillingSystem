import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck, Printer, ScanBarcode } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, LoadMore, PageHeader, TAB_TRIGGER } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { useEmployeeOptions } from "../people/api";
import { PackingSlipDocument, type PrintablePacking } from "./PackingSlipDocument";

interface QueueLine {
  orderItemId: string;
  productId: string;
  productName: string;
  unit: string;
  ordered: string;
  packed: string;
  remaining: string;
  barcodes: string[];
  batches: Array<{ batchId: string; batchNumber: string; expiryDate: string | null; qty: string }>;
}

interface QueueOrder {
  id: string;
  orderNumber: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  status: string;
  customerName: string;
  city: string | null;
  lines: QueueLine[];
}

export function PackingPage() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("packing.title")} subtitle={t("packing.subtitle")} />
      <Tabs.Root defaultValue="queue" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("packing.title")}>
          <Tabs.Trigger value="queue" className={TAB_TRIGGER}>
            {t("packing.queue")}
          </Tabs.Trigger>
          <Tabs.Trigger value="slips" className={TAB_TRIGGER}>
            {t("packing.slips")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="queue">
          <Queue />
        </Tabs.Content>
        <Tabs.Content value="slips">
          <Slips />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function Queue() {
  const { t, number, dateMedium } = useI18n();
  const [packing, setPacking] = useState<QueueOrder | null>(null);
  const q = useQuery({ queryKey: ["packing", "queue"], queryFn: () => api.get<{ data: QueueOrder[] }>("/packing/queue").then((r) => r.data) });
  return (
    <div className="flex flex-col gap-4">
      {q.error ? <ErrorNote error={q.error} /> : null}
      <DataTable
        id="packing-queue"
        rows={q.data ?? []}
        rowKey={(o) => o.id}
        loading={q.isPending}
        minWidth={720}
        onRowClick={allowed("packing.pack") ? (o) => setPacking(o) : undefined}
        empty={<EmptyState title={t("packing.emptyQueue")} hint={t("packing.emptyQueueHint")} />}
        columns={[
          {
            key: "order",
            header: t("packing.order"),
            sortValue: (o) => o.orderNumber,
            render: (o) => (
              <div>
                <p className="font-medium text-ink">{o.orderNumber}</p>
                <p className="text-[12px] text-ink-3">{dateMedium(o.orderDate)}</p>
              </div>
            ),
          },
          {
            key: "customer",
            header: t("customer.name"),
            sortValue: (o) => o.customerName,
            render: (o) => (
              <span className="text-ink">
                {o.customerName}
                {o.city && <span className="text-ink-3"> · {o.city}</span>}
              </span>
            ),
          },
          { key: "delivery", header: t("orders.deliveryDate"), sortValue: (o) => o.expectedDeliveryDate, render: (o) => <span className="text-ink-2">{o.expectedDeliveryDate ? dateMedium(o.expectedDeliveryDate) : "—"}</span> },
          { key: "status", header: t("common.status"), sortValue: (o) => t(`status.order.${o.status as "confirmed"}`), render: (o) => <Badge tone={o.status === "packing" ? "warn" : "accent"}>{t(`status.order.${o.status as "confirmed"}`)}</Badge> },
          { key: "left", header: t("packing.itemsLeft"), align: "right", sortValue: (o) => o.lines.filter((l) => Number(l.remaining) > 0).length, render: (o) => `${o.lines.filter((l) => Number(l.remaining) > 0).length} / ${o.lines.length}` },
          { key: "qty", header: t("packing.piecesLeft"), align: "right", sortValue: (o) => o.lines.reduce((s, l) => s + Number(l.remaining), 0), render: (o) => number(o.lines.reduce((s, l) => s + Number(l.remaining), 0), 0) },
          {
            key: "action",
            header: "",
            align: "right",
            hideable: false,
            render: () =>
              allowed("packing.pack") ? (
                <Button size="sm" variant="primary" icon={<PackageCheck size={14} />}>
                  {t("packing.pack")}
                </Button>
              ) : null,
          },
        ]}
      />
      <PackDialog order={packing} onClose={() => setPacking(null)} />
    </div>
  );
}

interface Pick {
  qty: string;
  boxNo: string;
}

/** First expiry first out: split a quantity across batches in expiry order. */
function fefo(line: QueueLine, qty: number): Array<{ batchId?: string; batchNumber?: string; qty: number }> {
  if (!line.batches.length) return [{ qty }];
  const out: Array<{ batchId?: string; batchNumber?: string; qty: number }> = [];
  let left = qty;
  for (const b of line.batches) {
    if (left <= 0) break;
    const take = Math.min(left, Number(b.qty));
    if (take > 0) out.push({ batchId: b.batchId, batchNumber: b.batchNumber, qty: take });
    left -= take;
  }
  if (left > 0) out.push({ qty: left });
  return out;
}

function PackDialog({ order, onClose }: { order: QueueOrder | null; onClose(): void }) {
  const { t, number } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const employees = useEmployeeOptions();
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [boxes, setBoxes] = useState("1");
  const [weight, setWeight] = useState("");
  const [packedBy, setPackedBy] = useState("");
  const [scan, setScan] = useState("");
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!order) return;
    setPicks(Object.fromEntries(order.lines.map((l) => [l.orderItemId, { qty: Number(l.remaining) > 0 ? String(Number(l.remaining)) : "0", boxNo: "" }])));
    setBoxes("1");
    setWeight("");
    setScan("");
    setScanMsg(null);
    setError(null);
  }, [order]);
  if (!order) return null;
  const onScan = () => {
    const code = scan.trim();
    if (!code) return;
    const line = order.lines.find((l) => l.barcodes.includes(code)) ?? order.lines.find((l) => l.productName.toLowerCase().includes(code.toLowerCase()));
    setScan("");
    if (!line) {
      setScanMsg(t("packing.scanNotOnOrder", { code }));
      return;
    }
    setScanMsg(`✓ ${line.productName}`);
    document.getElementById(`pack-qty-${line.orderItemId}`)?.focus();
  };
  const invalid = order.lines.some((l) => {
    const v = Number(picks[l.orderItemId]?.qty ?? 0);
    return !Number.isFinite(v) || v < 0 || v > Number(l.remaining);
  });
  const any = order.lines.some((l) => Number(picks[l.orderItemId]?.qty ?? 0) > 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const lines = order.lines.flatMap((l) => {
        const p = picks[l.orderItemId];
        const qty = Number(p?.qty ?? 0);
        if (!qty) return [];
        return fefo(l, qty).map((part) => ({
          orderItemId: l.orderItemId,
          qty: String(part.qty),
          ...(part.batchId ? { batchId: part.batchId } : {}),
          ...(p?.boxNo ? { boxNo: Number(p.boxNo) } : {}),
        }));
      });
      const res = await api.post<{ packingNumber: string }>("/packing", {
        salesOrderId: order.id,
        lines,
        boxCount: Number(boxes) || 0,
        ...(weight ? { totalWeightKg: weight } : {}),
        ...(packedBy ? { packedBy } : {}),
      });
      void qc.invalidateQueries({ queryKey: ["packing"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: t("packing.packed"), body: `${res.packingNumber} · ${order.orderNumber}` });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="xl"
      title={`${t("packing.pack")} · ${order.orderNumber}`}
      description={`${order.customerName}${order.city ? ` · ${order.city}` : ""}`}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || invalid || !any} onClick={() => void save()}>
            {busy ? t("common.saving") : t("packing.savePacking")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={scanRef}
            className="flex-1"
            leading={<ScanBarcode size={16} />}
            placeholder={t("packing.scan")}
            aria-label={t("packing.scan")}
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onScan();
              }
            }}
          />
          {scanMsg && <span className="text-[13px] text-ink-2">{scanMsg}</span>}
        </div>
        <div className="scroll-x rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                <th className="py-2 pl-3 font-medium">{t("invoice.product")}</th>
                <th className="py-2 pl-2 text-right font-medium">{t("packing.ordered")}</th>
                <th className="py-2 pl-2 text-right font-medium">{t("packing.remaining")}</th>
                <th className="py-2 pl-2 text-right font-medium">{t("packing.packNow")}</th>
                <th className="py-2 pl-2 font-medium">{t("packing.batches")}</th>
                <th className="py-2 pr-3 pl-2 text-right font-medium">{t("packing.box")}</th>
              </tr>
            </thead>
            <tbody className="num">
              {order.lines.map((l) => {
                const p = picks[l.orderItemId] ?? { qty: "0", boxNo: "" };
                const qty = Number(p.qty);
                const bad = !Number.isFinite(qty) || qty < 0 || qty > Number(l.remaining);
                const plan = qty > 0 && !bad ? fefo(l, qty) : [];
                return (
                  <tr key={l.orderItemId} className="border-b border-line align-top last:border-b-0">
                    <td className="py-1.5 pl-3">
                      <p className="font-medium text-ink">{l.productName}</p>
                      {l.barcodes[0] && <p className="font-mono text-[11.5px] text-ink-3">{l.barcodes[0]}</p>}
                    </td>
                    <td className="py-1.5 pl-2 text-right text-ink-2">
                      {number(l.ordered, 0)} {l.unit}
                    </td>
                    <td className="py-1.5 pl-2 text-right">{number(l.remaining, 0)}</td>
                    <td className="py-1.5 pl-2">
                      <Input
                        id={`pack-qty-${l.orderItemId}`}
                        inputSize="sm"
                        inputMode="decimal"
                        invalid={bad}
                        disabled={Number(l.remaining) <= 0}
                        aria-label={`${t("packing.packNow")} ${l.productName}`}
                        className="ml-auto w-20 [&_input]:text-right"
                        value={p.qty}
                        onChange={(e) => setPicks((x) => ({ ...x, [l.orderItemId]: { ...p, qty: e.target.value.trim() } }))}
                      />
                    </td>
                    <td className="py-1.5 pl-2 text-[12px] text-ink-2">
                      {plan.some((x) => x.batchNumber) ? plan.map((x) => `${x.batchNumber ?? t("packing.noBatch")} × ${number(x.qty, 0)}`).join(" · ") : l.batches.length ? "" : "—"}
                    </td>
                    <td className="py-1.5 pr-3 pl-2">
                      <Input
                        inputSize="sm"
                        inputMode="numeric"
                        aria-label={`${t("packing.box")} ${l.productName}`}
                        className="ml-auto w-14 [&_input]:text-right"
                        value={p.boxNo}
                        onChange={(e) => setPicks((x) => ({ ...x, [l.orderItemId]: { ...p, boxNo: e.target.value.replace(/\D/g, "").slice(0, 3) } }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[12.5px] text-ink-3">{t("packing.fefoHint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("packing.boxCount")} htmlFor="pk-boxes">
            <Input id="pk-boxes" inputMode="numeric" value={boxes} onChange={(e) => setBoxes(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Field>
          <Field label={t("packing.weight")} htmlFor="pk-weight" hint={t("common.optional")}>
            <Input id="pk-weight" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.trim())} />
          </Field>
          <Field label={t("packing.packedBy")} htmlFor="pk-by" hint={t("common.optional")}>
            <Select id="pk-by" value={packedBy} onChange={(e) => setPackedBy(e.target.value)}>
              <option value="">—</option>
              {(employees.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

interface SlipRow {
  id: string;
  packingNumber: string;
  status: "packed" | "cancelled" | "in_progress";
  boxCount: number;
  packedAt: string | null;
  orderNumber: string;
  customerName: string;
  lines: number;
}

function Slips() {
  const { t, dateTime } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = usePaged<SlipRow>("packing", "/packing", {});
  return (
    <div className="flex flex-col gap-4">
      {list.error ? <ErrorNote error={list.error} /> : null}
      <DataTable
        id="packing-slips"
        rows={list.rows}
        rowKey={(r) => r.id}
        loading={list.loading}
        onRowClick={(r) => setOpenId(r.id)}
        minWidth={680}
        empty={<EmptyState title={t("packing.noSlips")} />}
        columns={[
          { key: "number", header: t("common.number"), sortValue: (r) => r.packingNumber, render: (r) => <span className="font-medium text-ink">{r.packingNumber}</span> },
          { key: "when", header: t("common.date"), sortValue: (r) => r.packedAt, render: (r) => <span className="text-ink-2">{r.packedAt ? dateTime(r.packedAt) : "—"}</span> },
          { key: "order", header: t("packing.order"), sortValue: (r) => r.orderNumber, render: (r) => <span className="text-ink-2">{r.orderNumber}</span> },
          { key: "customer", header: t("customer.name"), sortValue: (r) => r.customerName, render: (r) => <span className="text-ink">{r.customerName}</span> },
          { key: "boxes", header: t("packing.boxCount"), align: "right", sortValue: (r) => r.boxCount, render: (r) => r.boxCount },
          { key: "status", header: t("common.status"), sortValue: (r) => (r.status === "cancelled" ? t("packing.unpacked") : t("packing.packedStatus")), render: (r) => <Badge tone={r.status === "cancelled" ? "danger" : "good"}>{r.status === "cancelled" ? t("packing.unpacked") : t("packing.packedStatus")}</Badge> },
        ]}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
      <SlipDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function SlipDialog({ id, onClose }: { id: string | null; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ["packing", "detail", id], queryFn: () => api.get<PrintablePacking>(`/packing/${id}`), enabled: Boolean(id) });
  const p = q.data;
  const unpack = async () => {
    setError(null);
    try {
      await api.post(`/packing/${id}/cancel`, {});
      void qc.invalidateQueries({ queryKey: ["packing"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: t("packing.unpackedDone") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  return (
    <Dialog
      open={Boolean(id)}
      onOpenChange={(v) => !v && onClose()}
      size="xl"
      title={p ? `${t("packing.slip")} ${p.packingNumber}` : t("common.loading")}
      closeLabel={t("common.close")}
      footer={
        p ? (
          <>
            {p.status === "packed" && (p.orderStatus === "packing" || p.orderStatus === "packed") && allowed("packing.pack") && (
              <Button variant="ghost" onClick={() => void unpack()}>
                {t("packing.unpack")}
              </Button>
            )}
            <Button variant="primary" icon={<Printer size={16} />} onClick={() => window.print()}>
              {t("packing.print")}
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : p ? (
        <div className="flex flex-col gap-3">
          {error ? <ErrorNote error={error} /> : null}
          <div className="overflow-x-auto rounded-lg bg-surface-2 p-2">
            <PackingSlipDocument packing={p} />
          </div>
          <PrintPortal>
            <PackingSlipDocument packing={p} />
          </PrintPortal>
        </div>
      ) : null}
    </Dialog>
  );
}
