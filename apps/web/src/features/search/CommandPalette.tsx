import { normalizeSearchText, searchProducts } from "@digitalbahi/core";
import { CornerDownLeft, FileText, Package, Search, Users, Zap } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { visibleModules } from "../../app/modules";
import { useI18n } from "../../app/i18n";
import { useRouter, type Route } from "../../app/router";
import { customerById, INVOICES, PRODUCTS } from "../../data/db";
import { LIVE } from "../../data/source";
import { useStoreVersion } from "../../data/store";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { VoiceButton } from "../../components/voice/VoiceButton";
import { searchCustomers } from "../invoice/CustomerPicker";

interface Item {
  id: string;
  group: "actions" | "customers" | "products" | "invoices";
  title: string;
  sub?: string;
  icon: ReactNode;
  route: Route;
}

interface RemoteInvoice {
  id: string;
  invoiceNumber: string;
  partyName: string;
  grandTotal: string;
}

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
  const version = useStoreVersion();
  // Customers and products are searched in the local workspace (instant, works offline);
  // invoices are looked up on the server.
  const searchable = useMemo(
    () => PRODUCTS.map((p) => ({ ...p, barcodes: [p.barcode], aliases: [p.nameHi, ...p.aliases], active: true })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const remote = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<{ invoices?: RemoteInvoice[] }>("/search", { q: debounced, limit: 5 }),
    enabled: LIVE && debounced.length >= 2,
  });

  const items = useMemo<Item[]>(() => {
    const q = normalizeSearchText(query);
    const actions: Item[] = visibleModules().filter((m) => !q || normalizeSearchText(t(m.label)).includes(q) || m.key.includes(q)).map((m) => ({
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
      sub: [c.city, c.mobile, c.gstin].filter(Boolean).join(" · "),
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
    const invoices: Item[] = LIVE
      ? (remote.data?.invoices ?? []).map((i) => ({
          id: `i-${i.id}`,
          group: "invoices" as const,
          title: i.invoiceNumber,
          sub: `${i.partyName} · ${money(Number(i.grandTotal))}`,
          icon: <FileText size={16} />,
          route: { name: "invoice-view" as const, invoiceId: i.id },
        }))
      : INVOICES.filter((i) => i.number.toLowerCase().includes(needle))
          .slice(-5)
          .reverse()
          .map((i) => ({
            id: `i-${i.id}`,
            group: "invoices" as const,
            title: i.number,
            sub: `${customerById.get(i.customerId)?.businessName} · ${money(i.total)}`,
            icon: <FileText size={16} />,
            route: { name: "invoice-view" as const, invoiceId: i.id },
          }));
    return [...customers, ...products, ...invoices, ...actions.slice(0, 4)];
  }, [query, t, money, locale, searchable, remote.data]);

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
        <D.Content className="fixed top-[calc(var(--app-vh)*0.08)] left-1/2 z-50 w-[calc(100%-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-pop animate-pop">
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
              className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-3 focus:outline-none"
            />
            <VoiceButton
              onText={(text) => {
                setQuery(text);
                setActive(0);
              }}
              label={t("voice.search")}
              className="size-9"
              size={18}
            />
          </div>
          <div className="max-h-[calc(var(--app-vh)*0.6)] overflow-y-auto p-2">
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
