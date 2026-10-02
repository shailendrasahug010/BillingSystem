import type { DocumentTotals } from "@digitalbahi/core";
import { Minus, Plus, ShoppingBasket, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useI18n } from "../../app/i18n";
import { EmptyState } from "../../components/ui/misc";
import { allowed, productById } from "../../data/db";
import { cn } from "../../lib/cn";
import type { Product } from "../../data/types";
import { saleUnits, unitByLetter, type SaleUnit } from "./units";
import { factorOf, unitSymbolOf, type DraftLine } from "./useInvoiceDraft";

/** Numeric input that keeps the typed text (e.g. "12.") and commits valid numbers. */
function NumberCell({
  value,
  onCommit,
  label,
  className,
  inputRef,
  onEnter,
  onTab,
  onLetter,
  decimals = 2,
}: {
  value: number;
  onCommit(v: number): void;
  label: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Enter: the next field, or back to product search. */
  onEnter?(): void;
  /** Tab (without Shift) from the line's last field: back to product search. */
  onTab?(): void;
  /** A letter typed in it (a unit's letter after the quantity); true when it was taken. */
  onLetter?(letter: string): boolean;
  decimals?: number;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <input
      ref={inputRef}
      aria-label={label}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(String(value));
      }}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9.]/g, "");
        setText(raw);
        const n = Number(raw);
        if (raw !== "" && Number.isFinite(n)) onCommit(Math.round(n * 10 ** decimals) / 10 ** decimals);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter?.();
        } else if (e.key === "Tab" && !e.shiftKey && onTab) {
          e.preventDefault();
          onTab();
        } else if (onLetter && e.key.length === 1 && /\p{L}/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && onLetter(e.key)) {
          e.preventDefault();
        }
      }}
      className={cn(
        "num h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-right text-[14px] text-ink hover:border-line focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/20 focus:outline-none",
        className,
      )}
    />
  );
}

/**
 * The unit a line is sold in: the product's own or one of its packs (box of
 * 24, strip of 10), each shown with its letter. Changing it re-prices the line
 * for that unit; the letter, typed on the list or after the quantity, picks it.
 * A product sold in one unit only shows it.
 */
function UnitSelect({
  product,
  line,
  units,
  onUnit,
  onEnter,
  onTab,
  selectRef,
  className,
}: {
  product: Product;
  line: DraftLine;
  units: SaleUnit[];
  onUnit(unitId: string | null): void;
  onEnter?(): void;
  /** Tab (without Shift): the next field of the line (it comes after the quantity, wherever it is drawn). */
  onTab?(): void;
  selectRef?: Ref<HTMLSelectElement>;
  className?: string;
}) {
  const { t } = useI18n();
  if (units.length < 2) {
    return (
      <span className="shrink-0 font-medium text-ink-2" title={t("invoice.unitOnly", { unit: product.unit })}>
        {product.unit}
      </span>
    );
  }
  return (
    <select
      ref={selectRef}
      aria-label={`${t("invoice.unit")} ${product.name}`}
      value={line.unitId ?? ""}
      onChange={(e) => onUnit(e.target.value || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        } else if (e.key === "Tab" && !e.shiftKey && onTab) {
          e.preventDefault();
          onTab();
        } else if (e.key.length === 1 && /\p{L}/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // The unit's letter, the business's own ones included (the list's type-to-find goes by the text).
          e.preventDefault();
          const u = unitByLetter(units, line.unitId, e.key);
          if (u && u.unitId !== line.unitId) onUnit(u.unitId);
        }
      }}
      className={cn("shrink-0 rounded-md border border-line bg-surface px-1 font-medium text-ink-2 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none", className)}
    >
      {units.map((u) => (
        <option key={u.unitId ?? ""} value={u.unitId ?? ""}>
          {u.letter} · {u.factor === 1 ? u.symbol : `${u.symbol} (${u.factor} ${product.unit})`}
        </option>
      ))}
    </select>
  );
}

function LineWarnings({ line }: { line: DraftLine }) {
  const { t } = useI18n();
  const p = productById.get(line.productId)!;
  const factor = factorOf(p, line.unitId);
  const short = line.qty * factor > p.stock;
  const belowCost = line.rate * (1 - line.discountPercent / 100) < p.purchasePrice * factor;
  if (!short && !belowCost) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] font-medium">
      {short && (
        <span className="inline-flex items-center gap-1 text-warn">
          <TriangleAlert size={12} /> {p.stock <= 0 ? t("status.stock.out_of_stock") : t("invoice.stockShort", { qty: `${p.stock} ${p.unit}` })}
        </span>
      )}
      {belowCost && (
        <span className="inline-flex items-center gap-1 text-danger">
          <TriangleAlert size={12} /> {t("invoice.belowCost")}
        </span>
      )}
    </div>
  );
}

/**
 * Scrolls an element into view clear of what stays on screen over the page
 * (the search bar above, the total bar below), given as its scroll margins.
 * Chrome's scrollIntoView({ block: "nearest" }) leaves an element alone while
 * any of it shows, even under those bars.
 */
function reveal(el: HTMLElement, behavior: ScrollBehavior = "auto") {
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  if (box.bottom + parseFloat(style.scrollMarginBottom) > window.innerHeight) el.scrollIntoView({ block: "end", behavior });
  else if (box.top - parseFloat(style.scrollMarginTop) < 0) el.scrollIntoView({ block: "start", behavior });
}

export function LineItems({
  lines,
  totals,
  focusKey,
  onFocused,
  onUpdate,
  onUnit,
  onRemove,
  onBackToSearch,
  variant = "desktop",
}: {
  lines: DraftLine[];
  totals: DocumentTotals | null;
  focusKey: string | null;
  onFocused(): void;
  onUpdate(key: string, patch: Partial<Pick<DraftLine, "qty" | "rate" | "discountPercent">>): void;
  onUnit(key: string, unitId: string | null): void;
  onRemove(key: string): void;
  onBackToSearch(): void;
  variant?: "desktop" | "mobile";
}) {
  const { t, money, locale } = useI18n();
  const qtyRefs = useRef(new Map<string, HTMLInputElement>());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const canChangeRate = allowed("invoice.override_price");
  const rateRefs = useRef(new Map<string, HTMLInputElement>());
  const unitRefs = useRef(new Map<string, HTMLSelectElement>());
  const discountRefs = useRef(new Map<string, HTMLInputElement>());
  // The line just added or added to, lit for a moment (on a phone, where its quantity is not focused).
  const [lit, setLit] = useState<string | null>(null);
  // Keyboard billing: product search -> Enter -> qty -> Enter -> rate -> Enter -> product search.
  // Without the price-override permission the rate is fixed, so qty goes straight back.
  const toRate = (key: string) => {
    const el = canChangeRate ? rateRefs.current.get(key) : undefined;
    if (el) el.focus();
    else onBackToSearch();
  };
  // A unit's letter typed after the quantity (2 then B: 2 boxes) picks it, as on the unit list.
  const byLetter = (units: SaleUnit[], line: DraftLine, letter: string) => {
    const u = unitByLetter(units, line.unitId, letter);
    if (!u) return false;
    if (u.unitId !== line.unitId) onUnit(line.key, u.unitId);
    return true;
  };
  // Tab keeps the old order, qty → unit → rate → Disc %, though the unit is drawn under the name.
  const afterUnit = (key: string) => (canChangeRate ? rateRefs.current.get(key) : discountRefs.current.get(key))?.focus();
  const keep = <E,>(refs: { current: Map<string, E> }, key: string) => (el: E | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };

  useEffect(() => {
    if (!focusKey) return;
    if (variant === "desktop") {
      const el = qtyRefs.current.get(focusKey);
      if (el) {
        // Shown by the table's focus handler, clear of the bars.
        el.focus({ preventScroll: true });
        el.select();
      }
    } else {
      const row = rowRefs.current.get(focusKey);
      if (row) reveal(row, "smooth");
      setLit(focusKey);
    }
    onFocused();
  }, [focusKey, onFocused, variant]);
  useEffect(() => {
    if (!lit) return;
    const timer = setTimeout(() => setLit(null), 1200);
    return () => clearTimeout(timer);
  }, [lit]);

  const resultFor = (key: string) => totals?.lines.find((l) => l.key === key);

  if (lines.length === 0) {
    return <EmptyState icon={<ShoppingBasket size={20} />} title={t("invoice.noItems")} hint={t("invoice.noItemsHint")} className="py-8" />;
  }

  if (variant === "mobile") {
    // Two rows a line: the name and the quantity at the thumb, then the price and the amount.
    return (
      <ul className="flex flex-col divide-y divide-line">
        {lines.map((line) => {
          const p = productById.get(line.productId)!;
          const r = resultFor(line.key);
          const name = locale === "hi" ? p.nameHi : p.name;
          const units = saleUnits(p);
          return (
            <li
              key={line.key}
              ref={(el) => {
                if (el) rowRefs.current.set(line.key, el);
                else rowRefs.current.delete(line.key);
              }}
              className={cn("-mx-4 scroll-mt-36 scroll-mb-48 px-4 py-2 transition-colors duration-700", lit === line.key && "bg-accent-soft")}
            >
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[14.5px] leading-snug font-medium text-ink">{name}</p>
                <div className="flex w-[8.5rem] shrink-0 items-center rounded-xl border border-line bg-surface">
                  <button type="button" className="flex size-10 shrink-0 items-center justify-center text-ink-2" aria-label={`−1 ${p.name}`} onClick={() => (line.qty > 1 ? onUpdate(line.key, { qty: line.qty - 1 }) : onRemove(line.key))}>
                    <Minus size={17} />
                  </button>
                  <NumberCell
                    value={line.qty}
                    label={`${t("invoice.qty")} ${p.name}`}
                    decimals={3}
                    onCommit={(v) => onUpdate(line.key, { qty: v })}
                    onEnter={onBackToSearch}
                    onLetter={(letter) => byLetter(units, line, letter)}
                    className="h-10 px-1 text-center text-[16px] font-semibold"
                  />
                  <button type="button" className="flex size-10 shrink-0 items-center justify-center text-ink-2" aria-label={`+1 ${p.name}`} onClick={() => onUpdate(line.key, { qty: line.qty + 1 })}>
                    <Plus size={17} />
                  </button>
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <p className="num min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
                  {money(line.rate)} × {line.qty} {unitSymbolOf(p, line.unitId)} · GST {p.gstRate}%
                </p>
                {units.length > 1 && <UnitSelect product={p} line={line} units={units} onUnit={(u) => onUnit(line.key, u)} className="h-8 text-[13px]" />}
                <span className="num text-[15px] font-semibold text-ink">{r ? money(r.total.toNumber()) : "—"}</span>
                <button type="button" onClick={() => onRemove(line.key)} className="-mr-1.5 flex size-8 items-center justify-center rounded-lg text-ink-3 hover:text-danger" aria-label={`${t("invoice.remove")}: ${p.name}`}>
                  <Trash size={16} />
                </button>
              </div>
              <LineWarnings line={line} />
            </li>
          );
        })}
      </ul>
    );
  }

  // One compact row a line, the table as wide as its card (no sideways scrolling to see the amount).
  return (
    <table
      className="w-full table-fixed text-[13.5px]"
      // A field reached by Enter, Tab or a new line: in view, clear of the search bar and the total bar.
      onFocus={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) reveal(e.target);
      }}
    >
      <colgroup>
        <col className="w-8" />
        <col />
        <col className="w-[116px]" />
        <col className="w-20" />
        <col className="w-14" />
        <col className="w-[104px]" />
        <col className="w-9" />
      </colgroup>
      <thead>
        <tr className="border-b border-line text-left text-[12px] text-ink-3">
          <th className="py-1.5 pl-3 font-medium">#</th>
          <th className="py-1.5 pl-1 font-medium">{t("invoice.product")}</th>
          <th className="py-1.5 text-center font-medium">{t("invoice.qty")}</th>
          <th className="py-1.5 pr-2 text-right font-medium">{t("invoice.rate")}</th>
          <th className="py-1.5 pr-2 text-right font-medium">{t("invoice.discount")}</th>
          <th className="py-1.5 pr-2 text-right font-medium">{t("invoice.amount")}</th>
          <th className="py-1.5" />
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => {
          const p = productById.get(line.productId)!;
          const r = resultFor(line.key);
          const name = locale === "hi" ? p.nameHi : p.name;
          const units = saleUnits(p);
          return (
            // The search bar stays at the top while lines scroll: a focused field keeps clear of it.
            <tr key={line.key} className="border-b border-line last:border-b-0 hover:bg-surface-2/60 focus-within:bg-accent-soft/40 [&_input]:scroll-mt-48 [&_input]:scroll-mb-28 [&_select]:scroll-mt-48">
              <td className="num py-1 pl-3 align-middle text-[12px] text-ink-3">{i + 1}</td>
              <td className="py-1 pl-1 align-middle">
                <p className="truncate leading-tight font-medium text-ink" title={name}>
                  {name}
                </p>
                <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-tight text-ink-3">
                  <span className="truncate">
                    <span className="font-mono">{p.code}</span> · GST {r ? r.gstRate.toNumber() : p.gstRate}%{p.batch ? ` · ${t("invoice.batch")} ${p.batch.number}` : ""}
                  </span>
                  <span aria-hidden>·</span>
                  <UnitSelect product={p} line={line} units={units} onUnit={(u) => onUnit(line.key, u)} onEnter={() => toRate(line.key)} onTab={() => afterUnit(line.key)} selectRef={keep(unitRefs, line.key)} className="h-5 text-[11px]" />
                </div>
                <LineWarnings line={line} />
              </td>
              <td className="py-1 align-middle">
                <div className="flex items-center justify-center">
                  <button type="button" tabIndex={-1} className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={`−1 ${p.name}`} onClick={() => onUpdate(line.key, { qty: Math.max(1, line.qty - 1) })}>
                    <Minus size={14} />
                  </button>
                  <NumberCell
                    value={line.qty}
                    decimals={3}
                    label={`${t("invoice.qty")} ${p.name}`}
                    inputRef={(el) => {
                      if (el) qtyRefs.current.set(line.key, el);
                      else qtyRefs.current.delete(line.key);
                    }}
                    onCommit={(v) => onUpdate(line.key, { qty: v })}
                    onEnter={() => toRate(line.key)}
                    onLetter={(letter) => byLetter(units, line, letter)}
                    {...(units.length > 1 ? { onTab: () => unitRefs.current.get(line.key)?.focus() } : {})}
                    className="h-8 px-1 text-center font-semibold"
                  />
                  <button type="button" tabIndex={-1} className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={`+1 ${p.name}`} onClick={() => onUpdate(line.key, { qty: line.qty + 1 })}>
                    <Plus size={14} />
                  </button>
                </div>
              </td>
              <td className="py-1 pr-1 align-middle">
                {/* The rate-list price; only roles allowed to change prices can type another. */}
                {canChangeRate ? (
                  <NumberCell
                    value={line.rate}
                    label={`${t("invoice.rate")} ${p.name}`}
                    inputRef={(el) => {
                      if (el) rateRefs.current.set(line.key, el);
                      else rateRefs.current.delete(line.key);
                    }}
                    onCommit={(v) => onUpdate(line.key, { rate: v })}
                    onEnter={onBackToSearch}
                    className="h-8"
                  />
                ) : (
                  <p className="num h-8 px-2 text-right text-[14px] leading-8 text-ink" aria-label={`${t("invoice.rate")} ${p.name}`}>
                    {line.rate}
                  </p>
                )}
              </td>
              <td className="py-1 pr-1 align-middle">
                <NumberCell
                  value={line.discountPercent}
                  label={`${t("invoice.discount")} ${p.name}`}
                  inputRef={keep(discountRefs, line.key)}
                  onCommit={(v) => onUpdate(line.key, { discountPercent: Math.min(100, v) })}
                  onEnter={onBackToSearch}
                  onTab={onBackToSearch}
                  className="h-8"
                />
              </td>
              <td className="py-1 pr-2 text-right align-middle">
                <p className="num truncate font-semibold text-ink" title={r && r.taxTotal.gt(0) ? `${t("invoice.tax")} ${money(r.taxTotal.toNumber())}` : undefined}>
                  {r ? money(r.total.toNumber()) : "—"}
                </p>
              </td>
              <td className="py-1 pr-1 align-middle">
                <button type="button" onClick={() => onRemove(line.key)} className="flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-danger-soft hover:text-danger" aria-label={`${t("invoice.remove")}: ${p.name}`}>
                  <Trash size={15} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
