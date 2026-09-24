import { Search, X } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SearchOption {
  id: string;
  label: string;
  sub?: ReactNode;
  trailing?: ReactNode;
}

/**
 * Keyboard-first combobox over a local list (customers, suppliers, products):
 * type to filter, arrows to move, Enter to pick. Shows the chosen option as a
 * chip with a clear button.
 */
export function SearchSelect({
  id,
  value,
  onChange,
  search,
  selectedLabel,
  placeholder,
  autoFocus,
  invalid,
  clearLabel,
  emptyText,
}: {
  id?: string;
  value: string | null;
  onChange(id: string | null): void;
  search(query: string): SearchOption[];
  selectedLabel?: ReactNode;
  placeholder: string;
  autoFocus?: boolean;
  invalid?: boolean;
  clearLabel: string;
  emptyText: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => (open ? search(query) : []), [open, query, search]);

  if (value) {
    return (
      <div className="flex h-10 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 pr-1 pl-3 text-sm">
        <span className="min-w-0 truncate font-medium text-ink">{selectedLabel}</span>
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => onChange(null)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  const pick = (o: SearchOption) => {
    onChange(o.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute top-3 left-3 text-ink-3" />
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === "Enter" && results[active]) (e.preventDefault(), pick(results[active]));
          else if (e.key === "Escape" && open) (e.stopPropagation(), setOpen(false));
        }}
        className={cn(
          "h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface pr-3 pl-9 text-sm text-ink placeholder:text-ink-3",
          "hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none",
          invalid && "border-danger",
        )}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-pop">
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-[13px] text-ink-3">{emptyText}</li>
          ) : (
            results.map((o, i) => (
              <li
                key={o.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => (e.preventDefault(), pick(o))}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer items-center justify-between gap-3 px-3 py-2", i === active && "bg-accent-soft")}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-ink">{o.label}</span>
                  {o.sub && <span className="block truncate text-[12px] text-ink-3">{o.sub}</span>}
                </span>
                {o.trailing && <span className="num shrink-0 text-[12.5px]">{o.trailing}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
