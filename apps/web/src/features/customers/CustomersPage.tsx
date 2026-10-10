import { daysBetween } from "@digitalbahi/core";
import { ChevronRight, Download, FileUp, Search, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { hashFor, useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { DataTable } from "../../components/ui/DataTable";
import { FilterBar, HeaderActions } from "../../components/ui/Page";
import { Avatar, EmptyState, Segmented, useDelayedReady } from "../../components/ui/misc";
import { allowed, CUSTOMERS, ROUTES, TODAY } from "../../data/db";
import { LIVE } from "../../data/source";
import { customerInsight, useStoreVersion } from "../../data/store";
import { cn } from "../../lib/cn";
import { downloadCsv } from "../../lib/download";
import { BEHAVIOUR_TONE } from "../invoice/CustomerCard";
import { searchCustomers } from "../invoice/CustomerPicker";
import { ImportDialog } from "../imports/ImportDialog";
import { AddCustomerDialog } from "./AddCustomerDialog";
import { customerKind, kindLabel } from "./customerKind";

type Sort = "outstanding" | "name" | "last";
type Row = { c: (typeof CUSTOMERS)[number]; ins: ReturnType<typeof customerInsight> };

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
  const [importing, setImporting] = useState(false);

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
        <HeaderActions phoneMenu>
          {LIVE && allowed("customer.create") && (
            <Button icon={<FileUp size={16} />} onClick={() => setImporting(true)}>
              {t("imports.import")}
            </Button>
          )}
          {allowed("customer.export") && (
            <Button
              icon={<Download size={16} />}
              onClick={() =>
                downloadCsv(
                  "customers.csv",
                  [
                    { label: t("common.code"), value: (c) => c.code },
                    { label: t("customer.businessName"), value: (c) => c.businessName },
                    { label: t("customer.name"), value: (c) => c.name },
                    { label: t("common.mobile"), value: (c) => c.mobile },
                    { label: t("customer.gstin"), value: (c) => c.gstin },
                    { label: t("common.city"), value: (c) => c.city },
                    { label: t("customer.outstanding"), value: (c) => c.balance ?? "" },
                  ],
                  CUSTOMERS,
                )
              }
            >
              {t("common.export")}
            </Button>
          )}
          <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
            {t("customer.add")}
          </Button>
        </HeaderActions>
      </div>

      <FilterBar labelled>
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
      </FilterBar>

      <DataTable<Row>
        id="customers"
        loading={!ready}
        rows={rows}
        rowKey={(r) => r.c.id}
        onRowClick={(r) => navigate({ name: "customer", customerId: r.c.id })}
        rowHref={(r) => hashFor({ name: "customer", customerId: r.c.id })}
        pageSize={50}
        minWidth={760}
        empty={
          CUSTOMERS.length === 0 ? (
            // A new business: nothing is filtered away, there is nobody yet.
            <EmptyState
              title={t("customer.noneYet")}
              hint={t("customer.noneYetHint")}
              action={
                LIVE && allowed("customer.create") ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="primary" size="sm" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
                      {t("customer.add")}
                    </Button>
                    <Button size="sm" icon={<FileUp size={16} />} onClick={() => setImporting(true)}>
                      {t("customer.importButton")}
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <EmptyState title={t("empty.customers")} action={<Button size="sm" onClick={() => { setQuery(""); setType("all"); setRoute(""); setOnlyOutstanding(false); setOnlyOverdue(false); }}>{t("common.reset")}</Button>} />
          )
        }
        columns={[
          {
            key: "name",
            header: t("customer.name"),
            sortValue: (r) => r.c.businessName,
            render: ({ c }) => (
              <div className="flex items-center gap-3">
                <Avatar name={c.businessName} />
                <div className="min-w-0">
                  <p className="font-medium text-ink">{c.businessName}</p>
                  <p className="text-[12.5px] text-ink-3">{[c.name !== c.businessName && c.name, c.city, c.mobile].filter(Boolean).join(" · ")}</p>
                </div>
              </div>
            ),
          },
          {
            key: "gstin",
            header: t("customer.gstinOrType"),
            sortValue: (r) => r.c.gstin,
            render: ({ c }) => (c.gstin ? <span className="font-mono text-[12px] text-ink-2">{c.gstin}</span> : <Badge tone={customerKind(c) === "export" ? "accent" : "neutral"}>{t(kindLabel(c))}</Badge>),
          },
          // Columns nobody has anything in yet (no routes made, payment habits not known) stay out of the way.
          ...(rows.some((r) => r.c.route) ? [{ key: "route", header: t("customer.route"), sortValue: (r: Row) => r.c.route, className: "text-ink-2", render: ({ c }: Row) => c.route }] : []),
          {
            key: "last",
            header: t("customer.lastPurchase"),
            sortValue: (r) => r.ins.lastPurchase,
            className: "text-ink-2",
            render: ({ ins }) =>
              ins.lastPurchase ? (
                <>
                  {date(ins.lastPurchase)}
                  <span className="block text-[12px] text-ink-3">{t("common.daysAgo", { count: daysBetween(ins.lastPurchase, TODAY) })}</span>
                </>
              ) : (
                "—"
              ),
          },
          ...(rows.some((r) => !LIVE || r.ins.behaviour.rating !== "new")
            ? [
                {
                  key: "behaviour",
                  header: t("customer.paymentBehaviour"),
                  render: ({ ins }: Row) =>
                    (!LIVE || ins.behaviour.rating !== "new") && (
                      <Badge tone={BEHAVIOUR_TONE[ins.behaviour.rating]} dot>
                        {t(`behaviour.${ins.behaviour.rating}`)}
                      </Badge>
                    ),
                },
              ]
            : []),
          {
            key: "outstanding",
            header: t("customer.outstanding"),
            align: "right",
            sortValue: (r) => r.ins.outstanding,
            render: ({ ins }) => (
              <>
                <p className={cn("font-semibold", ins.overdue > 0 ? "text-danger" : "text-ink")}>{money(ins.outstanding, 0)}</p>
                {ins.overdue > 0 && <p className="text-[12px] text-danger">{t("dashboard.kpi.overdue", { amount: money(ins.overdue, 0) })}</p>}
              </>
            ),
          },
          { key: "open", header: "", hideable: false, className: "w-8 text-ink-3", render: () => <ChevronRight size={16} /> },
        ]}
        mobile={({ c, ins }) => (
          <>
            <Avatar name={c.businessName} className="size-10" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-medium text-ink">{c.businessName}</p>
              <p className="truncate text-[12.5px] text-ink-3">{[c.city, c.route].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="text-right">
              <p className={cn("num text-[14px] font-semibold", ins.overdue > 0 ? "text-danger" : "text-ink")}>{money(ins.outstanding, 0)}</p>
              {(!LIVE || ins.behaviour.rating !== "new") && (
                <Badge tone={BEHAVIOUR_TONE[ins.behaviour.rating]} className="mt-1 h-5 text-[11px]">
                  {t(`behaviour.${ins.behaviour.rating}`)}
                </Badge>
              )}
            </div>
          </>
        )}
      />
      <AddCustomerDialog open={adding} onOpenChange={setAdding} />
      {LIVE && <ImportDialog kind="customers" open={importing} onOpenChange={setImporting} />}
    </div>
  );
}
