import { searchProducts, stockLevel } from "@digitalbahi/core";
import { ScanBarcode, Search } from "lucide-react";
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Kbd } from "../../components/ui/misc";
import { useSearchableProducts } from "../../data/hooks";
import type { CustomerInsight } from "../../data/store";
import type { Customer, Product } from "../../data/types";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { parseSpokenItem, parseTypedItem } from "../../lib/spoken";
import { VoiceButton } from "../../components/voice/VoiceButton";
import { productById } from "../../data/db";
import { topBilled } from "./topItems";
import { usualPick, wholeUnit } from "./units";
import { rateFor } from "./useInvoiceDraft";

/** How a product is added: with the quantity said or typed with it, or in the unit and count the shop usually takes. */
export interface AddHow {
  spoken?: { qty: number; unit: string | null; letter?: string | null };
  pick?: { unitId: string | null; qty: number };
}


/**
 * Product search runs locally over the cached catalogue (instant, works
 * offline). A hardware barcode scanner types the code and presses Enter, so an
 * exact barcode match is added immediately without opening the list.
 */
export const ProductSearch = forwardRef<
  HTMLInputElement,
  { customer: Customer | null; insight: CustomerInsight | null; cartIds: string[]; onAdd(productId: string, how?: AddHow): void; large?: boolean; onScan?(): void }
>(function ProductSearch({ customer, insight, cartIds, onAdd, large, onScan }, ref) {
  const { t, money, locale } = useI18n();
  // A phone-wide box shows a shorter hint, so it is read in full rather than cut off.
  const narrow = useMediaQuery("(max-width: 639px)");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [browsed, setBrowsed] = useState(false);
  const listId = useId();
  const searchable = useSearchableProducts();
  // The list closes a moment after the field loses focus (so a click on it lands); coming back cancels that.
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);

  const affinity = useMemo(() => {
    const m = new Map<string, number>();
    insight?.stats.forEach((s, id) => m.set(id, s.orderShare));
    return m;
  }, [insight]);

  // A quantity typed with the name ("parle 10b"): the name is searched, the quantity goes with the product picked.
  // A number that is part of the name ("dolo 650") stays in it.
  const { hits, typed } = useMemo(() => {
    const find = (q: string) => (q.trim() ? searchProducts(q, searchable, { customerAffinity: affinity, limit: 8 }) : []);
    const whole = find(query);
    const item = parseTypedItem(query);
    if (item.qty === null || !item.name) return { hits: whole, typed: null };
    const top = whole[0]?.product.name.toLowerCase() ?? "";
    if (new RegExp(`\\b${item.qty}\\b`).test(top)) return { hits: whole, typed: null };
    const found = find(item.name);
    return found.length ? { hits: found, typed: { qty: item.qty, unit: item.unit, letter: item.letter } } : { hits: whole, typed: null };
  }, [query, affinity, searchable]);
  // With nothing typed: what was billed most today and this week, one tap away.
  const top = useMemo(() => (open && !query.trim() ? topBilled(8).map((id) => productById.get(id)!) : []), [open, query]);
  const rows = query.trim() ? hits.map((h) => h.product) : top;

  // The quantity and unit said with the name ("Parle G 10 box"), for the product picked from what it found.
  const [spoken, setSpoken] = useState<AddHow["spoken"] | null>(null);
  // Without a quantity: the unit and count this shop usually takes (not for a product already on the bill, which goes up by one).
  const usual = (p: Product): AddHow | undefined => {
    if (cartIds.includes(p.id)) return undefined;
    const pick = usualPick(p, insight?.stats.get(p.id));
    return pick ? { pick: { unitId: pick.unitId, qty: pick.qty } } : undefined;
  };
  const add = (p: Product) => {
    const said = spoken ?? typed;
    onAdd(p.id, said ? { spoken: said } : usual(p));
    setSpoken(null);
    setQuery("");
    setOpen(false);
    setBrowsed(false);
    setActive(0);
  };
  const heard = (text: string) => {
    const item = parseSpokenItem(text);
    const find = (q: string) => (q.trim() ? searchProducts(q, searchable, { customerAffinity: affinity, limit: 8 }) : []);
    // A number that is part of the name ("Dolo 650") stays in it.
    const whole = find(text);
    const top = whole[0]?.product.name.toLowerCase() ?? "";
    const inName = item.qty !== null && new RegExp(`\\b${item.qty}\\b`).test(top);
    const name = inName ? text : item.name;
    const found = inName ? whole : find(item.name);
    const said = !inName && item.qty !== null ? { qty: item.qty, unit: item.unit } : null;
    // One clear match (the only one, or a name that starts with what was said, well ahead of the rest) is added at once; otherwise the list is open to pick from.
    const clear = found.length === 1 || (found.length > 1 && found[0]!.score >= 200 && found[0]!.score - found[1]!.score >= 100);
    if (clear) {
      const p = found[0]!.product;
      onAdd(p.id, said ? { spoken: said } : usual(p));
      setSpoken(null);
      setQuery("");
      setOpen(false);
      return;
    }
    setSpoken(said);
    setQuery(name);
    setActive(0);
    setOpen(true);
  };

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search size={large ? 20 : 18} className="pointer-events-none absolute left-3.5 text-ink-3" />
          <input
            ref={ref}
            role="combobox"
            aria-expanded={open && rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
            aria-label={t("invoice.searchProduct")}
            placeholder={narrow ? t("invoice.searchProductShort") : t("invoice.searchProduct")}
            value={query}
            inputMode="search"
            onChange={(e) => {
              setQuery(e.target.value);
              setSpoken(null);
              setBrowsed(false);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => {
              clearTimeout(closing.current);
              setOpen(true);
            }}
            onBlur={() => {
              closing.current = setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setBrowsed(true);
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setBrowsed(true);
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                // The day's list (nothing typed) takes Enter only once an arrow picked from it.
                const p = query.trim() || browsed ? rows[active] : undefined;
                if (p) {
                  e.preventDefault();
                  add(p);
                }
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            className={cn(
              "w-full rounded-xl border border-line bg-surface pr-14 text-ink placeholder:text-ink-3 sm:pr-24 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none",
              large ? "h-14 pl-11 text-[16px]" : "h-12 pl-10 text-[15px]",
            )}
          />
          <span className="absolute right-2 flex items-center gap-1.5">
            <Kbd keys="f2" className="hidden sm:inline-flex" />
            <VoiceButton onText={heard} label={t("voice.sayProduct")} className={large ? "size-10" : "size-9"} />
          </span>
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

      {open && rows.length > 0 && (
        <ul id={listId} role="listbox" aria-label={query.trim() ? undefined : t("invoice.topToday")} className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-[420px] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          {!query.trim() && (
            <li role="presentation" className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-3">
              {t("invoice.topToday")}
            </li>
          )}
          {typed && (
            <li role="presentation" className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-accent">
              {t("invoice.typedQty", { qty: typed.qty, unit: typed.unit ?? typed.letter ?? "" })}
            </li>
          )}
          {rows.map((p, i) => {
            const level = stockLevel(p.stock, p.minStock);
            const stats = insight?.stats.get(p.id);
            const inCart = cartIds.includes(p.id);
            // What this shop paid last time, in the unit it took then (the bill's rate before tax, with tax for a price list that includes it).
            const last = stats?.lastRate ? wholeUnit(p, stats.lastQty.toNumber()) : null;
            const lastRate = last && stats?.lastRate ? stats.lastRate.toNumber() * last.factor * (p.pricesIncludeTax ? 1 + p.gstRate / 100 : 1) : 0;
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
                    {[p.code, p.brand, p.packSize, p.hsn && `HSN ${p.hsn}`, `GST ${p.gstRate}%`].filter(Boolean).join(" · ")}
                  </p>
                  {last && stats && (
                    <p className="num truncate text-[12px] font-medium text-ink-2">
                      {t("invoice.lastTime", { qty: last.qty, unit: last.symbol, rate: money(lastRate), count: stats.daysSinceLast })}
                    </p>
                  )}
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
