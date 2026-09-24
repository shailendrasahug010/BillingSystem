import { daysBetween } from "@vyapaar/core";
import { ArrowDownUp, ChevronRight, Download, Search, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented, Skeleton, useDelayedReady } from "../../components/ui/misc";
import { CUSTOMERS, ROUTES, TODAY } from "../../data/db";
import { LIVE } from "../../data/source";
import { customerInsight, useStoreVersion } from "../../data/store";
import { cn } from "../../lib/cn";
import { BEHAVIOUR_TONE } from "../invoice/CustomerCard";
import { searchCustomers } from "../invoice/CustomerPicker";
import { AddCustomerDialog } from "./AddCustomerDialog";

type Sort = "outstanding" | "name" | "last";

export function CustomersPage() {
  const { t, money, date } = useI18n();
  const { navigate } = useRouter();
  const version = useStoreVersion();
  const ready = useDelayedReady(300);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | "b2b" | "b2c">("all");
  const [route, setRoute] = useState("");
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [sort, setSort] = useState<Sort>("outstanding");
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const base = query.trim() ? searchCustomers(query, 100) : CUSTOMERS;
    return base
      .map((c) => ({ c, ins: customerInsight(c.id) }))
      .filter(({ c, ins }) => (type === "all" || c.type === type) && (!route || c.route === route) && (!onlyOutstanding || ins.outstanding > 0.5) && (!onlyOverdue || ins.overdue > 0))
      .sort((a, b) =>
        sort === "name" ? a.c.businessName.localeCompare(b.c.businessName) : sort === "last" ? (b.ins.lastPurchase ?? "").localeCompare(a.ins.lastPurchase ?? "") : b.ins.outstanding - a.ins.outstanding,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, type, route, onlyOutstanding, onlyOverdue, sort, version]);

  const totalOutstanding = rows.reduce((s, r) => s + r.ins.outstanding, 0);

  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn("h-9 rounded-full border px-3.5 text-[13px] font-medium", active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold text-ink">{t("customer.title")}</h1>
          <p className="num text-[13px] text-ink-3">
            {t("common.showingCount", { shown: rows.length, total: CUSTOMERS.length })} · {t("customer.outstanding")} {money(totalOutstanding, 0)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<Download size={16} />}>{t("common.export")}</Button>
          <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
            {t("customer.add")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-card">
        <div className="flex flex-col gap-2 md:flex-row">
          <Input id="customer-filter" className="flex-1" leading={<Search size={16} />} placeholder={t("customer.search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("customer.search")} />
          <Select aria-label={t("customer.route")} value={route} onChange={(e) => setRoute(e.target.value)} className="md:w-56">
            <option value="">
              {t("customer.route")}: {t("common.all")}
            </option>
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="md:w-52">
            <option value="outstanding">↓ {t("customer.outstanding")}</option>
            <option value="last">↓ {t("customer.lastPurchase")}</option>
            <option value="name">A–Z {t("common.name")}</option>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            label={t("customer.type")}
            value={type}
            onChange={setType}
            options={[
              { value: "all", label: t("common.all") },
              { value: "b2b", label: t("customer.b2b") },
              { value: "b2c", label: t("customer.b2c") },
            ]}
          />
          {chip(onlyOutstanding, t("customer.filters.withOutstanding"), () => setOnlyOutstanding((v) => !v))}
          {chip(onlyOverdue, t("customer.filters.overdue"), () => setOnlyOverdue((v) => !v))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        {!ready ? (
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-9 w-9 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("empty.customers")} action={<Button size="sm" onClick={() => { setQuery(""); setType("all"); setRoute(""); setOnlyOutstanding(false); setOnlyOverdue(false); }}>{t("common.reset")}</Button>} />
        ) : (
          <>
            <table className="hidden w-full text-[13.5px] md:table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-[12px] text-ink-3">
                  <th className="px-4 py-2.5 font-medium">{t("customer.name")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("customer.gstin")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("customer.route")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("customer.lastPurchase")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("customer.paymentBehaviour")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      <ArrowDownUp size={12} />
                      {t("customer.outstanding")}
                    </span>
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, ins }) => (
                  <tr key={c.id} onClick={() => navigate({ name: "customer", customerId: c.id })} className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{c.businessName}</p>
                      <p className="text-[12.5px] text-ink-3">
                        {c.name} · {c.city} · <span className="num">{c.mobile}</span>
                      </p>
                    </td>
                    <td className="px-3 py-3">{c.gstin ? <span className="font-mono text-[12px] text-ink-2">{c.gstin}</span> : <Badge>{t("customer.b2c")}</Badge>}</td>
                    <td className="px-3 py-3 text-ink-2">{c.route}</td>
                    <td className="num px-3 py-3 text-ink-2">
                      {ins.lastPurchase ? (
                        <>
                          {date(ins.lastPurchase)}
                          <span className="block text-[12px] text-ink-3">{t("common.daysAgo", { count: daysBetween(ins.lastPurchase, TODAY) })}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {(!LIVE || ins.behaviour.rating !== "new") && (
                        <Badge tone={BEHAVIOUR_TONE[ins.behaviour.rating]} dot>
                          {t(`behaviour.${ins.behaviour.rating}`)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p className={cn("num font-semibold", ins.overdue > 0 ? "text-danger" : "text-ink")}>{money(ins.outstanding, 0)}</p>
                      {ins.overdue > 0 && <p className="num text-[12px] text-danger">{t("dashboard.kpi.overdue", { amount: money(ins.overdue, 0) })}</p>}
                    </td>
                    <td className="pr-3 text-ink-3">
                      <ChevronRight size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-line md:hidden">
              {rows.map(({ c, ins }) => (
                <li key={c.id}>
                  <button type="button" onClick={() => navigate({ name: "customer", customerId: c.id })} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-ink">{c.businessName}</p>
                      <p className="truncate text-[12.5px] text-ink-3">
                        {c.city} · {c.route}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={cn("num text-[14px] font-semibold", ins.overdue > 0 ? "text-danger" : "text-ink")}>{money(ins.outstanding, 0)}</p>
                      {(!LIVE || ins.behaviour.rating !== "new") && (
                        <Badge tone={BEHAVIOUR_TONE[ins.behaviour.rating]} className="mt-1 h-5 text-[11px]">
                          {t(`behaviour.${ins.behaviour.rating}`)}
                        </Badge>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <AddCustomerDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
