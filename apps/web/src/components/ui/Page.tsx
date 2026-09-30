import { translateError } from "@vyapaar/i18n";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { EmptyState, Skeleton } from "./misc";

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
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  className?: string;
  render(row: T): ReactNode;
}

/**
 * The list table used by every module: sticky-looking header row, row click,
 * skeleton while loading, empty state. Wide tables scroll sideways on phones.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  empty,
  minWidth = 640,
  footer,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  onRowClick?(row: T): void;
  loading?: boolean;
  empty?: ReactNode;
  minWidth?: number;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-line/80 bg-surface shadow-card">
      {loading ? (
        <div className="flex flex-col gap-3 p-4" role="status" aria-label={t("common.loading")}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        (empty ?? <EmptyState title={t("empty.generic")} />)
      ) : (
        <div className="scroll-x">
          <table className="w-full text-[13.5px]" style={{ minWidth }}>
            <thead>
              <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                {columns.map((c, i) => (
                  <th key={c.key} className={cn("py-2.5 font-medium", i === 0 ? "pl-4" : "pl-3", i === columns.length - 1 ? "pr-4" : "pr-3", c.align === "right" && "text-right")}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="num">
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn("border-b border-line/70 transition-colors last:border-b-0", onRowClick && "cursor-pointer hover:bg-accent-soft/40")}
                >
                  {columns.map((c, i) => (
                    <td key={c.key} className={cn("py-3 align-top", i === 0 ? "pl-4" : "pl-3", i === columns.length - 1 ? "pr-4" : "pr-3", c.align === "right" && "text-right", c.className)}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer}
          </table>
        </div>
      )}
    </div>
  );
}

/** An API error in the user's language (field-level errors are shown by their fields). */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const i18n = useI18n();
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError(0, "generic");
  return (
    <p className={cn("flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger", className)} role="alert">
      <TriangleAlert size={15} className="mt-0.5 shrink-0" />
      <span>
        {translateError(i18n, e)}
        {e.field && <span className="ml-1 font-mono text-[12px] opacity-80">({e.field})</span>}
        {/* A server failure is in the error log under this reference. */}
        {e.status >= 500 && e.requestId && <span className="mt-0.5 block font-mono text-[11.5px] opacity-80">{i18n.t("errors.reference", { ref: e.requestId })}</span>}
      </span>
    </p>
  );
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

/** The filter strip above a list. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-card md:flex-row md:flex-wrap md:items-center">{children}</div>;
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
