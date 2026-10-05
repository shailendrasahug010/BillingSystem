import { stockLevel } from "@digitalbahi/core";
import { Download, FileUp, PackagePlus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { DataTable, RowCard } from "../../components/ui/DataTable";
import { FilterBar, HeaderActions } from "../../components/ui/Page";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { allowed, BRANDS, PRODUCTS } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { LIVE } from "../../data/source";
import { cn } from "../../lib/cn";
import { downloadCsv } from "../../lib/download";
import { stockInPacks } from "../../lib/packs";
import { searchProducts } from "@digitalbahi/core";
import { ImportDialog } from "../imports/ImportDialog";
import { ProductEditor } from "./ProductEditor";

type Product = ReturnType<typeof useSearchableProducts>[number];

export function ProductsPage() {
  const { t, money, number, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [stock, setStock] = useState<"all" | "low" | "out">("all");
  const searchable = useSearchableProducts();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const canEdit = LIVE && allowed("product.update");
  const showMargin = !LIVE || allowed("product.view_cost");
  const costOf = (p: Product) => p.avgCost || p.purchasePrice;

  const rows = useMemo(() => {
    const base = query.trim() ? searchProducts(query, searchable, { limit: 100 }).map((h) => h.product) : searchable;
    return base.filter((p) => {
      const level = stockLevel(p.stock, p.minStock);
      return (!brand || p.brandId === brand) && (stock === "all" || (stock === "low" ? level === "low" : level === "out_of_stock"));
    });
  }, [query, brand, stock, searchable]);

  // Valued at average cost like Inventory and Reports; stock below zero counts as none.
  const stockValue = rows.reduce((s, p) => s + Math.max(p.stock, 0) * (p.avgCost ?? p.purchasePrice), 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold text-ink">{t("product.title")}</h1>
          <p className="num text-[13px] text-ink-3">
            {t("common.showingCount", { shown: rows.length, total: PRODUCTS.length })} · {t("product.stockValue")} {money(stockValue, 0)}
          </p>
        </div>
        <HeaderActions>
          {LIVE && allowed("product.import") && (
            <Button icon={<FileUp size={16} />} onClick={() => setImporting(true)}>
              {t("imports.import")}
            </Button>
          )}
          {allowed("product.export") && (
            <Button
              icon={<Download size={16} />}
              onClick={() =>
                downloadCsv(
                  "products.csv",
                  [
                    { label: t("product.code"), value: (p) => p.code },
                    { label: t("product.name"), value: (p) => p.name },
                    { label: t("product.brand"), value: (p) => p.brand },
                    { label: t("product.hsn"), value: (p) => p.hsn },
                    { label: t("product.gstRate"), value: (p) => p.gstRate },
                    { label: t("product.mrp"), value: (p) => p.mrp },
                    { label: t("product.sellingPrice"), value: (p) => p.rate },
                    { label: t("product.currentStock"), value: (p) => p.stock },
                    { label: t("product.unit"), value: (p) => p.unit },
                  ],
                  rows,
                )
              }
            >
              {t("common.export")}
            </Button>
          )}
          {(!LIVE || allowed("product.create")) && (
            <Button
              variant="primary"
              icon={<PackagePlus size={16} />}
              onClick={() => (LIVE ? setEditing({ id: null }) : toast({ tone: "info", title: t("common.sampleData"), body: t("product.demoReadOnly") }))}
            >
              {t("product.add")}
            </Button>
          )}
        </HeaderActions>
      </div>

      <FilterBar>
        <Input id="product-filter" className="flex-1" leading={<Search size={16} />} placeholder={t("product.search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("product.search")} />
        <Select aria-label={t("product.brand")} value={brand} onChange={(e) => setBrand(e.target.value)} className="md:w-56">
          <option value="">
            {t("product.brand")}: {t("common.all")}
          </option>
          {BRANDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Segmented
          size="sm"
          label={t("product.currentStock")}
          value={stock}
          onChange={setStock}
          options={[
            { value: "all", label: t("common.all") },
            { value: "low", label: t("product.filters.lowStock") },
            { value: "out", label: t("product.filters.outOfStock") },
          ]}
        />
      </FilterBar>

      <DataTable<Product>
        id="products"
        rows={rows}
        rowKey={(p) => p.id}
        {...(canEdit ? { onRowClick: (p: Product) => setEditing({ id: p.id }) } : {})}
        pageSize={50}
        minWidth={860}
        mobile={(p) => {
          const level = stockLevel(p.stock, p.minStock);
          return (
            <RowCard
              title={locale === "hi" ? p.nameHi : p.name}
              sub={[p.code, p.brand, money(p.rate)].filter(Boolean).join(" · ")}
              value={stockInPacks(p.stock, p, (n) => number(n)) ?? `${number(p.stock)} ${p.unit}`}
              tone={level === "out_of_stock" ? "danger" : level === "low" ? "warn" : undefined}
              valueSub={level !== "ok" ? t(`status.stock.${level}`) : stockInPacks(p.stock, p, (n) => number(n)) ? `= ${number(p.stock)} ${p.unit}` : undefined}
            />
          );
        }}
        empty={
          <EmptyState
            title={PRODUCTS.length === 0 ? t("product.noneYet") : t("empty.products")}
            {...(LIVE && allowed("product.create") && PRODUCTS.length === 0
              ? {
                  hint: t("product.emptyHint"),
                  action: (
                    <Button variant="primary" icon={<PackagePlus size={16} />} onClick={() => setEditing({ id: null })}>
                      {t("product.add")}
                    </Button>
                  ),
                }
              : {})}
          />
        }
        columns={[
          {
            key: "name",
            header: t("product.name"),
            sortValue: (p) => (locale === "hi" ? p.nameHi : p.name),
            render: (p) => (
              <>
                <p className="font-medium text-ink">{locale === "hi" ? p.nameHi : p.name}</p>
                <p className="text-[12px] text-ink-3">{[p.code, p.packSize, p.barcode].filter(Boolean).join(" · ")}</p>
              </>
            ),
          },
          // A column nobody has filled yet stays out of the way.
          ...(rows.some((p) => p.brand) ? [{ key: "brand", header: t("product.brand"), sortValue: (p: Product) => p.brand, className: "text-ink-2", render: (p: Product) => p.brand }] : []),
          { key: "hsn", header: t("product.hsn"), sortValue: (p) => p.hsn, className: "font-mono text-[12.5px] text-ink-2", render: (p) => p.hsn },
          { key: "gst", header: t("product.gstRate"), align: "right", sortValue: (p) => p.gstRate, render: (p) => (p.taxCategory.kind === "taxable" ? `${p.gstRate}%` : t("gst.nilRated")) },
          { key: "mrp", header: t("product.mrp"), align: "right", sortValue: (p) => p.mrp, className: "text-ink-2", render: (p) => (p.mrp > 0 ? money(p.mrp) : "—") },
          { key: "rate", header: t("product.sellingPrice"), align: "right", sortValue: (p) => p.rate, className: "text-ink", render: (p) => money(p.rate) },
          {
            key: "margin",
            header: t("product.margin"),
            align: "right",
            className: "text-ink-2",
            // No purchase cost known yet: no margin to show (not 100%).
            ...(showMargin ? { sortValue: (p: Product) => (p.rate > 0 && costOf(p) > 0 ? (p.rate - costOf(p)) / p.rate : null) } : {}),
            render: (p) => (p.rate > 0 && costOf(p) > 0 && showMargin ? `${(((p.rate - costOf(p)) / p.rate) * 100).toFixed(1)}%` : "—"),
          },
          {
            key: "stock",
            header: t("product.currentStock"),
            align: "right",
            sortValue: (p) => p.stock,
            render: (p) => {
              const level = stockLevel(p.stock, p.minStock);
              return (
                <>
                  <p className={cn("font-semibold", level === "out_of_stock" ? "text-danger" : level === "low" ? "text-warn" : "text-ink")}>{stockInPacks(p.stock, p, (n) => number(n)) ?? `${number(p.stock)} ${p.unit}`}</p>
                  {stockInPacks(p.stock, p, (n) => number(n)) && (
                    <p className="text-[12px] text-ink-3">
                      = {number(p.stock)} {p.unit}
                    </p>
                  )}
                  {level !== "ok" && (
                    <Badge tone={level === "out_of_stock" ? "danger" : "warn"} className="mt-0.5 h-5 text-[11px]">
                      {t(`status.stock.${level}`)}
                    </Badge>
                  )}
                </>
              );
            },
          },
        ]}
      />
      {LIVE && <ImportDialog kind="products" open={importing} onOpenChange={setImporting} />}
      {LIVE && <ProductEditor productId={editing?.id ?? null} open={editing !== null} onOpenChange={(v) => !v && setEditing(null)} />}
    </div>
  );
}
