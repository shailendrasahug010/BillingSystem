import { useQueryClient } from "@tanstack/react-query";
import {
  calculateDocument,
  compactName,
  DomainError,
  determineSupplyType,
  resolveTax,
  searchProducts,
  taxAt,
  type DocumentTotals,
  type PaymentMethod,
  type ResolvedTax,
} from "@digitalbahi/core";
import { translateError } from "@digitalbahi/i18n";
import { FileSpreadsheet, PackagePlus, Plus, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/misc";
import { BackButton, ErrorNote, PageHeader, useFieldError } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS, productById, supplierById, TODAY, WORKSPACE } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { refreshCatalog, refreshSupplier } from "../../data/live";
import { useStoreVersion } from "../../data/store";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { offlineScope, queueEntry, unreachable, workingOffline } from "../../offline/sync";
import { cn } from "../../lib/cn";
import { invalidateMoney, METHODS } from "../payments/PaymentDialog";
import { ProductEditor, type ProductPrefill } from "../products/ProductEditor";
import { searchSuppliers, supplierLabel } from "../suppliers/search";
import { SupplierDialog } from "../suppliers/SupplierDialog";
import { lineFromItem, newProductFrom, type ImportedItem, type PurchaseDraft } from "./billImport";
import { NewProductsDialog } from "./NewProductsDialog";
import { uuid } from "../../lib/uuid";

interface Line {
  key: string;
  productId: string;
  unitId: string;
  qty: string;
  freeQty: string;
  rate: string;
  discountPercent: string;
  gstRate: string;
  batchNumber: string;
  expiryDate: string;
  mfgDate: string;
  mrp: string;
  /** From an imported bill: how the supplier names the item, and its row in their file. */
  supplierItem?: { code?: string; name?: string };
  fileRow?: number;
}

interface Charge {
  key: string;
  label: string;
  amount: string;
  gstRate: string;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const RATE = /^\d{1,11}(\.\d{1,4})?$/;
const PCT = /^\d{1,3}(\.\d{1,3})?$/;
const MONEY = /^\d{1,13}(\.\d{1,2})?$/;
/** Suppliers whose bills carry GST (composition / unregistered suppliers charge none). */
const CHARGES_GST = new Set(["regular", "sez", "deemed_export"]);
const trim = (n: number, d = 4) => String(Math.round(n * 10 ** d) / 10 ** d);
const compactDiffers = (a: string, b: string) => compactName(a) !== compactName(b);
/** Imported lines stay in the bill's order; lines added by hand go after them. */
const byFileRow = (a: Line, b: Line) => (a.fileRow ?? Infinity) - (b.fileRow ?? Infinity);

/** A new product's details from the supplier's bill line. */
function prefillFrom(item: ImportedItem): ProductPrefill {
  const g = newProductFrom(item);
  return {
    name: g.name,
    ...(g.hsnCode ? { hsnCode: g.hsnCode } : {}),
    ...(g.taxCategoryId ? { taxCategoryId: g.taxCategoryId } : {}),
    ...(g.baseUnitId ? { baseUnitId: g.baseUnitId } : {}),
    ...(g.purchasePrice ? { purchasePrice: g.purchasePrice } : {}),
    ...(g.mrp ? { mrp: g.mrp } : {}),
    ...(g.barcode ? { barcodes: g.barcode } : {}),
    trackBatches: g.trackBatches,
    trackExpiry: g.trackExpiry,
  };
}

/**
 * Purchase bill entry: copy the supplier's bill line by line. Stock comes in
 * (with batch / expiry where the product tracks them), the landed cost moves
 * the average cost, the supplier's payable goes up and the inward GST is
 * recorded for ITC. Totals use the same calculator as the server, so what is
 * shown is what gets posted.
 */
export function PurchaseEntryPage({ supplierId: initialSupplier, draft }: { supplierId?: string; draft?: PurchaseDraft }) {
  const i18n = useI18n();
  const { t, money, number } = i18n;
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  useStoreVersion();
  const searchable = useSearchableProducts();
  const [supplierId, setSupplierId] = useState<string | null>(draft?.supplierId ?? initialSupplier ?? null);
  const [head, setHead] = useState(() => ({
    billNumber: draft?.billNumber.slice(0, 30) ?? "",
    billDate: draft?.billDate && draft.billDate <= TODAY ? draft.billDate : TODAY,
    receivedDate: TODAY,
    itc: "eligible",
    reverseCharge: false,
    notes: "",
  }));
  // An imported bill: lines whose product was found go straight in; the rest wait to be matched.
  const [lines, setLines] = useState<Line[]>(() =>
    (draft?.items ?? []).flatMap((item) => {
      const p = item.productId ? productById.get(item.productId) : undefined;
      return p ? [{ key: item.key, ...lineFromItem(item, p) }] : [];
    }),
  );
  const [pending, setPending] = useState<ImportedItem[]>(() => (draft?.items ?? []).filter((item) => !item.productId || !productById.has(item.productId)));
  const matchedAtOpen = useRef(draft ? draft.items.length - pending.length : 0);
  const [creating, setCreating] = useState<ImportedItem | null>(null);
  // A product or supplier not in the lists yet, added from here: what is known of it.
  const [newProduct, setNewProduct] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState<{ name?: string; gstin?: string } | null>(null);
  const [addingAll, setAddingAll] = useState(false);
  const [charges, setCharges] = useState<Charge[]>([]);
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState(() => godowns.find((w) => w.isDefault)?.id ?? "");
  const [paid, setPaid] = useState({ amount: "", method: "cash" as PaymentMethod, reference: "" });
  const [key] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const fieldError = useFieldError(error);
  const supplier = supplierId ? supplierById.get(supplierId) : undefined;

  const setLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const addProduct = (productId: string) => {
    const p = productById.get(productId);
    if (!p) return;
    const existing = lines.find((l) => l.productId === productId && !p.trackBatches);
    if (existing) {
      setLine(existing.key, { qty: trim(Number(existing.qty || 0) + 1, 3) });
      return;
    }
    // Buy in the product's purchase pack when it has one (cases), else the stock unit.
    const pack = p.packUnits?.[0];
    const factor = pack?.factor ?? 1;
    setLines((ls) => [
      ...ls,
      {
        key: uuid(),
        productId,
        unitId: pack?.unitId ?? p.unitId ?? "",
        qty: "1",
        freeQty: "",
        rate: p.purchasePrice ? trim(p.purchasePrice * factor) : "",
        discountPercent: "",
        gstRate: "",
        batchNumber: "",
        expiryDate: "",
        mfgDate: "",
        mrp: "",
      },
    ]);
  };

  /** Match a waiting bill line to one of our products. */
  const matchItem = (item: ImportedItem, productId: string) => {
    const p = productById.get(productId);
    if (!p) return;
    setPending((ps) => ps.filter((x) => x.key !== item.key));
    setLines((ls) => [...ls, { key: item.key, ...lineFromItem(item, p) }].sort(byFileRow));
  };

  const supplyType = supplier ? determineSupplyType({ supplierStateCode: supplier.stateCode, placeOfSupplyStateCode: BUSINESS.stateCode, recipientRegistration: "regular" }) : "intra_state";
  const chargesGst = supplier ? CHARGES_GST.has(supplier.gstRegistration) : true;

  const lineProblems = (l: Line): string | null => {
    const p = productById.get(l.productId);
    if (!QTY.test(l.qty) || Number(l.qty) <= 0) return t("validation.positive");
    if (l.freeQty && !QTY.test(l.freeQty)) return t("validation.amount");
    if (!RATE.test(l.rate)) return t("validation.amount");
    if (l.discountPercent && (!PCT.test(l.discountPercent) || Number(l.discountPercent) > 100)) return t("errors.DISCOUNT_PERCENT_RANGE");
    if (l.gstRate && (!PCT.test(l.gstRate) || Number(l.gstRate) > 100)) return t("validation.amount");
    if (p?.trackBatches && !l.batchNumber.trim()) return t("errors.BATCH_REQUIRED", { product: p.name });
    if (p?.trackExpiry && !l.expiryDate) return t("errors.EXPIRY_REQUIRED", { product: p.name });
    return null;
  };

  const calc = useMemo((): { totals: DocumentTotals | null; error: unknown; taxes: Map<string, ResolvedTax> } => {
    const taxes = new Map<string, ResolvedTax>();
    const valid = lines.filter((l) => QTY.test(l.qty) && Number(l.qty) > 0 && RATE.test(l.rate));
    if (!valid.length) return { totals: null, error: null, taxes };
    try {
      const engine = valid.map((l) => {
        const p = productById.get(l.productId)!;
        const factor = l.unitId && l.unitId !== p.unitId ? (p.packUnits?.find((u) => u.unitId === l.unitId)?.factor ?? 1) : 1;
        const tax = l.gstRate && PCT.test(l.gstRate) ? taxAt(l.gstRate) : resolveTax(p.taxCategory, { date: head.billDate });
        taxes.set(l.key, tax);
        return {
          key: l.key,
          qty: l.qty,
          rate: l.rate,
          discountPercent: l.discountPercent && PCT.test(l.discountPercent) ? l.discountPercent : "0",
          discountAmount: "0",
          conversionFactor: factor,
          tax,
          hsnCode: p.hsn || null,
          uqc: p.uqc,
        };
      });
      const totals = calculateDocument({
        lines: engine,
        supplyType,
        chargeTax: chargesGst && !head.reverseCharge,
        charges: charges
          .filter((c) => MONEY.test(c.amount) && Number(c.amount) > 0)
          .map((c, i) => ({ key: `C${i + 1}`, label: c.label || t("purchase.charge"), amount: c.amount, tax: c.gstRate && Number(c.gstRate) > 0 ? taxAt(c.gstRate) : null })),
        roundOff: WORKSPACE.roundOff,
        amountPaid: MONEY.test(paid.amount) ? paid.amount : "0",
      });
      return { totals, error: null, taxes };
    } catch (e) {
      return { totals: null, error: e, taxes };
    }
  }, [lines, charges, paid.amount, head.billDate, head.reverseCharge, supplyType, chargesGst, t]);

  const headProblems = {
    supplierId: supplierId ? null : t("validation.required"),
    supplierInvoiceNumber: head.billNumber.trim() ? null : t("validation.required"),
    supplierInvoiceDate: head.billDate > TODAY ? t("errors.FUTURE_DATE_NOT_ALLOWED") : head.billDate > head.receivedDate ? t("errors.BILL_AFTER_RECEIPT") : null,
    receivedDate: head.receivedDate > TODAY ? t("errors.FUTURE_DATE_NOT_ALLOWED") : null,
    lines: pending.length ? t("billImport.unmatchedLeft", { count: pending.length }) : lines.length ? null : t("purchase.noLines"),
    payment: paid.amount && !MONEY.test(paid.amount) ? t("validation.amount") : null,
  };
  const showHead = (k: keyof typeof headProblems) => (touched ? headProblems[k] : null) ?? fieldError(k);
  const invalid = Object.values(headProblems).some(Boolean) || lines.some((l) => lineProblems(l)) || !calc.totals;

  const save = async () => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    const body = {
      supplierId,
      supplierInvoiceNumber: head.billNumber.trim(),
      supplierInvoiceDate: head.billDate,
      receivedDate: head.receivedDate,
      itcEligibility: head.itc,
      ...(godowns.length > 1 && warehouseId ? { warehouseId } : {}),
      isReverseCharge: head.reverseCharge,
      lines: lines.map((l) => {
        const p = productById.get(l.productId)!;
        return {
          productId: l.productId,
          ...(l.unitId && l.unitId !== p.unitId ? { unitId: l.unitId } : {}),
          qty: l.qty,
          ...(l.freeQty && Number(l.freeQty) > 0 ? { freeQty: l.freeQty } : {}),
          rate: l.rate,
          ...(l.discountPercent ? { discountPercent: l.discountPercent } : {}),
          ...(l.gstRate ? { gstRate: l.gstRate } : {}),
          ...(l.batchNumber.trim() ? { batchNumber: l.batchNumber.trim() } : {}),
          ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}),
          ...(l.mfgDate && l.batchNumber.trim() ? { mfgDate: l.mfgDate } : {}),
          ...(l.mrp && RATE.test(l.mrp) ? { mrp: l.mrp } : {}),
          ...(l.supplierItem ? { supplierItem: l.supplierItem } : {}),
        };
      }),
      charges: charges
        .filter((c) => MONEY.test(c.amount) && Number(c.amount) > 0)
        .map((c) => ({ label: c.label.trim() || t("purchase.charge"), amount: c.amount, ...(c.gstRate && Number(c.gstRate) > 0 ? { gstRate: c.gstRate } : {}) })),
      ...(paid.amount && Number(paid.amount) > 0 ? { payment: { amount: paid.amount, method: paid.method, ...(paid.reference.trim() ? { reference: paid.reference.trim() } : {}) } } : {}),
      ...(head.notes.trim() ? { notes: head.notes.trim() } : {}),
      clientTotals: { grandTotal: calc.totals!.grandTotal.toFixed(2) },
    };
    /** Kept on this device with the same key; stock comes in and the supplier is owed at once. */
    const keep = async () => {
      const scope = offlineScope();
      const kept =
        scope &&
        (await queueEntry({
          kind: "purchase",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          supplierId: supplierId!,
          supplierName: supplier ? supplierLabel(supplier) : "",
          billNumber: head.billNumber.trim(),
          date: head.receivedDate,
          total: Number(calc.totals!.grandTotal.toFixed(2)),
          paid: paid.amount && MONEY.test(paid.amount) ? Number(paid.amount) : 0,
          lineCount: lines.length,
          stock: lines.map((l) => {
            const p = productById.get(l.productId)!;
            const factor = l.unitId && l.unitId !== p.unitId ? (p.packUnits?.find((u) => u.unitId === l.unitId)?.factor ?? 1) : 1;
            return { productId: l.productId, qty: Math.round((Number(l.qty) + (Number(l.freeQty) || 0)) * factor * 1000) / 1000 };
          }),
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("purchase.saved")} · ${money(calc.totals!.grandTotal.toFixed(2))} · ${t("offline.sendsLater")}` });
      navigate({ name: "planned", module: "purchases" });
    };
    try {
      if (workingOffline()) return await keep();
      const res = await api.post<{ id: string; purchaseNumber: string; grandTotal: string }>(
        "/purchases",
        body,
        { idempotencyKey: key },
      );
      await Promise.all([refreshCatalog(), refreshSupplier(supplierId!)]).catch(() => undefined);
      invalidateMoney(qc);
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("purchase.saved"), body: `${res.purchaseNumber} · ${money(res.grandTotal)}` });
      navigate({ name: "purchase-view", purchaseId: res.id });
    } catch (e) {
      if (unreachable(e)) {
        await keep().catch((err: unknown) => setError(err instanceof ApiError ? err : new ApiError(0, "generic")));
        return;
      }
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const tot = calc.totals;
  const draftMatch = useMemo(() => new Map((draft?.items ?? []).filter((i) => i.matchedBy).map((i) => [i.key, i.matchedBy!])), [draft]);
  const lineResult = (k: string) => tot?.lines.find((x) => x.key === k);

  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-0">
      <PageHeader back={<BackButton onClick={() => navigate({ name: "planned", module: "purchases" })} />} title={t("purchase.new")} subtitle={t("purchase.newHint")} />
      {error instanceof ApiError && !error.field?.startsWith("supplier") ? <ErrorNote error={error} /> : null}

      {draft && (
        <div className="flex gap-3 rounded-xl border border-info/30 bg-info-soft px-4 py-3 text-[13.5px]" role="status">
          <FileSpreadsheet size={18} className="mt-0.5 shrink-0 text-info" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-ink">
              {t("billImport.importedFrom", { file: draft.fileName })} · {t("billImport.matchedCount", { matched: matchedAtOpen.current, count: draft.items.length })}
            </p>
            {draft.scanned && <p className="font-medium text-warn">{t("billImport.fromPhoto")}</p>}
            <p className="text-ink-2">{t("billImport.reviewHint")}</p>
            {!draft.supplierId && draft.supplierHint && !supplier && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-warn">{t("billImport.supplierNotFound", { value: draft.supplierHint })}</p>
                {allowed("supplier.create") && draft.supplierFromBill && (
                  <Button size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => setNewSupplier(draft.supplierFromBill!)}>
                    {t("billImport.addSupplier")}
                  </Button>
                )}
              </div>
            )}
            {draft.duplicate && (
              <p className="font-medium text-danger" role="alert">
                {t("billImport.duplicate", { number: draft.billNumber, ours: draft.duplicate.purchaseNumber ?? "" })}
              </p>
            )}
          </div>
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Field label={t("supplier.name")} htmlFor="pu-supplier" error={showHead("supplierId")}>
              <SearchSelect
                id="pu-supplier"
                autoFocus={!initialSupplier}
                value={supplierId}
                onChange={setSupplierId}
                invalid={Boolean(showHead("supplierId"))}
                placeholder={t("supplier.search")}
                clearLabel={t("common.clear")}
                emptyText={t("search.noResults")}
                selectedLabel={supplier ? `${supplierLabel(supplier)} · ${supplier.code}` : null}
                search={(q) => searchSuppliers(q).map((s) => ({ id: s.id, label: supplierLabel(s), sub: [s.code, s.city, s.gstin].filter(Boolean).join(" · ") }))}
                {...(allowed("supplier.create") ? { create: { label: (q: string) => t("purchase.addNewSupplier", { name: q }), onCreate: (q: string) => setNewSupplier({ name: q }) } } : {})}
              />
              {!supplier && draft && draft.supplierCandidates.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
                  {t("billImport.closeMatches")}
                  {draft.supplierCandidates.map((c) => (
                    <Button key={c.id} size="sm" variant="soft" onClick={() => setSupplierId(c.id)}>
                      {c.name}
                      {c.city ? ` · ${c.city}` : ""}
                    </Button>
                  ))}
                </div>
              )}
              {supplier && (
                <p className="text-[12.5px] text-ink-3">
                  {supplyType === "inter_state" ? t("gst.interState") : t("gst.intraState")} · {chargesGst ? (supplier.gstin ?? "") : t(`supplier.registration.${supplier.gstRegistration === "composition" ? "composition" : "unregistered"}`)}
                </p>
              )}
            </Field>
          </div>
          <Field label={t("purchase.billNumber")} htmlFor="pu-bill" error={showHead("supplierInvoiceNumber")}>
            <Input id="pu-bill" autoFocus={Boolean(initialSupplier)} maxLength={30} value={head.billNumber} onChange={(e) => setHead((h) => ({ ...h, billNumber: e.target.value }))} invalid={Boolean(showHead("supplierInvoiceNumber"))} />
          </Field>
          <Field label={t("purchase.billDate")} htmlFor="pu-date" error={showHead("supplierInvoiceDate")}>
            <Input id="pu-date" type="date" max={TODAY} value={head.billDate} onChange={(e) => setHead((h) => ({ ...h, billDate: e.target.value }))} />
          </Field>
          <Field label={t("purchase.receivedDate")} htmlFor="pu-recv" error={showHead("receivedDate")}>
            <Input id="pu-recv" type="date" max={TODAY} value={head.receivedDate} onChange={(e) => setHead((h) => ({ ...h, receivedDate: e.target.value }))} />
          </Field>
          <Field label={t("purchase.itc")} htmlFor="pu-itc">
            <Select id="pu-itc" value={head.itc} onChange={(e) => setHead((h) => ({ ...h, itc: e.target.value }))}>
              {(["eligible", "ineligible", "capital_goods", "input_services"] as const).map((x) => (
                <option key={x} value={x}>
                  {t(`purchase.itcOptions.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          {godowns.length > 1 && (
            <Field label={t("godowns.godown")} htmlFor="pu-godown">
              <Select id="pu-godown" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {godowns.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex items-end pb-2 sm:col-span-2">
            <Checkbox label={t("purchase.reverseCharge")} checked={head.reverseCharge} onChange={(v) => setHead((h) => ({ ...h, reverseCharge: v }))} />
          </div>
        </div>
      </Card>

      {pending.length > 0 && (
        <Card className="border-warn/40">
          <CardHeader
            title={t("billImport.toMatch", { count: pending.length })}
            subtitle={t("billImport.toMatchHint")}
            action={
              allowed("product.create") ? (
                <Button variant="primary" size="sm" icon={<PackagePlus size={14} />} onClick={() => setAddingAll(true)}>
                  {t("billImport.addAllNew", { count: pending.length })}
                </Button>
              ) : undefined
            }
          />
          <ul className="flex flex-col divide-y divide-line">
            {pending.map((item) => {
              const f = item.file;
              return (
                <li key={item.key} className="grid grid-cols-1 gap-3 px-4 py-3 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
                  <div className="min-w-0">
                    <p className="font-medium break-words text-ink">{f.itemName}</p>
                    <p className="num text-[12.5px] text-ink-3">
                      {[f.itemCode, f.barcode, f.hsnCode && `HSN ${f.hsnCode}`].filter(Boolean).join(" · ")}
                      {(f.itemCode || f.barcode || f.hsnCode) && " · "}
                      {number(f.qty)} {f.unit ?? ""}
                      {f.rate && ` × ${money(Number(f.rate))}`}
                      {f.gstRate !== null && ` · GST ${f.gstRate}%`}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <SearchSelect
                          value={null}
                          onChange={(id) => id && matchItem(item, id)}
                          placeholder={t("billImport.pickProduct")}
                          clearLabel={t("common.clear")}
                          emptyText={t("empty.products")}
                          search={(q) =>
                            (q.trim() ? searchProducts(q, searchable, { limit: 8 }).map((h) => h.product) : []).map((p) => ({
                              id: p.id,
                              label: p.name,
                              sub: [p.code, p.brand, p.packSize].filter(Boolean).join(" · "),
                            }))
                          }
                        />
                      </div>
                      {allowed("product.create") && (
                        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(item)}>
                          {t("billImport.newProduct")}
                        </Button>
                      )}
                      <IconButton label={t("billImport.leaveOut", { item: f.itemName })} onClick={() => setPending((ps) => ps.filter((x) => x.key !== item.key))}>
                        <X size={16} />
                      </IconButton>
                    </div>
                    {item.candidates.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
                        {t("billImport.closeMatches")}
                        {item.candidates
                          .filter((c) => productById.has(c.productId))
                          .map((c) => (
                            <Button key={c.productId} size="sm" variant="soft" onClick={() => matchItem(item, c.productId)}>
                              {c.name}
                            </Button>
                          ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title={t("invoice.items")} subtitle={lines.length ? t("common.items", { count: lines.length }) : undefined} />
        <div className="p-4 sm:px-5">
          <SearchSelect
            value={null}
            onChange={(id) => id && addProduct(id)}
            placeholder={t("invoice.searchProduct")}
            clearLabel={t("common.clear")}
            emptyText={t("empty.products")}
            {...(allowed("product.create") ? { create: { label: (q: string) => t("purchase.addNewProduct", { name: q }), onCreate: setNewProduct } } : {})}
            search={(q) =>
              (q.trim() ? searchProducts(q, searchable, { limit: 8 }).map((h) => h.product) : []).map((p) => ({
                id: p.id,
                label: p.name,
                sub: [p.code, p.brand, p.packSize].filter(Boolean).join(" · "),
                trailing: `${number(p.stock)} ${p.unit}`,
              }))
            }
          />
          {touched && headProblems.lines && (
            <p className="mt-2 text-[12px] text-danger" role="alert">
              {headProblems.lines}
            </p>
          )}
        </div>
        {lines.length === 0 ? (
          <EmptyState title={t("purchase.noLines")} hint={t("purchase.noLinesHint")} />
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead>
                <tr className="border-y border-line bg-surface-2 text-left text-[12px] text-ink-3">
                  <th className="py-2 pl-4 font-medium">{t("invoice.product")}</th>
                  <th className="py-2 pl-2 font-medium">{t("invoice.unit")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.qty")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.free")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.rate")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.discount")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.gstRate")} %</th>
                  <th className="py-2 pl-2 font-medium">{t("invoice.batch")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.amount")}</th>
                  <th className="py-2 pr-4 pl-2" />
                </tr>
              </thead>
              <tbody className="num">
                {lines.map((l) => {
                  const p = productById.get(l.productId)!;
                  const problem = touched ? lineProblems(l) : null;
                  const r = lineResult(l.key);
                  const resolved = calc.taxes.get(l.key);
                  const matchedBy = draftMatch.get(l.key);
                  const units = [{ unitId: p.unitId ?? "", symbol: p.unit, factor: 1 }, ...(p.packUnits ?? [])];
                  return (
                    <tr key={l.key} className={cn("border-b border-line align-top", problem && "bg-danger-soft/40")}>
                      <td className="py-2 pl-4">
                        <p className="font-medium text-ink">{p.name}</p>
                        <p className="text-[12px] text-ink-3">
                          {p.code}
                          {p.hsn && ` · HSN ${p.hsn}`}
                        </p>
                        {l.supplierItem?.name && compactDiffers(l.supplierItem.name, p.name) && (
                          <p className="max-w-64 truncate text-[12px] text-ink-3" title={l.supplierItem.name}>
                            {t("billImport.onBill")}: {l.supplierItem.name}
                          </p>
                        )}
                        {matchedBy && <Badge tone="neutral">{t(`billImport.matchedBy.${matchedBy}`)}</Badge>}
                        {problem && (
                          <p className="text-[12px] text-danger" role="alert">
                            {problem}
                          </p>
                        )}
                      </td>
                      <td className="py-2 pl-2">
                        <Select aria-label={t("invoice.unit")} className="h-8 w-auto min-w-24 px-2 text-[13px]" value={l.unitId} onChange={(e) => setLine(l.key, { unitId: e.target.value })}>
                          {units.map((u) => (
                            <option key={u.unitId} value={u.unitId}>
                              {u.symbol}
                              {u.factor !== 1 ? ` (${u.factor})` : ""}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={t("invoice.qty")} className="ml-auto w-20 [&_input]:text-right" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.trim() })} />
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={t("invoice.free")} className="ml-auto w-16 [&_input]:text-right" value={l.freeQty} onChange={(e) => setLine(l.key, { freeQty: e.target.value.trim() })} />
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={t("invoice.rate")} className="ml-auto w-24 [&_input]:text-right" value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value.trim() })} />
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={t("invoice.discount")} className="ml-auto w-16 [&_input]:text-right" value={l.discountPercent} onChange={(e) => setLine(l.key, { discountPercent: e.target.value.trim() })} />
                      </td>
                      <td className="py-2 pl-2">
                        <Input
                          inputSize="sm"
                          inputMode="decimal"
                          aria-label={t("invoice.gstRate")}
                          title={t("purchase.gstOverrideHint")}
                          placeholder={resolved ? resolved.gstRate.toString() : ""}
                          className="ml-auto w-16 [&_input]:text-right"
                          value={l.gstRate}
                          onChange={(e) => setLine(l.key, { gstRate: e.target.value.trim() })}
                        />
                      </td>
                      <td className="py-2 pl-2">
                        {p.trackBatches || p.trackExpiry ? (
                          <div className="flex flex-col gap-1">
                            {p.trackBatches && <Input inputSize="sm" aria-label={t("invoice.batch")} placeholder={t("invoice.batch")} className="w-28" value={l.batchNumber} onChange={(e) => setLine(l.key, { batchNumber: e.target.value })} />}
                            {p.trackExpiry && <Input inputSize="sm" type="date" aria-label={t("invoice.expiry")} className="w-36" value={l.expiryDate} onChange={(e) => setLine(l.key, { expiryDate: e.target.value })} />}
                          </div>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="py-2 pl-2 text-right">
                        <p className="font-medium text-ink">{r ? money(r.total.toNumber()) : "—"}</p>
                        {r && <p className="text-[11.5px] text-ink-3">{money(r.taxable.toNumber())} + {money(r.taxTotal.toNumber())}</p>}
                      </td>
                      <td className="py-2 pr-4 pl-2 text-right">
                        <IconButton label={t("invoice.remove")} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                          <Trash2 size={16} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-4">
          <Card className="p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-ink">{t("purchase.charges")}</h2>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setCharges((cs) => [...cs, { key: uuid(), label: t("purchase.freight"), amount: "", gstRate: "" }])}>
                {t("purchase.addCharge")}
              </Button>
            </div>
            {charges.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("purchase.chargesHint")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {charges.map((c) => (
                  <div key={c.key} className="flex flex-wrap items-center gap-2">
                    <Input inputSize="sm" aria-label={t("common.name")} className="min-w-40 flex-1" value={c.label} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)))} />
                    <Input inputSize="sm" inputMode="decimal" aria-label={t("common.amount")} placeholder={t("common.amount")} className="w-28 [&_input]:text-right" value={c.amount} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, amount: e.target.value.trim() } : x)))} />
                    <Input inputSize="sm" inputMode="decimal" aria-label={t("invoice.gstRate")} placeholder="GST %" className="w-20 [&_input]:text-right" value={c.gstRate} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, gstRate: e.target.value.trim() } : x)))} />
                    <IconButton label={t("invoice.remove")} onClick={() => setCharges((cs) => cs.filter((x) => x.key !== c.key))}>
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-4 sm:p-5">
            <h2 className="mb-3 text-[16px] font-semibold text-ink">{t("purchase.paidNow")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("common.amount")} htmlFor="pu-paid" error={showHead("payment")}>
                <Input id="pu-paid" inputMode="decimal" leading={<span className="text-[13px]">₹</span>} value={paid.amount} onChange={(e) => setPaid((x) => ({ ...x, amount: e.target.value.trim() }))} />
              </Field>
              <Field label={t("common.method")} htmlFor="pu-method">
                <Select id="pu-method" value={paid.method} onChange={(e) => setPaid((x) => ({ ...x, method: e.target.value as PaymentMethod }))}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`paymentMethod.${m}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("payment.reference")} htmlFor="pu-ref" hint={t("common.optional")}>
                <Input id="pu-ref" value={paid.reference} onChange={(e) => setPaid((x) => ({ ...x, reference: e.target.value }))} />
              </Field>
            </div>
            <div className="mt-3">
              <Field label={t("common.notes")} htmlFor="pu-notes" hint={t("common.optional")}>
                <Input id="pu-notes" maxLength={1000} value={head.notes} onChange={(e) => setHead((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
          </Card>
        </div>

        <Card className="p-4 sm:p-5 lg:sticky lg:top-4 lg:self-start">
          <h2 className="mb-3 text-[16px] font-semibold text-ink">{t("invoice.summary")}</h2>
          {calc.error ? (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
              {calc.error instanceof DomainError ? translateError(i18n, calc.error) : t("errors.generic")}
            </p>
          ) : null}
          <dl className="num flex flex-col gap-1.5 text-[14px]">
            {[
              [t("invoice.taxableValue"), tot?.taxableTotal],
              ...(supplyType === "inter_state" ? [[t("invoice.igst"), tot?.igstTotal]] : [[t("invoice.cgst"), tot?.cgstTotal], [t("invoice.sgst"), tot?.sgstTotal]]),
              ...(tot && !tot.cessTotal.isZero() ? [[t("invoice.cess"), tot.cessTotal]] : []),
              ...(tot && !tot.chargesTotal.isZero() ? [[t("purchase.charges"), tot.chargesTotal]] : []),
              ...(tot && !tot.roundOff.isZero() ? [[t("invoice.roundOff"), tot.roundOff]] : []),
            ].map(([label, v]) => (
              <div key={String(label)} className="flex justify-between gap-3">
                <dt className="text-ink-2">{String(label)}</dt>
                <dd className="text-ink">{v ? money((v as { toNumber(): number }).toNumber()) : "—"}</dd>
              </div>
            ))}
            <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-[18px] font-semibold">
              <dt>{t("invoice.grandTotal")}</dt>
              <dd>{tot ? money(tot.grandTotal.toNumber()) : "—"}</dd>
            </div>
            {tot && Number(paid.amount) > 0 && (
              <div className="flex justify-between gap-3 text-[13px] text-ink-2">
                <dt>{t("invoice.balance")}</dt>
                <dd>{money(Math.max(0, tot.grandTotal.toNumber() - Number(paid.amount)))}</dd>
              </div>
            )}
            {head.reverseCharge && <p className="mt-1 text-[12px] text-warn">{t("purchase.reverseChargeHint")}</p>}
          </dl>
          <Button variant="primary" size="lg" block className="mt-4" disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("purchase.save")}
          </Button>
        </Card>
      </div>
      <NewProductsDialog
        open={addingAll}
        onOpenChange={setAddingAll}
        items={pending}
        supplierId={supplierId}
        onAdded={(created) => {
          for (const c of created) {
            const item = pending.find((x) => x.key === c.key);
            if (item) matchItem(item, c.productId);
          }
        }}
      />
      {newProduct !== null && (
        <ProductEditor
          productId={null}
          open
          prefill={{ name: newProduct }}
          onOpenChange={(v) => !v && setNewProduct(null)}
          onSaved={(id) => {
            setNewProduct(null);
            addProduct(id);
          }}
        />
      )}
      <SupplierDialog
        supplierId={null}
        open={newSupplier !== null}
        onOpenChange={(v) => !v && setNewSupplier(null)}
        {...(newSupplier ? { prefill: newSupplier } : {})}
        onSaved={(id) => setSupplierId(id)}
      />
      {creating && (
        <ProductEditor
          productId={null}
          open
          prefill={prefillFrom(creating)}
          onOpenChange={(v) => !v && setCreating(null)}
          onSaved={(id) => {
            const item = creating;
            setCreating(null);
            matchItem(item, id);
          }}
        />
      )}
    </div>
  );
}
