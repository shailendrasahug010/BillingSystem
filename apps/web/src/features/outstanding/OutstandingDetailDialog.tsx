import { CalendarClock, ChevronRight, NotebookPen, Phone, Printer, UserRound, Wallet } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Avatar, Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { allowed, BUSINESS, TODAY } from "../../data/db";
import { LIVE } from "../../data/source";
import { cn } from "../../lib/cn";
import { shareOnWhatsApp, whatsappNumber } from "../../lib/share";
import { PaymentDialog, type SavedPayment } from "../payments/PaymentDialog";
import { PaymentDetailDialog } from "../payments/PaymentsPage";
import { CollectionNoteDialog } from "./CollectionNoteDialog";
import { useOutstandingDetail, type OutstandingRow, type PayPromise } from "./data";
import { OutstandingStatementPrint } from "./OutstandingPrint";
import { ProvisionalReceiptDialog } from "./ProvisionalReceiptDialog";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";

/** "Promised ₹1,000 by 3 Oct", or "Promise missed: 28 Sep" once the day has passed. */
export function PromiseLine({ promise, className }: { promise: PayPromise; className?: string }) {
  const { t, money, date } = useI18n();
  const missed = promise.date < TODAY;
  return (
    <span className={cn("inline-flex items-center gap-1", missed ? "text-danger" : "text-accent-ink", className)}>
      <CalendarClock size={13} className="shrink-0" aria-hidden />
      {missed
        ? t("collect.promiseMissed", { date: date(promise.date) })
        : promise.amount !== null
          ? t("collect.promised", { amount: money(promise.amount, 0), date: date(promise.date) })
          : t("collect.promisedFull", { date: date(promise.date) })}
    </span>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "danger" | "accent" }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-2xl border px-3.5 py-2.5", tone === "accent" ? "border-transparent bg-accent-soft" : tone === "danger" ? "border-transparent bg-danger-soft" : "border-line bg-surface-2/60")}>
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className={cn("num font-display text-[18px] leading-tight font-semibold", tone === "danger" ? "text-danger" : tone === "accent" ? "text-accent-ink" : "text-ink")}>{value}</span>
      {sub && <span className="num text-[11.5px] text-ink-3">{sub}</span>}
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{children}</h3>;
}

/**
 * Everything a collector needs at the shop: whom to call, how much is due and
 * since when, bill by bill, the last payments, and the buttons to take a
 * payment, print the dues or open the customer.
 */
export function OutstandingDetailDialog({ row, source, onOpenChange }: { row: OutstandingRow | null; source: "server" | "device"; onOpenChange(open: boolean): void }) {
  const { t, money, date, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const [stage, setStage] = useState<"sheet" | "collect" | "note">("sheet");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [provisional, setProvisional] = useState<Extract<SavedPayment, { offline: unknown }>["offline"] | null>(null);
  const { detail: d, loading, error } = useOutstandingDetail(row, source);
  const open = row !== null;
  const onSheet = open && stage === "sheet" && !receiptId && !provisional;
  const canCollect = LIVE && allowed("payment.collect");
  const promise = d?.promise ?? row?.promise ?? null;
  const c = d?.customer;
  const mobile = c?.mobile ?? row?.mobile ?? null;

  const remind = () => {
    if (!row) return;
    const params = {
      party: row.name,
      business: BUSINESS.name,
      balance: money(d?.outstanding ?? row.outstanding),
      overdue: money(d?.overdue ?? row.overdue),
      since: row.oldestDueDate ? dateMedium(row.oldestDueDate) : "",
    };
    shareOnWhatsApp(Number(d?.overdue ?? row.overdue) > 0 && row.oldestDueDate ? t("messages.reminder", params) : t("messages.reminderBalance", params), mobile);
  };
  const maxAging = Math.max(1, ...(d?.aging ?? []).map((a) => Number(a.amount)));

  return (
    <>
      <Dialog
        open={onSheet}
        onOpenChange={onOpenChange}
        size="lg"
        closeLabel={t("common.close")}
        title={row?.name ?? ""}
        description={row ? [row.contactName, row.code, row.city, row.route].filter(Boolean).join(" · ") : undefined}
        footer={
          row && (
            <>
              <Button icon={<Printer size={16} />} disabled={!d} onClick={() => window.print()}>
                {t("common.print")}
              </Button>
              {allowed("customer.view") && (
                <Button icon={<UserRound size={16} />} onClick={() => navigate({ name: "customer", customerId: row.customerId })}>
                  {t("collect.openCustomer")}
                </Button>
              )}
              {canCollect && (
                <Button variant="primary" icon={<Wallet size={16} />} onClick={() => setStage("collect")}>
                  {t("payment.receive")}
                </Button>
              )}
            </>
          )
        }
      >
        {row && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Avatar name={row.name} className="size-12 text-[15px]" />
              <div className="min-w-0 flex-1 text-[13px] text-ink-2">
                {mobile && <p className="num font-medium text-ink">{mobile}</p>}
                {(c?.address ?? row.address) && <p className="truncate">{c?.address ?? row.address}</p>}
                <p className="truncate">{[c?.city ?? row.city, c?.pincode].filter(Boolean).join(" ")}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Phone size={15} />} disabled={!mobile} onClick={() => (window.location.href = `tel:${(mobile ?? "").replace(/\s/g, "")}`)}>
                {t("common.call")}
              </Button>
              <Button size="sm" icon={<WhatsAppIcon size={15} />} disabled={!whatsappNumber(mobile)} onClick={remind}>
                {t("collect.remind")}
              </Button>
              {canCollect && (
                <Button size="sm" icon={<NotebookPen size={15} />} onClick={() => setStage("note")}>
                  {t("collect.notPaid")}
                </Button>
              )}
            </div>
            {promise && (
              <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-3.5 py-2.5 text-[13.5px] font-medium", promise.date < TODAY ? "bg-danger-soft" : "bg-accent-soft")}>
                <PromiseLine promise={promise} />
                {promise.note && <span className="font-normal text-ink-2">· {promise.note}</span>}
              </p>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Figure label={t("collect.toCollect")} value={money(d?.outstanding ?? row.outstanding)} tone="accent" />
              <Figure label={t("collect.overdue")} value={money(d?.overdue ?? row.overdue)} {...(Number(d?.overdue ?? row.overdue) > 0 ? { tone: "danger" as const } : {})} />
              <Figure label={t("collect.notDue")} value={money(d?.notDue ?? Math.max(0, row.outstanding - row.overdue))} />
              <Figure label={t("collect.lastPayment")} value={row.lastPaymentAmount !== null ? money(row.lastPaymentAmount, 0) : "—"} {...(row.lastPaymentDate ? { sub: date(row.lastPaymentDate) } : {})} />
            </div>

            {c && (
              <p className="text-[13px] text-ink-2">
                <span className="font-medium text-ink">{t("collect.terms")}:</span> {c.creditDays > 0 ? t("collect.creditTerms", { count: c.creditDays }) : t("collect.cashTerms")}
                {c.creditLimit && Number(c.creditLimit) > 0 && ` · ${t("collect.limit", { amount: money(c.creditLimit, 0) })}`}
              </p>
            )}

            <ErrorNote error={error} />
            {loading ? (
              <div className="flex flex-col gap-2" role="status" aria-label={t("common.loading")}>
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              d && (
                <>
                  {d.aging.some((a) => Number(a.amount) > 0) && (
                    <section>
                      <SectionTitle>{t("collect.aging")}</SectionTitle>
                      <div className="flex flex-col gap-1.5">
                        {d.aging.map((a, i) => (
                          <div key={a.label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-[12.5px]">
                            <span className="text-ink-2">{t("reports.bucket", { label: a.label })}</span>
                            <span className="h-2 overflow-hidden rounded-full bg-surface-2">
                              <span className={cn("block h-full rounded-full", i === 0 ? "bg-warn" : "bg-danger")} style={{ width: `${(Number(a.amount) / maxAging) * 100}%` }} />
                            </span>
                            <span className="num text-right font-medium text-ink">{Number(a.amount) > 0 ? money(a.amount, 0) : "—"}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  <section>
                    <SectionTitle>{t("collect.openBills")}</SectionTitle>
                    {d.bills === null ? (
                      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-3">{t("collect.billsNeedInternet")}</p>
                    ) : d.bills.length === 0 ? (
                      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-3">{t("collect.noOpenBills")}</p>
                    ) : (
                      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
                        {d.bills.map((b) => {
                          const canOpen = LIVE && allowed("invoice.view");
                          const body = (
                            <>
                              <div className="min-w-0 flex-1">
                                <p className="font-mono text-[13px] font-medium text-ink">{b.number}</p>
                                <p className="num text-[12px] text-ink-3">
                                  {date(b.date)} · {t("collect.dueDate")} {date(b.dueDate)}
                                </p>
                              </div>
                              <div className="flex flex-col items-end gap-1 text-right">
                                <span className="num text-[14px] font-semibold text-ink">{money(b.balance)}</span>
                                {b.daysOverdue > 0 ? (
                                  <Badge tone="danger" className="h-5 text-[11px]">
                                    {t("collect.daysLate", { count: b.daysOverdue })}
                                  </Badge>
                                ) : (
                                  Number(b.paid) > 0 && <span className="num text-[11.5px] text-ink-3">{t("collect.paid")} {money(b.paid, 0)}</span>
                                )}
                              </div>
                              {canOpen && <ChevronRight size={16} className="shrink-0 text-ink-3" />}
                            </>
                          );
                          return (
                            <li key={b.id}>
                              {canOpen ? (
                                <button type="button" className="press flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2/60" onClick={() => navigate({ name: "invoice-view", invoiceId: b.id })}>
                                  {body}
                                </button>
                              ) : (
                                <div className="flex items-center gap-3 px-3.5 py-2.5">{body}</div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {Number(d.other) > 0 && (
                      <p className="mt-2 flex justify-between rounded-xl bg-surface-2 px-3.5 py-2 text-[13px]">
                        <span className="text-ink-2">{t("collect.other")}</span>
                        <span className="num font-semibold text-ink">{money(d.other)}</span>
                      </p>
                    )}
                  </section>

                  {source === "server" && (
                    <section>
                      <SectionTitle>{t("collect.visits")}</SectionTitle>
                      {d.notes.length === 0 ? (
                        <p className="text-[13px] text-ink-3">{t("collect.noVisits")}</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {d.notes.map((n) => (
                            <li key={n.id} className="flex gap-3 text-[13px]">
                              <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", n.kind === "promise" ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-3")}>
                                {n.kind === "promise" ? <CalendarClock size={14} /> : <NotebookPen size={14} />}
                              </span>
                              <div className="min-w-0 flex-1">
                                {n.kind === "promise" && n.promisedOn && (
                                  <p className="font-medium text-ink">
                                    {n.promisedAmount ? t("collect.promised", { amount: money(n.promisedAmount, 0), date: date(n.promisedOn) }) : t("collect.promisedFull", { date: date(n.promisedOn) })}
                                  </p>
                                )}
                                {n.note && <p className={n.kind === "promise" ? "text-ink-2" : "text-ink"}>{n.note}</p>}
                                <p className="num text-[12px] text-ink-3">
                                  {date(n.visitedOn)}
                                  {n.by && ` · ${t("collect.byName", { name: n.by })}`}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}

                  <section>
                    <SectionTitle>{t("collect.recentPayments")}</SectionTitle>
                    {d.payments.length === 0 ? (
                      <p className="text-[13px] text-ink-3">{t("collect.noPayment")}</p>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {d.payments.map((p) => (
                          <li key={p.id} className="flex items-center justify-between gap-3 text-[13px]">
                            <span className="text-ink-2">
                              {date(p.date)} · {t(`paymentMethod.${p.method}`)}
                              {p.number && <span className="ml-1 font-mono text-[12px] text-ink-3">{p.number}</span>}
                            </span>
                            <span className="num font-semibold text-good">{money(p.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )
            )}
          </div>
        )}
      </Dialog>
      {onSheet && d && (
        <PrintPortal>
          <OutstandingStatementPrint detail={d} />
        </PrintPortal>
      )}
      {row && stage === "collect" && (
        <PaymentDialog
          direction="in"
          partyId={row.customerId}
          initialAmount={(Number(d?.overdue ?? row.overdue) > 0 ? Number(d?.overdue ?? row.overdue) : Number(d?.outstanding ?? row.outstanding)).toFixed(2)}
          open
          onOpenChange={(v) => {
            if (!v) setStage("sheet");
          }}
          onSaved={(saved) => ("offline" in saved ? setProvisional(saved.offline) : setReceiptId(saved.id))}
        />
      )}
      <CollectionNoteDialog customer={row && { id: row.customerId, name: row.name }} open={Boolean(row) && stage === "note"} onOpenChange={(v) => !v && setStage("sheet")} />
      {receiptId && <PaymentDetailDialog paymentId={receiptId} onClose={() => setReceiptId(null)} />}
      <ProvisionalReceiptDialog payment={provisional} mobile={mobile} onClose={() => setProvisional(null)} />
    </>
  );
}
