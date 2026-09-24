import { stockLevel } from "@vyapaar/core";
import { Download, PackagePlus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { BRANDS, PRODUCTS } from "../../data/mock";
import { cn } from "../../lib/cn";
import { searchProducts } from "@vyapaar/core";

const searchable = PRODUCTS.map((p) => ({ ...p, barcodes: [p.barcode], aliases: [p.nameHi, ...p.aliases], active: true }));

export function ProductsPage() {
  const { t, money, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [stock, setStock] = useState<"all" | "low" | "out">("all");

  const rows = useMemo(() => {
    const base = query.trim() ? searchProducts(query, searchable, { limit: 100 }).map((h) => h.product) : searchable;
    return base.filter((p) => {
      const level = stockLevel(p.stock, p.minStock);
      return (!brand || p.brandId === brand) && (stock === "all" || (stock === "low" ? level === "low" : level === "out_of_stock"));
    });
  }, [query, brand, stock]);

  const stockValue = rows.reduce((s, p) => s + p.stock * p.purchasePrice, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold text-ink">{t("product.title")}</h1>
          <p className="num text-[13px] text-ink-3">
            {t("common.showingCount", { shown: rows.length, total: PRODUCTS.length })} · {t("product.stockValue")} {money(stockValue, 0)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<Download size={16} />}>{t("common.export")}</Button>
          <Button variant="primary" icon={<PackagePlus size={16} />}>
            {t("product.add")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-card md:flex-row md:items-center">
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
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        {rows.length === 0 ? (
          <EmptyState title={t("empty.products")} />
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[860px] text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-[12px] text-ink-3">
                  <th className="px-4 py-2.5 font-medium">{t("product.name")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("product.brand")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("product.hsn")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("product.gstRate")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("product.mrp")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("product.sellingPrice")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("product.margin")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("product.currentStock")}</th>
                </tr>
              </thead>
              <tbody className="num">
                {rows.map((p) => {
                  const level = stockLevel(p.stock, p.minStock);
                  const margin = ((p.rate - p.purchasePrice) / p.rate) * 100;
                  return (
                    <tr key={p.id} className="border-b border-line last:border-b-0 hover:bg-surface-2">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-ink">{locale === "hi" ? p.nameHi : p.name}</p>
                        <p className="text-[12px] text-ink-3">
                          <span className="font-mono">{p.code}</span> · {p.packSize} · <span className="font-mono">{p.barcode}</span>
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-ink-2">{p.brand}</td>
                      <td className="px-3 py-2.5 font-mono text-[12.5px] text-ink-2">{p.hsn}</td>
                      <td className="px-3 py-2.5 text-right">{p.taxCategory.kind === "taxable" ? `${p.gstRate}%` : t("gst.nilRated")}</td>
                      <td className="px-3 py-2.5 text-right text-ink-2">{money(p.mrp)}</td>
                      <td className="px-3 py-2.5 text-right text-ink">{money(p.rate)}</td>
                      <td className="px-3 py-2.5 text-right text-ink-2">{margin.toFixed(1)}%</td>
                      <td className="px-4 py-2.5 text-right">
                        <p className={cn("font-semibold", level === "out_of_stock" ? "text-danger" : level === "low" ? "text-warn" : "text-ink")}>
                          {p.stock} {p.unit}
                        </p>
                        {level !== "ok" && (
                          <Badge tone={level === "out_of_stock" ? "danger" : "warn"} className="mt-0.5 h-5 text-[11px]">
                            {t(`status.stock.${level}`)}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
