import { normalizeSearchText } from "@digitalbahi/core";
import { Search, UserPlus } from "lucide-react";
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Kbd } from "../../components/ui/misc";
import { CUSTOMERS, WALK_IN_ID } from "../../data/db";
import { customerInsight } from "../../data/store";
import type { Customer } from "../../data/types";
import { cn } from "../../lib/cn";

export function searchCustomers(query: string, limit = 8): Customer[] {
  const q = normalizeSearchText(query);
  if (!q) return CUSTOMERS.slice(0, limit);
  const digits = query.replace(/\D/g, "");
  return CUSTOMERS.map((c) => {
    const hay = normalizeSearchText(`${c.businessName} ${c.name} ${c.city} ${c.code}`);
    let score = 0;
    if (c.gstin && c.gstin.toLowerCase() === query.trim().toLowerCase()) score = 1000;
    else if (digits.length >= 4 && c.mobile.includes(digits)) score = 800;
    else if (c.code.toLowerCase() === q) score = 700;
    else if (normalizeSearchText(c.businessName).startsWith(q)) score = 300;
    else if (q.split(" ").every((tok) => hay.split(" ").some((w) => w.startsWith(tok)))) score = 200;
    else if (hay.includes(q)) score = 100;
    return { c, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.businessName.localeCompare(b.c.businessName))
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * Customer combobox: search by name, mobile, GSTIN or code. Arrow keys move,
 * Enter selects. Outstanding is shown in the results so the salesperson sees
 * risk before starting the bill.
 */
export const CustomerPicker = forwardRef<HTMLInputElement, { onSelect(id: string): void; onAdd?(typed: string): void; autoFocus?: boolean; large?: boolean }>(function CustomerPicker(
  { onSelect, onAdd, autoFocus, large },
  ref,
) {
  const { t, money } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => searchCustomers(query), [query]);
  // The list closes a moment after the field loses focus (so a click on it lands); coming back cancels that.
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);

  const choose = (c: Customer) => {
    onSelect(c.id);
    setQuery("");
    setOpen(false);
  };
  const add = () => {
    setOpen(false);
    onAdd?.(query);
  };
  // "Add customer" is the row after the results (arrow down to it, Enter).
  const last = onAdd ? results.length : results.length - 1;

  return (
    <div className="relative">
      <div className="relative flex items-center">
        <Search size={large ? 20 : 18} className="pointer-events-none absolute left-3.5 text-ink-3" />
        <input
          ref={ref}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && (results[active] || (onAdd && active === results.length)) ? `${listId}-${active}` : undefined}
          aria-label={t("invoice.searchCustomer")}
          placeholder={t("invoice.searchCustomer")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            clearTimeout(closing.current);
            setOpen(true);
          }}
          onBlur={() => {
            closing.current = setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(last, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && open && results[active]) {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === "Enter" && open && onAdd && active === results.length) {
              e.preventDefault();
              add();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className={cn(
            "w-full rounded-xl border border-line bg-surface pr-24 text-ink placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none",
            large ? "h-14 pl-11 text-[16px]" : "h-12 pl-10 text-[15px]",
          )}
        />
        <Kbd keys="f3" className="absolute right-3 hidden sm:inline-flex" />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-[360px] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          {results.map((c, i) => {
            const ins = customerInsight(c.id);
            return (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5", i === active && "bg-surface-2")}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-ink">
                    {c.businessName}
                    {c.id === WALK_IN_ID && <span className="ml-2 text-[12px] font-normal text-ink-3">{t("invoice.walkIn")}</span>}
                  </p>
                  <p className="truncate text-[12.5px] text-ink-3">
                    {[c.name !== c.businessName && c.name, c.city, c.mobile, c.gstin].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {ins.outstanding > 0.5 && (
                  <span className={cn("num shrink-0 text-[12.5px] font-medium", ins.overdue > 0 ? "text-danger" : "text-ink-2")}>{money(ins.outstanding, 0)}</span>
                )}
              </li>
            );
          })}
          {results.length === 0 && <li className="px-3 py-4 text-center text-[13px] text-ink-3">{t("search.noResults", { query })}</li>}
          {onAdd && (
            <li
              id={`${listId}-${results.length}`}
              role="option"
              aria-selected={active === results.length}
              onMouseDown={(e) => {
                // Keep the focus in the search until the click lands.
                e.preventDefault();
                add();
              }}
              onMouseEnter={() => setActive(results.length)}
              className={cn("mt-1 flex cursor-pointer items-center gap-2 rounded-lg border-t border-line px-3 py-2 text-[13px] font-medium text-accent", active === results.length && "bg-surface-2")}
            >
              <UserPlus size={15} /> {query.trim() ? t("customer.addNamed", { name: query.trim() }) : t("customer.add")}
            </li>
          )}
        </ul>
      )}
    </div>
  );
});
