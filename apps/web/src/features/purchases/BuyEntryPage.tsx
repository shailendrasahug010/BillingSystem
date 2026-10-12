import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GoodsReceiptView, PurchaseOrderView } from "@digitalbahi/contracts";
import { calculateDocument, DomainError, determineSupplyType, resolveTax, searchProducts, taxAt, type DocumentTotals, type ResolvedTax } from "@digitalbahi/core";
import { translateError } from "@digitalbahi/i18n";
import { ClipboardList, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Button, IconButton } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { BackButton, ErrorNote, PageHeader, useFieldError } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { BUSINESS, productById, supplierById, TODAY, WORKSPACE } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { refreshCatalog } from "../../data/live";
import { useStoreVersion } from "../../data/store";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { cn } from "../../lib/cn";
import { uuid } from "../../lib/uuid";
import { searchSuppliers, supplierLabel } from "../suppliers/search";
import { leftOnOrderLine } from "./buying";

interface Line {
  key: string;
  productId: string;
  unitId: string;
  qty: string;
  freeQty: string;
  /** Order: the rate asked; receipt: the expected rate (blank: the order's, else the last purchase rate). */
  rate: string;
  discountPercent: string;
  gstRate: string;
  batchNumber: string;
  expiryDate: string;
  mfgDate: string;
  mrp: string;
  /** Receipt against an order: the order line the goods came for. */
  orderItemId?: string;
  /** Receipt against an order: the order's rate per unit (what a blank rate means). */
  orderRate?: string;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const RATE = /^\d{1,11}(\.\d{1,4})?$/;
const PCT = /^\d{1,3}(\.\d{1,3})?$/;
/** Suppliers whose bills carry GST (composition / unregistered suppliers charge none). */
const CHARGES_GST = new Set(["regular", "sez", "deemed_export"]);
const trim = (n: number, d = 4) => String(Math.round(n * 10 ** d) / 10 ** d);
const plain = (v: string | null | undefined) => (v === null || v === undefined || !Number(v) ? "" : String(Number(v)));

/** A product's units: its stock unit and the packs it is bought in, with base units per unit. */
function unitsOf(productId: string) {
  const p = productById.get(productId);
  if (!p) return [];
  return [{ unitId: p.unitId ?? "", symbol: p.unit, factor: 1 }, ...(p.packUnits ?? [])];
}
const factorOf = (productId: string, unitId: string) => unitsOf(productId).find((u) => u.unitId === unitId)?.factor ?? 1;

/** An order to a supplier: what is wanted at the rates expected (from What to order, or typed in). */
export function PurchaseOrderEntryPage({ supplierId, lines }: { supplierId?: string; lines?: Array<{ productId: string; unitId: string; qty: string; rate: string }> }) {
  const start = useMemo(
    () =>
      (lines ?? [])
        .filter((l) => productById.has(l.productId))
        .map((l): Line => ({ key: uuid(), productId: l.productId, unitId: l.unitId, qty: l.qty, freeQty: "", rate: l.rate, discountPercent: "", gstRate: "", batchNumber: "", expiryDate: "", mfgDate: "", mrp: "" })),
    [lines],
  );
  return <BuyEntry kind="order" {...(supplierId ? { supplierId } : {})} lines={start} />;
}

/** Goods received before their bill: against an order (what is still to come), or by themselves. */
export function GoodsReceiptEntryPage({ supplierId, orderId }: { supplierId?: string; orderId?: string }) {
  const { t } = useI18n();
  const order = useQuery({ queryKey: ["purchase-order", orderId], queryFn: () => api.get<PurchaseOrderView>(`/purchase-orders/${orderId}`), enabled: Boolean(orderId) });
  if (!orderId) return <BuyEntry kind="receipt" {...(supplierId ? { supplierId } : {})} lines={[]} />;
  if (order.isPending) return <Skeleton className="h-60 w-full" />;
  if (order.error) return <ErrorNote error={order.error} onRetry={() => void order.refetch()} />;
  const o = order.data;
  if (o.status !== "open" && o.status !== "partly_received") return <EmptyState title={t("buying.order.notOpen", { number: o.orderNumber })} />;
  const lines = o.items.flatMap((i): Line[] => {
    const left = leftOnOrderLine(i);
    if (left.qty <= 0 || !productById.has(i.productId)) return [];
    return [
      {
        key: uuid(),
        productId: i.productId,
        unitId: i.unitId,
        qty: String(left.qty),
        freeQty: left.free > 0 ? String(left.free) : "",
        rate: "",
        discountPercent: "",
        gstRate: "",
        batchNumber: "",
        expiryDate: "",
        mfgDate: "",
        mrp: "",
        orderItemId: i.id,
        orderRate: plain(i.rate),
      },
    ];
  });
  return <BuyEntry kind="receipt" supplierId={o.supplierId} order={o} lines={lines} />;
}

function BuyEntry({ kind, supplierId: initialSupplier, order, lines: initialLines }: { kind: "order" | "receipt"; supplierId?: string; order?: PurchaseOrderView; lines: Line[] }) {
  const i18n = useI18n();
  const { t, money, number } = i18n;
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  useStoreVersion();
  const searchable = useSearchableProducts();
  const isOrder = kind === "order";
  const prefix = isOrder ? "po" : "gr";
  const [supplierId, setSupplierId] = useState<string | null>(initialSupplier ?? null);
  const [head, setHead] = useState({ date: TODAY, expected: "", challan: "", notes: "" });
  const [lines, setLines] = useState<Line[]>(initialLines);
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState(() => order?.warehouseId ?? godowns.find((w) => w.isDefault)?.id ?? "");
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
    const existing = lines.find((l) => l.productId === productId && !l.orderItemId && !p.trackBatches);
    if (existing) {
      setLine(existing.key, { qty: trim(Number(existing.qty || 0) + 1, 3) });
      return;
    }
    // Bought in the product's pack when it has one (cartons), else its stock unit.
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
        rate: isOrder && p.purchasePrice ? trim(p.purchasePrice * factor) : "",
        discountPercent: "",
        gstRate: "",
        batchNumber: "",
        expiryDate: "",
        mfgDate: "",
        mrp: "",
      },
    ]);
  };

  /** The rate a receipt line comes in at when none is typed: the order's, else the last purchase rate. */
  const expectedRate = (l: Line) => {
    if (l.orderRate) return l.orderRate;
    const p = productById.get(l.productId);
    return p ? trim(p.purchasePrice * factorOf(l.productId, l.unitId)) : "";
  };

  const supplyType = supplier ? determineSupplyType({ supplierStateCode: supplier.stateCode, placeOfSupplyStateCode: BUSINESS.stateCode, recipientRegistration: "regular" }) : "intra_state";
  const chargesGst = supplier ? CHARGES_GST.has(supplier.gstRegistration) : true;

  const lineProblem = (l: Line): string | null => {
    const p = productById.get(l.productId);
    if (!QTY.test(l.qty) || Number(l.qty) <= 0) return t("validation.positive");
    if (l.freeQty && !QTY.test(l.freeQty)) return t("validation.amount");
    if (isOrder ? !RATE.test(l.rate) : l.rate !== "" && !RATE.test(l.rate)) return t("validation.amount");
    if (l.discountPercent && (!PCT.test(l.discountPercent) || Number(l.discountPercent) > 100)) return t("errors.DISCOUNT_PERCENT_RANGE");
    if (l.gstRate && (!PCT.test(l.gstRate) || Number(l.gstRate) > 100)) return t("validation.amount");
    if (!isOrder && p?.trackBatches && !l.batchNumber.trim()) return t("errors.BATCH_REQUIRED", { product: p.name });
    if (!isOrder && p?.trackExpiry && !l.expiryDate) return t("errors.EXPIRY_REQUIRED", { product: p.name });
    return null;
  };

  // An order is priced like a bill (the supplier's GST); a receipt is worth its quantities at the expected rates.
  const calc = useMemo((): { totals: DocumentTotals | null; error: unknown; taxes: Map<string, ResolvedTax> } => {
    const taxes = new Map<string, ResolvedTax>();
    if (!isOrder) return { totals: null, error: null, taxes };
    const valid = lines.filter((l) => QTY.test(l.qty) && Number(l.qty) > 0 && RATE.test(l.rate));
    if (!valid.length) return { totals: null, error: null, taxes };
    try {
      const engine = valid.map((l) => {
        const p = productById.get(l.productId)!;
        const tax = l.gstRate && PCT.test(l.gstRate) ? taxAt(l.gstRate) : resolveTax(p.taxCategory, { date: head.date });
        taxes.set(l.key, tax);
        return {
          key: l.key,
          qty: l.qty,
          rate: l.rate,
          discountPercent: l.discountPercent && PCT.test(l.discountPercent) ? l.discountPercent : "0",
          discountAmount: "0",
          conversionFactor: factorOf(l.productId, l.unitId),
          tax,
          hsnCode: p.hsn || null,
          uqc: p.uqc,
        };
      });
      return { totals: calculateDocument({ lines: engine, supplyType, chargeTax: chargesGst, charges: [], roundOff: WORKSPACE.roundOff }), error: null, taxes };
    } catch (e) {
      return { totals: null, error: e, taxes };
    }
  }, [isOrder, lines, head.date, supplyType, chargesGst]);
  const receiptValue = isOrder
    ? 0
    : lines.reduce((s, l) => {
        const rate = Number(l.rate || expectedRate(l)) || 0;
        return s + (Number(l.qty) || 0) * rate * (1 - (Number(l.discountPercent) || 0) / 100);
      }, 0);

  const headProblems = {
    supplierId: supplierId ? null : t("validation.required"),
    date: head.date > TODAY ? t("errors.FUTURE_DATE_NOT_ALLOWED") : null,
    expected: isOrder && head.expected && head.expected < head.date ? t("errors.EXPECTED_BEFORE_ORDER") : null,
    lines: lines.length ? null : t("purchase.noLines"),
  };
  const showHead = (k: keyof typeof headProblems, field = k as string) => (touched ? headProblems[k] : null) ?? fieldError(field);
  const invalid = Object.values(headProblems).some(Boolean) || lines.some((l) => lineProblem(l)) || (isOrder && !calc.totals);

  const save = async () => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const godown = godowns.length > 1 && warehouseId ? { warehouseId } : {};
      if (isOrder) {
        const res = await api.post<PurchaseOrderView>(
          "/purchase-orders",
          {
            supplierId,
            orderDate: head.date,
            ...(head.expected ? { expectedDate: head.expected } : {}),
            ...godown,
            lines: lines.map((l) => ({
              productId: l.productId,
              ...(l.unitId && l.unitId !== productById.get(l.productId)?.unitId ? { unitId: l.unitId } : {}),
              qty: l.qty,
              ...(l.freeQty && Number(l.freeQty) > 0 ? { freeQty: l.freeQty } : {}),
              rate: l.rate,
              ...(l.discountPercent ? { discountPercent: l.discountPercent } : {}),
              ...(l.gstRate ? { gstRate: l.gstRate } : {}),
            })),
            ...(head.notes.trim() ? { notes: head.notes.trim() } : {}),
            clientTotals: { grandTotal: calc.totals!.grandTotal.toFixed(2) },
          },
          { idempotencyKey: key },
        );
        void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
        toast({ tone: "success", title: t("buying.order.saved"), body: `${res.orderNumber} · ${money(res.grandTotal)}` });
        navigate({ name: "purchase-order-view", purchaseOrderId: res.id }, { replace: true });
      } else {
        const res = await api.post<GoodsReceiptView>(
          "/goods-receipts",
          {
            supplierId,
            ...(order ? { purchaseOrderId: order.id } : {}),
            receivedDate: head.date,
            ...godown,
            ...(head.challan.trim() ? { challanNumber: head.challan.trim() } : {}),
            lines: lines.map((l) => ({
              productId: l.productId,
              ...(l.unitId && l.unitId !== productById.get(l.productId)?.unitId ? { unitId: l.unitId } : {}),
              qty: l.qty,
              ...(l.freeQty && Number(l.freeQty) > 0 ? { freeQty: l.freeQty } : {}),
              ...(l.rate ? { rate: l.rate } : {}),
              ...(l.discountPercent ? { discountPercent: l.discountPercent } : {}),
              ...(l.orderItemId ? { purchaseOrderItemId: l.orderItemId } : {}),
              ...(l.batchNumber.trim() ? { batchNumber: l.batchNumber.trim() } : {}),
              ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}),
              ...(l.mfgDate && l.batchNumber.trim() ? { mfgDate: l.mfgDate } : {}),
              ...(l.mrp && RATE.test(l.mrp) ? { mrp: l.mrp } : {}),
            })),
            ...(head.notes.trim() ? { notes: head.notes.trim() } : {}),
          },
          { idempotencyKey: key },
        );
        await refreshCatalog().catch(() => undefined);
        void qc.invalidateQueries({ queryKey: ["goods-receipts"] });
        void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
        void qc.invalidateQueries({ queryKey: ["purchase-order"] });
        void qc.invalidateQueries({ queryKey: ["stock"] });
        toast({ tone: "success", title: t("buying.receipt.saved"), body: `${res.receiptNumber} · ${t("common.items", { count: res.items.length })}` });
        navigate({ name: "goods-receipt-view", goodsReceiptId: res.id }, { replace: true });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const tot = calc.totals;
  const total = isOrder ? (tot ? tot.grandTotal.toNumber() : 0) : receiptValue;
  const back = () => (order ? navigate({ name: "purchase-order-view", purchaseOrderId: order.id }) : navigate({ name: "purchase-list", tab: isOrder ? "orders" : "receipts" }));

  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-0">
      <PageHeader
        back={<BackButton onClick={back} />}
        title={isOrder ? t("buying.order.new") : t("buying.receipt.new")}
        subtitle={order ? t("buying.receipt.against", { number: order.orderNumber }) : isOrder ? t("buying.order.newHint") : t("buying.receipt.newHint")}
      />
      {error instanceof ApiError && !error.field?.startsWith("supplier") ? <ErrorNote error={error} /> : null}

      <Card className="p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Field label={t("supplier.name")} htmlFor={`${prefix}-supplier`} error={showHead("supplierId")}>
              {order ? (
                <p className="py-2 font-medium text-ink">{order.partyName}</p>
              ) : (
                <SearchSelect
                  id={`${prefix}-supplier`}
                  autoFocus={!initialSupplier}
                  value={supplierId}
                  onChange={setSupplierId}
                  invalid={Boolean(showHead("supplierId"))}
                  placeholder={t("supplier.search")}
                  clearLabel={t("common.clear")}
                  emptyText={t("search.noResults")}
                  selectedLabel={supplier ? `${supplierLabel(supplier)} · ${supplier.code}` : null}
                  search={(q) => searchSuppliers(q).map((s) => ({ id: s.id, label: supplierLabel(s), sub: [s.code, s.city, s.gstin].filter(Boolean).join(" · ") }))}
                />
              )}
            </Field>
          </div>
          <Field label={isOrder ? t("buying.order.date") : t("buying.receipt.date")} htmlFor={`${prefix}-date`} error={showHead("date", isOrder ? "orderDate" : "receivedDate")}>
            <Input id={`${prefix}-date`} type="date" max={TODAY} value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} />
          </Field>
          {isOrder ? (
            <Field label={t("buying.order.expected")} htmlFor="po-expected" hint={t("common.optional")} error={showHead("expected", "expectedDate")}>
              <Input id="po-expected" type="date" min={head.date} value={head.expected} onChange={(e) => setHead((h) => ({ ...h, expected: e.target.value }))} />
            </Field>
          ) : (
            <Field label={t("buying.receipt.challan")} htmlFor="gr-challan" hint={t("common.optional")}>
              <Input id="gr-challan" maxLength={30} value={head.challan} onChange={(e) => setHead((h) => ({ ...h, challan: e.target.value }))} />
            </Field>
          )}
          {godowns.length > 1 && (
            <Field label={isOrder ? t("buying.order.deliverTo") : t("godowns.godown")} htmlFor={`${prefix}-godown`}>
              <Select id={`${prefix}-godown`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {godowns.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className={cn(godowns.length > 1 ? "sm:col-span-1 lg:col-span-3" : "sm:col-span-2 lg:col-span-4")}>
            <Field label={t("common.notes")} htmlFor={`${prefix}-notes`} hint={t("common.optional")}>
              <Input id={`${prefix}-notes`} maxLength={1000} value={head.notes} onChange={(e) => setHead((h) => ({ ...h, notes: e.target.value }))} />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("invoice.items")} subtitle={lines.length ? t("common.items", { count: lines.length }) : undefined} />
        <div className="p-4 sm:px-5">
          <SearchSelect
            value={null}
            onChange={(id) => id && addProduct(id)}
            placeholder={t("invoice.searchProduct")}
            clearLabel={t("common.clear")}
            emptyText={t("empty.products")}
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
            <table className={cn("w-full text-[13px]", isOrder ? "min-w-[900px]" : "min-w-[860px]")}>
              <thead>
                <tr className="border-y border-line bg-surface-2 text-left text-[12px] text-ink-3">
                  <th className="py-2 pl-4 font-medium">{t("invoice.product")}</th>
                  <th className="py-2 pl-2 font-medium">{t("invoice.unit")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.qty")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.free")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{isOrder ? t("invoice.rate") : t("buying.receipt.expectedRate")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.discount")}</th>
                  {isOrder ? <th className="py-2 pl-2 text-right font-medium">{t("invoice.gstRate")} %</th> : <th className="py-2 pl-2 font-medium">{t("invoice.batch")}</th>}
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.amount")}</th>
                  <th className="py-2 pr-4 pl-2" />
                </tr>
              </thead>
              <tbody className="num">
                {lines.map((l) => {
                  const p = productById.get(l.productId)!;
                  const problem = touched ? lineProblem(l) : null;
                  const r = tot?.lines.find((x) => x.key === l.key);
                  const resolved = calc.taxes.get(l.key);
                  const units = unitsOf(l.productId);
                  const rateShown = Number(l.rate || (isOrder ? 0 : expectedRate(l))) || 0;
                  const value = (Number(l.qty) || 0) * rateShown * (1 - (Number(l.discountPercent) || 0) / 100);
                  return (
                    <tr key={l.key} data-line={p.name} className={cn("border-b border-line align-top", problem && "bg-danger-soft/40")}>
                      <td className="py-2 pl-4">
                        <p className="font-medium text-ink">{p.name}</p>
                        <p className="text-[12px] text-ink-3">
                          {p.code} · {t("buying.inStock", { qty: number(p.stock), unit: p.unit })}
                        </p>
                        {problem && (
                          <p className="text-[12px] text-danger" role="alert">
                            {problem}
                          </p>
                        )}
                      </td>
                      <td className="py-2 pl-2">
                        <Select aria-label={t("invoice.unit")} className="h-8 w-auto min-w-24 px-2 text-[13px]" value={l.unitId} disabled={Boolean(l.orderItemId)} onChange={(e) => setLine(l.key, { unitId: e.target.value })}>
                          {units.map((u) => (
                            <option key={u.unitId} value={u.unitId}>
                              {u.symbol}
                              {u.factor !== 1 ? ` (${u.factor})` : ""}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={`${t("invoice.qty")} ${p.name}`} className="ml-auto w-20 [&_input]:text-right" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.trim() })} />
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={`${t("invoice.free")} ${p.name}`} className="ml-auto w-16 [&_input]:text-right" value={l.freeQty} onChange={(e) => setLine(l.key, { freeQty: e.target.value.trim() })} />
                      </td>
                      <td className="py-2 pl-2">
                        <Input
                          inputSize="sm"
                          inputMode="decimal"
                          aria-label={`${t("invoice.rate")} ${p.name}`}
                          placeholder={isOrder ? "" : expectedRate(l)}
                          className="ml-auto w-24 [&_input]:text-right"
                          value={l.rate}
                          onChange={(e) => setLine(l.key, { rate: e.target.value.trim() })}
                        />
                      </td>
                      <td className="py-2 pl-2">
                        <Input inputSize="sm" inputMode="decimal" aria-label={`${t("invoice.discount")} ${p.name}`} className="ml-auto w-16 [&_input]:text-right" value={l.discountPercent} onChange={(e) => setLine(l.key, { discountPercent: e.target.value.trim() })} />
                      </td>
                      {isOrder ? (
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
                      ) : (
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
                      )}
                      <td className="py-2 pl-2 text-right">
                        {isOrder ? (
                          <>
                            <p className="font-medium text-ink">{r ? money(r.total.toNumber()) : "—"}</p>
                            {r && <p className="text-[11.5px] text-ink-3">{money(r.taxable.toNumber())} + {money(r.taxTotal.toNumber())}</p>}
                          </>
                        ) : (
                          <p className="font-medium text-ink">{rateShown ? money(value) : "—"}</p>
                        )}
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

      <Card className="p-4 sm:p-5 lg:ml-auto lg:w-[380px]">
        <h2 className="mb-3 text-[16px] font-semibold text-ink">{t("invoice.summary")}</h2>
        {calc.error ? (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {calc.error instanceof DomainError ? translateError(i18n, calc.error) : t("errors.generic")}
          </p>
        ) : null}
        <dl className="num flex flex-col gap-1.5 text-[14px]">
          {isOrder ? (
            <>
              {[
                [t("invoice.taxableValue"), tot?.taxableTotal],
                ...(supplyType === "inter_state" ? [[t("invoice.igst"), tot?.igstTotal]] : [[t("invoice.cgst"), tot?.cgstTotal], [t("invoice.sgst"), tot?.sgstTotal]]),
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
              <p className="text-[12px] text-ink-3">{t("buying.order.estimate")}</p>
            </>
          ) : (
            <>
              <div className="flex justify-between gap-3 text-[18px] font-semibold">
                <dt>{t("buying.receipt.value")}</dt>
                <dd>{money(receiptValue)}</dd>
              </div>
              <p className="text-[12px] text-ink-3">{t("buying.receipt.valueHint")}</p>
            </>
          )}
        </dl>
        <Button variant="primary" size="lg" block className="mt-4 max-lg:hidden" disabled={busy} icon={<ClipboardList size={16} />} onClick={() => void save()}>
          {busy ? t("common.saving") : isOrder ? t("buying.order.save") : t("buying.receipt.save")}
        </Button>
      </Card>

      {/* On a phone the total and Save stay at the foot of the screen. */}
      <div data-overlay="bottom" className="glass fixed inset-x-3 bottom-[calc(10px+var(--inset-bottom))] z-20 rounded-2xl border border-line/70 px-4 py-2.5 shadow-pop short:bottom-3 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] text-ink-3">{lines.length ? t("common.items", { count: lines.length }) : t("purchase.noLines")}</p>
            <p className="num font-display text-[20px] leading-tight font-semibold text-ink">{money(total)}</p>
          </div>
          <Button variant="primary" icon={<Save size={16} />} disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
