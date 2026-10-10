import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentLinksSetup, PaymentLinkView } from "@digitalbahi/contracts";
import { todayIn, upiPayLink } from "@digitalbahi/core";
import { Ban, CheckCircle2, Copy, Link2, Loader2, RefreshCw, Search, Wallet } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, RowCard, type Column } from "../../components/ui/Page";
import { QrCode } from "../../components/ui/QrCode";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS } from "../../data/db";
import { refreshCustomer } from "../../data/live";
import { LIVE } from "../../data/source";
import { api } from "../../lib/api";
import { shareOnWhatsApp } from "../../lib/share";
import { usePaged } from "../../lib/usePaged";
import { invalidateMoney, PaymentDialog } from "./PaymentDialog";

export type PaymentLink = PaymentLinkView;

const OPEN = new Set<PaymentLink["status"]>(["created", "partly_paid"]);
const STATUS_TONE: Record<PaymentLink["status"], Tone> = { created: "accent", partly_paid: "warn", paid: "good", expired: "neutral", cancelled: "neutral" };
const MONEY = /^\d{1,13}(\.\d{1,2})?$/;
/** The day a time falls on in India (as TODAY is). */
const dayOf = (iso: string) => todayIn("Asia/Kolkata", new Date(iso));

/** Whether the business takes payments online (a gateway with its keys saved). */
export function useLinksSetup(enabled = true) {
  return useQuery({
    queryKey: ["payment-links-setup"],
    queryFn: () => api.get<PaymentLinksSetup>("/payment-links/setup"),
    enabled: enabled && LIVE && allowed("payment.collect"),
    staleTime: 60_000,
  });
}

/** What is being asked for: one bill, or (no bill) what the customer owes. */
export interface PayFor {
  customerId: string;
  customerName: string;
  mobile: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  /** What is due (rupees, "1250.00"). */
  due: string;
}

/**
 * "Ask to pay" on a bill or a customer: a payment link at the business's
 * gateway, paid by UPI, card or net banking and recorded by itself; without
 * a gateway, the business's own UPI QR code for the amount.
 */
export function PayLinkButton(props: PayFor) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<Link2 size={16} />} title={t("payLink.hint")} onClick={() => setOpen(true)}>
        {t("payLink.button")}
      </Button>
      {open && <PayLinkDialog {...props} open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function PayLinkDialog({ open, onOpenChange, existing, ...pay }: PayFor & { open: boolean; onOpenChange(open: boolean): void; existing?: PaymentLink | null }) {
  const { t, money } = useI18n();
  const setup = useLinksSetup(open);
  const ready = existing ? true : setup.data?.ready;
  const title = t("payLink.title", { name: pay.customerName });
  const what = pay.invoiceNumber ? t("payLink.forBill", { number: pay.invoiceNumber, amount: money(pay.due) }) : t("payLink.forBalance", { amount: money(pay.due) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={what} closeLabel={t("common.close")}>
      {ready === undefined ? (
        setup.error ? (
          <ErrorNote error={setup.error} onRetry={() => void setup.refetch()} />
        ) : (
          <p className="text-[13px] text-ink-3" role="status">
            {t("common.loading")}
          </p>
        )
      ) : ready ? (
        <GatewayLink pay={pay} existing={existing ?? null} test={existing ? existing.environment === "test" : setup.data?.environment === "test"} />
      ) : (
        <UpiOnly pay={pay} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

/** The gateway's link: make it, show it as a QR code and a link to send, and watch for the payment. */
function GatewayLink({ pay, existing, test }: { pay: PayFor; existing: PaymentLink | null; test: boolean }) {
  const { t, money, dateTime } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(pay.due);
  const [link, setLink] = useState<PaymentLink | null>(existing);
  const [reused, setReused] = useState(false);
  // The status last seen, so "paid" is announced once.
  const seen = useRef<PaymentLink["status"] | null>(existing?.status ?? null);

  const take = (next: PaymentLink) => {
    if (seen.current !== "paid" && next.status === "paid") {
      toast({ tone: "success", title: t("payLink.paidToast", { name: pay.customerName, amount: money(next.amountPaid) }) });
      invalidateMoney(qc);
      void refreshCustomer(pay.customerId).catch(() => undefined);
    }
    if (seen.current !== next.status) void qc.invalidateQueries({ queryKey: ["payment-links"] });
    seen.current = next.status;
    setLink(next);
  };

  const make = useMutation({
    mutationFn: () =>
      api.post<PaymentLink>("/payment-links", {
        customerId: pay.customerId,
        ...(pay.invoiceId ? { invoiceId: pay.invoiceId } : {}),
        ...(Number(amount) !== Number(pay.due) ? { amount: Number(amount).toFixed(2) } : {}),
      }),
    onSuccess: (made) => {
      // An open link for the same thing and amount comes back instead of a new one.
      setReused(new Date(made.createdAt).getTime() < Date.now() - 60_000);
      take(made);
    },
  });
  // While the link is on screen and open: asked about every few seconds.
  const watching = Boolean(link && OPEN.has(link.status));
  const watch = useQuery({
    queryKey: ["payment-link-watch", link?.id],
    queryFn: async () => {
      const next = await api.post<PaymentLink>(`/payment-links/${link!.id}/refresh`);
      take(next);
      return next;
    },
    enabled: watching,
    refetchInterval: 5000,
  });
  const cancel = useMutation({
    mutationFn: () => api.post<PaymentLink>(`/payment-links/${link!.id}/cancel`),
    onSuccess: (next) => {
      take(next);
      toast({ tone: "success", title: t("payLink.cancelled") });
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!.url);
      toast({ tone: "success", title: t("payLink.copied") });
    } catch {
      toast({ tone: "danger", title: t("payLink.copyFailed") });
    }
  };

  if (!link) {
    const valid = MONEY.test(amount.trim()) && Number(amount) > 0;
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !make.isPending) make.mutate();
        }}
      >
        <ErrorNote error={make.error} />
        <Field label={t("payLink.amount")} htmlFor="pay-link-amount">
          <Input id="pay-link-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {test && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("payLink.testLink")}</p>}
        <Button type="submit" variant="primary" icon={make.isPending ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} disabled={!valid || make.isPending} className="self-end">
          {make.isPending ? t("payLink.making") : t("payLink.make")}
        </Button>
      </form>
    );
  }

  const paid = link.status === "paid";
  const numbers = link.payments.map((p) => p.paymentNumber).filter(Boolean).join(", ");
  const message = t(link.invoiceNumber ? "payLink.messageBill" : "payLink.messageBalance", {
    name: pay.customerName,
    amount: money(link.amount),
    number: link.invoiceNumber ?? "",
    business: BUSINESS.name,
    url: link.url,
  });
  return (
    <div className="flex flex-col gap-4" data-pay-link={link.status}>
      <ErrorNote error={watch.error ?? cancel.error} />
      {paid ? (
        <div className="flex items-start gap-3 rounded-xl bg-good-soft px-3.5 py-3 text-good" role="status">
          <CheckCircle2 size={20} className="mt-0.5 shrink-0" aria-hidden />
          <div className="text-[13.5px]">
            <p className="font-semibold">{t("payLink.paidTitle", { amount: money(link.amountPaid) })}</p>
            {numbers && <p>{t("payLink.paidReceipts", { numbers })}</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          {OPEN.has(link.status) && <QrCode text={link.url} size={168} label={t("payLink.scan")} />}
          <div className="flex min-w-0 flex-1 flex-col gap-2 text-[13px] text-ink-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[link.status]} dot>
                {t(`payLink.status.${link.status}`)}
              </Badge>
              <span className="num font-semibold text-ink">{money(link.amount)}</span>
            </div>
            {OPEN.has(link.status) && (
              <>
                <p className="flex items-center gap-1.5" role="status">
                  <Loader2 size={14} className="animate-spin text-ink-3" aria-hidden />
                  {t("payLink.waiting")}
                </p>
                <p className="text-ink-3">{t("payLink.expires", { date: dateTime(link.expiresAt) })}</p>
              </>
            )}
            {reused && <p className="text-ink-3">{t("payLink.reused")}</p>}
            {link.environment === "test" && <p className="text-warn">{t("payLink.testLink")}</p>}
          </div>
        </div>
      )}
      {OPEN.has(link.status) && (
        <>
          <div className="flex gap-2">
            <Input readOnly aria-label={t("payLink.address")} value={link.url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 [&_input]:font-mono [&_input]:text-[12.5px]" data-pay-link-url />
            <Button icon={<Copy size={15} />} onClick={() => void copy()}>
              {t("payLink.copy")}
            </Button>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {allowed("payment.collect") && (
              <Button
                variant="ghost"
                icon={<Ban size={16} />}
                disabled={cancel.isPending}
                onClick={() =>
                  void confirm({ title: t("payLink.cancelTitle"), body: t("payLink.cancelBody", { name: pay.customerName }), confirmLabel: t("payLink.cancel"), danger: true }).then((yes) => yes && cancel.mutate())
                }
              >
                {t("payLink.cancel")}
              </Button>
            )}
            <Button icon={watch.isFetching ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} disabled={watch.isFetching} onClick={() => void watch.refetch()}>
              {t("payLink.check")}
            </Button>
            <Button variant="primary" icon={<WhatsAppIcon size={16} />} onClick={() => shareOnWhatsApp(message, pay.mobile)}>
              {t("payLink.send")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** No gateway: the business's UPI QR code for the amount; the payment is recorded by hand when it arrives. */
function UpiOnly({ pay, onDone }: { pay: PayFor; onDone(): void }) {
  const { t, money } = useI18n();
  const { navigate } = useRouter();
  const [recording, setRecording] = useState(false);
  const upi = BUSINESS.bank.upi.trim();
  const qr = upi ? upiPayLink({ upiId: upi, name: BUSINESS.name, amount: pay.due, note: pay.invoiceNumber ?? pay.customerName }) : null;
  const message = t(pay.invoiceNumber ? "payLink.upiMessageBill" : "payLink.upiMessageBalance", {
    name: pay.customerName,
    amount: money(pay.due),
    number: pay.invoiceNumber ?? "",
    business: BUSINESS.name,
    upi,
  });
  return (
    <div className="flex flex-col gap-4">
      {qr ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start" data-pay-upi>
          <QrCode text={qr} size={168} label={t("payLink.upiTitle")} />
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            <p className="font-medium text-ink">{t("payLink.upiScan", { amount: money(pay.due), upi })}</p>
            <p className="text-[12.5px] text-ink-3">{t("payLink.upiNote")}</p>
          </div>
        </div>
      ) : (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{t("payLink.noUpi")}</p>
      )}
      <div className="flex items-start gap-3 rounded-xl bg-accent-soft px-3.5 py-3 text-[13px] text-accent-ink">
        <Link2 size={18} className="mt-0.5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-2">
          <p>{t("payLink.setUp")}</p>
          {allowed("settings.update") && (
            <button
              type="button"
              className="press self-start text-[13px] font-medium underline"
              onClick={() => {
                onDone();
                navigate({ name: "settings" });
              }}
            >
              {t("payLink.openSettings")}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {allowed("payment.collect") && (
          <Button icon={<Wallet size={16} />} onClick={() => setRecording(true)}>
            {t("payLink.record")}
          </Button>
        )}
        {qr && (
          <Button variant="primary" icon={<WhatsAppIcon size={16} />} onClick={() => shareOnWhatsApp(message, pay.mobile)}>
            {t("payLink.send")}
          </Button>
        )}
      </div>
      {recording && (
        <PaymentDialog
          direction="in"
          partyId={pay.customerId}
          initialAmount={pay.due}
          {...(pay.invoiceId ? { documentId: pay.invoiceId } : {})}
          open={recording}
          onOpenChange={(v) => {
            setRecording(v);
            if (!v) onDone();
          }}
        />
      )}
    </div>
  );
}

/** Payments → Online: the links made, open first, each opened to send again, check or cancel. */
export function OnlineLinks() {
  const { t, money, amount, dateMedium } = useI18n();
  const [status, setStatus] = useState<"open" | "paid" | "all">("open");
  const [q, setQ] = useState("");
  const [opened, setOpened] = useState<PaymentLink | null>(null);
  const list = usePaged<PaymentLink>("payment-links", "/payment-links", { status, q: q.trim().length >= 2 ? q.trim() : undefined });
  const forOf = (l: PaymentLink) => (l.invoiceNumber ? l.invoiceNumber : t("payLink.balance"));
  const columns: Column<PaymentLink>[] = [
    { key: "made", header: t("payLink.col.made"), sortValue: (l) => l.createdAt, render: (l) => <span className="text-ink-2">{dateMedium(dayOf(l.createdAt))}</span> },
    { key: "customer", header: t("payLink.col.customer"), sortValue: (l) => l.customerName, render: (l) => <span className="font-medium text-ink">{l.customerName}</span> },
    { key: "for", header: t("payLink.col.for"), sortValue: forOf, render: (l) => <span className="text-ink-2">{forOf(l)}</span> },
    {
      key: "status",
      header: t("payLink.col.status"),
      sortValue: (l) => l.status,
      render: (l) => (
        <Badge tone={STATUS_TONE[l.status]} dot>
          {t(`payLink.status.${l.status}`)}
        </Badge>
      ),
    },
    { key: "expires", header: t("payLink.col.expires"), sortValue: (l) => l.expiresAt, render: (l) => <span className="text-ink-3">{OPEN.has(l.status) ? dateMedium(dayOf(l.expiresAt)) : "—"}</span> },
    { key: "paid", header: t("payLink.col.paid"), align: "right", sortValue: (l) => Number(l.amountPaid), render: (l) => <span className={Number(l.amountPaid) > 0 ? "font-semibold text-good" : "text-ink-3"}>{amount(l.amountPaid)}</span> },
    { key: "amount", header: t("payLink.col.amount"), align: "right", sortValue: (l) => Number(l.amount), render: (l) => <span className="font-semibold text-ink">{amount(l.amount)}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      {/* Open, paid or all: always in sight beside the search. */}
      <FilterBar
        quick={
          <Segmented
            size="sm"
            label={t("payLink.col.status")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "open", label: t("payLink.filters.open") },
              { value: "paid", label: t("payLink.filters.paid") },
              { value: "all", label: t("payLink.filters.all") },
            ]}
          />
        }
      >
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("payLink.search")} aria-label={t("payLink.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <DataTable
        id="payment-links"
        columns={columns}
        rows={list.rows}
        rowKey={(l) => l.id}
        loading={list.loading}
        onRowClick={(l) => setOpened(l)}
        minWidth={720}
        empty={t("payLink.empty")}
        mobile={(l) => <RowCard title={l.customerName} sub={`${forOf(l)} · ${t(`payLink.status.${l.status}`)}`} value={money(l.amount)} tone={l.status === "paid" ? "good" : OPEN.has(l.status) ? undefined : "muted"} />}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
      {opened && (
        <PayLinkDialog
          open
          onOpenChange={(v) => !v && setOpened(null)}
          existing={opened}
          customerId={opened.customerId}
          customerName={opened.customerName}
          mobile={null}
          invoiceId={opened.invoiceId}
          invoiceNumber={opened.invoiceNumber}
          due={opened.amount}
        />
      )}
    </div>
  );
}
