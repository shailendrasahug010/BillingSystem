import { translateError } from "@digitalbahi/i18n";
import { addDays } from "@digitalbahi/core";
import { ArrowLeft, Ellipsis, RotateCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Popover } from "radix-ui";
import { Children, Fragment, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { TODAY } from "../../data/db";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

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

/** The buttons of a fragment (or a list) one by one, the empty ones (a `false` from a permission check) left out. */
function flatButtons(children: ReactNode): ReactElement[] {
  return Children.toArray(children).flatMap((c) =>
    isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment ? flatButtons(c.props.children) : isValidElement(c) ? [c] : [],
  );
}

/**
 * A page's buttons at the top right. On a computer all of them; on a phone the main one
 * (the primary button, else the last) with the rest under "⋯", so the list starts near the top.
 */
export function HeaderActions({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const buttons = flatButtons(children);
  const all = <div className="flex flex-wrap gap-2">{children}</div>;
  if (buttons.length <= 2) return all;
  const main = buttons.find((b) => (b.props as { variant?: string }).variant === "primary") ?? buttons[buttons.length - 1]!;
  const rest = buttons.filter((b) => b !== main);
  return (
    <>
      <div className="hidden md:block">{all}</div>
      <div className="flex w-full items-center gap-2 md:hidden">
        <div className="min-w-0 flex-1 [&>*]:w-full">{main}</div>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger className="press flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-line bg-surface text-ink-2 shadow-card" aria-label={t("common.more")} title={t("common.more")}>
            <Ellipsis size={18} />
          </Popover.Trigger>
          <Popover.Portal>
            {/* A tap on any of them closes the list (the dialog it opens belongs to the page). */}
            <Popover.Content
              align="end"
              sideOffset={6}
              onClick={() => setOpen(false)}
              className="z-50 flex w-60 flex-col gap-1.5 rounded-xl border border-line bg-surface p-2 shadow-pop [&>*]:w-full [&>*]:justify-start"
            >
              {rest}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </>
  );
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
 * The filter strip above a list. On a phone only the first filter (the
 * search) shows, with a Filters button for the rest, so the list starts
 * near the top; `quick` (date chips) stays in sight on every screen.
 */
/**
 * Search first, then a "Filters" button for the rest. On a computer the rest are open
 * from the start, on their own row, so the search box always keeps its width; on a
 * phone they open on a tap. Quick chips (today, this week) sit beside the search.
 */
export function FilterBar({ children, quick }: { children: ReactNode; quick?: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(min-width: 1024px)").matches);
  const [first, ...rest] = Children.toArray(children).filter(Boolean);
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[12rem] flex-1 [&>*]:w-full">{first}</div>
        {rest.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "press inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium md:order-last",
              open ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong",
            )}
          >
            <SlidersHorizontal size={15} aria-hidden />
            {t("common.filters")}
          </button>
        )}
        {quick && <div className="w-full min-w-0 md:w-auto">{quick}</div>}
      </div>
      {rest.length > 0 && open && <div className="flex flex-col gap-2 border-t border-line pt-2.5 md:flex-row md:flex-wrap md:items-center">{rest}</div>}
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
