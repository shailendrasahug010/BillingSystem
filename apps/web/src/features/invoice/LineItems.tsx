import type { DocumentTotals } from "@digitalbahi/core";
import { Copy, Minus, Plus, Replace, ShoppingBasket, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useI18n } from "../../app/i18n";
import { EmptyState } from "../../components/ui/misc";
import { allowed, PRODUCTS, productById } from "../../data/db";
import { inStockAlternative } from "./alternatives";
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
  onFocusChange,
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
  /** The field gained (true) or lost (false) the cursor. */
  onFocusChange?(focused: boolean): void;
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
        onFocusChange?.(true);
      }}
      onBlur={() => {
        focused.current = false;
        setText(String(value));
        onFocusChange?.(false);
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

/**
 * Under a line: too little stock (with an in-stock product of the same kind
 * to swap in), a price below cost, and the product on another line of the
 * bill too (in another unit), so it is not billed twice by mistake.
 */
function LineWarnings({ line, lines, onReplace }: { line: DraftLine; lines: DraftLine[]; onReplace?(productId: string): void }) {
  const { t, locale } = useI18n();
  const p = productById.get(line.productId)!;
  const factor = factorOf(p, line.unitId);
  const need = (line.qty + (line.freeQty || 0)) * factor;
  const short = need > p.stock;
  const belowCost = line.rate * (1 - line.discountPercent / 100) < p.purchasePrice * factor;
  const twin = lines.findIndex((l) => l.key !== line.key && l.productId === line.productId);
  const instead = short && onReplace ? inStockAlternative(p, need, PRODUCTS, new Set(lines.map((l) => l.productId))) : null;
  if (!short && !belowCost && twin < 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] font-medium">
      {short && (
        <span className="inline-flex items-center gap-1 text-warn">
          <TriangleAlert size={12} /> {p.stock <= 0 ? t("status.stock.out_of_stock") : t("invoice.stockShort", { qty: `${p.stock} ${p.unit}` })}
        </span>
      )}
      {instead && (
        <button type="button" onClick={() => onReplace!(instead.id)} className="inline-flex items-center gap-1 rounded-md px-1 text-accent hover:underline" title={t("invoice.swapHint")}>
          <Replace size={12} /> {t("invoice.swapFor", { name: locale === "hi" ? instead.nameHi : instead.name, qty: instead.stock })}
        </button>
      )}
      {belowCost && (
        <span className="inline-flex items-center gap-1 text-danger">
          <TriangleAlert size={12} /> {t("invoice.belowCost")}
        </span>
      )}
      {twin >= 0 && (
        <span className="inline-flex items-center gap-1 text-warn">
          <Copy size={12} /> {t("invoice.alsoOnLine", { line: twin + 1, qty: lines[twin]!.qty, unit: unitSymbolOf(p, lines[twin]!.unitId) })}
        </span>
      )}
    </div>
  );
}

/** One-tap counts under a line on a phone while its quantity is typed: in its unit, then one or two of each bigger pack. */
function QuickQty({ product, line, units, onPick }: { product: Product; line: DraftLine; units: SaleUnit[]; onPick(qty: number, unitId?: string | null): void }) {
  const { t } = useI18n();
  const symbol = unitSymbolOf(product, line.unitId);
  const factor = factorOf(product, line.unitId);
  const packs = units.filter((u) => u.factor > factor).slice(0, 2);
  // Tapped, a count keeps the quantity field focused (else the field's blur would hide the counts before the tap lands).
  const keep = (e: { preventDefault(): void }) => e.preventDefault();
  const chip = "num h-9 min-w-10 shrink-0 rounded-lg border border-line bg-surface px-2.5 text-[13.5px] font-semibold text-ink active:bg-accent-soft";
  return (
    <div className="-mx-1 mt-1.5 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label={`${t("invoice.quickQty")}: ${product.name}`}>
      {QUICK_COUNTS.map((n) => (
        <button key={n} type="button" onPointerDown={keep} onMouseDown={keep} onClick={() => onPick(n)} aria-pressed={line.qty === n} className={cn(chip, line.qty === n && "border-accent bg-accent-soft text-accent")}>
          {n}
          {n === 1 && <span className="ml-1 text-[11px] font-medium text-ink-3">{symbol}</span>}
        </button>
      ))}
      {packs.flatMap((u) =>
        [1, 2].map((n) => (
          <button key={`${u.symbol}-${n}`} type="button" onPointerDown={keep} onMouseDown={keep} onClick={() => onPick(n, u.unitId)} className={cn(chip, "text-accent")}>
            {n} {u.symbol}
          </button>
        )),
      )}
    </div>
  );
}

const QUICK_COUNTS = [1, 2, 3, 5, 10, 12, 24];

/**
 * Scrolls an element into view clear of what stays on screen over the page:
 * the bars marked data-overlay (the top bar and the pinned search above, the
 * total bar and a phone's tab bar below), measured where they are now, so at
 * any zoom. Chrome's scrollIntoView({ block: "nearest" }) leaves an element
 * alone while any of it shows, even under those bars.
 */
function reveal(el: HTMLElement, behavior: ScrollBehavior = "auto") {
  const bars = [...document.querySelectorAll<HTMLElement>("[data-overlay]")].map((b) => ({ side: b.dataset.overlay, box: b.getBoundingClientRect() })).filter((b) => b.box.height > 0);
  const top = Math.max(0, ...bars.filter((b) => b.side === "top").map((b) => b.box.bottom)) + 8;
  const bottom = Math.min(window.innerHeight, ...bars.filter((b) => b.side === "bottom").map((b) => b.box.top)) - 8;
  const box = el.getBoundingClientRect();
  if (box.bottom > bottom) window.scrollBy({ top: box.bottom - bottom, behavior });
  else if (box.top < top) window.scrollBy({ top: box.top - top, behavior });
}

export function LineItems({
  lines,
  totals,
  focusKey,
  onFocused,
  onUpdate,
  onUnit,
  onRemove,
  onReplace,
  onBackToSearch,
  variant = "desktop",
}: {
  lines: DraftLine[];
  totals: DocumentTotals | null;
  focusKey: string | null;
  onFocused(): void;
  onUpdate(key: string, patch: Partial<Pick<DraftLine, "qty" | "freeQty" | "rate" | "discountPercent">>): void;
  onUnit(key: string, unitId: string | null): void;
  onRemove(key: string): void;
  /** An out-of-stock line swapped for an in-stock product. */
  onReplace?(key: string, productId: string): void;
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
  // On a phone, the line whose free quantity was asked for (its field shows while it is 0).
  const [freeOpen, setFreeOpen] = useState<string | null>(null);
  const focusFree = useRef<string | null>(null);
  // On a phone, the line whose one-tap counts show: the one whose quantity is being typed.
  const [picking, setPicking] = useState<string | null>(null);
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
              className={cn("animate-line -mx-4 scroll-mt-36 scroll-mb-48 px-4 py-2 transition-colors duration-700", lit === line.key && "bg-accent-soft")}
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
                    onFocusChange={(on) => setPicking(on ? line.key : null)}
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
                {/* Free pieces (10+1): a small button until there are some, so the price keeps its room. */}
                {line.freeQty > 0 || freeOpen === line.key ? (
                  <label className="flex shrink-0 items-center gap-1 text-[12px] text-good">
                    {t("invoice.free")}
                    <span className="w-11 shrink-0">
                      <NumberCell
                        value={line.freeQty}
                        decimals={3}
                        label={`${t("invoice.free")} ${p.name}`}
                        inputRef={(el) => {
                          // Opened by its button: the cursor goes in once.
                          if (el && focusFree.current === line.key) {
                            focusFree.current = null;
                            el.focus();
                          }
                        }}
                        onCommit={(v) => onUpdate(line.key, { freeQty: v })}
                        onEnter={onBackToSearch}
                        className="h-8 border-line px-1 text-[13px] font-semibold text-good"
                      />
                    </span>
                  </label>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      focusFree.current = line.key;
                      setFreeOpen(line.key);
                    }}
                    className="h-8 shrink-0 rounded-lg px-1.5 text-[12px] font-medium text-accent"
                    aria-label={`${t("invoice.free")} ${p.name}`}
                  >
                    +{t("invoice.free")}
                  </button>
                )}
                {units.length > 1 && <UnitSelect product={p} line={line} units={units} onUnit={(u) => onUnit(line.key, u)} className="h-8 text-[13px]" />}
                <span className="num text-[15px] font-semibold text-ink">{r ? money(r.total.toNumber()) : "—"}</span>
                <button type="button" onClick={() => onRemove(line.key)} className="-mr-1.5 flex size-8 items-center justify-center rounded-lg text-ink-3 hover:text-danger" aria-label={`${t("invoice.remove")}: ${p.name}`}>
                  <Trash size={16} />
                </button>
              </div>
              {picking === line.key && (
                <QuickQty
                  product={p}
                  line={line}
                  units={units}
                  onPick={(qty, unitId) => {
                    if (unitId !== undefined) onUnit(line.key, unitId);
                    onUpdate(line.key, { qty });
                    // Picked: the keypad closes with the field.
                    (document.activeElement as HTMLElement | null)?.blur();
                  }}
                />
              )}
              <LineWarnings line={line} lines={lines} {...(onReplace ? { onReplace: (id: string) => onReplace(line.key, id) } : {})} />
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
          <th className="py-1.5 pr-2 text-right font-medium">{t("invoice.free")}</th>
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
            <tr key={line.key} className="animate-line border-b border-line last:border-b-0 hover:bg-surface-2/60 focus-within:bg-accent-soft/40 [&_input]:scroll-mt-48 [&_input]:scroll-mb-28 [&_select]:scroll-mt-48">
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
                <LineWarnings line={line} lines={lines} {...(onReplace ? { onReplace: (id: string) => onReplace(line.key, id) } : {})} />
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
              <td className="py-1 pr-1 align-middle">
                {/* Scheme quantity given free (10+1), in the line's unit; clicked into, so Tab from Disc % still goes back to the search. */}
                <NumberCell
                  value={line.freeQty}
                  decimals={3}
                  label={`${t("invoice.free")} ${p.name}`}
                  onCommit={(v) => onUpdate(line.key, { freeQty: v })}
                  onEnter={onBackToSearch}
                  onTab={onBackToSearch}
                  className={cn("h-8", line.freeQty > 0 && "font-semibold text-good")}
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
