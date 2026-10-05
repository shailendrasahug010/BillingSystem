import { Download, Factory, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, FilterBar, PageHeader, RowCard, type Column } from "../../components/ui/Page";
import { allowed, SUPPLIERS, type Supplier } from "../../data/db";
import { useStoreVersion } from "../../data/store";
import { downloadCsv } from "../../lib/download";
import { searchSuppliers, supplierLabel } from "./search";
import { SupplierDialog } from "./SupplierDialog";

export function SuppliersPage() {
  const { t, money } = useI18n();
  const { navigate } = useRouter();
  const version = useStoreVersion();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "payable">("all");
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const base = q.trim() ? searchSuppliers(q, 500) : [...SUPPLIERS].sort((a, b) => supplierLabel(a).localeCompare(supplierLabel(b)));
    return filter === "payable" ? base.filter((s) => s.balance > 0) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter, version]);
  const payable = SUPPLIERS.reduce((sum, s) => sum + Math.max(0, s.balance), 0);

  const columns: Column<Supplier>[] = [
    {
      key: "name",
      header: t("supplier.displayName"),
      sortValue: (s) => supplierLabel(s),
      render: (s) => (
        <div>
          <p className="font-medium text-ink">{supplierLabel(s)}</p>
          <p className="text-[12px] text-ink-3">
            <span className="font-mono">{s.code}</span>
            {s.companyName && s.name !== s.companyName ? ` · ${s.companyName}` : ""}
          </p>
        </div>
      ),
    },
    { key: "city", header: t("common.city"), sortValue: (s) => s.city, render: (s) => <span className="text-ink-2">{s.city ?? ""}</span> },
    { key: "mobile", header: t("common.mobile"), render: (s) => <span className="text-ink-2">{s.mobile ?? ""}</span> },
    { key: "gstin", header: t("customer.gstin"), sortValue: (s) => s.gstin, render: (s) => <span className="font-mono text-[12.5px] text-ink-2">{s.gstin ?? t(`supplier.registration.${s.gstRegistration === "composition" ? "composition" : s.gstRegistration === "regular" ? "regular" : "unregistered"}`)}</span> },
    { key: "days", header: t("customer.creditDays"), align: "right", sortValue: (s) => s.creditDays, render: (s) => <span className="text-ink-2">{s.creditDays || "—"}</span> },
    { key: "balance", header: t("supplier.outstandingPayable"), align: "right", sortValue: (s) => s.balance, render: (s) => <span className={s.balance > 0 ? "font-semibold text-ink" : "text-ink-3"}>{money(s.balance)}</span> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("supplier.title")}
        subtitle={
          <>
            {t("common.showingCount", { shown: rows.length, total: SUPPLIERS.length })} · {t("supplier.outstandingPayable")} {money(payable, 0)}
          </>
        }
        actions={
          <>
            <Button
              icon={<Download size={16} />}
              onClick={() =>
                downloadCsv(
                  "suppliers.csv",
                  [
                    { label: t("common.code"), value: (s) => s.code },
                    { label: t("supplier.displayName"), value: (s) => s.name },
                    { label: t("supplier.companyName"), value: (s) => s.companyName },
                    { label: t("common.city"), value: (s) => s.city },
                    { label: t("common.mobile"), value: (s) => s.mobile },
                    { label: t("customer.gstin"), value: (s) => s.gstin },
                    { label: t("supplier.outstandingPayable"), value: (s) => s.balance.toFixed(2) },
                  ],
                  rows,
                )
              }
            >
              {t("common.export")}
            </Button>
            {allowed("supplier.create") && (
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                {t("supplier.add")}
              </Button>
            )}
          </>
        }
      />
      <FilterBar>
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("supplier.search")} aria-label={t("supplier.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Segmented
          size="sm"
          label={t("common.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("common.all") },
            { value: "payable", label: t("supplier.withPayable") },
          ]}
        />
      </FilterBar>
      <DataTable
        id="suppliers"
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate({ name: "supplier", supplierId: s.id })}
        mobile={(s) => (
          <RowCard
            title={supplierLabel(s)}
            sub={[s.code, s.city, s.mobile].filter(Boolean).join(" · ")}
            value={money(s.balance)}
            valueSub={s.balance > 0 ? t("supplier.outstandingPayable") : undefined}
          />
        )}
        empty={
          <EmptyState
            icon={<Factory size={20} />}
            title={t("supplier.empty")}
            hint={t("supplier.emptyHint")}
            {...(allowed("supplier.create") && SUPPLIERS.length === 0
              ? {
                  action: (
                    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                      {t("supplier.add")}
                    </Button>
                  ),
                }
              : {})}
          />
        }
      />
      <SupplierDialog supplierId={null} open={adding} onOpenChange={setAdding} onSaved={(id) => navigate({ name: "supplier", supplierId: id })} />
    </div>
  );
}
