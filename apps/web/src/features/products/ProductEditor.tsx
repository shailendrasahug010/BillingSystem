import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, BRANDS, WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api, ApiError } from "../../lib/api";

interface ProductDetail {
  id: string;
  name: string;
  nameLocal: string | null;
  aliases: string[] | null;
  code: string;
  hsnCode: string | null;
  taxCategoryId: string;
  brandId: string | null;
  categoryId: string | null;
  baseUnitId: string;
  packSize: string | null;
  purchasePrice?: string;
  sellingPrice: string;
  mrp: string | null;
  pricesIncludeTax: boolean;
  minStock: string | null;
  reorderQty: string | null;
  trackBatches: boolean;
  trackExpiry: boolean;
  isActive: boolean;
  version: number;
  units: Array<{ unitId: string; conversionFactor: string; isDefaultSale: boolean; isDefaultPurchase: boolean }>;
  barcodes: Array<{ barcode: string; unitId: string | null }>;
  prices: Array<{ priceLevelId: string; unitId: string; price: string; discountPercent: string }>;
  stock: { total: string };
}

const NEW = "__new";
const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));
const RATE = /^\d{1,11}(\.\d{1,4})?$/;
const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const HSN = /^(\d{4}|\d{6}|\d{8})$/;
const byPriceKey = (a: { priceLevelId: string; unitId: string }, b: { priceLevelId: string; unitId: string }) =>
  `${a.priceLevelId}:${a.unitId}`.localeCompare(`${b.priceLevelId}:${b.unitId}`);
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function emptyForm() {
  const defaultTax = WORKSPACE.taxCategories.find((c) => c.kind === "taxable") ?? WORKSPACE.taxCategories[0];
  const bySymbol = (symbol: string) => WORKSPACE.unitList.find((u) => u.symbol.toUpperCase() === symbol);
  const defaultUnit = bySymbol("PCS") ?? bySymbol("NOS") ?? WORKSPACE.unitList[0];
  return {
    name: "",
    nameLocal: "",
    aliases: "",
    code: "",
    hsnCode: "",
    taxCategoryId: defaultTax?.id ?? "",
    brandId: "",
    newBrand: "",
    categoryId: "",
    newCategory: "",
    baseUnitId: defaultUnit?.id ?? "",
    packSize: "",
    purchasePrice: "",
    sellingPrice: "",
    mrp: "",
    pricesIncludeTax: false,
    minStock: "",
    reorderQty: "",
    barcodes: "",
    caseUnitId: "",
    caseFactor: "",
    levelPrices: {} as Record<string, string>,
    openingStock: "",
    openingCost: "",
    isActive: true,
    trackBatches: false,
    trackExpiry: false,
  };
}

type Form = ReturnType<typeof emptyForm>;

/** Details known before the form opens (a new product from a supplier's bill line). */
export type ProductPrefill = Partial<Pick<Form, "name" | "hsnCode" | "taxCategoryId" | "baseUnitId" | "purchasePrice" | "mrp" | "barcodes" | "trackBatches" | "trackExpiry">>;

function formFrom(p: ProductDetail): Form {
  const alt = p.units[0];
  return {
    ...emptyForm(),
    name: p.name,
    nameLocal: p.nameLocal ?? "",
    aliases: (p.aliases ?? []).join(", "),
    code: p.code,
    hsnCode: p.hsnCode ?? "",
    taxCategoryId: p.taxCategoryId,
    brandId: p.brandId ?? "",
    categoryId: p.categoryId ?? "",
    baseUnitId: p.baseUnitId,
    packSize: p.packSize ?? "",
    purchasePrice: num(p.purchasePrice),
    sellingPrice: num(p.sellingPrice),
    mrp: num(p.mrp),
    pricesIncludeTax: p.pricesIncludeTax,
    minStock: num(p.minStock),
    reorderQty: num(p.reorderQty),
    barcodes: p.barcodes.map((b) => b.barcode).join(", "),
    caseUnitId: alt?.unitId ?? "",
    caseFactor: num(alt?.conversionFactor),
    levelPrices: Object.fromEntries(p.prices.filter((x) => x.unitId === p.baseUnitId).map((x) => [x.priceLevelId, num(x.price)])),
    isActive: p.isActive,
    trackBatches: p.trackBatches,
    trackExpiry: p.trackExpiry,
  };
}

/**
 * Add or edit a product (live mode). Only what a distributor fills in on day
 * one is on the form: names, GST category and HSN, unit and case size, prices
 * per rate list, minimum stock and opening stock. The server validates again
 * and assigns the code; on edit only the changed fields are sent.
 */
export function ProductEditor({
  productId,
  open,
  onOpenChange,
  prefill,
  onSaved,
}: {
  productId: string | null;
  open: boolean;
  onOpenChange(v: boolean): void;
  prefill?: ProductPrefill;
  onSaved?(id: string): void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<Form>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const fieldError = useFieldError(error);
  const canPrice = allowed("product.update_price") || !productId;
  const canCost = allowed("product.view_cost");
  const levels = WORKSPACE.priceLevels.filter((l) => !l.isDefault);
  const prefillRef = useRef(prefill);

  const detail = useQuery({
    queryKey: ["product", productId],
    queryFn: () => api.get<ProductDetail>(`/products/${productId}`),
    enabled: open && Boolean(productId),
    staleTime: 0,
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTouched(false);
    if (!productId) setForm({ ...emptyForm(), ...prefillRef.current });
    else if (detail.data) setForm(formFrom(detail.data));
  }, [open, productId, detail.data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const problems = useMemo(() => {
    const p: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) p.name = t("validation.required");
    if (!form.taxCategoryId) p.taxCategoryId = t("validation.required");
    if (!form.baseUnitId) p.baseUnitId = t("validation.required");
    if (form.hsnCode && !HSN.test(form.hsnCode)) p.hsnCode = t("validation.hsn");
    for (const k of ["purchasePrice", "sellingPrice", "mrp", "openingCost"] as const) if (form[k] && !RATE.test(form[k])) p[k] = t("validation.amount");
    for (const k of ["minStock", "reorderQty", "openingStock"] as const) if (form[k] && !QTY.test(form[k])) p[k] = t("validation.amount");
    if (form.caseUnitId && (!QTY.test(form.caseFactor) || Number(form.caseFactor) <= 0)) p.caseFactor = t("validation.amount");
    if (form.caseUnitId && form.caseUnitId === form.baseUnitId) p.caseUnitId = t("errors.ALT_UNIT_IS_BASE_UNIT");
    if (form.brandId === NEW && !form.newBrand.trim()) p.brandId = t("validation.required");
    if (form.categoryId === NEW && !form.newCategory.trim()) p.categoryId = t("validation.required");
    for (const l of levels) if (form.levelPrices[l.id] && !RATE.test(form.levelPrices[l.id]!)) p.levelPrices = t("validation.amount");
    return p;
  }, [form, t, levels]);
  const show = (k: keyof Form) => (touched ? problems[k] : undefined) ?? fieldError(k) ?? undefined;

  /** The product body the API expects, from the form (and the loaded product, so untouched units and prices survive). */
  const build = async () => {
    let brandId: string | null = form.brandId || null;
    if (form.brandId === NEW) brandId = (await api.post<{ id: string }>("/brands", { name: form.newBrand.trim() })).id;
    let categoryId: string | null = form.categoryId || null;
    if (form.categoryId === NEW) categoryId = (await api.post<{ id: string }>("/categories", { name: form.newCategory.trim() })).id;
    const loaded = detail.data;
    const units = [
      ...(form.caseUnitId
        ? [{ unitId: form.caseUnitId, conversionFactor: form.caseFactor, isDefaultSale: loaded?.units[0]?.isDefaultSale ?? false, isDefaultPurchase: loaded?.units[0]?.isDefaultPurchase ?? true }]
        : []),
      ...(loaded?.units.slice(1).filter((u) => u.unitId !== form.caseUnitId && u.unitId !== form.baseUnitId) ?? []),
    ].map(({ unitId, conversionFactor, isDefaultSale, isDefaultPurchase }) => ({ unitId, conversionFactor: num(conversionFactor), isDefaultSale, isDefaultPurchase }));
    const unitIds = new Set([form.baseUnitId, ...units.map((u) => u.unitId)]);
    const editable = new Set(levels.map((l) => l.id));
    const prices = [
      ...(loaded?.prices ?? []).filter((x) => !(x.unitId === form.baseUnitId && editable.has(x.priceLevelId)) && unitIds.has(x.unitId)),
      ...levels
        .filter((l) => form.levelPrices[l.id])
        .map((l) => ({
          priceLevelId: l.id,
          unitId: form.baseUnitId,
          price: form.levelPrices[l.id]!,
          discountPercent: loaded?.prices.find((x) => x.priceLevelId === l.id && x.unitId === form.baseUnitId)?.discountPercent ?? "0",
        })),
    ]
      .map((x) => ({ priceLevelId: x.priceLevelId, unitId: x.unitId, price: num(x.price), discountPercent: num(x.discountPercent) || "0" }))
      .sort(byPriceKey);
    return {
      name: form.name.trim(),
      nameLocal: form.nameLocal.trim(),
      aliases: list(form.aliases),
      hsnCode: form.hsnCode || undefined,
      taxCategoryId: form.taxCategoryId,
      brandId,
      categoryId,
      baseUnitId: form.baseUnitId,
      packSize: form.packSize.trim(),
      ...(canCost ? { purchasePrice: form.purchasePrice || "0" } : {}),
      sellingPrice: form.sellingPrice || "0",
      mrp: form.mrp || null,
      pricesIncludeTax: form.pricesIncludeTax,
      minStock: form.minStock || null,
      reorderQty: form.reorderQty || null,
      trackBatches: form.trackBatches,
      trackExpiry: form.trackExpiry,
      isActive: form.isActive,
      barcodes: list(form.barcodes),
      units,
      prices,
    };
  };

  const save = async () => {
    setTouched(true);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setError(null);
    try {
      const body = await build();
      let saved: ProductDetail;
      if (!productId) {
        saved = await api.post<ProductDetail>("/products", {
          ...body,
          ...(form.code.trim() ? { code: form.code.trim() } : {}),
          ...(form.openingStock ? { openingStock: form.openingStock, ...(form.openingCost ? { openingStockCost: form.openingCost } : {}) } : {}),
        });
      } else {
        const loaded = detail.data!;
        const before: Record<string, unknown> = {
          ...formFrom(loaded),
          aliases: loaded.aliases ?? [],
          barcodes: loaded.barcodes.map((b) => b.barcode),
          units: loaded.units.map(({ unitId, conversionFactor, isDefaultSale, isDefaultPurchase }) => ({ unitId, conversionFactor: num(conversionFactor), isDefaultSale, isDefaultPurchase })),
          prices: loaded.prices
            .map((x) => ({ priceLevelId: x.priceLevelId, unitId: x.unitId, price: num(x.price), discountPercent: num(x.discountPercent) || "0" }))
            .sort(byPriceKey),
          brandId: loaded.brandId,
          categoryId: loaded.categoryId,
          mrp: loaded.mrp === null ? null : num(loaded.mrp),
          minStock: loaded.minStock === null ? null : num(loaded.minStock),
          reorderQty: loaded.reorderQty === null ? null : num(loaded.reorderQty),
          hsnCode: loaded.hsnCode ?? undefined,
          purchasePrice: num(loaded.purchasePrice) || "0",
          sellingPrice: num(loaded.sellingPrice) || "0",
        };
        const patch = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
        if (form.code.trim() && form.code.trim().toUpperCase() !== loaded.code) patch.code = form.code.trim();
        if (!canPrice) for (const k of ["purchasePrice", "sellingPrice", "mrp", "prices"]) delete patch[k];
        saved = Object.keys(patch).length ? await api.patch<ProductDetail>(`/products/${productId}`, patch) : loaded;
      }
      await refreshCatalog();
      toast({ tone: "success", title: t("product.saved"), body: `${saved.code} · ${saved.name}` });
      if (onSaved) onSaved(saved.id);
      else onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const loading = Boolean(productId) && detail.isPending;
  const stock = detail.data ? Number(detail.data.stock.total) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={productId ? t("product.edit") : t("product.add")}
      description={productId && detail.data ? `${detail.data.code} · ${t("product.currentStock")} ${stock}` : undefined}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || loading} onClick={() => void save()}>
            {busy ? t("invoice.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : detail.error ? (
        <ErrorNote error={detail.error} />
      ) : (
        <form className="flex flex-col gap-5" onSubmit={(e) => (e.preventDefault(), void save())}>
          {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label={t("product.name")} htmlFor="p-name" error={show("name")}>
                <Input id="p-name" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} invalid={Boolean(show("name"))} />
              </Field>
            </div>
            <Field label={t("product.nameLocal")} htmlFor="p-local" hint={t("common.optional")}>
              <Input id="p-local" lang="hi" value={form.nameLocal} onChange={(e) => set("nameLocal", e.target.value)} />
            </Field>
            <Field label={t("product.brand")} htmlFor="p-brand" error={show("brandId")}>
              <Select id="p-brand" value={form.brandId} onChange={(e) => set("brandId", e.target.value)}>
                <option value="">{t("common.none")}</option>
                {BRANDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                <option value={NEW}>+ {t("product.newBrand")}</option>
              </Select>
              {form.brandId === NEW && <Input aria-label={t("product.newBrand")} placeholder={t("product.newBrand")} value={form.newBrand} onChange={(e) => set("newBrand", e.target.value)} />}
            </Field>
            <Field label={t("product.category")} htmlFor="p-cat" error={show("categoryId")}>
              <Select id="p-cat" value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                <option value="">{t("common.none")}</option>
                {WORKSPACE.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={NEW}>+ {t("product.newCategory")}</option>
              </Select>
              {form.categoryId === NEW && (
                <Input aria-label={t("product.newCategory")} placeholder={t("product.newCategory")} value={form.newCategory} onChange={(e) => set("newCategory", e.target.value)} />
              )}
            </Field>
            <Field label={t("product.packSize")} htmlFor="p-pack" hint={t("product.packSizeHint")}>
              <Input id="p-pack" value={form.packSize} onChange={(e) => set("packSize", e.target.value)} />
            </Field>
            <Field label={t("product.taxCategory")} htmlFor="p-tax" error={show("taxCategoryId")} hint={t("product.taxCategoryHint")}>
              <Select id="p-tax" value={form.taxCategoryId} onChange={(e) => set("taxCategoryId", e.target.value)}>
                {WORKSPACE.taxCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("product.hsn")} htmlFor="p-hsn" error={show("hsnCode")} hint={t("product.hsnHint")}>
              <Input id="p-hsn" inputMode="numeric" maxLength={8} className="[&_input]:font-mono" value={form.hsnCode} onChange={(e) => set("hsnCode", e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field label={t("product.barcode")} htmlFor="p-barcode" hint={t("product.barcodeHint")} error={fieldError("barcodes")}>
              <Input id="p-barcode" className="[&_input]:font-mono" value={form.barcodes} onChange={(e) => set("barcodes", e.target.value)} />
            </Field>
            <Field label={t("product.aliases")} htmlFor="p-alias" hint={t("product.aliasesHint")}>
              <Input id="p-alias" value={form.aliases} onChange={(e) => set("aliases", e.target.value)} />
            </Field>
            <Field label={t("product.code")} htmlFor="p-code" hint={productId ? undefined : t("product.codeHint")} error={fieldError("code")}>
              <Input id="p-code" className="[&_input]:font-mono [&_input]:uppercase" maxLength={20} value={form.code} onChange={(e) => set("code", e.target.value)} />
            </Field>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("product.unitsAndStock")}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("product.baseUnit")} htmlFor="p-unit" error={show("baseUnitId")}>
                <Select id="p-unit" value={form.baseUnitId} onChange={(e) => set("baseUnitId", e.target.value)}>
                  {WORKSPACE.unitList.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.symbol} – {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("product.caseUnit")} htmlFor="p-case" error={show("caseUnitId")} hint={t("common.optional")}>
                <Select id="p-case" value={form.caseUnitId} onChange={(e) => set("caseUnitId", e.target.value)}>
                  <option value="">{t("common.none")}</option>
                  {WORKSPACE.unitList
                    .filter((u) => u.id !== form.baseUnitId)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.symbol} – {u.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={t("product.caseFactor", { unit: WORKSPACE.units.get(form.baseUnitId) ?? "" })} htmlFor="p-factor" error={show("caseFactor")}>
                <Input id="p-factor" inputMode="decimal" disabled={!form.caseUnitId} value={form.caseFactor} onChange={(e) => set("caseFactor", e.target.value.trim())} />
              </Field>
              <Field label={t("product.minStock")} htmlFor="p-min" error={show("minStock")} hint={t("product.minStockHint")}>
                <Input id="p-min" inputMode="decimal" value={form.minStock} onChange={(e) => set("minStock", e.target.value.trim())} />
              </Field>
              {!productId && (
                <>
                  <Field label={t("product.openingStock")} htmlFor="p-open" error={show("openingStock")} hint={t("product.openingStockHint")}>
                    <Input id="p-open" inputMode="decimal" value={form.openingStock} onChange={(e) => set("openingStock", e.target.value.trim())} />
                  </Field>
                  {canCost && (
                    <Field label={t("product.openingCost")} htmlFor="p-open-cost" error={show("openingCost")} hint={t("product.openingCostHint")}>
                      <Input id="p-open-cost" inputMode="decimal" leading={<span className="text-[13px]">₹</span>} value={form.openingCost} onChange={(e) => set("openingCost", e.target.value.trim())} />
                    </Field>
                  )}
                </>
              )}
              <Field label={t("product.reorderQty")} htmlFor="p-reorder" error={show("reorderQty")} hint={t("common.optional")}>
                <Input id="p-reorder" inputMode="decimal" value={form.reorderQty} onChange={(e) => set("reorderQty", e.target.value.trim())} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Checkbox label={t("product.batchTracking")} checked={form.trackBatches} onChange={(v) => set("trackBatches", v)} />
              <Checkbox label={t("product.expiryTracking")} checked={form.trackExpiry} onChange={(v) => set("trackExpiry", v)} />
              {productId && (
                <Checkbox label={t("product.activeHint")} checked={form.isActive} onChange={(v) => set("isActive", v)} />
              )}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("product.pricing")}</h3>
            {!canPrice && <p className="text-[13px] text-ink-3">{t("product.pricesLocked")}</p>}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {canCost && (
                <Field label={t("product.purchasePrice")} htmlFor="p-cost" error={show("purchasePrice")}>
                  <Input id="p-cost" inputMode="decimal" disabled={!canPrice} leading={<span className="text-[13px]">₹</span>} value={form.purchasePrice} onChange={(e) => set("purchasePrice", e.target.value.trim())} />
                </Field>
              )}
              <Field label={t("product.sellingPrice")} htmlFor="p-rate" error={show("sellingPrice")}>
                <Input id="p-rate" inputMode="decimal" disabled={!canPrice} leading={<span className="text-[13px]">₹</span>} value={form.sellingPrice} onChange={(e) => set("sellingPrice", e.target.value.trim())} />
              </Field>
              <Field label={t("product.mrp")} htmlFor="p-mrp" error={show("mrp")}>
                <Input id="p-mrp" inputMode="decimal" disabled={!canPrice} leading={<span className="text-[13px]">₹</span>} value={form.mrp} onChange={(e) => set("mrp", e.target.value.trim())} />
              </Field>
              {levels.map((l) => (
                <Field key={l.id} label={t("product.levelPrice", { level: l.name })} htmlFor={`p-level-${l.id}`} error={touched ? problems.levelPrices : undefined} hint={t("common.optional")}>
                  <Input
                    id={`p-level-${l.id}`}
                    inputMode="decimal"
                    disabled={!canPrice}
                    leading={<span className="text-[13px]">₹</span>}
                    value={form.levelPrices[l.id] ?? ""}
                    onChange={(e) => set("levelPrices", { ...form.levelPrices, [l.id]: e.target.value.trim() })}
                  />
                </Field>
              ))}
            </div>
            <Checkbox label={t("product.pricesIncludeTax")} disabled={!canPrice} checked={form.pricesIncludeTax} onChange={(v) => set("pricesIncludeTax", v)} />
          </section>
        </form>
      )}
    </Dialog>
  );
}
