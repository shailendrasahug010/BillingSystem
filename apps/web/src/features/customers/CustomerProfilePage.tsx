import { buildReorderList, daysBetween, findState } from "@digitalbahi/core";
import { ArrowLeft, ClipboardPlus, MapPin, Pencil, Phone, Receipt, Wallet } from "lucide-react";
import { Tabs } from "radix-ui";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { BarList } from "../../components/charts/BarList";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Avatar, EmptyState } from "../../components/ui/misc";
import { allowed, customerById, PRODUCTS, productById, TODAY, WORKSPACE } from "../../data/db";
import { useCustomerInsight } from "../../data/hooks";
import { LIVE } from "../../data/source";
import { useStoreVersion } from "../../data/store";
import { useCustomerHistory } from "./useCustomerHistory";
import { cn } from "../../lib/cn";
import { shareOnWhatsApp } from "../../lib/share";
import { ApiError } from "../../lib/api";
import { useToast } from "../../components/ui/Toast";
import { AddCustomerDialog } from "./AddCustomerDialog";
import { editCustomer, NotKeptOffline } from "./saveCustomer";
import { translateError } from "@digitalbahi/i18n";
import { BEHAVIOUR_TONE } from "../invoice/CustomerCard";
import { customerKind, kindLabel } from "./customerKind";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";

/** The day (YYYY-MM-DD, this device's time zone) of an instant. */
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

/** What each tab shows, and the permission it needs. */
const TAB_PERMISSION = { overview: "customer.view", invoices: "invoice.view", payments: "payment.view", ledger: "customer.view_ledger", products: "customer.view" } as const;

/** The selling price list (Price A / B / C) this shop buys on; bills from now on use its prices. */
function PriceListPicker({ customerId, value }: { customerId: string; value: string | null | undefined }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!LIVE || WORKSPACE.priceLevels.length < 2) return null;
  const current = value ?? WORKSPACE.defaultPriceLevelId ?? "";
  const name = WORKSPACE.priceLevels.find((l) => l.id === current)?.name ?? "—";
  if (!allowed("customer.update")) {
    return (
      <span>
        {t("customer.priceList")}: <span className="font-medium text-ink-2">{name}</span>
      </span>
    );
  }
  const change = async (priceLevelId: string) => {
    setBusy(true);
    try {
      const { queued } = await editCustomer(customerId, { priceLevelId });
      const title = t("customer.priceListChanged", { name: WORKSPACE.priceLevels.find((l) => l.id === priceLevelId)?.name ?? "" });
      toast(queued ? { tone: "offline", title, body: t("offline.sendsLater") } : { tone: "success", title });
    } catch (e) {
      toast({ tone: "danger", title: e instanceof NotKeptOffline ? t("offline.notReadyWork") : translateError(i18n, e instanceof ApiError ? e : new ApiError(0, "generic")) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="inline-flex items-center gap-1.5">
      {t("customer.priceList")}:
      <select
        aria-label={t("customer.priceList")}
        value={current}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        className="h-7 rounded-md border border-line bg-surface px-1.5 text-[12.5px] font-medium text-ink focus:border-accent focus:outline-none"
      >
        {WORKSPACE.priceLevels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CustomerProfilePage({ customerId }: { customerId: string }) {
  const { t, money, compact, date, locale } = useI18n();
  const { navigate } = useRouter();
  const version = useStoreVersion();
  const [editing, setEditing] = useState(false);
  const customer = customerById.get(customerId);
  const insight = useCustomerInsight(customer ? customer.id : null);
  const { invoices, payments, ledger } = useCustomerHistory(customerId);
  const orderMultiples = useMemo(
    () => new Map(PRODUCTS.map((p) => [p.id, { id: p.id, name: p.name, active: true, stockQty: p.stock, orderMultiple: p.caseSize }])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const productName = (id: string) => {
    const p = productById.get(id);
    return p ? (locale === "hi" ? p.nameHi : p.name) : "—";
  };

  if (!customer || !insight) return <EmptyState title={t("empty.generic")} />;
  const state = findState(customer.stateCode);
  const top = [...insight.stats.values()]
    .map((s) => ({ id: s.productId, label: productName(s.productId), amount: s.totalQty.toNumber() * (s.lastRate?.toNumber() ?? 0) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
  const reorder = buildReorderList({ stats: insight.stats, products: orderMultiples }).slice(0, 8);

  const tile = (label: string, value: string, sub?: string, tone?: "danger") => (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card">
      <p className="text-[12.5px] text-ink-3">{label}</p>
      <p className={cn("num mt-1 font-display text-[21px] leading-tight font-semibold", tone === "danger" ? "text-danger" : "text-ink")}>{value}</p>
      {sub && <p className={cn("text-[12px]", tone === "danger" ? "text-danger" : "text-ink-3")}>{sub}</p>}
    </div>
  );

  const tabCls = "relative h-10 px-3 text-[13.5px] font-medium text-ink-3 whitespace-nowrap data-[state=active]:text-ink data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <button type="button" onClick={() => navigate({ name: "customers" })} className="mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink" aria-label={t("common.back")}>
            <ArrowLeft size={18} />
          </button>
          <Avatar name={customer.businessName} className="mt-0.5 size-12 text-[15px]" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[24px] leading-tight font-semibold text-ink">{customer.businessName}</h1>
              <Badge tone={customer.type === "b2b" || customerKind(customer) === "export" ? "accent" : "neutral"}>{t(kindLabel(customer))}</Badge>
              <Badge>{customer.category}</Badge>
              {customer.remindersOptOut && (
                <>
                  <Badge tone="warn">{t("customer.remindersStopped")}</Badge>
                  {customer.remindersOptOutAt && (
                    <span className="text-[12.5px] text-ink-3">{t(customer.remindersOptOutBy === "reply" ? "customer.remindersStoppedBy.reply" : "customer.remindersStoppedBy.staff", { date: localDay(customer.remindersOptOutAt) })}</span>
                  )}
                </>
              )}
            </div>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-3">
              <span>{customer.name}</span>
              <span className="num inline-flex items-center gap-1">
                <Phone size={12} /> {customer.mobile}
              </span>
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {customer.address}, {locale === "hi" ? state?.nameHi : state?.name} {customer.pincode}
              </span>
              {customer.gstin && <span className="font-mono text-[12px]">GSTIN {customer.gstin}</span>}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-[12.5px] text-ink-3">
              <span>
                {t("customer.route")}: {customer.route} · {t("customer.salesRep")}: {customer.salesRep} · {t("customer.creditDays")}: {customer.creditDays}
              </span>
              {LIVE && WORKSPACE.priceLevels.length > 1 && <span aria-hidden>·</span>}
              <PriceListPicker customerId={customer.id} value={customer.priceLevelId} />
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {customer.mobile && (
            <>
              <Button icon={<Phone size={16} />} title={customer.mobile} onClick={() => (window.location.href = `tel:${customer.mobile.replace(/\s/g, "")}`)}>
                {t("common.call")}
              </Button>
              <Button icon={<WhatsAppIcon size={16} />} onClick={() => shareOnWhatsApp("", customer.mobile)}>
                {t("common.whatsapp")}
              </Button>
            </>
          )}
          {LIVE && allowed("customer.update") && (
            <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
              {t("common.edit")}
            </Button>
          )}
          {allowed("payment.collect") && (
            <Button icon={<Wallet size={16} />} onClick={() => navigate(LIVE ? { name: "planned", module: "payments", action: "collect", partyId: customer.id } : { name: "planned", module: "payments" })}>
              {t("dashboard.actions.receivePayment")}
            </Button>
          )}
          {LIVE && allowed("order.create") && (
            <Button icon={<ClipboardPlus size={16} />} onClick={() => navigate({ name: "planned", module: "orders", action: "new", partyId: customer.id })}>
              {t("orders.new")}
            </Button>
          )}
          {allowed("invoice.create") && (
            <Button variant="primary" icon={<Receipt size={16} />} onClick={() => navigate({ name: "invoice-new", customerId: customer.id })}>
              {t("invoice.new")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {tile(t("customer.totalSales"), compact(insight.totalSales), `${insight.invoiceCount} ${t("customer.invoiceCount")}`)}
        {tile(t("customer.outstanding"), money(insight.outstanding, 0), insight.overdue > 0 ? t("dashboard.kpi.overdue", { amount: money(insight.overdue, 0) }) : undefined, insight.overdue > 0 ? "danger" : undefined)}
        {tile(t("customer.avgOrderValue"), money(insight.avgOrderValue, 0))}
        {tile(t("customer.lastPurchase"), insight.lastPurchase ? date(insight.lastPurchase) : "—", insight.lastPurchase ? t("common.daysAgo", { count: daysBetween(insight.lastPurchase, TODAY) }) : undefined)}
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card">
          <p className="text-[12.5px] text-ink-3">{t("customer.paymentBehaviour")}</p>
          <div className="mt-1.5">
            <Badge tone={BEHAVIOUR_TONE[insight.behaviour.rating]} dot>
              {t(`behaviour.${insight.behaviour.rating}`)}
            </Badge>
          </div>
          {insight.behaviour.avgDaysToPay !== null && <p className="mt-1 text-[12px] text-ink-3">{t("customer.avgDaysToPay", { days: Math.round(insight.behaviour.avgDaysToPay) })}</p>}
        </div>
      </div>

      <Tabs.Root defaultValue="overview" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={customer.businessName}>
          {(["overview", "invoices", "payments", "ledger", "products"] as const).filter((k) => allowed(TAB_PERMISSION[k])).map((k) => (
            <Tabs.Trigger key={k} value={k} className={tabCls}>
              {t(`customer.tabs.${k}`)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="overview" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("customer.mostPurchased")} />
            <div className="px-4 pt-3 pb-5 sm:px-5">
              <BarList ariaLabel={t("customer.mostPurchased")} items={top} format={(v) => compact(v)} />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("suggestions.reorder.title")} subtitle={t("suggestions.subtitle", { name: customer.businessName })} />
            <div className="scroll-x px-2 pt-2 pb-3">
              <table className="w-full text-[13px]">
                <thead className="text-left text-ink-3">
                  <tr>
                    <th className="px-2 py-2 font-medium">{t("suggestions.reorder.product")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("suggestions.reorder.lastQty")}</th>
                    <th className="px-2 py-2 font-medium">{t("suggestions.reorder.lastPurchase")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("suggestions.reorder.suggestedQty")}</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {reorder.map((r) => (
                    <tr key={r.productId} className="border-t border-line">
                      <td className="px-2 py-2">
                        <p className="text-ink">{locale === "hi" ? productById.get(r.productId)!.nameHi : productById.get(r.productId)!.name}</p>
                        <Badge tone={r.status === "overdue" ? "danger" : r.status === "due" ? "warn" : "neutral"} className="mt-0.5 h-5 text-[11px]">
                          {t(`suggestions.reorder.status.${r.status}`)}
                        </Badge>
                      </td>
                      <td className="px-2 py-2 text-right">{r.lastQty.toString()}</td>
                      <td className="px-2 py-2 text-ink-2">{t("common.daysAgo", { count: r.daysSinceLast })}</td>
                      <td className="px-2 py-2 text-right font-semibold text-ink">{r.suggestedQty.toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Tabs.Content>

        <Tabs.Content value="invoices">
          <Card className="scroll-x">
            <table className="w-full min-w-[600px] text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-4 py-2.5 font-medium">{t("invoice.number")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("common.date")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("invoice.dueDate")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("common.total")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("invoice.balance")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("common.status")}</th>
                </tr>
              </thead>
              <tbody className="num">
                {invoices.slice(0, 30).map((i) => {
                  const bal = i.cancelled ? 0 : i.total - i.paid;
                  const overdue = bal > 0.5 && i.dueDate < TODAY;
                  const status = i.cancelled ? "cancelled" : bal <= 0.5 ? "paid" : overdue ? "overdue" : i.paid > 0 ? "partial" : "unpaid";
                  return (
                    <tr key={i.id} onClick={() => navigate({ name: "invoice-view", invoiceId: i.id })} className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-2">
                      <td className="px-4 py-2.5 font-mono text-[12.5px] text-accent">{i.number}</td>
                      <td className="px-3 py-2.5 text-ink-2">{date(i.date)}</td>
                      <td className={cn("px-3 py-2.5", overdue ? "text-danger" : "text-ink-2")}>{date(i.dueDate)}</td>
                      <td className="px-3 py-2.5 text-right text-ink">{money(i.total)}</td>
                      <td className="px-3 py-2.5 text-right text-ink">{bal > 0.5 ? money(bal) : "—"}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={status === "paid" ? "good" : status === "overdue" ? "danger" : status === "partial" ? "warn" : "neutral"} dot>
                          {status === "cancelled" ? t("status.document.cancelled") : t(`status.payment.${status}`)}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </Tabs.Content>

        <Tabs.Content value="payments">
          <Card className="scroll-x">
            {payments.length === 0 ? (
              <EmptyState title={t("empty.generic")} />
            ) : (
              <table className="w-full min-w-[520px] text-[13.5px]">
                <thead>
                  <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                    <th className="px-4 py-2.5 font-medium">#</th>
                    <th className="px-3 py-2.5 font-medium">{t("common.date")}</th>
                    <th className="px-3 py-2.5 font-medium">{t("invoice.paymentMode")}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{t("common.amount")}</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {payments.slice(0, 30).map((p) => (
                    <tr key={p.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2.5 font-mono text-[12.5px] text-ink-2">{p.number}</td>
                      <td className="px-3 py-2.5 text-ink-2">{date(p.date)}</td>
                      <td className="px-3 py-2.5">
                        {t(`paymentMethod.${p.method}`)}
                        {p.reference && <span className="ml-2 font-mono text-[12px] text-ink-3">{p.reference}</span>}
                      </td>
                      <td className={cn("px-4 py-2.5 text-right font-medium", p.cancelled ? "text-ink-3 line-through" : "text-good")}>{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </Tabs.Content>

        <Tabs.Content value="ledger">
          <Card className="scroll-x">
            <table className="w-full min-w-[620px] text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-4 py-2.5 font-medium">{t("common.date")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("customer.ledger.particulars")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("customer.ledger.debit")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("customer.ledger.credit")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t("customer.ledger.runningBalance")}</th>
                </tr>
              </thead>
              <tbody className="num">
                {ledger.map((e) => (
                  <tr key={e.key} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-2.5 text-ink-2">{date(e.date)}</td>
                    <td className="px-3 py-2.5 text-ink">{e.label}</td>
                    <td className="px-3 py-2.5 text-right">{e.debit ? money(e.debit) : ""}</td>
                    <td className="px-3 py-2.5 text-right text-good">{e.credit ? money(e.credit) : ""}</td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {money(Math.abs(e.balance))} {e.balance < 0 ? "Cr" : "Dr"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Tabs.Content>

        <Tabs.Content value="products">
          <Card className="scroll-x">
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-4 py-2.5 font-medium">{t("invoice.product")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("customer.invoiceCount")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("invoice.qty")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("customer.lastPurchase")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("suggestions.tabs.reorder")}</th>
                </tr>
              </thead>
              <tbody className="num">
                {[...insight.stats.values()]
                  .sort((a, b) => b.orderCount - a.orderCount)
                  .map((s) => (
                    <tr key={s.productId} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2.5 text-ink">{productName(s.productId)}</td>
                      <td className="px-3 py-2.5 text-right">{s.orderCount}</td>
                      <td className="px-3 py-2.5 text-right">{s.totalQty.toString()}</td>
                      <td className="px-3 py-2.5 text-ink-2">
                        {date(s.lastPurchasedOn)} · {t("common.daysAgo", { count: s.daysSinceLast })}
                      </td>
                      <td className="px-4 py-2.5 text-ink-2">{s.typicalIntervalDays ? t("suggestions.reason.due", { intervalDays: Math.round(s.typicalIntervalDays), daysSince: s.daysSinceLast }) : "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>
        </Tabs.Content>
      </Tabs.Root>
      <AddCustomerDialog open={editing} onOpenChange={setEditing} customer={customer} />
    </div>
  );
}
