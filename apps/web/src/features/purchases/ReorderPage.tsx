import { useQuery } from "@tanstack/react-query";
import type { ReorderRow } from "@digitalbahi/contracts";
import { ClipboardList } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { BackButton, ErrorNote, PageHeader } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { allowed, supplierById } from "../../data/db";
import { api } from "../../lib/api";
import { searchSuppliers, supplierLabel } from "../suppliers/search";

const REASON_TONE: Record<ReorderRow["reason"], Tone> = { out: "danger", below_min: "warn", runs_out: "accent" };
const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const trim = (n: number, d = 4) => String(Math.round(n * 10 ** d) / 10 ** d);

/**
 * What to order: products running short (none left, below their minimum, or
 * running out before an order would arrive and last), from one supplier or
 * all of them grouped by supplier, with the quantity to order in the carton
 * they are bought in. Chosen lines become a purchase order to that supplier.
 */
export function ReorderPage({ supplierId: initialSupplier }: { supplierId?: string }) {
  const { t, money, number } = useI18n();
  const { navigate } = useRouter();
  const [supplierId, setSupplierId] = useState<string | null>(initialSupplier ?? null);
  const [days, setDays] = useState("30");
  const [lead, setLead] = useState("7");
  const [cover, setCover] = useState("15");
  // What the person changed: quantities typed over the suggestion, lines left out.
  const [qty, setQty] = useState<Record<string, string>>({});
  const [left, setLeft] = useState<Set<string>>(() => new Set());
  const whole = (v: string, min: number, max: number, fallback: number) => (/^\d{1,3}$/.test(v) ? Math.min(max, Math.max(min, Number(v))) : fallback);
  const params = { ...(supplierId ? { supplierId } : {}), days: whole(days, 7, 180, 30), lead: whole(lead, 0, 60, 7), cover: whole(cover, 1, 120, 15) };
  const q = useQuery({ queryKey: ["purchase-reorder", params], queryFn: () => api.get<{ asOf: string; data: ReorderRow[] }>("/purchase-orders/reorder", params), placeholderData: (previous) => previous });
  const supplier = supplierId ? supplierById.get(supplierId) : undefined;

  const groups = useMemo(() => {
    const by = new Map<string, { supplierId: string | null; name: string | null; rows: ReorderRow[] }>();
    for (const r of q.data?.data ?? []) {
      const k = r.supplierId ?? "";
      if (!by.has(k)) by.set(k, { supplierId: r.supplierId, name: r.supplierName, rows: [] });
      by.get(k)!.rows.push(r);
    }
    // Suppliers by name; products with no supplier last.
    return [...by.values()].sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [q.data]);

  const qtyOf = (r: ReorderRow) => qty[r.productId] ?? String(Number(r.qty));
  const makeOrder = (g: { supplierId: string | null; rows: ReorderRow[] }) => {
    if (!g.supplierId) return;
    const chosen = g.rows.filter((r) => !left.has(r.productId) && QTY.test(qtyOf(r)) && Number(qtyOf(r)) > 0);
    navigate({
      name: "purchase-order-new",
      supplierId: g.supplierId,
      lines: chosen.map((r) => ({ productId: r.productId, unitId: r.unitId, qty: qtyOf(r), rate: trim(Number(r.purchasePrice) * Number(r.factor)) })),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader back={<BackButton onClick={() => navigate({ name: "purchase-list", tab: "orders" })} />} title={t("buying.reorder.title")} subtitle={t("buying.reorder.hint")} />
      <Card className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-5">
        <div className="sm:col-span-2">
          <Field label={t("buying.reorder.supplier")} htmlFor="ro-supplier">
            <SearchSelect
              id="ro-supplier"
              value={supplierId}
              onChange={setSupplierId}
              placeholder={t("buying.reorder.allSuppliers")}
              clearLabel={t("common.clear")}
              emptyText={t("search.noResults")}
              selectedLabel={supplier ? supplierLabel(supplier) : null}
              search={(text) => searchSuppliers(text).map((s) => ({ id: s.id, label: supplierLabel(s), sub: [s.code, s.city].filter(Boolean).join(" · ") }))}
            />
          </Field>
        </div>
        <Field label={t("buying.reorder.days")} htmlFor="ro-days">
          <Select id="ro-days" value={days} onChange={(e) => setDays(e.target.value)}>
            {["15", "30", "60", "90"].map((d) => (
              <option key={d} value={d}>
                {t("buying.reorder.daysValue", { days: d })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("buying.reorder.lead")} htmlFor="ro-lead">
          <Input id="ro-lead" inputMode="numeric" maxLength={2} value={lead} onChange={(e) => setLead(e.target.value.trim())} />
        </Field>
        <Field label={t("buying.reorder.cover")} htmlFor="ro-cover">
          <Input id="ro-cover" inputMode="numeric" maxLength={3} value={cover} onChange={(e) => setCover(e.target.value.trim())} />
        </Field>
      </Card>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : groups.length === 0 ? (
        <EmptyState title={t("buying.reorder.empty")} hint={t("buying.reorder.emptyHint")} />
      ) : (
        groups.map((g) => {
          const chosen = g.rows.filter((r) => !left.has(r.productId) && QTY.test(qtyOf(r)) && Number(qtyOf(r)) > 0);
          const value = chosen.reduce((s, r) => s + Number(qtyOf(r)) * Number(r.purchasePrice) * Number(r.factor), 0);
          return (
            <Card key={g.supplierId ?? "none"} data-reorder-group={g.name ?? ""}>
              <CardHeader
                title={g.name ?? t("buying.reorder.noSupplier")}
                subtitle={`${t("common.items", { count: g.rows.length })}${chosen.length ? ` · ${money(value)}` : ""}`}
                action={
                  g.supplierId && allowed("purchase.order") ? (
                    <Button variant="primary" size="sm" icon={<ClipboardList size={14} />} disabled={!chosen.length} onClick={() => makeOrder(g)}>
                      {t("buying.reorder.make", { count: chosen.length })}
                    </Button>
                  ) : undefined
                }
              />
              <div className="scroll-x">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead>
                    <tr className="border-y border-line bg-surface-2 text-left text-[12px] text-ink-3">
                      <th className="w-10 py-2 pl-4" />
                      <th className="py-2 pl-2 font-medium">{t("invoice.product")}</th>
                      <th className="py-2 pl-2 text-right font-medium">{t("buying.reorder.onHand")}</th>
                      <th className="py-2 pl-2 text-right font-medium">{t("buying.reorder.onOrder")}</th>
                      <th className="py-2 pl-2 text-right font-medium">{t("buying.reorder.perDay")}</th>
                      <th className="py-2 pl-2 text-right font-medium">{t("buying.reorder.daysLeft")}</th>
                      <th className="py-2 pr-4 pl-2 text-right font-medium">{t("buying.reorder.suggest")}</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {g.rows.map((r) => {
                      const out = left.has(r.productId);
                      return (
                        <tr key={r.productId} data-reorder={r.name} className={out ? "border-b border-line text-ink-3" : "border-b border-line"}>
                          <td className="py-2 pl-4">
                            <Checkbox
                              label={<span className="sr-only">{r.name}</span>}
                              checked={!out}
                              onChange={(v) =>
                                setLeft((s) => {
                                  const n = new Set(s);
                                  if (v) n.delete(r.productId);
                                  else n.add(r.productId);
                                  return n;
                                })
                              }
                            />
                          </td>
                          <td className="py-2 pl-2">
                            <p className="font-medium text-ink">{r.name}</p>
                            <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                              {r.code}
                              <Badge tone={REASON_TONE[r.reason]}>{t(`buying.reorder.reasons.${r.reason}`)}</Badge>
                            </p>
                          </td>
                          <td className="py-2 pl-2 text-right">
                            {number(r.onHand)} {r.unit}
                          </td>
                          <td className="py-2 pl-2 text-right">{Number(r.onOrder) ? `${number(r.onOrder)} ${r.unit}` : "—"}</td>
                          <td className="py-2 pl-2 text-right">{Number(r.perDay) ? `${number(r.perDay)} ${r.unit}` : "—"}</td>
                          <td className="py-2 pl-2 text-right">{r.daysLeft === null ? "—" : t("buying.reorder.daysLeftValue", { days: number(r.daysLeft) })}</td>
                          <td className="py-2 pr-4 pl-2">
                            <div className="flex items-center justify-end gap-1.5">
                              <Input
                                inputSize="sm"
                                inputMode="decimal"
                                aria-label={`${t("buying.reorder.suggest")} ${r.name}`}
                                className="w-20 [&_input]:text-right"
                                value={qtyOf(r)}
                                disabled={out}
                                onChange={(e) => setQty((x) => ({ ...x, [r.productId]: e.target.value.trim() }))}
                              />
                              <span className="w-10 text-[12px] text-ink-3">{r.unitSymbol}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
