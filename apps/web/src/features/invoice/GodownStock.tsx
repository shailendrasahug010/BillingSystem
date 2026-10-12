import { Warehouse } from "lucide-react";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import type { Product } from "../../data/types";
import { godowns, pickGodown, useGodownStock } from "./godown";

/** A product's stock in the godown the bill takes it from (null: not known, the total is shown). */
const InGodown = createContext<(productId: string) => number | null>(() => null);

/** Bill lines and the product search below this show the stock of `warehouseId` (when the business has more than one godown). */
export function GodownStockProvider({ warehouseId, children }: { warehouseId: string | null; children: ReactNode }) {
  const stock = useGodownStock(pickGodown() ? warehouseId : null);
  const inGodown = useCallback((productId: string) => (stock ? (stock.get(productId) ?? 0) : null), [stock]);
  return <InGodown.Provider value={inGodown}>{children}</InGodown.Provider>;
}

/** The stock a screen should go by for a product: its godown's when known, else the total. */
export function useStockOf(): (product: Product) => number {
  const inGodown = useContext(InGodown);
  return useCallback((product: Product) => inGodown(product.id) ?? product.stock, [inGodown]);
}

/** Which godown the goods leave from: shown only when the business has more than one. */
export function GodownPicker({ value, onChange }: { value: string | null; onChange(id: string): void }) {
  const { t } = useI18n();
  if (!pickGodown()) return null;
  const list = godowns();
  return (
    <label className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
      <Warehouse size={14} className="text-ink-3" aria-hidden />
      <span className="sr-only sm:not-sr-only">{t("godowns.godown")}</span>
      <select
        id="bill-godown"
        className="h-8 max-w-[11rem] truncate rounded-md border border-line bg-surface px-2 text-[13px] font-medium text-ink focus:border-accent focus:outline-none"
        value={value ?? list[0]?.id ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("godowns.godown")}
      >
        {list.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}
