import type { ReorderRow, Suggestion, SuggestionGroup, SuggestionReason } from "@vyapaar/core";
import { CircleQuestionMark, Plus, Sparkles } from "lucide-react";
import { Popover } from "radix-ui";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useShortcuts } from "../../app/shortcuts";
import { Badge } from "../../components/ui/Badge";
import { Kbd } from "../../components/ui/misc";
import { productById, TODAY } from "../../data/mock";
import { cn } from "../../lib/cn";
import { daysBetween } from "@vyapaar/core";
import type { Translate } from "@vyapaar/i18n";

type Tab = "all" | SuggestionGroup;

export function reasonText(t: Translate, reason: SuggestionReason, locale: string): string {
  const p = reason.params;
  switch (reason.code) {
    case "together": {
      const other = productById.get(String(p.withProductId));
      const name = other ? (locale === "hi" ? other.nameHi : other.name) : String(p.withProductName);
      return t(p.scope === "customer" ? "suggestions.reason.together_customer" : "suggestions.reason.together_all", { ...p, withProductName: name });
    }
    default:
      return t(`suggestions.reason.${reason.code}`, p);
  }
}

const reasonTone = (code: SuggestionReason["code"]) =>
  code === "overdue" || code === "out_of_stock" ? "danger" : code === "due" || code === "low_stock" || code === "lapsed" ? "warn" : "accent";

/**
 * Smart suggestions. Everything here is a recommendation with its reason on
 * screen; nothing is added until the user clicks (or presses Alt+1…9).
 */
export function SuggestionsPanel({
  customerName,
  suggestions,
  reorder,
  onAdd,
  hasCustomer,
  variant = "desktop",
}: {
  customerName: string | null;
  suggestions: Suggestion[];
  reorder: ReorderRow[];
  onAdd(productId: string, qty: number): void;
  hasCustomer: boolean;
  variant?: "desktop" | "mobile";
}) {
  const { t, locale, date } = useI18n();
  const [tab, setTab] = useState<Tab>("all");
  const [tableView, setTableView] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: suggestions.length, reorder: 0, frequent: 0, together: 0, last_order: 0 };
    for (const s of suggestions) c[s.group] += 1;
    return c;
  }, [suggestions]);

  const visible = (tab === "all" ? suggestions : suggestions.filter((s) => s.group === tab)).slice(0, variant === "mobile" ? 12 : 9);

  useShortcuts(
    Array.from({ length: 9 }, (_, i) => ({
      id: `sugg-${i}`,
      keys: `alt+${i + 1}`,
      allowInInputs: true,
      handler: () => {
        const s = visible[i];
        if (s) onAdd(s.productId, s.suggestedQty?.toNumber() ?? productById.get(s.productId)?.caseSize ?? 1);
      },
    })),
    variant === "desktop",
  );

  if (!hasCustomer) {
    return (
      <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface px-4 py-4 text-[13.5px] text-ink-3">
        <Sparkles size={18} className="shrink-0 text-marigold" />
        {t("suggestions.pickCustomer")}
      </div>
    );
  }

  const tabs: Tab[] = ["all", "reorder", "frequent", "together", "last_order"];

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface shadow-card" aria-labelledby="sugg-title">
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5">
        <div className="min-w-0">
          <h2 id="sugg-title" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <Sparkles size={16} className="text-marigold" />
            {t("suggestions.title")}
          </h2>
          <p className="text-[12.5px] text-ink-3">{t("suggestions.subtitle", { name: customerName ?? "" })}</p>
        </div>
        {variant === "desktop" && tab === "reorder" && reorder.length > 0 && (
          <button type="button" onClick={() => setTableView((v) => !v)} className="text-[12.5px] font-medium text-accent hover:underline">
            {tableView ? t("suggestions.title") : t("suggestions.reorder.title")}
          </button>
        )}
      </div>

      <div className="scroll-x mt-2.5 border-b border-line px-2">
        <div role="tablist" aria-label={t("suggestions.title")} className="flex w-max gap-1">
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              disabled={k !== "all" && counts[k] === 0}
              className={cn(
                "relative flex h-9 items-center gap-1.5 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-40",
                tab === k ? "text-ink after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent" : "text-ink-3 hover:text-ink",
              )}
            >
              {t(`suggestions.tabs.${k}`)}
              <span className="num rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-3">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === "reorder" && tableView && variant === "desktop" ? (
        <div className="scroll-x p-2">
          <table className="w-full text-[13px]">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="px-2 py-2 font-medium">{t("suggestions.reorder.product")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("suggestions.reorder.lastQty")}</th>
                <th className="px-2 py-2 font-medium">{t("suggestions.reorder.lastPurchase")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("suggestions.reorder.suggestedQty")}</th>
                <th className="px-2 py-2 font-medium">{t("common.status")}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="num">
              {reorder.map((row) => {
                const p = productById.get(row.productId)!;
                return (
                  <tr key={row.productId} className="border-t border-line">
                    <td className="px-2 py-2 text-ink">{locale === "hi" ? p.nameHi : p.name}</td>
                    <td className="px-2 py-2 text-right">{row.lastQty.toString()}</td>
                    <td className="px-2 py-2 text-ink-2">
                      {date(row.lastPurchasedOn)} · {t("common.daysAgo", { count: row.daysSinceLast })}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold">{row.suggestedQty.toString()}</td>
                    <td className="px-2 py-2">
                      <Badge tone={row.status === "overdue" ? "danger" : row.status === "due" ? "warn" : "neutral"}>{t(`suggestions.reorder.status.${row.status}`)}</Badge>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button type="button" onClick={() => onAdd(row.productId, row.suggestedQty.toNumber())} className="inline-flex h-7 items-center gap-1 rounded-md bg-accent-soft px-2 text-[12px] font-semibold text-accent-ink">
                        <Plus size={13} /> {t("suggestions.add")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : visible.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">{t("suggestions.empty")}</p>
      ) : (
        <ul className={cn("p-2", variant === "desktop" ? "grid grid-cols-1 gap-1.5 md:grid-cols-2 2xl:grid-cols-3" : "flex flex-col gap-1.5")}>
          {visible.map((s, i) => {
            const p = productById.get(s.productId)!;
            // No purchase history for this product (e.g. "bought together"): start with one case.
            const qty = s.suggestedQty?.toNumber() ?? p.caseSize;
            const main = s.reasons[0]!;
            const flags = s.reasons.filter((r) => r.code === "out_of_stock" || r.code === "low_stock");
            return (
              <li key={s.productId} className="group flex items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 hover:border-line hover:bg-surface-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-ink">{locale === "hi" ? p.nameHi : p.name}</p>
                  <p className="flex items-start gap-1.5 text-[12px] leading-snug text-ink-3">
                    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", reasonTone(main.code) === "danger" ? "bg-danger" : reasonTone(main.code) === "warn" ? "bg-warn" : "bg-accent")} aria-hidden />
                    <span className="line-clamp-2">{reasonText(t, main, locale)}</span>
                    <Popover.Root>
                      <Popover.Trigger className="mt-px inline-flex shrink-0 text-ink-3 hover:text-accent" aria-label={t("suggestions.why")}>
                        <CircleQuestionMark size={13} />
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content side="top" sideOffset={6} className="z-50 w-72 rounded-xl border border-line bg-surface p-3 text-[12.5px] text-ink-2 shadow-pop">
                          <p className="mb-1.5 font-semibold text-ink">{t("suggestions.why")}</p>
                          <ul className="flex flex-col gap-1">
                            {s.reasons.map((r) => (
                              <li key={r.code} className="flex gap-2">
                                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                                {reasonText(t, r, locale)}
                              </li>
                            ))}
                          </ul>
                          {p.batch && (
                            <p className="mt-2 text-ink-3">
                              {t("invoice.batch")} {p.batch.number} · {t("invoice.expiry")} {date(p.batch.expiry)} ({t("common.days", { count: daysBetween(TODAY, p.batch.expiry) })})
                            </p>
                          )}
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  </p>
                  {flags.length > 0 && (
                    <div className="mt-1 flex gap-1">
                      {flags.map((f) => (
                        <Badge key={f.code} tone={f.code === "out_of_stock" ? "danger" : "warn"} className="h-5 px-2 text-[11px]">
                          {reasonText(t, f, locale)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                {variant === "desktop" && i < 9 && <Kbd keys={`alt+${i + 1}`} className="hidden opacity-0 group-hover:opacity-100 xl:inline-flex" />}
                <button
                  type="button"
                  onClick={() => onAdd(s.productId, qty)}
                  className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-accent-soft px-3 text-[13px] font-semibold text-accent-ink transition-colors hover:bg-accent hover:text-ink-inverse"
                  aria-label={`${t("suggestions.add")} ${qty} ${p.name}`}
                >
                  <Plus size={14} />
                  <span className="num">{qty}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
