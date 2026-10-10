import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { Checkbox } from "./Field";
import { EmptyState, Skeleton } from "./misc";

export interface Column<T> {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  className?: string;
  render(row: T): ReactNode;
  /** Makes the header a sort button: rows are ordered by this value. */
  sortValue?(row: T): string | number | null | undefined;
  /** The column's name in the Columns menu when its header is not plain text. */
  label?: string;
  /** false: always shown (the first column always is). */
  hideable?: boolean;
}

type SortDir = "asc" | "desc";
interface Prefs {
  sort: { key: string; dir: SortDir } | null;
  hidden: string[];
}

const PREFS_KEY = (id: string) => `digitalbahi:table:${id}`;

function readPrefs(id: string | undefined): Prefs {
  if (!id) return { sort: null, hidden: [] };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY(id)) ?? "null") as Partial<Prefs> | null;
    return { sort: p?.sort ?? null, hidden: Array.isArray(p?.hidden) ? p.hidden : [] };
  } catch {
    return { sort: null, hidden: [] };
  }
}

function writePrefs(id: string | undefined, prefs: Prefs) {
  if (!id) return;
  try {
    localStorage.setItem(PREFS_KEY(id), JSON.stringify(prefs));
  } catch {
    // Private mode: kept until the screen closes.
  }
}

function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const ea = a === null || a === undefined || a === "";
  const eb = b === null || b === undefined || b === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Above this many rows a desktop table keeps its header in view while it scrolls. */
const STICKY_FROM = 20;

/**
 * The list table used by every module: header row, row click, skeleton while
 * loading, empty state. Wide tables scroll sideways on phones. Columns with a
 * sortValue sort from their header; with an id the table remembers its sort
 * and offers a Columns menu to hide columns; pageSize shows the rows in steps
 * (a list of thousands of shops stays quick); mobile renders each row as a
 * card on phones instead of the table. Rows that open something are reached
 * by keyboard too (Tab, then ↑ ↓, Enter), and with rowHref a Ctrl-click or a
 * middle click opens the row in a new tab, as a link would.
 */
export function DataTable<T>({
  id,
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  empty,
  minWidth = 640,
  footer,
  pageSize,
  mobile,
  caption,
  rowHref,
}: {
  id?: string;
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  onRowClick?(row: T): void;
  loading?: boolean;
  empty?: ReactNode;
  minWidth?: number;
  footer?: ReactNode;
  pageSize?: number;
  mobile?(row: T): ReactNode;
  /** Left of the Columns menu, e.g. how many rows there are. */
  caption?: ReactNode;
  /** The address of the screen a row opens (hashFor), for opening it in a new tab. */
  rowHref?(row: T): string;
}) {
  const { t } = useI18n();
  const [prefs, setPrefsState] = useState<Prefs>(() => readPrefs(id));
  const [limit, setLimit] = useState(pageSize ?? Number.POSITIVE_INFINITY);
  const setPrefs = (p: Prefs) => {
    setPrefsState(p);
    writePrefs(id, p);
  };

  const hideable = columns.filter((c, i) => i > 0 && c.hideable !== false && (c.label || typeof c.header === "string"));
  const shownColumns = columns.filter((c) => !prefs.hidden.includes(c.key));
  const sortColumn = prefs.sort ? columns.find((c) => c.key === prefs.sort!.key && c.sortValue) : undefined;
  const sorted = useMemo(() => {
    if (!sortColumn || !prefs.sort) return rows;
    const dir = prefs.sort.dir === "asc" ? 1 : -1;
    const value = sortColumn.sortValue!;
    return rows
      .map((row, i) => ({ row, i, v: value(row) }))
      .sort((a, b) => {
        const empty = (x: unknown) => x === null || x === undefined || x === "";
        // Rows without a value stay at the end in both directions.
        if (empty(a.v) !== empty(b.v)) return empty(a.v) ? 1 : -1;
        return compare(a.v, b.v) * dir || a.i - b.i;
      })
      .map((x) => x.row);
  }, [rows, sortColumn, prefs.sort]);
  const visible = sorted.length > limit ? sorted.slice(0, limit) : sorted;
  const sticky = visible.length > STICKY_FROM;
  // The rows rise in when the list first shows, not again with each sort, filter or letter typed.
  const shown = !loading && rows.length > 0;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!shown || settled) return;
    const timer = window.setTimeout(() => setSettled(true), 700);
    return () => window.clearTimeout(timer);
  }, [shown, settled]);

  const openInTab = (row: T) => rowHref && window.open(rowHref(row), "_blank", "noopener");
  const rowClick = (e: MouseEvent, row: T) => {
    if (rowHref && (e.ctrlKey || e.metaKey || e.shiftKey)) openInTab(row);
    else onRowClick!(row);
  };
  const rowKeys = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    // Keys pressed on a field or button in the row are that one's own.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.key === "Enter" && rowHref && (e.ctrlKey || e.metaKey)) openInTab(row);
      else onRowClick!(row);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = (e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  const toggleSort = (key: string) => {
    const now = prefs.sort?.key === key ? prefs.sort.dir : null;
    // First click sorts up, the second down, the third back to the list's own order.
    setPrefs({ ...prefs, sort: now === null ? { key, dir: "asc" } : now === "asc" ? { key, dir: "desc" } : null });
  };

  const cellPad = (i: number, n: number) => cn(i === 0 ? "pl-4" : "pl-3", i === n - 1 ? "pr-4" : "pr-3");

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-line/80 bg-surface shadow-card">
      {(id && hideable.length > 0) || caption ? (
        <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-1.5">
          <div className="min-w-0 text-[12.5px] text-ink-3">{caption}</div>
          {id && hideable.length > 0 && (
            <Popover.Root>
              <Popover.Trigger className="press hidden h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink md:inline-flex">
                <Columns3 size={14} aria-hidden />
                {t("table.columns")}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content align="end" sideOffset={6} className="z-50 flex w-60 flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-pop">
                  <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("table.showColumns")}</p>
                  {hideable.map((c) => (
                    <Checkbox
                      key={c.key}
                      label={c.label ?? String(c.header)}
                      checked={!prefs.hidden.includes(c.key)}
                      onChange={(on) => setPrefs({ ...prefs, hidden: on ? prefs.hidden.filter((k) => k !== c.key) : [...prefs.hidden, c.key] })}
                    />
                  ))}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
        </div>
      ) : null}
      {loading ? (
        <div className="flex flex-col gap-3 p-4" role="status" aria-label={t("common.loading")}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        (empty ?? <EmptyState title={t("empty.generic")} />)
      ) : (
        <>
          <div className={cn("scroll-x", mobile && "hidden md:block", sticky && "lg:max-h-app-table lg:overflow-y-auto")}>
            <table className="w-full text-[13.5px]" style={{ minWidth }}>
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  {shownColumns.map((c, i) => {
                    const dir = prefs.sort?.key === c.key ? prefs.sort.dir : null;
                    return (
                      <th
                        key={c.key}
                        aria-sort={c.sortValue ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
                        className={cn("bg-surface-2 py-2.5 font-medium", sticky && "lg:sticky lg:top-0 lg:z-[1]", cellPad(i, shownColumns.length), c.align === "right" && "text-right")}
                      >
                        {c.sortValue ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(c.key)}
                            className={cn("inline-flex items-center gap-1 uppercase hover:text-ink", c.align === "right" && "flex-row-reverse", dir && "text-ink")}
                          >
                            {c.header}
                            {dir === "asc" ? <ArrowUp size={12} aria-hidden /> : dir === "desc" ? <ArrowDown size={12} aria-hidden /> : <ArrowUpDown size={12} className="opacity-50" aria-hidden />}
                          </button>
                        ) : (
                          c.header
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className={cn("num", !settled && "rows-in")}>
                {visible.map((row) => (
                  <tr
                    key={rowKey(row)}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? (e) => rowClick(e, row) : undefined}
                    onKeyDown={onRowClick ? (e) => rowKeys(e, row) : undefined}
                    // A middle click opens the row in a new tab (no scrolling wheel-mode on the way).
                    onMouseDown={rowHref ? (e) => e.button === 1 && e.preventDefault() : undefined}
                    onAuxClick={rowHref ? (e) => e.button === 1 && openInTab(row) : undefined}
                    className={cn(
                      "border-b border-line/70 transition-colors last:border-b-0",
                      onRowClick && "cursor-pointer hover:bg-accent-soft/40 focus-visible:bg-accent-soft/50 focus-visible:-outline-offset-2",
                    )}
                  >
                    {shownColumns.map((c, i) => (
                      <td key={c.key} className={cn("py-3 align-top", cellPad(i, shownColumns.length), c.align === "right" && "text-right", c.className)}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {footer}
            </table>
          </div>
          {mobile && (
            <ul className={cn("divide-y divide-line md:hidden", !settled && "rows-in")}>
              {visible.map((row) => (
                <li key={rowKey(row)}>
                  {onRowClick ? (
                    <button type="button" onClick={() => onRowClick(row)} className="press flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2">
                      {mobile(row)}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3.5">{mobile(row)}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sorted.length > visible.length && (
            <div className="flex justify-center border-t border-line/70 py-2.5">
              <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + (pageSize ?? sorted.length))}>
                {t("table.showMore", { count: Math.min(pageSize ?? sorted.length, sorted.length - visible.length), left: sorted.length - visible.length })}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One row of a list as a phone card: what it is on the left (a title and a
 * line under it), the figure that matters on the right (amount, stock) with
 * a note or badge under it.
 */
export function RowCard({ title, sub, value, valueSub, tone }: { title: ReactNode; sub?: ReactNode; value?: ReactNode; valueSub?: ReactNode; tone?: "danger" | "warn" | "good" | "muted" }) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium text-ink">{title}</div>
        {sub && <div className="num mt-0.5 truncate text-[12.5px] text-ink-3">{sub}</div>}
      </div>
      {(value !== undefined || valueSub) && (
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {value !== undefined && (
            <span className={cn("num text-[14.5px] font-semibold text-ink", tone === "danger" && "text-danger", tone === "warn" && "text-warn", tone === "good" && "text-good", tone === "muted" && "text-ink-3 line-through")}>{value}</span>
          )}
          {valueSub && <div className="num text-[12px] text-ink-3">{valueSub}</div>}
        </div>
      )}
    </>
  );
}
