import { normalizeSearchText, searchProducts } from "@vyapaar/core";
import { CornerDownLeft, FileText, Package, Search, Users, Zap } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useMemo, useState, type ReactNode } from "react";
import { MODULES } from "../../app/modules";
import { useI18n } from "../../app/i18n";
import { useRouter, type Route } from "../../app/router";
import { customerById, INVOICES, PRODUCTS } from "../../data/mock";
import { cn } from "../../lib/cn";
import { searchCustomers } from "../invoice/CustomerPicker";

interface Item {
  id: string;
  group: "actions" | "customers" | "products" | "invoices";
  title: string;
  sub?: string;
  icon: ReactNode;
  route: Route;
}

const searchable = PRODUCTS.map((p) => ({ ...p, barcodes: [p.barcode], aliases: [p.nameHi, ...p.aliases], active: true }));

/**
 * Global search (Ctrl+K): customers by name / mobile / GSTIN, products by name
 * / code / barcode, invoices by number, and every screen by name. In
 * production customer, product and invoice hits come from the local cache
 * first and are topped up by GET /search on the server.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money, locale } = useI18n();
  const { navigate } = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo<Item[]>(() => {
    const q = normalizeSearchText(query);
    const actions: Item[] = MODULES.filter((m) => !q || normalizeSearchText(t(m.label)).includes(q) || m.key.includes(q)).map((m) => ({
      id: `m-${m.key}`,
      group: "actions",
      title: t(m.label),
      icon: <Zap size={16} />,
      route: m.route,
    }));
    if (q.length < 2) return actions.slice(0, 8);
    const customers: Item[] = searchCustomers(query, 5).map((c) => ({
      id: `c-${c.id}`,
      group: "customers",
      title: c.businessName,
      sub: `${c.city} · ${c.mobile}${c.gstin ? ` · ${c.gstin}` : ""}`,
      icon: <Users size={16} />,
      route: { name: "customer", customerId: c.id },
    }));
    const products: Item[] = searchProducts(query, searchable, { limit: 5 }).map((h) => ({
      id: `p-${h.product.id}`,
      group: "products",
      title: locale === "hi" ? h.product.nameHi : h.product.name,
      sub: `${h.product.code} · ${h.product.brand} · ${money(h.product.rate)}`,
      icon: <Package size={16} />,
      route: { name: "products" },
    }));
    const needle = query.trim().toLowerCase();
    const invoices: Item[] = INVOICES.filter((i) => i.number.toLowerCase().includes(needle))
      .slice(-5)
      .reverse()
      .map((i) => ({
        id: `i-${i.id}`,
        group: "invoices",
        title: i.number,
        sub: `${customerById.get(i.customerId)?.businessName} · ${money(i.total)}`,
        icon: <FileText size={16} />,
        route: { name: "invoice-view", invoiceId: i.id },
      }));
    return [...customers, ...products, ...invoices, ...actions.slice(0, 4)];
  }, [query, t, money, locale]);

  const go = (item: Item) => {
    navigate(item.route);
    onOpenChange(false);
    setQuery("");
  };

  const groups: Item["group"][] = ["customers", "products", "invoices", "actions"];

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[rgb(8_20_22/0.45)] backdrop-blur-[2px]" />
        <D.Content className="fixed top-[8vh] left-1/2 z-50 w-[calc(100%-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-pop animate-pop">
          <D.Title className="sr-only">{t("shortcuts.search")}</D.Title>
          <D.Description className="sr-only">{t("search.placeholder")}</D.Description>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search size={18} className="text-ink-3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(items.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter" && items[active]) {
                  e.preventDefault();
                  go(items[active]);
                }
              }}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              className="h-14 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-3 focus:outline-none"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {items.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-ink-3">{t("search.noResults", { query })}</p>}
            {groups.map((g) => {
              const list = items.filter((i) => i.group === g);
              if (list.length === 0) return null;
              return (
                <div key={g} className="mb-1">
                  <p className="eyebrow px-3 pt-2 pb-1">{t(`search.groups.${g}`)}</p>
                  {list.map((item) => {
                    const i = items.indexOf(item);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(item)}
                        className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", active === i && "bg-surface-2")}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-3">{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-[14px] text-ink", item.group === "invoices" && "font-mono")}>{item.title}</span>
                          {item.sub && <span className="block truncate text-[12px] text-ink-3">{item.sub}</span>}
                        </span>
                        {active === i && <CornerDownLeft size={14} className="text-ink-3" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
