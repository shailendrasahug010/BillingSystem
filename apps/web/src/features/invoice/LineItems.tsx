import type { DocumentTotals } from "@vyapaar/core";
import { Minus, Plus, ShoppingBasket, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useI18n } from "../../app/i18n";
import { EmptyState } from "../../components/ui/misc";
import { productById } from "../../data/db";
import { cn } from "../../lib/cn";
import type { Product } from "../../data/types";
import { factorOf, type DraftLine } from "./useInvoiceDraft";

/** Numeric input that keeps the typed text (e.g. "12.") and commits valid numbers. */
function NumberCell({
  value,
  onCommit,
  label,
  className,
  inputRef,
  onEnter,
  decimals = 2,
}: {
  value: number;
  onCommit(v: number): void;
  label: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  onEnter?(): void;
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
 * The unit a line is sold in: the stock unit or one of the product's packs
 * (box of 24, strip of 10). Changing it re-prices the line for that unit.
 */
function UnitSelect({ product, line, onUnit, className }: { product: Product; line: DraftLine; onUnit(unitId: string | null): void; className?: string }) {
  const { t } = useI18n();
  const packs = product.packUnits ?? [];
  if (packs.length === 0) return <span className={cn("text-[11px] text-ink-3", className)}>{product.unit}</span>;
  return (
    <select
      aria-label={`${t("invoice.unit")} ${product.name}`}
      value={line.unitId ?? ""}
      onChange={(e) => onUnit(e.target.value || null)}
      className={cn("rounded-md border border-line bg-surface px-1.5 text-ink-2 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none", className)}
    >
      <option value="">{product.unit}</option>
      {[...packs]
        .sort((a, b) => a.factor - b.factor)
        .map((u) => (
          <option key={u.unitId} value={u.unitId}>
            {u.symbol} ({u.factor} {product.unit})
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

  useEffect(() => {
    if (!focusKey) return;
    const el = qtyRefs.current.get(focusKey);
    if (el && variant === "desktop") {
      el.focus();
      el.select();
    }
    onFocused();
  }, [focusKey, onFocused, variant]);

  const resultFor = (key: string) => totals?.lines.find((l) => l.key === key);

  if (lines.length === 0) {
    return <EmptyState icon={<ShoppingBasket size={20} />} title={t("invoice.noItems")} hint={t("invoice.noItemsHint")} className="py-8" />;
  }

  if (variant === "mobile") {
    return (
      <ul className="flex flex-col divide-y divide-line">
        {lines.map((line) => {
          const p = productById.get(line.productId)!;
          const r = resultFor(line.key);
          return (
            <li key={line.key} className="flex flex-col gap-2 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] font-medium text-ink">{locale === "hi" ? p.nameHi : p.name}</p>
                  <p className="num text-[12.5px] text-ink-3">
                    {money(line.rate)} × {line.qty} · GST {p.gstRate}%
                  </p>
                  {(p.packUnits?.length ?? 0) > 0 && <UnitSelect product={p} line={line} onUnit={(u) => onUnit(line.key, u)} className="mt-1 h-9 text-[13.5px]" />}
                  <LineWarnings line={line} />
                </div>
                <span className="num text-[15px] font-semibold text-ink">{r ? money(r.total.toNumber()) : "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-xl border border-line">
                  <button type="button" className="flex size-11 items-center justify-center text-ink-2" aria-label="−1" onClick={() => (line.qty > 1 ? onUpdate(line.key, { qty: line.qty - 1 }) : onRemove(line.key))}>
                    <Minus size={18} />
                  </button>
                  <NumberCell value={line.qty} label={t("invoice.qty")} decimals={3} onCommit={(v) => onUpdate(line.key, { qty: v })} className="h-11 w-14 text-center text-[16px] font-semibold" />
                  <button type="button" className="flex size-11 items-center justify-center text-ink-2" aria-label="+1" onClick={() => onUpdate(line.key, { qty: line.qty + 1 })}>
                    <Plus size={18} />
                  </button>
                </div>
                {[p.caseSize > 1 ? p.caseSize : 5, 10].map((inc) => (
                  <button key={inc} type="button" onClick={() => onUpdate(line.key, { qty: line.qty + inc })} className="num h-11 rounded-xl border border-line px-3 text-[14px] font-medium text-ink-2">
                    +{inc}
                  </button>
                ))}
                <button type="button" onClick={() => onRemove(line.key)} className="ml-auto flex size-11 items-center justify-center rounded-xl text-ink-3 hover:text-danger" aria-label={t("invoice.remove")}>
                  <Trash size={17} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="scroll-x">
      <table className="w-full min-w-[760px] text-[13.5px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-ink-3">
            <th className="w-8 py-2 pl-4 font-medium">#</th>
            <th className="py-2 pl-2 font-medium">{t("invoice.product")}</th>
            <th className="w-[124px] py-2 text-center font-medium">{t("invoice.qty")}</th>
            <th className="w-[96px] py-2 pr-2 text-right font-medium">{t("invoice.rate")}</th>
            <th className="w-[72px] py-2 pr-2 text-right font-medium">{t("invoice.discount")}</th>
            <th className="w-[64px] py-2 pr-2 text-right font-medium">{t("invoice.gstRate")}</th>
            <th className="w-[110px] py-2 pr-3 text-right font-medium">{t("invoice.amount")}</th>
            <th className="w-10 py-2 pr-2" />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => {
            const p = productById.get(line.productId)!;
            const r = resultFor(line.key);
            return (
              <tr key={line.key} className="border-b border-line align-top last:border-b-0 hover:bg-surface-2/60">
                <td className="num py-2.5 pl-4 text-ink-3">{i + 1}</td>
                <td className="py-2.5 pl-2">
                  <p className="font-medium text-ink">{locale === "hi" ? p.nameHi : p.name}</p>
                  <p className="text-[12px] text-ink-3">
                    <span className="font-mono">{p.code}</span> · HSN <span className="font-mono">{p.hsn}</span> · {p.packSize}
                    {p.batch && (
                      <>
                        {" "}
                        · {t("invoice.batch")} {p.batch.number}
                      </>
                    )}
                  </p>
                  <LineWarnings line={line} />
                </td>
                <td className="py-1.5">
                  <div className="flex items-center justify-center">
                    <button type="button" className="flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="−1" onClick={() => onUpdate(line.key, { qty: Math.max(1, line.qty - 1) })}>
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
                      onEnter={onBackToSearch}
                      className="w-14 text-center font-semibold"
                    />
                    <button type="button" className="flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="+1" onClick={() => onUpdate(line.key, { qty: line.qty + 1 })}>
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="flex justify-center">
                    <UnitSelect product={p} line={line} onUnit={(u) => onUnit(line.key, u)} className="h-7 text-[11.5px]" />
                  </div>
                </td>
                <td className="py-1.5 pr-2">
                  <NumberCell value={line.rate} label={`${t("invoice.rate")} ${p.name}`} onCommit={(v) => onUpdate(line.key, { rate: v })} onEnter={onBackToSearch} />
                </td>
                <td className="py-1.5 pr-2">
                  <NumberCell value={line.discountPercent} label={`${t("invoice.discount")} ${p.name}`} onCommit={(v) => onUpdate(line.key, { discountPercent: Math.min(100, v) })} onEnter={onBackToSearch} />
                </td>
                <td className="num py-2.5 pr-2 text-right text-ink-2">{r ? `${r.gstRate.toNumber()}%` : "—"}</td>
                <td className="py-2.5 pr-3 text-right">
                  <p className="num font-semibold text-ink">{r ? money(r.total.toNumber()) : "—"}</p>
                  {r && r.taxTotal.gt(0) && <p className="num text-[11.5px] text-ink-3">+{money(r.taxTotal.toNumber())} {t("invoice.tax")}</p>}
                </td>
                <td className="py-2 pr-2">
                  <button type="button" onClick={() => onRemove(line.key)} className="flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-danger-soft hover:text-danger" aria-label={`${t("invoice.remove")}: ${p.name}`}>
                    <Trash size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
