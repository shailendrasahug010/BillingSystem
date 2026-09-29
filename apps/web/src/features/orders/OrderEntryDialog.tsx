import { useQueryClient } from "@tanstack/react-query";
import { searchProducts } from "@vyapaar/core";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Button, IconButton } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { customerById, productById, TODAY } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { isWaitingCustomer, offlineScope, queueEntry, unreachable, useOffline, workingOffline } from "../../offline/sync";
import { searchCustomers } from "../invoice/CustomerPicker";
import { rateFor } from "../invoice/useInvoiceDraft";

interface Line {
  productId: string;
  unitId: string;
  qty: string;
  freeQty: string;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const SOURCES = ["salesperson", "counter", "phone", "whatsapp"] as const;

/**
 * Book an order: customer, products and quantities. Prices come from the
 * customer's rate list on the server (the amounts here are an estimate);
 * nothing leaves the godown until the order is invoiced.
 */
export function OrderEntryDialog({ open, onOpenChange, customerId: initialCustomer }: { open: boolean; onOpenChange(v: boolean): void; customerId?: string }) {
  const { t, money, number } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { navigate } = useRouter();
  const searchable = useSearchableProducts();
  const [customerId, setCustomerId] = useState<string | null>(initialCustomer ?? null);
  const [lines, setLines] = useState<Line[]>([]);
  const [delivery, setDelivery] = useState("");
  const [source, setSource] = useState<(typeof SOURCES)[number]>("salesperson");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);
  const offline = useOffline();
  const keepHere = offline.offlineMode || !offline.online || (Boolean(customerId) && isWaitingCustomer(customerId!));

  useEffect(() => {
    if (!open) return;
    setCustomerId(initialCustomer ?? null);
    setLines([]);
    setDelivery("");
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open, initialCustomer]);

  const customer = customerId ? (customerById.get(customerId) ?? null) : null;
  const factorOf = (l: Line) => {
    const p = productById.get(l.productId);
    return l.unitId && l.unitId !== p?.unitId ? (p?.packUnits?.find((u) => u.unitId === l.unitId)?.factor ?? 1) : 1;
  };
  const estimate = lines.reduce((s, l) => {
    const p = productById.get(l.productId);
    return p && QTY.test(l.qty) ? s + Number(l.qty) * rateFor(p, customer) * factorOf(l) * (1 + (p.pricesIncludeTax ? 0 : p.gstRate / 100)) : s;
  }, 0);
  const ready = customerId && lines.length > 0 && lines.every((l) => QTY.test(l.qty) && Number(l.qty) > 0 && (!l.freeQty || QTY.test(l.freeQty)));

  const add = (productId: string) => {
    const existing = lines.find((l) => l.productId === productId);
    if (existing) {
      setLines((ls) => ls.map((l) => (l.productId === productId ? { ...l, qty: String(Number(l.qty || 0) + 1) } : l)));
      return;
    }
    setLines((ls) => [...ls, { productId, unitId: productById.get(productId)?.unitId ?? "", qty: "1", freeQty: "" }]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      customerId,
      source,
      ...(delivery ? { expectedDeliveryDate: delivery } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: lines.map((l) => {
        const p = productById.get(l.productId);
        return {
          productId: l.productId,
          ...(l.unitId && l.unitId !== p?.unitId ? { unitId: l.unitId } : {}),
          qty: l.qty,
          ...(l.freeQty && Number(l.freeQty) > 0 ? { freeQty: l.freeQty } : {}),
        };
      }),
    };
    /** Kept on this device (same key: an attempt that did reach the server is not booked twice). */
    const keep = async () => {
      const scope = offlineScope();
      const kept =
        scope &&
        (await queueEntry({
          kind: "order",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          customerId: customerId!,
          customerName: customer?.businessName ?? "",
          date: TODAY,
          estimate: Math.round(estimate * 100) / 100,
          lineCount: lines.length,
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("orders.saved")} · ${customer?.businessName ?? ""} · ${t("offline.sendsLater")}` });
      onOpenChange(false);
    };
    try {
      if (keepHere || workingOffline()) return await keep();
      const res = await api.post<{ id: string; orderNumber: string; grandTotal: string }>("/sales-orders", body, { idempotencyKey: key });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: t("orders.saved"), body: `${res.orderNumber} · ${money(res.grandTotal)}` });
      onOpenChange(false);
      navigate({ name: "order-view", orderId: res.id });
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("orders.new")}
      description={t("orders.newHint")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? t("common.saving") : estimate > 0 ? `${t("orders.save")} · ≈ ${money(estimate, 0)}` : t("orders.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && error.code === "OFFLINE_NOT_KEPT" ? (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {t("offline.notReadyWork")}
          </p>
        ) : error instanceof ApiError && !error.field?.startsWith("customer") ? (
          <ErrorNote error={error} />
        ) : null}
        {keepHere && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{t("offline.orderNote")}</p>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label={t("customer.name")} htmlFor="so-customer" error={fieldError("customerId")}>
            <SearchSelect
              id="so-customer"
              autoFocus={!initialCustomer}
              value={customerId}
              onChange={setCustomerId}
              placeholder={t("customer.search")}
              clearLabel={t("common.clear")}
              emptyText={t("search.noResults")}
              selectedLabel={customer ? `${customer.businessName} · ${customer.code}` : null}
              search={(q) => searchCustomers(q).map((c) => ({ id: c.id, label: c.businessName, sub: [c.code, c.city, c.mobile].filter(Boolean).join(" · "), trailing: c.balance ? money(c.balance) : undefined }))}
            />
          </Field>
          <Field label={t("orders.deliveryDate")} htmlFor="so-delivery" hint={t("common.optional")} error={fieldError("expectedDeliveryDate")}>
            <Input id="so-delivery" type="date" min={TODAY} value={delivery} onChange={(e) => setDelivery(e.target.value)} />
          </Field>
          <Field label={t("orders.source")} htmlFor="so-source">
            <Select id="so-source" value={source} onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`orders.sources.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SearchSelect
          value={null}
          onChange={(id) => id && add(id)}
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
        {lines.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-[12px] text-ink-3">
                  <th className="py-2 pl-3 font-medium">{t("invoice.product")}</th>
                  <th className="py-2 pl-2 font-medium">{t("invoice.unit")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.qty")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.free")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.rate")}</th>
                  <th className="py-2 pr-3 pl-2" />
                </tr>
              </thead>
              <tbody className="num">
                {lines.map((l) => {
                  const p = productById.get(l.productId)!;
                  const units = [{ unitId: p.unitId ?? "", symbol: p.unit, factor: 1 }, ...(p.packUnits ?? [])];
                  const bad = !QTY.test(l.qty) || Number(l.qty) <= 0;
                  return (
                    <tr key={l.productId} className="border-b border-line last:border-b-0">
                      <td className="py-1.5 pl-3">
                        <p className="font-medium text-ink">{p.name}</p>
                        <p className="text-[12px] text-ink-3">
                          {t("product.currentStock")}: {number(p.stock)} {p.unit}
                        </p>
                      </td>
                      <td className="py-1.5 pl-2">
                        <Select aria-label={t("invoice.unit")} className="h-8 w-24 px-2 text-[13px]" value={l.unitId} onChange={(e) => setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, unitId: e.target.value } : x)))}>
                          {units.map((u) => (
                            <option key={u.unitId} value={u.unitId}>
                              {u.symbol}
                              {u.factor !== 1 ? ` (${u.factor})` : ""}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-1.5 pl-2">
                        <Input
                          inputSize="sm"
                          inputMode="decimal"
                          invalid={bad}
                          aria-label={`${t("invoice.qty")} ${p.name}`}
                          className="ml-auto w-20 [&_input]:text-right"
                          value={l.qty}
                          onChange={(e) => setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, qty: e.target.value.trim() } : x)))}
                        />
                      </td>
                      <td className="py-1.5 pl-2">
                        <Input
                          inputSize="sm"
                          inputMode="decimal"
                          aria-label={`${t("invoice.free")} ${p.name}`}
                          className="ml-auto w-16 [&_input]:text-right"
                          value={l.freeQty}
                          onChange={(e) => setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, freeQty: e.target.value.trim() } : x)))}
                        />
                      </td>
                      <td className="py-1.5 pl-2 text-right text-ink-2">{money(rateFor(p, customer) * factorOf(l))}</td>
                      <td className="py-1.5 pr-3 pl-2 text-right">
                        <IconButton label={t("invoice.remove")} onClick={() => setLines((ls) => ls.filter((x) => x.productId !== l.productId))}>
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
        <Field label={t("common.notes")} htmlFor="so-notes" hint={t("common.optional")}>
          <Input id="so-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
