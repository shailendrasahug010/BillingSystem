import { useState } from "react";
import { cn } from "../../lib/cn";

/**
 * Ranked horizontal bars (top products / customers / companies). One series,
 * one colour; value at the tip in ink, never in the bar colour. Bars are
 * capped thin with a rounded data end, square at the baseline.
 */
export function BarList({
  items,
  format,
  onSelect,
  color = "var(--series-1)",
  ariaLabel,
  empty,
}: {
  items: Array<{ id: string; label: string; amount: number; sub?: string }>;
  format(v: number): string;
  onSelect?(id: string): void;
  color?: string;
  ariaLabel: string;
  /** Said instead of an empty list (nothing sold yet in the period). */
  empty?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...items.map((i) => i.amount));
  const total = items.reduce((s, i) => s + i.amount, 0);
  if (items.length === 0 && empty) return <p className="text-[13px] text-ink-3">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2.5" aria-label={ariaLabel}>
      {items.map((item) => {
        const pct = (item.amount / max) * 100;
        const Tag = onSelect ? "button" : "div";
        return (
          <li key={item.id}>
            <Tag
              {...(onSelect ? { type: "button" as const, onClick: () => onSelect(item.id) } : {})}
              onPointerEnter={() => setHover(item.id)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(item.id)}
              onBlur={() => setHover(null)}
              title={`${item.label}: ${format(item.amount)} (${Math.round((item.amount / total) * 100)}%)`}
              className={cn("block w-full text-left", onSelect && "rounded-md focus-visible:outline-2")}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
                <span className={cn("min-w-0 truncate", hover === item.id ? "text-ink" : "text-ink-2")}>{item.label}</span>
                <span className="num shrink-0 font-medium text-ink">{format(item.amount)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className="bar-grow h-full rounded-full transition-[width,opacity] duration-300"
                  style={{ width: `${Math.max(1.5, pct)}%`, background: color, opacity: hover && hover !== item.id ? 0.45 : 1 }}
                />
              </div>
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}

/** Ordered buckets (receivables aging): an ordinal ramp, light = recent, dark = oldest. */
export function AgingColumns({
  buckets,
  format,
  labels,
  ariaLabel,
}: {
  buckets: Array<{ key: string; amount: number; count: number }>;
  format(v: number): string;
  labels: Record<string, string>;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.amount));
  const ramp = ["var(--ordinal-1)", "var(--ordinal-2)", "var(--ordinal-3)", "var(--ordinal-4)", "var(--ordinal-4)"];
  return (
    <div className="flex h-[196px] items-end gap-3 sm:gap-4" role="img" aria-label={ariaLabel}>
      {buckets.map((b, i) => (
        <div
          key={b.key}
          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
          onPointerEnter={() => setHover(b.key)}
          onPointerLeave={() => setHover(null)}
          title={`${labels[b.key]}: ${format(b.amount)} · ${b.count}`}
        >
          <span className="num text-[12px] font-medium text-ink">{format(b.amount)}</span>
          <div className="flex w-full max-w-[40px] flex-1 items-end">
            <div
              className="bar-rise w-full rounded-t-lg transition-opacity"
              style={{
                height: `${Math.max(2, (b.amount / max) * 100)}%`,
                background: ramp[i],
                opacity: hover && hover !== b.key ? 0.5 : 1,
              }}
            />
          </div>
          <span className="w-full border-t border-line pt-1.5 text-center text-[11.5px] leading-tight text-ink-3">{labels[b.key]}</span>
        </div>
      ))}
    </div>
  );
}
