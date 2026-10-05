import { costRises, type CostRise } from "@digitalbahi/core";
import { ArrowRight, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { productById } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";

const RATE = /^\d{1,11}(\.\d{1,2})?$/;

/** A product the bill made dearer, with the rate and MRP to set. */
export interface PriceRise extends CostRise {
  name: string;
  unit: string;
  /** The product's rates include GST: the rate shown and set is with GST. */
  inclusive: boolean;
  /** The selling rate as the product stores it (with GST when inclusive). */
  currentRate: string;
  suggested: string;
  mrp: string;
}

/** One purchase line: the supplier's rate per base unit before GST (what the product's purchase price keeps). */
export interface CostLineIn {
  productId: string;
  newCost: number;
  mrp?: string;
}

/**
 * Products this bill makes dearer than their last cost, read before the bill
 * is saved (the save moves the cost). Margins compare costs without GST with
 * the selling rate without GST; the suggested rate keeps the old margin and
 * is given the way the product stores its rate.
 */
export function findPriceRises(lines: readonly CostLineIn[]): PriceRise[] {
  const known = lines.flatMap((l) => {
    const p = productById.get(l.productId);
    if (!p || !(p.purchasePrice > 0)) return [];
    const inclusive = Boolean(p.pricesIncludeTax);
    const exTax = inclusive ? p.rate / (1 + p.gstRate / 100) : p.rate;
    return [{ l, p, inclusive, input: { productId: l.productId, oldCost: p.purchasePrice.toFixed(4), newCost: l.newCost.toFixed(4), rate: exTax.toFixed(4) } }];
  });
  const rises = costRises(known.map((k) => k.input));
  return rises.map((r) => {
    const { l, p, inclusive } = known.find((k) => k.l.productId === r.productId)!;
    // Same margin: scale the stored rate by the cost rise (up to the next 10 paise).
    const suggested = p.rate > 0 ? Math.ceil(((p.rate * Number(r.newCost)) / Number(r.oldCost)) * 10 - 1e-9) / 10 : Number(r.newCost);
    const lineMrp = l.mrp && Number(l.mrp) > 0 ? Number(l.mrp) : 0;
    return {
      ...r,
      name: p.name,
      unit: p.unit,
      inclusive,
      currentRate: p.rate.toFixed(2),
      suggested: suggested.toFixed(2),
      mrp: (lineMrp > p.mrp ? lineMrp : p.mrp || 0).toFixed(2),
    };
  });
}

/**
 * After a purchase bill that costs more than before: the items, their cost
 * then and now and the margin it leaves, with a new selling rate (keeping the
 * old margin) and MRP to set in one go. Skipping keeps the old rates.
 */
export function PriceRiseDialog({ rises, onDone }: { rises: PriceRise[]; onDone(): void }) {
  const { t, money, number } = useI18n();
  const toast = useToast();
  const [values, setValues] = useState(() => Object.fromEntries(rises.map((r) => [r.productId, { rate: r.suggested, mrp: r.mrp, on: true }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = rises.filter((r) => values[r.productId]?.on);
  const invalid = chosen.some((r) => !RATE.test(values[r.productId]!.rate) || (values[r.productId]!.mrp !== "" && !RATE.test(values[r.productId]!.mrp)));

  const update = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const r of chosen) {
        const v = values[r.productId]!;
        await api.patch(`/products/${r.productId}`, { sellingPrice: v.rate, ...(v.mrp && Number(v.mrp) > 0 ? { mrp: v.mrp } : {}) });
      }
      await refreshCatalog().catch(() => undefined);
      toast({ tone: "success", title: t("purchase.priceRise.updated", { count: chosen.length }) });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const set = (id: string, patch: Partial<{ rate: string; mrp: string; on: boolean }>) => setValues((v) => ({ ...v, [id]: { ...v[id]!, ...patch } }));

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      title={
        <span className="inline-flex items-center gap-2">
          <TrendingUp size={18} className="text-warn" /> {t("purchase.priceRise.title")}
        </span>
      }
      description={t("purchase.priceRise.hint")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onDone}>{t("purchase.priceRise.skip")}</Button>
          <Button variant="primary" disabled={busy || invalid || chosen.length === 0} onClick={() => void update()}>
            {busy ? t("common.saving") : t("purchase.priceRise.update", { count: chosen.length })}
          </Button>
        </div>
      }
    >
      {error ? <ErrorNote error={error} /> : null}
      <ul className="flex flex-col divide-y divide-line" data-testid="price-rises">
        {rises.map((r) => {
          const v = values[r.productId]!;
          return (
            <li key={r.productId} className="flex flex-col gap-2 py-3">
              <label className="flex items-start gap-2.5">
                <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={v.on} onChange={(e) => set(r.productId, { on: e.target.checked })} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{r.name}</span>
                  <span className="num flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-3">
                    {t("purchase.priceRise.cost")} {money(r.oldCost)} <ArrowRight size={12} /> <span className="font-medium text-danger">{money(r.newCost)}</span> (+{number(r.risePercent, 1)}%) · {t("purchase.priceRise.perUnit", { unit: r.unit })}
                  </span>
                  {r.marginBefore !== null && (
                    <span className="num flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-3">
                      {t("purchase.priceRise.margin")} {number(r.marginBefore, 1)}% <ArrowRight size={12} /> <span className="font-medium text-warn">{number(r.marginNow ?? "0", 1)}%</span> · {t("purchase.priceRise.rateNow")} {money(r.currentRate)}
                      {r.inclusive && ` ${t("purchase.priceRise.inclTax")}`}
                    </span>
                  )}
                </span>
              </label>
              {v.on && (
                <div className="grid grid-cols-2 gap-2 pl-6">
                  <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                    {t("purchase.priceRise.newRate")}
                    <Input inputSize="sm" inputMode="decimal" aria-label={`${t("purchase.priceRise.newRate")} · ${r.name}`} leading={<span className="text-[12px]">₹</span>} value={v.rate} onChange={(e) => set(r.productId, { rate: e.target.value.trim() })} invalid={!RATE.test(v.rate)} />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                    {t("product.mrp")}
                    <Input inputSize="sm" inputMode="decimal" aria-label={`${t("product.mrp")} · ${r.name}`} leading={<span className="text-[12px]">₹</span>} value={v.mrp} onChange={(e) => set(r.productId, { mrp: e.target.value.trim() })} invalid={v.mrp !== "" && !RATE.test(v.mrp)} />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
