import { TriangleAlert, Inbox, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { shortcutLabel } from "../../app/shortcuts";
import { Button } from "./Button";

export function Kbd({ keys, className }: { keys: string; className?: string }) {
  // Callers may hide the hint on small screens ("hidden sm:inline-flex"); only add a display when they don't.
  const display = className && /(^|\s)hidden(\s|$)/.test(className) ? "" : "inline-flex";
  return (
    <span className={cn(display, "items-center gap-0.5", className)}>
      {shortcutLabel(keys).map((k) => (
        <kbd
          key={k}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[10.5px] font-medium text-ink-2"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent shadow-card">{icon ?? <Inbox size={24} />}</div>
      <p className="font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-ink-3">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, hint, retryLabel, onRetry }: { title: string; hint: string; retryLabel: string; onRetry(): void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-danger/30 bg-danger-soft px-6 py-8 text-center">
      <TriangleAlert className="text-danger" size={22} />
      <p className="font-medium text-ink">{title}</p>
      <p className="text-[13px] text-ink-2">{hint}</p>
      <Button size="sm" icon={<RotateCw size={14} />} onClick={onRetry} className="mt-1">
        {retryLabel}
      </Button>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} aria-hidden />;
}

/** Simulates network latency so loading states are visible in the prototype. */
export function useDelayedReady(ms = 450): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return ready;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  label,
}: {
  value: T;
  onChange(v: NoInfer<T>): void;
  options: Array<{ value: NoInfer<T>; label: ReactNode }>;
  size?: "sm" | "md";
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-line/70 bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "press rounded-full font-medium transition-[background-color,color,box-shadow] duration-200",
            size === "sm" ? "h-7 px-3 text-[12px]" : "h-8 px-3.5 text-[13px]",
            value === o.value ? "bg-surface text-accent-ink shadow-card ring-1 ring-line/60" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Soft colour pairs for initials; the same name always gets the same one. */
const AVATAR_TINTS = [
  "bg-tint-blue-soft text-tint-blue",
  "bg-tint-green-soft text-tint-green",
  "bg-tint-orange-soft text-tint-orange",
  "bg-tint-violet-soft text-tint-violet",
  "bg-tint-rose-soft text-tint-rose",
  "bg-tint-teal-soft text-tint-teal",
  "bg-tint-amber-soft text-tint-amber",
] as const;

export function tintFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-full font-display text-[13px] font-semibold", tintFor(name), className)} aria-hidden>
      {initials}
    </span>
  );
}

/**
 * A number that counts up to its value when it first appears (and glides to
 * a new value when it changes), ending on exactly the formatted value.
 * Reduced motion shows it at once.
 */
export function CountUp({ value, format, duration = 900 }: { value: number; format(v: number): string; duration?: number }) {
  const [shown, setShown] = useState(0);
  const [from, setFrom] = useState(0);
  useEffect(() => {
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof requestAnimationFrame === "undefined") {
      setShown(value);
      return;
    }
    const start = performance.now();
    const begin = from;
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(begin + (value - begin) * eased);
      if (p < 1) frame = requestAnimationFrame(step);
      else setFrom(value);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);
  return <span className="count-up">{format(Math.abs(shown - value) < 0.005 ? value : shown)}</span>;
}

export function ProgressBar({ value, tone = "accent", label }: { value: number; tone?: "accent" | "warn" | "danger" | "good"; label: string }) {
  const bar = { accent: "bg-accent", warn: "bg-warn", danger: "bg-danger", good: "bg-good" }[tone];
  const track = { accent: "bg-accent-soft", warn: "bg-warn-soft", danger: "bg-danger-soft", good: "bg-good-soft" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full", track)} role="meter" aria-label={label} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full", bar)} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}
