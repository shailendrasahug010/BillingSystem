import { translateError } from "@digitalbahi/i18n";
import { Cloud, CloudOff, LockKeyhole, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { useSession } from "../../app/session";
import { allowed, TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { peekOfflineNumber } from "../../offline/device";
import { kindOf, removeEntry, retryEntry, syncNow, useOffline, type OutboxEntry, type PaymentEntry, type QueuedEntry, type QueuedKind, type SyncedEntry } from "../../offline/sync";
import type { Route } from "../../app/router";
import { passwordOpens, rememberPassword, vaultOpen } from "../../offline/vault";
import { Field, Input } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/Confirm";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { useFieldLabels } from "../../features/notifications/notifications";

/** On a list screen: its kind of work still waiting on this device, and the way to see it. */
export function WaitingStrip({ kinds }: { kinds: QueuedKind[] }) {
  const { t } = useI18n();
  const state = useOffline();
  const [open, setOpen] = useState(false);
  const waiting = state.entries.filter((e) => kinds.includes(kindOf(e)));
  if (!waiting.length) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="press flex items-center gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-left text-[13px] text-warn" role="status">
        <CloudOff size={15} className="shrink-0" />
        <span className="flex-1">{t("offline.waitingHere", { count: waiting.length })}</span>
        <span className="font-semibold underline">{t("offline.see")}</span>
      </button>
      <OfflineBillsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Online / offline / syncing, with the count of bills waiting; opens the list. */
export function OfflineChip() {
  const { t } = useI18n();
  const state = useOffline();
  const [open, setOpen] = useState(false);
  const offline = state.offlineMode || !state.online;
  const waiting = state.entries.length;
  const failed = state.entries.some((e) => e.status === "failed");
  const label = offline ? t("sync.offline") : state.syncing ? t("sync.syncing") : t("sync.online");
  const Icon = offline ? CloudOff : state.syncing ? RefreshCw : Cloud;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
          offline ? "border-transparent bg-warn-soft text-warn" : "border-line bg-surface text-ink-2 hover:text-ink",
          // On a phone the chip shows only when there is something to say: offline, or bills waiting.
          !offline && waiting === 0 && !state.syncing && "max-sm:hidden",
        )}
        title={waiting > 0 ? t("sync.pending", { count: waiting }) : t("sync.synced")}
        aria-label={`${label}${waiting > 0 ? ` · ${t("sync.pending", { count: waiting })}` : ""}`}
      >
        <Icon size={14} className={cn(offline ? "text-warn" : "text-good", state.syncing && "animate-spin")} />
        <span className={offline ? undefined : "hidden sm:inline"}>{label}</span>
        {waiting > 0 && <span className={cn("num rounded-full px-1.5 text-[11px] text-white", failed ? "bg-danger" : "bg-warn")}>{waiting}</span>}
      </button>
      <OfflineBillsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** A thin strip over the page while there is no connection. */
export function OfflineBanner() {
  const { t } = useI18n();
  const state = useOffline();
  if (!state.offlineMode && state.online) return null;
  return (
    <div className="no-print flex items-center gap-2 bg-warn-soft px-4 py-1.5 text-[12.5px] text-warn" role="status">
      <CloudOff size={14} className="shrink-0" />
      {t("offline.banner")}
    </div>
  );
}

/** What an entry is, in a word or two. */
function useKindLabel() {
  const { t } = useI18n();
  return (e: Pick<QueuedEntry, "kind"> & Partial<Pick<PaymentEntry, "direction">>) => {
    const kind = kindOf(e);
    return kind === "payment" && e.direction === "out" ? t("offline.kinds.paymentOut") : t(`offline.kinds.${kind}`);
  };
}

function EntryRow({ entry, onOpen }: { entry: QueuedEntry; onOpen(): void }) {
  const i18n = useI18n();
  const { t, money, date } = i18n;
  const confirm = useConfirm();
  const label = useKindLabel();
  const failed = entry.status === "failed";
  const kind = kindOf(entry);
  const bill = kind === "invoice" ? (entry as OutboxEntry) : null;
  const name =
    entry.kind === "payment" || entry.kind === "return" || entry.kind === "price-note"
      ? entry.partyName
      : entry.kind === "purchase"
        ? `${entry.supplierName} · ${entry.billNumber}`
        : entry.kind === "expense"
          ? [entry.categoryName, entry.paidTo].filter(Boolean).join(" · ")
          : entry.kind === "invoice-cancel"
            ? `${entry.customerName} · ${entry.documentNumber}`
            : (entry as { customerName: string }).customerName;
  const amount =
    entry.kind === "payment"
      ? entry.amount
      : entry.kind === "order" || entry.kind === "return" || entry.kind === "price-note"
        ? entry.estimate
        : entry.kind === "collection-note"
          ? entry.amount
          : entry.kind === "purchase" || entry.kind === "expense"
            ? entry.total
            : entry.kind === "invoice-cancel"
              ? entry.amount
            : bill
              ? bill.total
              : null;
  const when = entry.kind === "payment" || entry.kind === "order" || entry.kind === "collection-note" || entry.kind === "purchase" || entry.kind === "expense" || entry.kind === "return" || entry.kind === "price-note" || entry.kind === "visit" ? entry.date : bill ? bill.date : null;
  const visit = entry.kind === "visit" ? (entry.outcome === "no_order" && entry.reason ? `${t("beat.outcome.no_order")}: ${t(`beat.reasons.${entry.reason as "other"}`)}` : t(`beat.outcome.${entry.outcome}`)) : null;
  const conflict = kind === "customer-edit" && entry.error?.code === "VERSION_CONFLICT";
  const removeText =
    kind === "invoice" ? t("offline.removeConfirm", { number: bill!.number }) : kind === "customer" ? t("offline.removeCustomerConfirm", { name }) : t("offline.removeEntryConfirm", { what: label(entry).toLowerCase(), name });
  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {bill ? (
          <button type="button" onClick={onOpen} className="font-mono text-[13.5px] font-semibold text-accent hover:underline">
            {bill.number}
          </button>
        ) : (
          <span className="text-[13.5px] font-semibold text-ink">{label(entry)}</span>
        )}
        <Badge tone={failed ? "danger" : "warn"} dot>
          {failed ? t("offline.failed") : t("offline.waiting")}
        </Badge>
        {amount !== null && amount > 0 && (
          <span className="num ml-auto text-[13.5px] font-medium text-ink">
            {entry.kind === "order" || entry.kind === "return" || entry.kind === "price-note" ? "≈ " : ""}
            {money(amount)}
          </span>
        )}
      </div>
      <p className="text-[12.5px] text-ink-3">
        {[name, when ? date(when) : null, entry.kind === "customer-edit" ? t("offline.detailsChanged") : null, visit].filter(Boolean).join(" · ")}
      </p>
      {failed && entry.error && (
        <>
          <p className="text-[12.5px] text-danger">{conflict ? t("offline.conflict") : translateError(i18n, new ApiError(entry.error.status, entry.error.code, entry.error.params))}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void retryEntry(entry.id)}>
              {conflict ? t("offline.keepMine") : t("offline.tryAgain")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void confirm({ title: t("offline.removeTitle"), body: removeText, confirmLabel: t("offline.remove"), danger: true }).then((ok) => {
                  if (ok) void removeEntry(entry.id);
                });
              }}
            >
              {t("offline.remove")}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * Signed in without typing the password (OTP, a restored session): the copy
 * on this device cannot open without internet until the password is
 * confirmed once, here, while online.
 */
function OpenOfflineSetup() {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const userId = useSession().user?.id;
  const [needed, setNeeded] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (userId && vaultOpen(userId)) void passwordOpens(userId).then((opens) => setNeeded(!opens));
  }, [userId]);
  if (!needed || !userId) return null;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/check", { password });
      if (await rememberPassword(userId, password)) {
        setNeeded(false);
        toast({ tone: "success", title: t("offline.passwordSetup.done") });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setPassword("");
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
    >
      <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <LockKeyhole size={14} aria-hidden />
        {t("offline.passwordSetup.title")}
      </p>
      <p className="text-[12.5px] text-ink-3">{t("offline.passwordSetup.body")}</p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label={t("auth.password")} htmlFor="offline-password" error={error ? translateError(i18n, error) : null}>
            <Input id="offline-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" size="md" disabled={busy || !password}>
          {t("offline.passwordSetup.confirm")}
        </Button>
      </div>
    </form>
  );
}

/** Where something the server took can be seen now. */
function syncedRoute(s: SyncedEntry): Route | null {
  switch (kindOf(s)) {
    case "invoice":
      return { name: "invoice-view", invoiceId: s.serverId };
    case "order":
      return { name: "order-view", orderId: s.serverId };
    case "customer":
    case "customer-edit":
      return { name: "customer", customerId: s.serverId };
    case "purchase":
      return { name: "purchase-view", purchaseId: s.serverId };
    default:
      return null;
  }
}

export function OfflineBillsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money, date } = useI18n();
  const { navigate } = useRouter();
  const state = useOffline();
  const offline = state.offlineMode || !state.online;
  const label = useKindLabel();
  const fieldLabels = useFieldLabels();
  const go = (route: Route) => {
    onOpenChange(false);
    navigate(route);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("offline.title")} description={t("offline.description")} size="md" closeLabel={t("common.close")}>
      <div className="flex flex-col gap-4">
        {/* Only people who bill have a device series. */}
        {allowed("invoice.create") && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
            {state.device?.seriesCode ? t("offline.device", { code: state.device.seriesCode, number: peekOfflineNumber(state.device, TODAY) }) : t("offline.noDevice")}
          </p>
        )}
        {!offline && <OpenOfflineSetup />}
        {state.entries.length === 0 ? (
          <p className="text-[13.5px] text-ink-3">{t("offline.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {state.entries.map((e) => (
              <EntryRow key={e.id} entry={e} onOpen={() => go({ name: "invoice-view", invoiceId: `offline:${e.id}` })} />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] text-ink-3">{state.lastSyncAt ? t("sync.lastSynced", { time: new Date(state.lastSyncAt).toLocaleTimeString() }) : ""}</span>
          <Button
            variant="primary"
            icon={<RefreshCw size={15} className={cn(state.syncing && "animate-spin")} />}
            disabled={offline || state.syncing || !state.entries.some((e) => e.status === "pending")}
            onClick={() => void syncNow()}
          >
            {t("offline.syncNow")}
          </Button>
        </div>
        {state.synced.length > 0 && (
          <section className="flex flex-col gap-1 border-t border-line pt-3">
            <h3 className="text-[13px] font-semibold text-ink-2">{t("offline.recent")}</h3>
            <ul className="flex flex-col">
              {state.synced.slice(0, 8).map((s) => {
                const kind = kindOf(s);
                const route = syncedRoute(s);
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-x-2 py-1 text-[12.5px] text-ink-3">
                    {kind !== "invoice" && <span className="text-ink-2">{label(s)}</span>}
                    {route && kind !== "customer-edit" ? (
                      <button type="button" onClick={() => go(route)} className="font-mono font-medium text-accent hover:underline">
                        {s.serverNumber}
                      </button>
                    ) : kind === "payment" || kind === "expense" || kind === "return" ? (
                      <span className="font-mono font-medium text-ink-2">{s.serverNumber}</span>
                    ) : null}
                    {kind === "invoice" && s.serverNumber !== s.number && (
                      <span>
                        ({t("offline.savedAs", { number: s.serverNumber })} · {s.number})
                      </span>
                    )}
                    {route && kind === "customer-edit" ? (
                      <button type="button" onClick={() => go(route)} className="font-medium text-accent hover:underline">
                        {s.customerName}
                      </button>
                    ) : (
                      <span>{s.customerName}</span>
                    )}
                    {s.serverTotal > 0 && <span className="num ml-auto">{money(s.serverTotal)}</span>}
                    {kind === "invoice" && Math.abs(s.serverTotal - s.total) >= 0.01 && <span className="w-full text-warn">{t("offline.totalChanged", { amount: money(s.serverTotal) })}</span>}
                    {s.held && <span className="w-full text-warn">{t("offline.heldForReview")}</span>}
                    {s.kept && s.kept.length > 0 && <span className="w-full text-warn">{t("offline.editKept", { fields: fieldLabels(s.kept) })}</span>}
                    <span className="sr-only">{date(s.syncedAt.slice(0, 10))}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
