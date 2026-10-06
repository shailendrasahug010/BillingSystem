import { translateError } from "@digitalbahi/i18n";
import { addDays } from "@digitalbahi/core";
import { ArrowLeft, RotateCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { TODAY } from "../../data/db";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { NamedDates } from "./Field";

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {back}
        <div className="min-w-0">
          <h1 className="truncate text-[26px] font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
          {subtitle && <div className="num text-[13px] text-ink-3">{subtitle}</div>}
        </div>
      </div>
      {actions && <HeaderActions>{actions}</HeaderActions>}
    </div>
  );
}

/** A page's buttons at the top right, all of them in sight on every screen. */
export function HeaderActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

export { DataTable, RowCard, type Column } from "./DataTable";

/** An API error in the user's language (field-level errors are shown by their fields). */
export function ErrorNote({ error, className, onRetry }: { error: unknown; className?: string; onRetry?(): void }) {
  const i18n = useI18n();
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError(0, "generic");
  // Worth trying again: no connection, too many requests, or the server failed (not a rule the request broke).
  const passing = e.status === 0 || e.status === 429 || e.status >= 500;
  const line = lineOf(e.field);
  return (
    <div className={cn("flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger", className)} role="alert">
      <TriangleAlert size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {line !== null && <span className="font-medium">{i18n.t("errors.onLine", { line })} </span>}
        {translateError(i18n, e)}
        {/* A server failure is in the error log under this reference. */}
        {e.status >= 500 && e.requestId && <span className="mt-0.5 block font-mono text-[11.5px] opacity-80">{i18n.t("errors.reference", { ref: e.requestId })}</span>}
      </span>
      {onRetry && passing && (
        <button type="button" onClick={onRetry} className="press -my-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium underline-offset-2 hover:underline">
          <RotateCw size={13} aria-hidden />
          {i18n.t("common.retry")}
        </button>
      )}
    </div>
  );
}

/** The bill line an error is about ("lines.2.qty" is line 3), or null; other field names are not shown, as they mean nothing to the reader. */
function lineOf(field: string | undefined): number | null {
  const m = field ? /(?:^|\.)(?:lines|items)\.(\d+)(?:\.|$)/.exec(field) : null;
  return m ? Number(m[1]) + 1 : null;
}

/** Field error text for an ApiError that names this field. */
export function useFieldError(error: unknown) {
  const i18n = useI18n();
  return (field: string): string | null =>
    error instanceof ApiError && error.field && (error.field === field || error.field.endsWith(`.${field}`)) ? translateError(i18n, error) : null;
}

/** "Load more" under a paged list. */
export function LoadMore({ hasMore, loading, onClick }: { hasMore: boolean; loading: boolean; onClick(): void }) {
  const { t } = useI18n();
  if (!hasMore) return null;
  return (
    <div className="flex justify-center">
      <Button size="sm" disabled={loading} onClick={onClick}>
        {loading ? t("common.loading") : t("common.loadMore")}
      </Button>
    </div>
  );
}

/**
 * Search first, then a "Filters" button for the rest, closed until it is tapped
 * (on a computer too), so the list starts near the top. While closed, the button
 * says how many filters are on. Quick chips (today, this week) sit beside the search;
 * `actions` (export, plan a trip, run salary) stay in sight on the right. `fit` keeps
 * the first box (a month, a period) as narrow as it is instead of the full row.
 * `openOnComputer` starts open on a computer, for reports, where the grouping and
 * dates are the point rather than a narrowing of a list.
 */
export function FilterBar({ children, quick, actions, fit, openOnComputer }: { children: ReactNode; quick?: ReactNode; actions?: ReactNode; fit?: boolean; openOnComputer?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => Boolean(openOnComputer) && typeof matchMedia !== "undefined" && matchMedia("(min-width: 1024px)").matches);
  const [on, setOn] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const [first, ...rest] = Children.toArray(children).filter(Boolean);
  // Count what is set in the hidden filters: a chosen option, a date, a pressed chip, a segment other than the first.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const count = () => {
      let n = 0;
      el.querySelectorAll("select").forEach((s) => (n += s.selectedIndex > 0 ? 1 : 0));
      el.querySelectorAll<HTMLInputElement>("input:not([aria-hidden]):not([type=checkbox])").forEach((i) => (n += i.value ? 1 : 0));
      el.querySelectorAll("input[type=checkbox]:checked, button[aria-pressed=true]").forEach(() => n++);
      el.querySelectorAll('[role="radiogroup"]').forEach((g) => (n += g.querySelector('[role="radio"]')?.getAttribute("aria-checked") === "true" ? 0 : 1));
      setOn(n);
    };
    count();
    const watch = new MutationObserver(count);
    watch.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
    el.addEventListener("input", count);
    el.addEventListener("change", count);
    return () => {
      watch.disconnect();
      el.removeEventListener("input", count);
      el.removeEventListener("change", count);
    };
  }, []);
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <div className={fit ? "w-full md:w-auto" : "min-w-0 flex-1 sm:min-w-[12rem] [&>*]:w-full"}>{first}</div>
        {rest.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "press inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium max-sm:px-2.5 md:order-last",
              open || on > 0 ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong",
            )}
          >
            <SlidersHorizontal size={15} aria-hidden />
            {/* On a phone the button is its icon, so the search hint beside it is read in full. */}
            <span className="max-sm:sr-only">{t("common.filters")}</span>
            {on > 0 && <span className="num rounded-full bg-accent px-1.5 text-[11px] leading-[18px] text-ink-inverse">{on}</span>}
          </button>
        )}
        {quick && <div className="w-full min-w-0 md:w-auto">{quick}</div>}
        {actions && <div className="flex flex-wrap items-center gap-2 md:order-last md:ml-auto">{actions}</div>}
      </div>
      {rest.length > 0 && (
        <NamedDates.Provider value>
          <div ref={panel} hidden={!open} className="flex flex-col gap-2 border-t border-line pt-2.5 md:flex-row md:flex-wrap md:items-center">
            {rest}
          </div>
        </NamedDates.Provider>
      )}
    </div>
  );
}

const CHIP = "press h-8 shrink-0 rounded-full border px-3 text-[12.5px] font-medium";

/** Today, this week, this month in one tap for a list's from / to dates; tapping the chosen one again clears them. */
export function QuickDates({ from, to, onChange }: { from: string; to: string; onChange(from: string, to: string): void }) {
  const { t } = useI18n();
  const weekday = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7;
  const options = [
    { key: "today", label: t("common.today"), from: TODAY },
    { key: "week", label: t("dates.thisWeek"), from: addDays(TODAY, -weekday) },
    { key: "month", label: t("dashboard.range.thisMonth"), from: `${TODAY.slice(0, 8)}01` },
  ];
  return (
    <div className="scroll-x flex gap-1.5" role="group" aria-label={t("common.period")}>
      {options.map((o) => {
        const on = from === o.from && to === TODAY;
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => (on ? onChange("", "") : onChange(o.from, TODAY))} className={cn(CHIP, on ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small label / value pair for detail views. */
export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: "danger" | "good" | "warn" }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className={cn("num text-[15px] font-semibold text-ink", tone === "danger" && "text-danger", tone === "good" && "text-good", tone === "warn" && "text-warn")}>{value}</span>
    </div>
  );
}

export const TAB_TRIGGER =
  "relative h-10 px-3 text-[13.5px] font-medium text-ink-3 whitespace-nowrap data-[state=active]:text-ink data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent";

/** Square back arrow used by detail screens. */
export function BackButton({ onClick }: { onClick(): void }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={onClick} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink" aria-label={t("common.back")}>
      <ArrowLeft size={18} />
    </button>
  );
}

/** KPI tile on detail screens. */
export function Tile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "danger" | "good" }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card">
      <p className="text-[12.5px] text-ink-3">{label}</p>
      <p className={cn("num mt-1 font-display text-[21px] leading-tight font-semibold", tone === "danger" ? "text-danger" : tone === "good" ? "text-good" : "text-ink")}>{value}</p>
      {sub && <p className={cn("text-[12px]", tone === "danger" ? "text-danger" : "text-ink-3")}>{sub}</p>}
    </div>
  );
}
