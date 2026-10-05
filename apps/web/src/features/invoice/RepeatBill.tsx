import { nextRepeatDate, type RepeatFrequency } from "@digitalbahi/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Repeat, Trash2 } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY } from "../../data/db";
import { api } from "../../lib/api";

export interface RepeatRow {
  id: string;
  customerId: string;
  customerName: string;
  frequency: RepeatFrequency;
  anchorDay: number;
  nextDate: string;
  endDate: string | null;
  isActive: boolean;
  billsMade: number;
  lastError: string | null;
  sourceInvoiceId: string | null;
  sourceNumber: string | null;
  lastInvoiceId: string | null;
  lastNumber: string | null;
  amount: string | null;
}

const KEY = ["repeat-bills"];

export function useRepeatBills(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<{ data: RepeatRow[] }>("/repeat-bills").then((r) => r.data), enabled });
}

/** Whether it ran to its end date (as against paused). */
const ended = (r: RepeatRow) => !r.isActive && r.endDate !== null && r.nextDate > r.endDate;

/** "Every month on the 5th", "Every week on Monday". */
function useEvery() {
  const { t, locale } = useI18n();
  return (r: Pick<RepeatRow, "frequency" | "anchorDay" | "nextDate">) => {
    if (r.frequency === "weekly") {
      const day = new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { weekday: "long", timeZone: "UTC" }).format(new Date(`${r.nextDate}T00:00:00Z`));
      return t("repeat.everyWeek", { day });
    }
    return t("repeat.everyMonth", { day: r.anchorDay });
  };
}

/** "Repeat this bill": every week or month from a start date, until stopped or an end date. */
export function RepeatBillButton({ invoiceId, number }: { invoiceId: string; number: string }) {
  const { t, dateMedium } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const every = useEvery();
  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState<RepeatFrequency>("monthly");
  const [start, setStart] = useState(() => nextRepeatDate("monthly", TODAY, Number(TODAY.slice(8, 10))));
  const [end, setEnd] = useState("");
  const existing = useRepeatBills(open).data?.filter((r) => r.sourceInvoiceId === invoiceId && r.isActive) ?? [];
  const save = useMutation({
    mutationFn: () => api.post<RepeatRow>("/repeat-bills", { invoiceId, frequency, startDate: start, ...(end ? { endDate: end } : {}) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      setOpen(false);
      toast({ tone: "success", title: t("repeat.saved", { number }), body: `${every(r)} · ${t("repeat.nextOn", { date: dateMedium(r.nextDate) })}` });
    },
  });
  const pick = (f: RepeatFrequency) => {
    setFrequency(f);
    setStart(nextRepeatDate(f, TODAY, Number(TODAY.slice(8, 10))));
  };

  return (
    <>
      <Button icon={<Repeat size={16} />} title={t("repeat.hint")} onClick={() => setOpen(true)}>
        {t("repeat.button")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) save.reset();
        }}
        title={t("repeat.title", { number })}
        description={t("repeat.hint")}
        closeLabel={t("common.close")}
        footer={
          <Button variant="primary" disabled={save.isPending || !start || (Boolean(end) && end < start)} onClick={() => save.mutate()}>
            {save.isPending ? t("common.saving") : t("repeat.start")}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          {existing.length > 0 && (
            <p className="rounded-xl bg-accent-soft px-3.5 py-2.5 text-[13px] text-accent-ink" role="status">
              {t("repeat.already", { every: every(existing[0]!), date: dateMedium(existing[0]!.nextDate) })}
            </p>
          )}
          <Segmented
            label={t("repeat.how")}
            value={frequency}
            onChange={pick}
            options={[
              { value: "monthly", label: t("repeat.monthly") },
              { value: "weekly", label: t("repeat.weekly") },
            ]}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("repeat.firstOn")} htmlFor="repeat-start" hint={start ? every({ frequency, anchorDay: Number(start.slice(8, 10)), nextDate: start }) : undefined}>
              <Input id="repeat-start" type="date" min={TODAY} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label={t("repeat.until")} htmlFor="repeat-end" hint={t("repeat.untilHint")}>
              <Input id="repeat-end" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <p className="text-[12.5px] text-ink-3">{t("repeat.howItWorks")}</p>
          <ErrorNote error={save.error} />
        </div>
      </Dialog>
    </>
  );
}

/** Every repeat bill, to pause, start again or stop. */
export function RepeatBillsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t, has, money, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const qc = useQueryClient();
  const every = useEvery();
  const list = useRepeatBills(open);
  const canEdit = allowed("invoice.create");
  const confirm = useConfirm();
  const change = useMutation({
    mutationFn: (v: { id: string; isActive?: boolean; remove?: boolean }) =>
      v.remove ? api.delete(`/repeat-bills/${v.id}`) : api.patch(`/repeat-bills/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const rows = list.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("repeat.listTitle")} description={t("repeat.listHint")} size="lg" closeLabel={t("common.close")}>
      <div className="flex flex-col gap-3">
        <ErrorNote error={list.error ?? change.error} />
        {list.isPending ? (
          <p className="text-[13px] text-ink-3">{t("common.loading")}</p>
        ) : rows.length === 0 ? (
          <EmptyState title={t("repeat.empty")} hint={t("repeat.emptyHint")} />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line" aria-label={t("repeat.listTitle")}>
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center" data-repeat={r.id}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-ink">{r.customerName}</span>
                    {r.amount && <span className="num text-[13px] text-ink-2">{money(r.amount)}</span>}
                    <Badge tone={r.isActive ? (r.lastError ? "warn" : "good") : "neutral"}>
                      {r.isActive ? (r.lastError ? t("repeat.status.stuck") : t("repeat.status.on")) : ended(r) ? t("repeat.status.ended") : t("repeat.status.paused")}
                    </Badge>
                  </div>
                  <p className="text-[12.5px] text-ink-3">
                    {every(r)}
                    {r.isActive && ` · ${t("repeat.nextOn", { date: dateMedium(r.nextDate) })}`}
                    {r.endDate && ` · ${t("repeat.endsOn", { date: dateMedium(r.endDate) })}`}
                    {` · ${t("repeat.made", { count: r.billsMade })}`}
                  </p>
                  {r.isActive && r.lastError && <p className="text-[12.5px] text-warn">{has(`errors.${r.lastError}`) ? t(`errors.${r.lastError as "generic"}`) : t("errors.REPEAT_BILL_FAILED")}</p>}
                  <p className="text-[12.5px] text-ink-3">
                    {r.sourceNumber && r.sourceInvoiceId && (
                      <button type="button" className="text-accent hover:underline" onClick={() => (onOpenChange(false), navigate({ name: "invoice-view", invoiceId: r.sourceInvoiceId! }))}>
                        {t("repeat.from", { number: r.sourceNumber })}
                      </button>
                    )}
                    {r.lastNumber && r.lastInvoiceId && (
                      <>
                        {" · "}
                        <button type="button" className="text-accent hover:underline" onClick={() => (onOpenChange(false), navigate({ name: "invoice-view", invoiceId: r.lastInvoiceId! }))}>
                          {t("repeat.last", { number: r.lastNumber })}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    {!ended(r) && (
                      <Button size="sm" icon={r.isActive ? <Pause size={15} /> : <Play size={15} />} disabled={change.isPending} onClick={() => change.mutate({ id: r.id, isActive: !r.isActive })}>
                        {r.isActive ? t("repeat.pause") : t("repeat.resume")}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} aria-label={t("repeat.remove", { name: r.customerName })} disabled={change.isPending} onClick={() =>
                        void confirm({ title: t("repeat.removeTitle", { name: r.customerName }), body: t("repeat.removeMessage"), confirmLabel: t("repeat.removeConfirm"), danger: true }).then(
                          (yes) => yes && change.mutate({ id: r.id, remove: true }),
                        )
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
