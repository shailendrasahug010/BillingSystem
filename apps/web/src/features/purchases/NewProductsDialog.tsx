import { translateError } from "@vyapaar/i18n";
import { PackagePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Input, Select } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { newProductFrom, type ImportedItem } from "./billImport";

interface Row {
  key: string;
  item: ImportedItem;
  include: boolean;
  name: string;
  taxCategoryId: string;
  baseUnitId: string;
  sellingPrice: string;
  /** Close matches the importer found: the item may already be ours under another name. */
  lookalike: string | null;
  error: string | null;
}

const RATE = /^\d{1,11}(\.\d{1,4})?$/;
/** Billed per case at more than the MRP: the MRP is per piece, not comparable with the rate. */
const perPackAboveMrp = (f: ImportedItem["file"]) => Boolean(f.rate && f.mrp && Number(f.rate) > Number(f.mrp));
const round2 = (n: number) => String(Math.round(n * 100) / 100);

/**
 * Items on a supplier's bill that are not in our product list, added in one
 * go: name, GST, unit and selling price come from the bill (all can be
 * changed), the purchase rate, MRP, HSN, barcode and batch / expiry
 * tracking too, and the supplier becomes the preferred supplier. Items that
 * look like one of our products are left unticked so they can be matched
 * instead.
 */
export function NewProductsDialog({ open, onOpenChange, items, supplierId, onAdded }: { open: boolean; onOpenChange(v: boolean): void; items: ImportedItem[]; supplierId: string | null; onAdded(created: Array<{ key: string; productId: string }>): void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [margin, setMargin] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(
      items.map((item) => {
        const g = newProductFrom(item);
        const lookalike = item.candidates[0]?.name ?? null;
        return {
          key: item.key,
          item,
          include: !lookalike,
          name: g.name,
          taxCategoryId: g.taxCategoryId ?? "",
          baseUnitId: g.baseUnitId ?? "",
          // Distributors sell below MRP; the bill's MRP is a starting point, else the purchase rate.
          sellingPrice: (perPackAboveMrp(item.file) ? g.purchasePrice : (g.mrp ?? g.purchasePrice)) ?? "",
          lookalike,
          error: null,
        };
      }),
    );
    setMargin("");
  }, [open, items]);

  /** Selling price = purchase rate + margin, never above the MRP. */
  const applyMargin = (value: string) => {
    setMargin(value);
    const m = Number(value);
    if (value === "" || !Number.isFinite(m) || m < 0) return;
    setRows((rs) =>
      rs.map((r) => {
        const rate = Number(r.item.file.rate);
        if (!r.item.file.rate || !Number.isFinite(rate)) return r;
        const price = rate * (1 + m / 100);
        const mrp = r.item.file.mrp && !perPackAboveMrp(r.item.file) ? Number(r.item.file.mrp) : Infinity;
        return { ...r, sellingPrice: round2(Math.min(price, mrp)) };
      }),
    );
  };
  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, error: null } : r)));

  const chosen = rows.filter((r) => r.include);
  const problem = (r: Row) => (!r.name.trim() ? t("validation.required") : !r.taxCategoryId ? t("billImport.pickGst") : !r.baseUnitId ? t("validation.required") : r.sellingPrice && !RATE.test(r.sellingPrice) ? t("validation.amount") : null);
  const invalid = useMemo(() => chosen.some((r) => problem(r)), [chosen]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    setBusy(true);
    const created: Array<{ key: string; productId: string }> = [];
    for (const r of chosen) {
      const f = r.item.file;
      const g = newProductFrom(r.item);
      try {
        const res = await api.post<{ id: string }>("/products", {
          name: r.name.trim(),
          ...(g.hsnCode ? { hsnCode: g.hsnCode } : {}),
          taxCategoryId: r.taxCategoryId,
          baseUnitId: r.baseUnitId,
          ...(f.rate && RATE.test(f.rate) ? { purchasePrice: f.rate } : {}),
          sellingPrice: r.sellingPrice && RATE.test(r.sellingPrice) ? r.sellingPrice : "0",
          ...(f.mrp && RATE.test(f.mrp) ? { mrp: f.mrp } : {}),
          ...(g.barcode ? { barcodes: [g.barcode] } : {}),
          ...(supplierId ? { preferredSupplierId: supplierId } : {}),
          trackBatches: g.trackBatches,
          trackExpiry: g.trackExpiry,
        });
        created.push({ key: r.key, productId: res.id });
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, "generic");
        set(r.key, { error: translateError(i18n, err) });
      }
    }
    if (created.length) {
      await refreshCatalog().catch(() => undefined);
      setRows((rs) => rs.filter((r) => !created.some((c) => c.key === r.key)));
      onAdded(created);
      toast({ tone: "success", title: t("billImport.productsAdded", { count: created.length }) });
    }
    setBusy(false);
    if (created.length === chosen.length) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("billImport.newProductsTitle")}
      description={t("billImport.newProductsHint")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        <Button variant="primary" icon={<PackagePlus size={16} />} disabled={busy || chosen.length === 0 || invalid} onClick={() => void add()}>
          {busy ? t("common.saving") : t("billImport.addProducts", { count: chosen.length })}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <label htmlFor="np-margin">{t("billImport.margin")}</label>
          <Input id="np-margin" inputMode="decimal" className="w-24" placeholder="10" value={margin} onChange={(e) => applyMargin(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="text-ink-3">{t("billImport.marginHint")}</span>
        </div>
        <div className="scroll-x">
          <table className="w-full min-w-[880px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="w-8 py-2" />
                <th className="py-2 pr-2 font-medium">{t("billImport.productName")}</th>
                <th className="py-2 pr-2 font-medium">GST</th>
                <th className="py-2 pr-2 font-medium">{t("billImport.unit")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("billImport.purchaseRate")}</th>
                <th className="py-2 pr-2 text-right font-medium">MRP</th>
                <th className="py-2 text-right font-medium">{t("billImport.sellingPrice")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const f = r.item.file;
                const issue = r.include ? problem(r) : null;
                return (
                  <tr key={r.key} className={r.include ? "" : "opacity-60"}>
                    <td className="py-2 align-top">
                      <Checkbox label={<span className="sr-only">{r.name}</span>} checked={r.include} onChange={(v) => set(r.key, { include: v })} />
                    </td>
                    <td className="py-2 pr-2 align-top">
                      <Input aria-label={`${t("billImport.productName")} ${f.itemName}`} value={r.name} disabled={!r.include} onChange={(e) => set(r.key, { name: e.target.value })} />
                      <p className="mt-1 text-[11.5px] text-ink-3">
                        {f.itemName}
                        {f.hsnCode && ` · HSN ${f.hsnCode}`}
                      </p>
                      {r.lookalike && <p className="text-[11.5px] text-warn">{t("billImport.looksLike", { name: r.lookalike })}</p>}
                      {perPackAboveMrp(f) && <p className="text-[11.5px] text-warn">{t("billImport.packAboveMrp", { unit: f.unit ?? "" })}</p>}
                      {(r.error || issue) && <p className="text-[11.5px] text-danger">{r.error ?? issue}</p>}
                    </td>
                    <td className="py-2 pr-2 align-top">
                      <Select className="w-40" aria-label={`GST ${f.itemName}`} value={r.taxCategoryId} disabled={!r.include} onChange={(e) => set(r.key, { taxCategoryId: e.target.value })}>
                        <option value="">—</option>
                        {WORKSPACE.taxCategories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-2 pr-2 align-top">
                      <Select className="w-24" aria-label={`${t("billImport.unit")} ${f.itemName}`} value={r.baseUnitId} disabled={!r.include} onChange={(e) => set(r.key, { baseUnitId: e.target.value })}>
                        {WORKSPACE.unitList.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.symbol}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="num py-2 pr-2 text-right align-top text-ink-2">{f.rate ?? "—"}</td>
                    <td className="num py-2 pr-2 text-right align-top text-ink-2">{f.mrp ?? "—"}</td>
                    <td className="py-2 align-top">
                      <Input aria-label={`${t("billImport.sellingPrice")} ${f.itemName}`} inputMode="decimal" className="w-28 [&_input]:text-right" value={r.sellingPrice} disabled={!r.include} onChange={(e) => set(r.key, { sellingPrice: e.target.value.replace(/[^0-9.]/g, "") })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  );
}
