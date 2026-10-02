import { useQueryClient } from "@tanstack/react-query";
import { VISIT_REASONS } from "@digitalbahi/contracts";
import { translateError } from "@digitalbahi/i18n";
import { ClipboardList, MapPinCheck, MessageCircle, Phone, Receipt, UserRound, Wallet, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS } from "../../data/db";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { shareOnWhatsApp, whatsappNumber } from "../../lib/share";
import { OrderEntryDialog } from "../orders/OrderEntryDialog";
import { ProvisionalReceiptDialog } from "../outstanding/ProvisionalReceiptDialog";
import { PaymentDialog, type SavedPayment } from "../payments/PaymentDialog";
import { PaymentDetailDialog } from "../payments/PaymentsPage";
import { CallBadge } from "./CallBadge";
import { recordVisit, type BeatCustomer } from "./data";

type Stage = "sheet" | "order" | "collect" | "no-order";
type Reason = (typeof VISIT_REASONS)[number];

/**
 * One shop on the beat: what it owes, what it is due to buy again (with the
 * usual quantity), and what to do there: a bill, an order (started with the
 * due products), a payment, "no order" and why, or just checked in. Without
 * a connection each is kept on the phone and sent later.
 */
export function BeatCustomerSheet({ customer, date, working, onClose }: { customer: BeatCustomer; date: string; working: boolean; onClose(): void }) {
  const i18n = useI18n();
  const { t, money, number } = i18n;
  const { navigate } = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>("sheet");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [provisional, setProvisional] = useState<Extract<SavedPayment, { offline: unknown }>["offline"] | null>(null);
  const [busy, setBusy] = useState(false);
  const due = customer.reorder.products;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["beat"] });

  const visited = async () => {
    setBusy(true);
    try {
      const how = await recordVisit({ customer, routeId: customer.routeId, date, outcome: "visited", reason: null, note: "" });
      toast(how === "kept" ? { tone: "offline", title: t("offline.savedHere"), body: `${t("beat.visitSaved")} · ${t("offline.sendsLater")}` } : { tone: "success", title: t("beat.visitSaved"), body: customer.name });
      refresh();
      onClose();
    } catch (e) {
      toast({ tone: "danger", title: t("beat.notSaved"), body: e instanceof ApiError ? translateError(i18n, e) : undefined });
    } finally {
      setBusy(false);
    }
  };

  // A chat with the shop; with what it owes when it owes something.
  const whatsapp = () => shareOnWhatsApp(customer.balance > 0.5 ? t("messages.reminderBalance", { party: customer.name, business: BUSINESS.name, balance: money(customer.balance) }) : "", customer.mobile);

  return (
    <>
      <Dialog
        open={stage === "sheet"}
        onOpenChange={(v) => !v && onClose()}
        title={customer.name}
        description={[customer.city, customer.mobile].filter(Boolean).join(" · ") || undefined}
        closeLabel={t("common.close")}
      >
        <div className="flex flex-col gap-4">
          {customer.today && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
              {t("beat.today")}: <CallBadge call={customer.today} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-line bg-surface-2/60 px-3 py-2">
              <p className="text-[12px] text-ink-3">{t("beat.owes")}</p>
              <p className="num text-[17px] font-semibold text-ink">{money(customer.balance, 0)}</p>
              {customer.overdue > 0.5 && <p className="num text-[12px] text-danger">{t("dashboard.kpi.overdue", { amount: money(customer.overdue, 0) })}</p>}
            </div>
            <div className="rounded-2xl border border-line bg-surface-2/60 px-3 py-2">
              <p className="text-[12px] text-ink-3">{t("beat.lastCallLabel")}</p>
              <p className="text-[15px] font-semibold text-ink">{customer.lastCallOn ? t("common.daysAgo", { count: customer.daysSinceCall ?? 0 }) : t("beat.neverCalled")}</p>
              {customer.typicalVisitIntervalDays ? <p className="text-[12px] text-ink-3">{t("beat.buysEvery", { count: customer.typicalVisitIntervalDays })}</p> : null}
            </div>
          </div>

          {/* What the shop is due to buy again, with the quantity it usually takes. */}
          <section aria-label={t("beat.dueTitle")}>
            <h3 className="mb-1.5 text-[13px] font-semibold text-ink">{t("beat.dueTitle")}</h3>
            {due.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("beat.nothingDue")}</p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
                {due.map((p) => (
                  <li key={p.productId} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-ink">{p.productName}</p>
                      <p className="text-[12px] text-ink-3">{t("beat.dueLine", { days: p.daysSinceLast, every: p.typicalIntervalDays, qty: number(p.lastQty) })}</p>
                    </div>
                    <Badge tone={p.status === "overdue" ? "warn" : p.status === "due" ? "accent" : "neutral"}>{t(`beat.reorder.${p.status}`)}</Badge>
                    <span className="num w-12 text-right text-[14px] font-semibold text-ink">{number(p.suggestedQty)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid grid-cols-2 gap-2">
            {allowed("invoice.create") && (
              <Button variant="primary" icon={<Receipt size={16} />} onClick={() => navigate({ name: "invoice-new", customerId: customer.id })}>
                {t("beat.newBill")}
              </Button>
            )}
            {allowed("order.create") && (
              <Button variant={allowed("invoice.create") ? "soft" : "primary"} icon={<ClipboardList size={16} />} onClick={() => setStage("order")}>
                {due.length ? t("beat.orderDue", { count: due.length }) : t("beat.newOrder")}
              </Button>
            )}
            {allowed("payment.collect") && (
              <Button icon={<Wallet size={16} />} onClick={() => setStage("collect")}>
                {t("beat.collect")}
              </Button>
            )}
            <Button icon={<XCircle size={16} />} onClick={() => setStage("no-order")}>
              {t("beat.noOrder")}
            </Button>
            <Button icon={<MapPinCheck size={16} />} disabled={busy} onClick={() => void visited()}>
              {t("beat.checkIn")}
            </Button>
            <Button icon={<UserRound size={16} />} onClick={() => navigate({ name: "customer", customerId: customer.id })}>
              {t("beat.profile")}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button size="sm" icon={<Phone size={15} />} disabled={!customer.mobile} onClick={() => (window.location.href = `tel:${(customer.mobile ?? "").replace(/\s/g, "")}`)}>
              {t("common.call")}
            </Button>
            <Button size="sm" icon={<MessageCircle size={15} />} disabled={!whatsappNumber(customer.mobile)} onClick={whatsapp}>
              WhatsApp
            </Button>
          </div>
          {working && <p className="text-[12.5px] text-warn">{t("beat.keptHere")}</p>}
        </div>
      </Dialog>

      {stage === "order" && (
        <OrderEntryDialog
          open
          stay
          customerId={customer.id}
          initialLines={due.map((p) => ({ productId: p.productId, qty: p.suggestedQty }))}
          onSaved={() => {
            refresh();
            onClose();
          }}
          onOpenChange={(v) => !v && setStage("sheet")}
        />
      )}
      {stage === "collect" && (
        <PaymentDialog
          direction="in"
          partyId={customer.id}
          initialAmount={(customer.overdue > 0.5 ? customer.overdue : Math.max(0, customer.balance)).toFixed(2)}
          open
          onOpenChange={(v) => !v && setStage("sheet")}
          onSaved={(saved) => {
            refresh();
            if ("offline" in saved) setProvisional(saved.offline);
            else setReceiptId(saved.id);
          }}
        />
      )}
      <NoOrderDialog
        open={stage === "no-order"}
        onOpenChange={(v) => !v && setStage("sheet")}
        onSave={async (reason, note) => {
          const how = await recordVisit({ customer, routeId: customer.routeId, date, outcome: "no_order", reason, note });
          toast(how === "kept" ? { tone: "offline", title: t("offline.savedHere"), body: `${t("beat.noOrderSaved")} · ${t("offline.sendsLater")}` } : { tone: "success", title: t("beat.noOrderSaved"), body: `${customer.name} · ${t(`beat.reasons.${reason}`)}` });
          refresh();
          onClose();
        }}
      />
      {receiptId && <PaymentDetailDialog paymentId={receiptId} onClose={() => setReceiptId(null)} />}
      <ProvisionalReceiptDialog payment={provisional} mobile={customer.mobile} onClose={() => setProvisional(null)} />
    </>
  );
}

/** Why there was no order: one of the usual reasons, and a note. */
function NoOrderDialog({ open, onOpenChange, onSave }: { open: boolean; onOpenChange(v: boolean): void; onSave(reason: Reason, note: string): Promise<void> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!open) return;
    setReason(null);
    setNote("");
    setError(null);
  }, [open]);
  const save = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(reason, note);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("beat.noOrderTitle")}
      description={t("beat.noOrderHint")}
      size="sm"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!reason || busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {error.code === "OFFLINE_NOT_KEPT" ? t("offline.notReadyWork") : translateError(i18n, error)}
          </p>
        )}
        <div role="radiogroup" aria-label={t("common.reason")} className="grid grid-cols-2 gap-2">
          {VISIT_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              onClick={() => setReason(r)}
              className={cn(
                "press min-h-11 rounded-xl border px-3 py-2 text-left text-[13.5px] font-medium",
                reason === r ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong",
              )}
            >
              {t(`beat.reasons.${r}`)}
            </button>
          ))}
        </div>
        <Field label={t("beat.note")} htmlFor="visit-note">
          <Input id="visit-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("beat.notePlaceholder")} />
        </Field>
      </div>
    </Dialog>
  );
}
