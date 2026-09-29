import { daysBetween, findState, type CreditCheck } from "@vyapaar/core";
import { MapPin, Phone, TriangleAlert, X } from "lucide-react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Avatar, ProgressBar } from "../../components/ui/misc";
import { TODAY, WORKSPACE } from "../../data/db";
import type { CustomerInsight } from "../../data/store";
import type { Customer } from "../../data/types";
import { cn } from "../../lib/cn";

export const BEHAVIOUR_TONE: Record<string, Tone> = { excellent: "good", good: "good", slow: "warn", risky: "danger", new: "neutral" };

/**
 * What the salesperson needs before adding a single item: who it is, how much
 * they owe, how much credit is left, when they last bought and how they pay.
 */
export function CustomerCard({
  customer,
  insight,
  credit,
  onClear,
  compact,
}: {
  customer: Customer;
  insight: CustomerInsight;
  credit: CreditCheck | null;
  onClear?(): void;
  compact?: boolean;
}) {
  const { t, money, date, locale } = useI18n();
  const { navigate } = useRouter();
  const state = findState(customer.stateCode);
  const limit = customer.creditLimit ?? 0;
  const used = limit > 0 ? insight.outstanding / limit : 0;
  const lastDays = insight.lastPurchase ? daysBetween(insight.lastPurchase, TODAY) : null;
  const priceList = WORKSPACE.priceLevels.length > 1 ? WORKSPACE.priceLevels.find((l) => l.id === (customer.priceLevelId ?? WORKSPACE.defaultPriceLevelId))?.name : undefined;

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
      <div className="flex items-start gap-3 p-4">
        <Avatar name={customer.businessName} className="size-11 text-[14px]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="truncate text-left font-display text-[17px] font-semibold text-ink hover:underline" onClick={() => navigate({ name: "customer", customerId: customer.id })}>
              {customer.businessName}
            </button>
            <Badge tone={customer.type === "b2b" ? "accent" : "neutral"}>{customer.type === "b2b" ? t("customer.b2b") : t("customer.b2c")}</Badge>
            <Badge tone={BEHAVIOUR_TONE[insight.behaviour.rating]} dot>
              {t(`behaviour.${insight.behaviour.rating}`)}
            </Badge>
            {/* The rate list the bill is priced from (Price A / B / C). */}
            {priceList && (
              <Badge>
                <span className="sr-only">{t("customer.priceList")}: </span>
                <span>{priceList}</span>
              </Badge>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-ink-3">
            <span>{customer.name}</span>
            <span className="inline-flex items-center gap-1">
              <Phone size={12} />
              <span className="num">{customer.mobile}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} />
              {customer.city}, {locale === "hi" ? state?.nameHi : state?.name}
            </span>
            {customer.gstin && <span className="font-mono text-[12px]">GSTIN {customer.gstin}</span>}
          </p>
        </div>
        {onClear && (
          <button type="button" onClick={onClear} className="-mt-1 -mr-1 inline-flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={t("invoice.changeCustomer")}>
            <X size={16} />
          </button>
        )}
      </div>

      <dl className={cn("grid border-t border-line", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
        <div className="border-r border-line px-4 py-3">
          <dt className="text-[12px] text-ink-3">{t("invoice.customerCard.outstanding")}</dt>
          <dd className={cn("num mt-0.5 text-[16px] font-semibold", insight.overdue > 0 ? "text-danger" : "text-ink")}>{money(insight.outstanding, 0)}</dd>
          {insight.overdue > 0 && <dd className="num text-[11.5px] text-danger">{t("dashboard.kpi.overdue", { amount: money(insight.overdue, 0) })}</dd>}
        </div>
        <div className={cn("px-4 py-3", !compact && "sm:border-r sm:border-line")}>
          <dt className="text-[12px] text-ink-3">{t("invoice.customerCard.creditLimit")}</dt>
          <dd className="num mt-0.5 text-[16px] font-semibold text-ink">{limit > 0 ? money(limit, 0) : "—"}</dd>
          {limit > 0 && (
            <dd className="mt-1.5 flex flex-col gap-1">
              <ProgressBar value={used} tone={used >= 1 ? "danger" : used >= 0.8 ? "warn" : "accent"} label={t("invoice.customerCard.creditLimit")} />
              <span className="num text-[11.5px] text-ink-3">
                {t("invoice.customerCard.available")} {money(Math.max(0, limit - insight.outstanding), 0)}
              </span>
            </dd>
          )}
        </div>
        <div className={cn("border-t border-r border-line px-4 py-3", !compact && "sm:border-t-0")}>
          <dt className="text-[12px] text-ink-3">{t("invoice.customerCard.lastPurchase")}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold text-ink">{insight.lastPurchase ? date(insight.lastPurchase) : t("invoice.customerCard.never")}</dd>
          {lastDays !== null && <dd className="text-[11.5px] text-ink-3">{t("common.daysAgo", { count: lastDays })}</dd>}
        </div>
        <div className={cn("border-t border-line px-4 py-3", !compact && "sm:border-t-0")}>
          <dt className="text-[12px] text-ink-3">{t("invoice.customerCard.avgOrder")}</dt>
          <dd className="num mt-0.5 text-[15px] font-semibold text-ink">{money(insight.avgOrderValue, 0)}</dd>
          {insight.behaviour.avgDaysToPay !== null && (
            <dd className="text-[11.5px] text-ink-3">{t("customer.avgDaysToPay", { days: Math.round(insight.behaviour.avgDaysToPay) })}</dd>
          )}
        </div>
      </dl>

      {credit && credit.level !== "ok" && (
        <div className={cn("flex gap-2.5 border-t px-4 py-3 text-[13px]", credit.level === "block" ? "border-danger/30 bg-danger-soft text-danger" : "border-warn/30 bg-warn-soft text-warn")} role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <p className="font-semibold">{t("credit.warning")}</p>
            {credit.reasons.map((r) => (
              <p key={r.code}>{r.code === "credit_limit_exceeded" ? t("credit.credit_limit_exceeded", r.params) : t("credit.overdue_invoices", r.params)}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
