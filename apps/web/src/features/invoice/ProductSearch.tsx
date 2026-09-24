import { searchProducts, stockLevel } from "@vyapaar/core";
import { ScanBarcode, Search } from "lucide-react";
import { forwardRef, useId, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Kbd } from "../../components/ui/misc";
import { PRODUCTS } from "../../data/mock";
import type { CustomerInsight } from "../../data/store";
import type { Customer, Product } from "../../data/types";
import { cn } from "../../lib/cn";
import { rateFor } from "./useInvoiceDraft";

const searchable = PRODUCTS.map((p) => ({
  ...p,
  barcodes: [p.barcode],
  aliases: [p.nameHi, ...p.aliases],
  sku: p.code,
  active: true,
  inStock: p.stock > 0,
}));

/**
 * Product search runs locally over the cached catalogue (instant, works
 * offline). A hardware barcode scanner types the code and presses Enter, so an
 * exact barcode match is added immediately without opening the list.
 */
export const ProductSearch = forwardRef<
  HTMLInputElement,
  { customer: Customer | null; insight: CustomerInsight | null; cartIds: string[]; onAdd(productId: string): void; large?: boolean; onScan?(): void }
>(function ProductSearch({ customer, insight, cartIds, onAdd, large, onScan }, ref) {
  const { t, money, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const affinity = useMemo(() => {
    const m = new Map<string, number>();
    insight?.stats.forEach((s, id) => m.set(id, s.orderShare));
    return m;
  }, [insight]);

  const hits = useMemo(
    () => (query.trim() ? searchProducts(query, searchable, { customerAffinity: affinity, limit: 8 }) : []),
    [query, affinity],
  );

  const add = (p: Product) => {
    onAdd(p.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search size={large ? 20 : 18} className="pointer-events-none absolute left-3.5 text-ink-3" />
          <input
            ref={ref}
            role="combobox"
            aria-expanded={open && hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && hits[active] ? `${listId}-${active}` : undefined}
            aria-label={t("invoice.searchProduct")}
            placeholder={t("invoice.searchProduct")}
            value={query}
            inputMode="search"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                const hit = hits[active];
                if (hit) {
                  e.preventDefault();
                  add(hit.product);
                }
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            className={cn(
              "w-full rounded-xl border border-line bg-surface pr-14 text-ink placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none",
              large ? "h-14 pl-11 text-[16px]" : "h-12 pl-10 text-[15px]",
            )}
          />
          <Kbd keys="f2" className="absolute right-3 hidden sm:inline-flex" />
        </div>
        <button
          type="button"
          onClick={onScan}
          className={cn(
            "inline-flex shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 font-medium text-ink hover:border-accent",
            large ? "h-14" : "h-12",
          )}
          aria-label={t("invoice.scan")}
        >
          <ScanBarcode size={20} className="text-accent" />
          <span className="hidden sm:inline">{t("invoice.scan")}</span>
        </button>
      </div>

      {open && hits.length > 0 && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-[420px] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          {hits.map((hit, i) => {
            const p = hit.product;
            const level = stockLevel(p.stock, p.minStock);
            const stats = insight?.stats.get(p.id);
            const inCart = cartIds.includes(p.id);
            return (
              <li
                key={p.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(p);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5", i === active && "bg-surface-2")}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-ink">
                    {locale === "hi" ? p.nameHi : p.name}
                    {inCart && <span className="ml-2 text-[12px] font-normal text-accent">✓ {t("invoice.alreadyAdded")}</span>}
                  </p>
                  <p className="truncate text-[12.5px] text-ink-3">
                    <span className="font-mono">{p.code}</span> · {p.brand} · {p.packSize} · HSN <span className="font-mono">{p.hsn}</span> · GST {p.gstRate}%
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="num text-[14px] font-semibold text-ink">{money(rateFor(p, customer))}</span>
                  <div className="flex gap-1">
                    {stats && stats.orderCount >= 2 && (
                      <span title={t("suggestions.reason.frequent", { count: stats.orderCount, total: insight!.summary.invoiceCount })}>
                        <Badge tone="accent" className="h-5 px-2 text-[11px]">
                          <span className="num">{stats.orderCount}×</span>
                        </Badge>
                      </span>
                    )}
                    <Badge tone={level === "out_of_stock" ? "danger" : level === "low" ? "warn" : "neutral"} className="h-5 px-2 text-[11px]">
                      {level === "out_of_stock" ? t("status.stock.out_of_stock") : t("invoice.inStock", { qty: p.stock })}
                    </Badge>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open && query.trim().length > 0 && hits.length === 0 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1.5 rounded-xl border border-line bg-surface px-4 py-5 text-center text-[13px] text-ink-3 shadow-pop">
          {t("search.noResults", { query })}
        </div>
      )}
    </div>
  );
});
