import { useQuery, useQueryClient } from "@tanstack/react-query";
import { countDifferences } from "@digitalbahi/core";
import { Printer, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { FirmHeader, MadeWithDigitalBahi } from "../../components/brand/Brand";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { productById, TODAY, WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { stockInPacks } from "../../lib/packs";
import { cn } from "../../lib/cn";

interface CountRow {
  productId: string;
  code: string;
  name: string;
  unit: string;
  qty: string;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;
/** The stock API takes up to this many lines in one adjustment. */
const PER_ADJUSTMENT = 300;
const draftKey = (godownId: string) => `stock-count:${godownId || "all"}`;

/** Every active product with its stock (in one godown when there are several), page by page. */
async function allStock(warehouseId: string): Promise<CountRow[]> {
  const rows: CountRow[] = [];
  let cursor: string | null = null;
  do {
    const res: { data: CountRow[]; nextCursor: string | null } = await api.get("/stock", { limit: 200, ...(warehouseId ? { warehouseId } : {}), ...(cursor ? { cursor } : {}) });
    rows.push(...res.data);
    cursor = res.nextCursor;
  } while (cursor && rows.length < 20_000);
  return rows;
}

function readDraft(godownId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(draftKey(godownId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDraft(godownId: string, counts: Record<string, string>): void {
  try {
    if (Object.keys(counts).length) localStorage.setItem(draftKey(godownId), JSON.stringify(counts));
    else localStorage.removeItem(draftKey(godownId));
  } catch {
    // A private window: the count just is not kept if the page closes.
  }
}

/**
 * The stock count: every product with a blank to fill in, as a sheet to
 * print and take to the shelves, then typed in here. Blank means not
 * counted (left as it is); only what differs is posted, as one physical
 * count adjustment. What has been typed is kept on this device until saved.
 */
export function StockCountDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t, number, date } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState(() => (godowns.length > 1 ? (godowns.find((w) => w.isDefault)?.id ?? godowns[0]?.id ?? "") : ""));
  const [counts, setCounts] = useState<Record<string, string>>(() => readDraft(warehouseId));
  const [q, setQ] = useState("");
  const [onlyLeft, setOnlyLeft] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stock = useQuery({ queryKey: ["stock", "count", warehouseId], queryFn: () => allStock(warehouseId), enabled: open, staleTime: 0 });

  useEffect(() => writeDraft(warehouseId, counts), [warehouseId, counts]);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const rows = useMemo(() => stock.data ?? [], [stock.data]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!needle || r.name.toLowerCase().includes(needle) || r.code.toLowerCase().includes(needle)) && (!onlyLeft || !counts[r.productId]));
  const counted = rows.filter((r) => counts[r.productId] !== undefined && counts[r.productId] !== "");
  const invalid = counted.filter((r) => !QTY.test(counts[r.productId]!));
  const changes = invalid.length ? [] : countDifferences(counted.map((r) => ({ productId: r.productId, system: r.qty, counted: counts[r.productId]! })));
  const godownName = godowns.find((w) => w.id === warehouseId)?.name ?? "";
  const packs = (qty: string, productId: string) => stockInPacks(qty, productById.get(productId), (n) => number(n));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const numbers: string[] = [];
      for (let i = 0; i < changes.length; i += PER_ADJUSTMENT) {
        const res = await api.post<{ adjustmentNumber: string }>("/stock/adjustments", {
          reason: "count_correction",
          ...(warehouseId ? { warehouseId } : {}),
          notes: t("inventory.count.note", { counted: counted.length }),
          lines: changes.slice(i, i + PER_ADJUSTMENT).map((c) => ({ productId: c.productId, qtyChange: c.qtyChange })),
        });
        numbers.push(res.adjustmentNumber);
      }
      setCounts({});
      await refreshCatalog().catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("inventory.count.saved", { count: changes.length }), body: numbers.join(", ") || t("inventory.count.noChanges") });
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
      title={t("inventory.count.title")}
      description={t("inventory.count.hint")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <p className="num text-[13px] text-ink-3" aria-live="polite">
            {t("inventory.count.progress", { counted: counted.length, count: rows.length, changes: changes.length })}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
            <Button variant="primary" disabled={busy || counted.length === 0 || invalid.length > 0} onClick={() => void save()}>
              {busy ? t("common.saving") : changes.length ? t("inventory.count.save", { count: changes.length }) : t("inventory.count.saveNoChange")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <ErrorNote error={error} /> : null}
        <div className="flex flex-wrap items-end gap-2">
          {godowns.length > 1 && (
            <Field label={t("godowns.godown")} htmlFor="count-godown">
              <Select
                id="count-godown"
                value={warehouseId}
                onChange={(e) => {
                  setWarehouseId(e.target.value);
                  setCounts(readDraft(e.target.value));
                }}
              >
                {godowns.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Input className="min-w-48 flex-1" leading={<Search size={16} />} placeholder={t("product.search")} aria-label={t("product.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          <Button icon={<Printer size={16} />} disabled={!rows.length} onClick={() => window.print()}>
            {t("inventory.count.print")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <Checkbox label={t("inventory.count.onlyLeft")} checked={onlyLeft} onChange={setOnlyLeft} />
          <Checkbox label={t("inventory.count.showSystem")} checked={showSystem} onChange={setShowSystem} />
        </div>
        {stock.error ? <ErrorNote error={stock.error} onRetry={() => void stock.refetch()} /> : null}
        {stock.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" data-testid="count-lines">
            {shown.slice(0, 400).map((r) => {
              const value = counts[r.productId] ?? "";
              const bad = value !== "" && !QTY.test(value);
              const diff = value !== "" && !bad ? Math.round((Number(value) - Number(r.qty)) * 1000) / 1000 : null;
              return (
                <li key={r.productId} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-ink">{r.name}</p>
                    <p className="num text-[12px] text-ink-3">
                      {r.code}
                      {(showSystem || value !== "") && ` · ${t("inventory.system")}: ${packs(r.qty, r.productId) ?? `${number(r.qty)} ${r.unit}`}`}
                      {diff !== null && diff !== 0 && (
                        <span className={diff > 0 ? "text-good" : "text-danger"}>
                          {" "}
                          → {diff > 0 ? "+" : ""}
                          {number(diff)}
                        </span>
                      )}
                    </p>
                  </div>
                  <Input
                    inputSize="sm"
                    inputMode="decimal"
                    aria-label={`${t("inventory.counted")} · ${r.name}`}
                    placeholder={t("inventory.counted")}
                    trailing={<span className="text-[11px]">{r.unit}</span>}
                    className={cn("w-32 [&_input]:text-right", diff === 0 && "[&_input]:text-good")}
                    invalid={bad}
                    value={value}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      setCounts((c) => {
                        const next = { ...c };
                        if (v === "") delete next[r.productId];
                        else next[r.productId] = v;
                        return next;
                      });
                    }}
                  />
                </li>
              );
            })}
            {shown.length > 400 && <li className="px-3 py-2 text-[12.5px] text-ink-3">{t("inventory.count.more", { count: shown.length - 400 })}</li>}
            {shown.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">{t("search.noResults")}</li>}
          </ul>
        )}
      </div>
      {open && rows.length > 0 && (
        <PrintPortal>
          <article className="mx-auto w-full max-w-[1000px] bg-white p-6 text-[12px] leading-snug text-[#0e1a33]" style={{ fontFamily: "var(--font-sans)" }}>
            <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-3">
              <FirmHeader detail="short" />
              <div className="text-right">
                <p className="text-[16px] font-bold text-[#1450b4]">{t("inventory.count.sheetTitle")}</p>
                <p>
                  {date(TODAY)}
                  {godownName && ` · ${godownName}`}
                </p>
              </div>
            </header>
            <table className="mt-3 w-full border-collapse">
              <thead>
                <tr>
                  {["#", t("product.code"), t("product.name"), t("product.unit"), ...(showSystem ? [t("inventory.system")] : []), t("inventory.counted"), t("common.notes")].map((h, i) => (
                    <th key={h} className={cn("border-b-2 border-[#0e1a33] px-2 py-1.5 font-semibold", i === 0 || (showSystem && i === 4) ? "text-right" : "text-left")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.productId} style={{ breakInside: "avoid" }}>
                    <td className="border-b border-[#d5dbe7] px-2 py-2 text-right">{i + 1}</td>
                    <td className="border-b border-[#d5dbe7] px-2 py-2 font-mono">{r.code}</td>
                    <td className="border-b border-[#d5dbe7] px-2 py-2">{r.name}</td>
                    <td className="border-b border-[#d5dbe7] px-2 py-2">{r.unit}</td>
                    {showSystem && <td className="border-b border-[#d5dbe7] px-2 py-2 text-right whitespace-nowrap">{packs(r.qty, r.productId) ?? number(r.qty)}</td>}
                    <td className="w-32 border-b border-[#9aa5bb] px-2 py-2">{counts[r.productId] ?? ""}</td>
                    <td className="w-40 border-b border-[#9aa5bb] px-2 py-2" />
                  </tr>
                ))}
              </tbody>
            </table>
            <footer className="mt-10 flex justify-between gap-6 text-[12px]">
              <p className="w-56 border-t border-[#0e1a33] pt-1 text-center">{t("inventory.count.countedBy")}</p>
              <p className="w-56 border-t border-[#0e1a33] pt-1 text-center">{t("inventory.count.checkedBy")}</p>
            </footer>
            <MadeWithDigitalBahi />
          </article>
        </PrintPortal>
      )}
    </Dialog>
  );
}
