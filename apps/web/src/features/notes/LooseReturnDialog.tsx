import { useQuery, useQueryClient } from "@tanstack/react-query";
import { calculateDocument, dec, determineSupplyType, NO_TAX, resolveTax, roundRate, searchProducts, type PartyGstRegistration } from "@digitalbahi/core";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button, IconButton } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { BUSINESS, customerById, productById, TODAY, WORKSPACE } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { refreshCatalog, refreshCustomer } from "../../data/live";
import { LIVE } from "../../data/source";
import { api, ApiError, newIdempotencyKey, QUICK_SAVE_MS } from "../../lib/api";
import { offlineScope, queueEntry, unreachable, useOffline, workingOffline } from "../../offline/sync";
import { searchCustomers } from "../invoice/CustomerPicker";
import { defaultGodownId, godowns, lastGodownId, pickGodown } from "../invoice/godown";
import { discountFor, factorOf, rateFor, unitSymbolOf } from "../invoice/useInvoiceDraft";
import { invalidateMoney } from "../payments/PaymentDialog";

interface Line {
  key: string;
  productId: string;
  unitId: string;
  qty: string;
  rate: string;
  discountPercent: number;
  /** Typed in by hand: a change of unit keeps it. */
  rateTyped: boolean;
}

interface LastRate {
  productId: string;
  unitId: string;
  rate: string;
  discountPercent: string;
  conversionFactor: string;
  invoiceNumber: string | null;
  invoiceDate: string;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const RATE = /^\d{1,13}(\.\d{1,4})?$/;
const REASONS = ["sales_return", "damage", "other"] as const;
let seq = 0;

/**
 * Goods a customer brings back without their bill: pick the products and
 * quantities; each is taken back at the rate the customer was last billed
 * (the rate list's when never billed it, or as typed), with GST. The credit
 * note pays the customer's open bills, oldest due first; anything over stays
 * on their account. Without a connection it is kept on this device and sent
 * later (stock and the balance move here at once).
 */
export function LooseReturnDialog({ open, onOpenChange, customerId: fixedCustomer }: { open: boolean; onOpenChange(v: boolean): void; customerId?: string | null }) {
  const { t, money, number } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const searchable = useSearchableProducts();
  const offline = useOffline();
  const [customerId, setCustomerId] = useState<string | null>(fixedCustomer ?? null);
  const [lines, setLines] = useState<Line[]>([]);
  const [date, setDate] = useState(TODAY);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("sales_return");
  const [restock, setRestock] = useState(true);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  useEffect(() => {
    if (!open) return;
    setCustomerId(fixedCustomer ?? null);
    setLines([]);
    setDate(TODAY);
    setReason("sales_return");
    setRestock(true);
    setWarehouseId(lastGodownId());
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [open, fixedCustomer]);

  const customer = customerId ? (customerById.get(customerId) ?? null) : null;
  const productIds = [...new Set(lines.map((l) => l.productId))].sort();
  // What the customer was last billed for these products (needs the server; the rate list's otherwise).
  const last = useQuery({
    queryKey: ["last-rates", customerId, productIds.join(",")],
    queryFn: () => api.get<{ data: LastRate[] }>(`/customers/${customerId}/last-rates?productIds=${productIds.join(",")}`),
    enabled: open && LIVE && Boolean(customerId) && productIds.length > 0 && !offline.offlineMode && offline.online,
    staleTime: 60_000,
  });
  const billedRate = (productId: string, unitId: string): { rate: number; discountPercent: number; from: LastRate } | null => {
    const rows = last.data?.data ?? [];
    const row = rows.find((r) => r.productId === productId && r.unitId === unitId) ?? rows.find((r) => r.productId === productId);
    if (!row) return null;
    const p = productById.get(productId);
    const rate = row.unitId === unitId || !p ? Number(row.rate) : roundRate(dec(row.rate).dividedBy(row.conversionFactor).times(factorOf(p, unitId))).toNumber();
    return { rate, discountPercent: Number(row.discountPercent), from: row };
  };
  const defaultRate = (productId: string, unitId: string) => {
    const p = productById.get(productId)!;
    const billed = billedRate(productId, unitId);
    return billed ?? { rate: rateFor(p, customer, unitId), discountPercent: discountFor(p, customer, unitId), from: null };
  };

  // The customer's last billed rates arrive after the lines are added: they take over rates not typed in.
  const lastData = last.data;
  useEffect(() => {
    if (!lastData) return;
    setLines((ls) =>
      ls.map((l) => {
        if (l.rateTyped) return l;
        const d = defaultRate(l.productId, l.unitId);
        return { ...l, rate: String(d.rate), discountPercent: d.discountPercent };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastData]);

  const add = (productId: string) => {
    const p = productById.get(productId);
    if (!p) return;
    const unitId = p.unitId ?? "";
    const d = defaultRate(productId, unitId);
    seq += 1;
    setLines((ls) => [...ls, { key: `R${seq}`, productId, unitId, qty: "1", rate: String(d.rate), discountPercent: d.discountPercent, rateTyped: false }]);
  };
  const change = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  const supplyType = determineSupplyType({
    supplierStateCode: BUSINESS.stateCode,
    placeOfSupplyStateCode: customer?.stateCode ?? BUSINESS.stateCode,
    ...(customer?.gstRegistration ? { recipientRegistration: customer.gstRegistration as PartyGstRegistration } : {}),
  });
  const valid = lines.length > 0 && lines.every((l) => QTY.test(l.qty) && Number(l.qty) > 0 && RATE.test(l.rate));
  // The same engine and inputs as the server: the total shown is the note's total.
  const totals = useMemo(() => {
    if (!valid) return null;
    try {
      return calculateDocument({
        supplyType,
        chargeTax: WORKSPACE.chargeTax,
        roundOff: WORKSPACE.roundOff,
        lines: lines.map((l) => {
          const p = productById.get(l.productId)!;
          const factor = factorOf(p, l.unitId);
          const tax =
            p.taxCategory.kind === "taxable"
              ? resolveTax(p.taxCategory, { date, unitValue: dec(l.rate).dividedBy(factor), unitValueIncludesTax: Boolean(p.pricesIncludeTax) })
              : { ...NO_TAX, kind: p.taxCategory.kind };
          return { key: l.key, qty: l.qty, rate: l.rate, rateIncludesTax: Boolean(p.pricesIncludeTax), discountPercent: l.discountPercent, discountAmount: 0, conversionFactor: factor, tax, hsnCode: p.hsn, uqc: p.uqc };
        }),
      });
    } catch {
      return null;
    }
  }, [valid, lines, supplyType, date]);
  const lineTotal = (k: string) => totals?.lines.find((x) => x.key === k)?.total.toNumber() ?? null;
  const ready = Boolean(customer) && valid && totals !== null;

  const save = async () => {
    if (!customer || !totals) return;
    setBusy(true);
    setError(null);
    const grandTotal = totals.grandTotal.toFixed(2);
    const body = {
      customerId: customer.id,
      noteDate: date,
      reason,
      restock,
      ...(warehouseId && pickGodown() ? { warehouseId } : {}),
      lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty, rate: l.rate, ...(l.discountPercent > 0 ? { discountPercent: String(l.discountPercent) } : {}) })),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    /** Kept on this device with the same key: stock and the balance move now, the note comes when it syncs. */
    const keep = async () => {
      const scope = offlineScope();
      const kept =
        scope &&
        (await queueEntry({
          kind: "loose-return",
          id: key,
          userId: scope.userId,
          businessId: scope.businessId,
          savedAt: new Date().toISOString(),
          status: "pending",
          error: null,
          customerId: customer.id,
          partyName: customer.businessName,
          date,
          estimate: Number(grandTotal),
          stock: restock ? lines.map((l) => ({ productId: l.productId, qty: Math.round(Number(l.qty) * factorOf(productById.get(l.productId)!, l.unitId) * 1000) / 1000 })) : [],
          body,
        }));
      if (!kept) throw new ApiError(0, "OFFLINE_NOT_KEPT");
      toast({ tone: "offline", title: t("offline.savedHere"), body: `${t("notes.creditSaved")} · ≈ ${money(grandTotal)} · ${t("offline.sendsLater")}` });
      onOpenChange(false);
    };
    try {
      if (workingOffline()) return await keep();
      const res = await api.post<{ noteNumber: string; grandTotal: string; amountSettled: string; allocations: Array<{ invoiceNumber: string | null; amount: string }> }>(
        "/returns",
        { ...body, clientTotals: { grandTotal } },
        { idempotencyKey: key, timeoutMs: QUICK_SAVE_MS },
      );
      await Promise.all([restock ? refreshCatalog() : Promise.resolve(), refreshCustomer(customer.id)]).catch(() => undefined);
      invalidateMoney(qc);
      for (const k of ["invoice", "invoice-raw", "stock", "notes", "godown-stock"]) void qc.invalidateQueries({ queryKey: [k] });
      const left = Number(res.grandTotal) - Number(res.amountSettled);
      toast({
        tone: "success",
        title: t("notes.creditSaved"),
        body: [`${res.noteNumber} · ${money(res.grandTotal)}`, res.allocations.length ? `${t("notes.paidBills")} ${res.allocations.map((a) => a.invoiceNumber).join(", ")}` : null, left > 0.005 ? t("notes.onAccount", { amount: money(left) }) : null]
          .filter(Boolean)
          .join(" · "),
      });
      onOpenChange(false);
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

  const places = godowns();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("notes.loose.title")}
      description={t("notes.loose.hint")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()} data-loose-save>
            {busy ? t("common.saving") : totals ? `${t("common.save")} · ${money(totals.grandTotal.toFixed(2))}` : t("common.save")}
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label={t("customer.name")} htmlFor="lr-customer" error={fieldError("customerId")}>
            {fixedCustomer ? (
              <p className="flex h-10 items-center rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 text-sm font-medium text-ink">{customer?.businessName ?? ""}</p>
            ) : (
              <SearchSelect
                id="lr-customer"
                autoFocus
                value={customerId}
                onChange={setCustomerId}
                placeholder={t("customer.search")}
                clearLabel={t("common.clear")}
                emptyText={t("search.noResults")}
                selectedLabel={customer ? `${customer.businessName} · ${customer.code}` : null}
                search={(q) => searchCustomers(q).map((c) => ({ id: c.id, label: c.businessName, sub: [c.code, c.city, c.mobile].filter(Boolean).join(" · "), trailing: c.balance ? money(c.balance) : undefined }))}
              />
            )}
          </Field>
          <Field label={t("common.date")} htmlFor="lr-date">
            <Input id="lr-date" type="date" max={TODAY} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t("common.reason")} htmlFor="lr-reason">
            <Select id="lr-reason" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`notes.reasons.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SearchSelect
          id="lr-product"
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
            }))
          }
        />
        {lines.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="py-2 pl-3 font-medium">{t("invoice.product")}</th>
                  <th className="py-2 pl-2 font-medium">{t("invoice.unit")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.qty")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("invoice.rate")}</th>
                  <th className="py-2 pl-2 text-right font-medium">{t("common.amount")}</th>
                  <th className="py-2 pr-3 pl-2" />
                </tr>
              </thead>
              <tbody className="num">
                {lines.map((l) => {
                  const p = productById.get(l.productId)!;
                  const units = [{ unitId: p.unitId ?? "", symbol: p.unit, factor: 1 }, ...(p.packUnits ?? [])];
                  const billed = billedRate(l.productId, l.unitId);
                  const total = lineTotal(l.key);
                  return (
                    <tr key={l.key} className="border-b border-line align-top last:border-b-0" data-loose-line={p.name}>
                      <td className="py-1.5 pl-3">
                        <p className="font-medium text-ink">{p.name}</p>
                        <p className="text-[12px] text-ink-3">
                          {billed && !l.rateTyped ? t("notes.loose.lastBilled", { bill: billed.from.invoiceNumber ?? "" }) : l.rateTyped ? t("notes.loose.rateTyped") : t("notes.loose.rateList")}
                          {l.discountPercent > 0 ? ` · −${number(l.discountPercent)}%` : ""}
                        </p>
                      </td>
                      <td className="py-1.5 pl-2">
                        <Select
                          aria-label={`${t("invoice.unit")} ${p.name}`}
                          className="h-8 w-24 px-2 text-[13px]"
                          value={l.unitId}
                          onChange={(e) => {
                            const unitId = e.target.value;
                            const d = defaultRate(l.productId, unitId);
                            change(l.key, l.rateTyped ? { unitId } : { unitId, rate: String(d.rate), discountPercent: d.discountPercent });
                          }}
                        >
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
                          aria-label={`${t("invoice.qty")} ${p.name}`}
                          invalid={!QTY.test(l.qty) || Number(l.qty) <= 0}
                          className="ml-auto w-20 [&_input]:text-right"
                          value={l.qty}
                          onChange={(e) => change(l.key, { qty: e.target.value.trim() })}
                        />
                      </td>
                      <td className="py-1.5 pl-2">
                        <Input
                          inputSize="sm"
                          inputMode="decimal"
                          aria-label={`${t("invoice.rate")} ${p.name}`}
                          invalid={!RATE.test(l.rate)}
                          className="ml-auto w-24 [&_input]:text-right"
                          value={l.rate}
                          onChange={(e) => change(l.key, { rate: e.target.value.trim(), rateTyped: true, discountPercent: 0 })}
                        />
                        <p className="mt-0.5 text-right text-[11.5px] text-ink-3">/{unitSymbolOf(p, l.unitId)}</p>
                      </td>
                      <td className="py-2 pl-2 text-right font-medium text-ink">{total !== null ? money(total) : "—"}</td>
                      <td className="py-1.5 pr-3 pl-2 text-right">
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
        {totals && (
          <dl className="num ml-auto grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-[13px]" data-loose-totals>
            <dt className="text-ink-3">{t("invoice.taxable")}</dt>
            <dd className="text-right text-ink-2">{money(totals.taxableTotal.toFixed(2))}</dd>
            <dt className="text-ink-3">{t("invoice.tax")}</dt>
            <dd className="text-right text-ink-2">{money(totals.taxTotal.toFixed(2))}</dd>
            <dt className="font-semibold text-ink">{t("notes.loose.credit")}</dt>
            <dd className="text-right font-semibold text-ink">{money(totals.grandTotal.toFixed(2))}</dd>
          </dl>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {pickGodown() && (
            <Field label={t("godowns.godown")} htmlFor="lr-godown">
              <Select id="lr-godown" value={warehouseId ?? defaultGodownId() ?? ""} onChange={(e) => setWarehouseId(e.target.value)}>
                {places.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("common.notes")} htmlFor="lr-notes" hint={t("common.optional")}>
            <Input id="lr-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <Checkbox label={t("notes.restockSale")} checked={restock} onChange={setRestock} />
      </div>
    </Dialog>
  );
}
