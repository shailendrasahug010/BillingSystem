import type { SchemeView } from "@digitalbahi/contracts";
import { schemeRuleProblem } from "@digitalbahi/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Power, Save, Trash, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { SearchSelect, type SearchOption } from "../../components/ui/SearchSelect";
import { Segmented } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { allowed, BRANDS, PRODUCTS, productById, SUPPLIERS, TODAY, WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { api } from "../../lib/api";

interface SlabForm {
  from: string;
  freeQty: string;
  discountPercent: string;
  discountPerUnit: string;
}

interface Form {
  name: string;
  kind: "free_goods" | "discount";
  measure: "qty" | "value";
  productIds: string[];
  brandIds: string[];
  categoryIds: string[];
  slabs: SlabForm[];
  repeat: boolean;
  /** "" = each product bought, free on itself. */
  freeProductId: string;
  validFrom: string;
  validTo: string;
  customerCategoryIds: string[];
  priceLevelIds: string[];
  supplierId: string | null;
  reference: string;
  notes: string;
}

const EMPTY_SLAB: SlabForm = { from: "", freeQty: "", discountPercent: "", discountPerUnit: "" };

function formOf(s: SchemeView | null): Form {
  if (!s) {
    return {
      name: "",
      kind: "free_goods",
      measure: "qty",
      productIds: [],
      brandIds: [],
      categoryIds: [],
      slabs: [{ ...EMPTY_SLAB }],
      repeat: true,
      freeProductId: "",
      validFrom: TODAY,
      validTo: "",
      customerCategoryIds: [],
      priceLevelIds: [],
      supplierId: null,
      reference: "",
      notes: "",
    };
  }
  const plain = (v: string | null) => (v === null ? "" : String(Number(v)));
  return {
    name: s.name,
    kind: s.kind,
    measure: s.measure,
    productIds: s.productIds,
    brandIds: s.brandIds,
    categoryIds: s.categoryIds,
    slabs: s.slabs.map((x) => ({ from: plain(x.from), freeQty: plain(x.freeQty), discountPercent: plain(x.discountPercent), discountPerUnit: plain(x.discountPerUnit) })),
    repeat: s.repeat,
    freeProductId: s.freeProductId ?? "",
    validFrom: s.validFrom,
    validTo: s.validTo ?? "",
    customerCategoryIds: s.customerCategoryIds,
    priceLevelIds: s.priceLevelIds,
    supplierId: s.supplierId,
    reference: s.reference ?? "",
    notes: s.notes ?? "",
  };
}

const num = (v: string) => v.trim().replace(/,/g, "");

/** The form as POST /schemes takes it. */
function bodyOf(f: Form) {
  const slabs = f.slabs
    .filter((s) => num(s.from) !== "")
    .map((s) =>
      f.kind === "free_goods"
        ? { from: num(s.from), ...(num(s.freeQty) ? { freeQty: num(s.freeQty) } : {}) }
        : { from: num(s.from), ...(num(s.discountPercent) ? { discountPercent: num(s.discountPercent) } : {}), ...(num(s.discountPerUnit) ? { discountPerUnit: num(s.discountPerUnit) } : {}) },
    );
  return {
    name: f.name.trim(),
    kind: f.kind,
    measure: f.measure,
    productIds: f.productIds,
    brandIds: f.brandIds,
    categoryIds: f.categoryIds,
    slabs,
    repeat: f.kind === "free_goods" && f.repeat,
    freeProductId: f.kind === "free_goods" && f.freeProductId ? f.freeProductId : null,
    validFrom: f.validFrom,
    validTo: f.validTo || null,
    customerCategoryIds: f.customerCategoryIds,
    priceLevelIds: f.priceLevelIds,
    supplierId: f.supplierId,
    reference: f.reference.trim() || null,
    notes: f.notes.trim() || null,
  };
}

/** Chosen entries as chips, and a search to add more. */
function ChipPicker({ id, label, values, options, onChange, placeholder }: { id: string; label: string; values: string[]; options: Array<{ id: string; label: string; sub?: string }>; onChange(v: string[]): void; placeholder: string }) {
  const { t } = useI18n();
  const search = (q: string): SearchOption[] => {
    const query = q.trim().toLowerCase();
    return options
      .filter((o) => !values.includes(o.id) && (!query || o.label.toLowerCase().includes(query) || (o.sub ?? "").toLowerCase().includes(query)))
      .slice(0, 30)
      .map((o) => ({ id: o.id, label: o.label, ...(o.sub ? { sub: o.sub } : {}) }));
  };
  return (
    <Field label={label} htmlFor={id}>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-chips={id}>
          {values.map((v) => (
            <span key={v} className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-[12.5px] font-medium text-accent-ink">
              {options.find((o) => o.id === v)?.label ?? "?"}
              <button type="button" className="rounded-full p-0.5 hover:bg-surface" aria-label={`${t("common.remove")}: ${options.find((o) => o.id === v)?.label ?? ""}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchSelect id={id} value={null} onChange={(v) => v && onChange([...values, v])} search={search} placeholder={placeholder} clearLabel={t("common.clear")} emptyText={t("search.noResults")} />
    </Field>
  );
}

/**
 * A scheme as the company announced it: what it is on (products, brands or
 * categories), its slabs (free goods, or a discount), when it runs and for
 * whom, and the company that pays for it (whom the claim goes to).
 */
export function SchemeEditor({ scheme, open, onOpenChange }: { scheme: SchemeView | null; open: boolean; onOpenChange(v: boolean): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => formOf(scheme));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const canEdit = allowed("product.update_price");
  const customerCategories = useQuery({
    queryKey: ["customer-categories"],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string }> }>("/customer-categories").then((r) => r.data),
    enabled: open && allowed("customer.view"),
    staleTime: 60_000,
  });
  const done = async (title: string) => {
    toast({ tone: "success", title });
    await qc.invalidateQueries({ queryKey: ["schemes"] });
    // The bill screen gives what is running now.
    await refreshCatalog().catch(() => undefined);
    onOpenChange(false);
  };
  const save = useMutation({
    mutationFn: () => (scheme ? api.patch<SchemeView>(`/schemes/${scheme.id}`, bodyOf(form)) : api.post<SchemeView>("/schemes", bodyOf(form))),
    onSuccess: () => done(t("schemes.savedToast")),
  });
  const toggle = useMutation({
    mutationFn: () => api.patch<SchemeView>(`/schemes/${scheme!.id}`, { isActive: !scheme!.isActive }),
    onSuccess: (s) => done(s.isActive ? t("schemes.switchedOn") : t("schemes.switchedOff")),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/schemes/${scheme!.id}`),
    onSuccess: () => done(t("schemes.deleted")),
  });
  const fieldError = useFieldError(save.error);
  const body = bodyOf(form);
  const problem = schemeRuleProblem({ ...body, validTo: body.validTo });
  const ready = body.name.length >= 2 && body.validFrom !== "" && problem === null;
  const free = form.kind === "free_goods";
  const products = PRODUCTS.map((p) => ({ id: p.id, label: p.name, sub: [p.code, p.brand].filter(Boolean).join(" · ") }));
  const single = form.productIds.length === 1 && !form.brandIds.length && !form.categoryIds.length ? productById.get(form.productIds[0]!) : undefined;
  const unit = form.measure === "value" ? "₹" : (single?.unit ?? t("schemes.stockUnits"));
  const setSlab = (i: number, patch: Partial<SlabForm>) => set({ slabs: form.slabs.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={scheme ? scheme.name : t("schemes.new")}
      description={t("schemes.editorHint")}
      closeLabel={t("common.close")}
      footer={
        canEdit ? (
          <>
            {scheme && (
              <>
                <Button
                  variant="ghost"
                  className="mr-auto"
                  icon={<Power size={16} />}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate()}
                >
                  {scheme.isActive ? t("schemes.switchOff") : t("schemes.switchOn")}
                </Button>
                {scheme.bills === 0 && (
                  <Button
                    variant="ghost"
                    className="text-danger hover:text-danger"
                    icon={<Trash size={16} />}
                    disabled={remove.isPending}
                    onClick={async () => {
                      if (await confirm({ title: t("schemes.deleteTitle", { scheme: scheme.name }), body: t("schemes.deleteBody"), confirmLabel: t("common.delete") })) remove.mutate();
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                )}
              </>
            )}
            <Button variant="primary" icon={<Save size={16} />} disabled={!ready || save.isPending} onClick={() => save.mutate()}>
              {t("schemes.save")}
            </Button>
          </>
        ) : undefined
      }
    >
      <fieldset disabled={!canEdit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={t("schemes.name")} htmlFor="scheme-name" error={fieldError("name")}>
            <Input id="scheme-name" placeholder={t("schemes.namePlaceholder")} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t("schemes.kind")}>
            <Segmented
              label={t("schemes.kind")}
              value={form.kind}
              onChange={(kind) => set({ kind })}
              options={[
                { value: "free_goods", label: t("schemes.kinds.free_goods") },
                { value: "discount", label: t("schemes.kinds.discount") },
              ]}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ChipPicker id="scheme-products" label={t("schemes.onProducts")} values={form.productIds} options={products} onChange={(productIds) => set({ productIds })} placeholder={t("schemes.findProduct")} />
          <ChipPicker id="scheme-brands" label={t("schemes.onBrands")} values={form.brandIds} options={BRANDS.map((b) => ({ id: b.id, label: b.name }))} onChange={(brandIds) => set({ brandIds })} placeholder={t("schemes.findBrand")} />
          <ChipPicker id="scheme-categories" label={t("schemes.onCategories")} values={form.categoryIds} options={WORKSPACE.categories.map((c) => ({ id: c.id, label: c.name }))} onChange={(categoryIds) => set({ categoryIds })} placeholder={t("schemes.findCategory")} />
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-ink-2">{t("schemes.slabs")}</p>
            <Segmented
              size="sm"
              label={t("schemes.countedBy")}
              value={form.measure}
              onChange={(measure) => set({ measure })}
              options={[
                { value: "qty", label: t("schemes.measure.qty") },
                { value: "value", label: t("schemes.measure.value") },
              ]}
            />
          </div>
          {form.slabs.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" data-slab={i}>
              <Field label={t("schemes.from", { unit })} htmlFor={`scheme-from-${i}`}>
                <Input id={`scheme-from-${i}`} inputMode="decimal" value={s.from} onChange={(e) => setSlab(i, { from: e.target.value })} />
              </Field>
              {free ? (
                <Field label={t("schemes.freeQty")} htmlFor={`scheme-free-${i}`}>
                  <Input id={`scheme-free-${i}`} inputMode="decimal" value={s.freeQty} onChange={(e) => setSlab(i, { freeQty: e.target.value })} />
                </Field>
              ) : (
                <>
                  <Field label={t("schemes.percentOff")} htmlFor={`scheme-percent-${i}`}>
                    <Input id={`scheme-percent-${i}`} inputMode="decimal" value={s.discountPercent} onChange={(e) => setSlab(i, { discountPercent: e.target.value })} />
                  </Field>
                  <div className="hidden sm:block">
                    <Field label={t("schemes.perUnitOff")} htmlFor={`scheme-per-unit-${i}`}>
                      <Input id={`scheme-per-unit-${i}`} inputMode="decimal" value={s.discountPerUnit} onChange={(e) => setSlab(i, { discountPerUnit: e.target.value })} />
                    </Field>
                  </div>
                </>
              )}
              {free && <span className="hidden sm:block" />}
              <Button variant="ghost" className="mb-0.5" aria-label={t("schemes.removeSlab")} disabled={form.slabs.length === 1} onClick={() => set({ slabs: form.slabs.filter((_, j) => j !== i) })} icon={<X size={16} />} />
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} disabled={form.slabs.length >= 10} onClick={() => set({ slabs: [...form.slabs, { ...EMPTY_SLAB }] })}>
              {t("schemes.addSlab")}
            </Button>
            {free && <Checkbox label={t("schemes.repeat")} checked={form.repeat} onChange={(repeat) => set({ repeat })} />}
          </div>
          {free && (
            <Field label={t("schemes.freeProduct")} htmlFor="scheme-free-product" hint={form.freeProductId ? t("schemes.freeOtherHint") : t("schemes.freeSameHint")}>
              <Select id="scheme-free-product" value={form.freeProductId} onChange={(e) => set({ freeProductId: e.target.value })}>
                <option value="">{t("schemes.sameProduct")}</option>
                {PRODUCTS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("schemes.validFrom")} htmlFor="scheme-valid-from">
            <Input id="scheme-valid-from" type="date" value={form.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
          </Field>
          <Field label={t("schemes.validTo")} htmlFor="scheme-valid-to" hint={form.validTo ? undefined : t("schemes.noEnd")} error={fieldError("validTo")}>
            <Input id="scheme-valid-to" type="date" min={form.validFrom} value={form.validTo} onChange={(e) => set({ validTo: e.target.value })} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChipPicker
            id="scheme-customer-categories"
            label={t("schemes.forCategories")}
            values={form.customerCategoryIds}
            options={(customerCategories.data ?? []).map((c) => ({ id: c.id, label: c.name }))}
            onChange={(customerCategoryIds) => set({ customerCategoryIds })}
            placeholder={t("schemes.everyCustomer")}
          />
          <ChipPicker id="scheme-rate-lists" label={t("schemes.forRateLists")} values={form.priceLevelIds} options={WORKSPACE.priceLevels.map((l) => ({ id: l.id, label: l.name }))} onChange={(priceLevelIds) => set({ priceLevelIds })} placeholder={t("schemes.everyCustomer")} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("schemes.company")} htmlFor="scheme-supplier" hint={t("schemes.companyHint")}>
            <SearchSelect
              id="scheme-supplier"
              value={form.supplierId}
              onChange={(supplierId) => set({ supplierId })}
              selectedLabel={SUPPLIERS.find((x) => x.id === form.supplierId)?.name ?? scheme?.supplierName ?? ""}
              search={(q) =>
                SUPPLIERS.filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase()))
                  .slice(0, 20)
                  .map((x) => ({ id: x.id, label: x.name, ...(x.city ? { sub: x.city } : {}) }))
              }
              placeholder={t("schemes.findCompany")}
              clearLabel={t("common.clear")}
              emptyText={t("search.noResults")}
            />
          </Field>
          <Field label={t("schemes.reference")} htmlFor="scheme-reference">
            <Input id="scheme-reference" placeholder="HUL/SC/2610" value={form.reference} onChange={(e) => set({ reference: e.target.value })} />
          </Field>
        </div>
        <Field label={t("common.notes")} htmlFor="scheme-notes">
          <Input id="scheme-notes" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        {problem && body.slabs.length > 0 && <p className="text-[12.5px] text-warn">{t(`errors.${problem as "SCHEME_NO_PRODUCTS"}`)}</p>}
        <ErrorNote error={save.error ?? toggle.error ?? remove.error} />
      </fieldset>
    </Dialog>
  );
}
