import { translateError } from "@vyapaar/i18n";
import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { TODAY } from "../../data/db";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { peekOfflineNumber } from "../../offline/device";
import { removeBill, retryBill, syncNow, useOffline, type OutboxEntry } from "../../offline/sync";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

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
        )}
        title={waiting > 0 ? t("sync.pending", { count: waiting }) : t("sync.synced")}
        aria-label={`${label}${waiting > 0 ? ` · ${t("sync.pending", { count: waiting })}` : ""}`}
      >
        <Icon size={14} className={cn(offline ? "text-warn" : "text-good", state.syncing && "animate-spin")} />
        <span className="hidden sm:inline">{label}</span>
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

function EntryRow({ entry, onOpen }: { entry: OutboxEntry; onOpen(): void }) {
  const i18n = useI18n();
  const { t, money, date } = i18n;
  const failed = entry.status === "failed";
  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onOpen} className="font-mono text-[13.5px] font-semibold text-accent hover:underline">
          {entry.number}
        </button>
        <Badge tone={failed ? "danger" : "warn"} dot>
          {failed ? t("offline.failed") : t("offline.waiting")}
        </Badge>
        <span className="num ml-auto text-[13.5px] font-medium text-ink">{money(entry.total)}</span>
      </div>
      <p className="text-[12.5px] text-ink-3">
        {entry.customerName} · {date(entry.date)}
      </p>
      {failed && entry.error && (
        <>
          <p className="text-[12.5px] text-danger">{translateError(i18n, new ApiError(entry.error.status, entry.error.code, entry.error.params))}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void retryBill(entry.id)}>
              {t("offline.tryAgain")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t("offline.removeConfirm", { number: entry.number }))) void removeBill(entry.id);
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

export function OfflineBillsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, money, date } = useI18n();
  const { navigate } = useRouter();
  const state = useOffline();
  const offline = state.offlineMode || !state.online;
  const show = (invoiceId: string) => {
    onOpenChange(false);
    navigate({ name: "invoice-view", invoiceId });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("offline.title")} description={t("offline.description")} size="md" closeLabel={t("common.close")}>
      <div className="flex flex-col gap-4">
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
          {state.device ? t("offline.device", { code: state.device.seriesCode, number: peekOfflineNumber(state.device, TODAY) }) : t("offline.noDevice")}
        </p>
        {state.entries.length === 0 ? (
          <p className="text-[13.5px] text-ink-3">{t("offline.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {state.entries.map((e) => (
              <EntryRow key={e.id} entry={e} onOpen={() => show(`offline:${e.id}`)} />
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
              {state.synced.slice(0, 8).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-2 py-1 text-[12.5px] text-ink-3">
                  <button type="button" onClick={() => show(s.serverId)} className="font-mono font-medium text-accent hover:underline">
                    {s.serverNumber}
                  </button>
                  {s.serverNumber !== s.number && <span>({t("offline.savedAs", { number: s.serverNumber })} · {s.number})</span>}
                  <span>{s.customerName}</span>
                  <span className="num ml-auto">{money(s.serverTotal)}</span>
                  {Math.abs(s.serverTotal - s.total) >= 0.01 && <span className="w-full text-warn">{t("offline.totalChanged", { amount: money(s.serverTotal) })}</span>}
                  <span className="sr-only">{date(s.syncedAt.slice(0, 10))}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
