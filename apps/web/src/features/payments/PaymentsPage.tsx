import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@vyapaar/core";
import type { LocaleCode } from "@vyapaar/i18n";
import { ArrowDownLeft, ArrowUpRight, Download, Printer, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { createTranslator, formatCurrency, formatDate } from "@vyapaar/i18n";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, Stat, type Column } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { allowed, BUSINESS, customerById, supplierById, WORKSPACE } from "../../data/db";
import { refreshCustomer, refreshSupplier } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { downloadCsv } from "../../lib/download";
import { usePaged } from "../../lib/usePaged";
import { invalidateMoney, METHODS, PaymentDialog } from "./PaymentDialog";
import { SendButton } from "../../components/messaging/SendDialog";
import { PdfActions } from "../../components/ui/PdfActions";
import { ReceiptDocument, type PrintablePayment } from "./ReceiptDocument";

interface PaymentRow {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  direction: "in" | "out";
  customerId: string | null;
  supplierId: string | null;
  partyName: string;
  amount: string;
  method: PaymentMethod;
  referenceNumber: string | null;
  chequeStatus: "pending" | "deposited" | "cleared" | "bounced" | null;
  unallocatedAmount: string;
  status: "posted" | "cancelled";
}

interface PaymentDetail extends PaymentRow {
  chequeDate: string | null;
  chequeBank: string | null;
  notes: string | null;
  cancelReason: string | null;
  party: { id: string; name: string } | undefined;
  allocations: Array<{ id: string; documentId: string; documentNumber: string | null; amount: string; reversedAt: string | null }>;
}

const CHEQUE_TONE: Record<string, Tone> = { pending: "warn", deposited: "accent", cleared: "good", bounced: "danger" };

export function PaymentsPage({ action, partyId }: { action?: "collect" | "pay"; partyId?: string }) {
  const { t, money, dateMedium } = useI18n();
  const { navigate } = useRouter();
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [method, setMethod] = useState<"" | PaymentMethod>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ direction: "in" | "out"; partyId: string | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = usePaged<PaymentRow>("payments", "/payments", { direction, method, from, to, q: q.trim().length >= 2 ? q.trim() : undefined });

  // Deep links: "Collect" on a customer, "Pay" on a supplier.
  useEffect(() => {
    if (action) setDialog({ direction: action === "collect" ? "in" : "out", partyId: partyId ?? null });
  }, [action, partyId]);

  const columns: Column<PaymentRow>[] = [
    { key: "date", header: t("common.date"), render: (p) => <span className="text-ink-2">{dateMedium(p.paymentDate)}</span> },
    { key: "number", header: t("common.number"), render: (p) => <span className="font-medium text-ink">{p.paymentNumber}</span> },
    {
      key: "party",
      header: t("common.party"),
      render: (p) => (
        <span className="flex items-center gap-2">
          {p.direction === "in" ? <ArrowDownLeft size={14} className="text-good" aria-label={t("payment.in")} /> : <ArrowUpRight size={14} className="text-warn" aria-label={t("payment.out")} />}
          <span className="text-ink">{p.partyName}</span>
        </span>
      ),
    },
    {
      key: "method",
      header: t("common.method"),
      render: (p) => (
        <span className="text-ink-2">
          {t(`paymentMethod.${p.method}`)}
          {p.referenceNumber && <span className="text-ink-3"> · {p.referenceNumber}</span>}
        </span>
      ),
    },
    {
      key: "status",
      header: t("common.status"),
      render: (p) =>
        p.status === "cancelled" ? (
          <Badge tone="danger">{p.chequeStatus === "bounced" ? t("payment.chequeStatus.bounced") : t("common.cancelled")}</Badge>
        ) : p.chequeStatus ? (
          <Badge tone={CHEQUE_TONE[p.chequeStatus] ?? "neutral"}>{t(`payment.chequeStatus.${p.chequeStatus}`)}</Badge>
        ) : Number(p.unallocatedAmount) > 0 ? (
          <Badge tone="accent">
            {t("payment.advanceShort")} {money(p.unallocatedAmount)}
          </Badge>
        ) : null,
    },
    {
      key: "amount",
      header: t("common.amount"),
      align: "right",
      render: (p) => <span className={p.status === "cancelled" ? "text-ink-3 line-through" : p.direction === "in" ? "font-semibold text-good" : "font-semibold text-ink"}>{money(p.amount)}</span>,
    },
  ];

  const live = list.rows.filter((p) => p.status === "posted");
  const totalIn = live.filter((p) => p.direction === "in").reduce((s, p) => s + Number(p.amount), 0);
  const totalOut = live.filter((p) => p.direction === "out").reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("payment.title")}
        subtitle={
          <>
            {t("payment.in")} {money(totalIn, 0)} · {t("payment.out")} {money(totalOut, 0)}
          </>
        }
        actions={
          <>
            {allowed("report.export") && (
              <Button
                icon={<Download size={16} />}
                onClick={() =>
                  downloadCsv(
                    "payments.csv",
                    [
                      { label: t("common.date"), value: (p) => p.paymentDate },
                      { label: t("common.number"), value: (p) => p.paymentNumber },
                      { label: t("common.party"), value: (p) => p.partyName },
                      { label: t("common.type"), value: (p) => (p.direction === "in" ? t("payment.in") : t("payment.out")) },
                      { label: t("common.method"), value: (p) => t(`paymentMethod.${p.method}`) },
                      { label: t("common.reference"), value: (p) => p.referenceNumber },
                      { label: t("common.status"), value: (p) => p.status },
                      { label: t("common.amount"), value: (p) => p.amount },
                    ],
                    list.rows,
                  )
                }
              >
                {t("common.export")}
              </Button>
            )}
            {allowed("payment.pay") && (
              <Button icon={<ArrowUpRight size={16} />} onClick={() => setDialog({ direction: "out", partyId: null })}>
                {t("payment.pay")}
              </Button>
            )}
            {allowed("payment.collect") && (
              <Button variant="primary" icon={<ArrowDownLeft size={16} />} onClick={() => setDialog({ direction: "in", partyId: null })}>
                {t("payment.receive")}
              </Button>
            )}
          </>
        }
      />

      <FilterBar>
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("payment.search")} aria-label={t("payment.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Segmented
          size="sm"
          label={t("common.type")}
          value={direction}
          onChange={setDirection}
          options={[
            { value: "all", label: t("common.all") },
            { value: "in", label: t("payment.in") },
            { value: "out", label: t("payment.out") },
          ]}
        />
        <Select aria-label={t("common.method")} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod | "")} className="md:w-40">
          <option value="">
            {t("common.method")}: {t("common.all")}
          </option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`paymentMethod.${m}`)}
            </option>
          ))}
        </Select>
        <Input type="date" aria-label={t("common.from")} value={from} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
        <Input type="date" aria-label={t("common.to")} value={to} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
      </FilterBar>

      {list.error ? <ErrorNote error={list.error} /> : null}
      <DataTable columns={columns} rows={list.rows} rowKey={(p) => p.id} loading={list.loading} onRowClick={(p) => setOpenId(p.id)} minWidth={760} />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />

      {dialog && (
        <PaymentDialog
          direction={dialog.direction}
          partyId={dialog.partyId}
          open
          onOpenChange={(v) => {
            if (!v) {
              setDialog(null);
              if (action) navigate({ name: "planned", module: "payments" });
            }
          }}
        />
      )}
      <PaymentDetailDialog paymentId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function PaymentDetailDialog({ paymentId, onClose }: { paymentId: string | null; onClose(): void }) {
  const { t, money, dateMedium, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [printLocale, setPrintLocale] = useState<LocaleCode>((WORKSPACE.printLocale as LocaleCode) || locale);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const detail = useQuery({
    queryKey: ["payments", "detail", paymentId],
    queryFn: () => api.get<PaymentDetail>(`/payments/${paymentId}`),
    enabled: Boolean(paymentId),
  });

  useEffect(() => {
    setCancelling(false);
    setReason("");
    setError(null);
  }, [paymentId]);

  const p = detail.data;
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, body);
      if (p?.customerId) await refreshCustomer(p.customerId).catch(() => undefined);
      if (p?.supplierId) await refreshSupplier(p.supplierId).catch(() => undefined);
      invalidateMoney(qc);
      toast({ tone: "success", title: done, body: p?.paymentNumber ?? "" });
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const printable: PrintablePayment | null = p ? { ...p, partyName: p.party?.name ?? p.partyName ?? "" } : null;
  const shareMessage = () => {
    if (!p || !printable) return { text: "", mobile: null };
    const tr = createTranslator(printLocale).t;
    const bills = p.allocations.filter((a) => !a.reversedAt).map((a) => a.documentNumber).filter(Boolean).join(", ");
    const params = {
      party: printable.partyName,
      amount: formatCurrency(p.amount, printLocale),
      method: tr(`paymentMethod.${p.method}`) + (p.referenceNumber ? ` (${p.referenceNumber})` : ""),
      date: formatDate(p.paymentDate),
      number: p.paymentNumber,
      bills: bills || "—",
      business: BUSINESS.name,
    };
    const mobile = p.customerId ? customerById.get(p.customerId)?.mobile : p.supplierId ? supplierById.get(p.supplierId)?.mobile : null;
    return { text: tr(p.direction === "in" ? "share.receipt" : "share.payment", params), mobile: mobile ?? null };
  };
  const message = shareMessage();

  const posted = p?.status === "posted";
  const chequeOpen = posted && p?.method === "cheque" && (p.chequeStatus === "pending" || p.chequeStatus === "deposited");

  return (
    <Dialog
      open={Boolean(paymentId)}
      onOpenChange={(v) => !v && onClose()}
      title={p ? `${p.direction === "in" ? t("payment.receipt") : t("payment.voucher")} ${p.paymentNumber}` : t("common.loading")}
      description={p ? `${p.party?.name ?? p.partyName ?? ""} · ${dateMedium(p.paymentDate)}` : undefined}
      closeLabel={t("common.close")}
      footer={
        p && posted ? (
          <>
            {chequeOpen && allowed("payment.collect") && p.chequeStatus === "pending" && (
              <Button disabled={busy} onClick={() => void run(`/payments/${p.id}/cheque`, { status: "deposited" }, t("payment.chequeStatus.deposited"))}>
                {t("payment.markDeposited")}
              </Button>
            )}
            {chequeOpen && allowed("payment.collect") && (
              <Button disabled={busy} onClick={() => void run(`/payments/${p.id}/cheque`, { status: "cleared" }, t("payment.chequeStatus.cleared"))}>
                {t("payment.markCleared")}
              </Button>
            )}
            {chequeOpen && allowed("payment.cancel") && (
              <Button variant="danger" disabled={busy} onClick={() => void run(`/payments/${p.id}/cheque`, { status: "bounced", ...(reason.trim() ? { reason: reason.trim() } : {}) }, t("payment.chequeStatus.bounced"))}>
                {t("payment.markBounced")}
              </Button>
            )}
            {Number(p.unallocatedAmount) > 0 && allowed("payment.allocate") && (
              <Button disabled={busy} onClick={() => void run(`/payments/${p.id}/allocate`, {}, t("payment.allocatedDone"))}>
                {t("payment.allocateAdvance")}
              </Button>
            )}
            {allowed("payment.cancel") &&
              (cancelling ? (
                <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void run(`/payments/${p.id}/cancel`, { reason: reason.trim() }, t("payment.cancelledDone"))}>
                  {t("payment.confirmCancel")}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setCancelling(true)}>
                  {t("payment.cancel")}
                </Button>
              ))}
          </>
        ) : undefined
      }
    >
      {detail.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : detail.error ? (
        <ErrorNote error={detail.error} />
      ) : p ? (
        <div className="flex flex-col gap-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label={t("common.amount")} value={money(p.amount)} tone={p.status === "cancelled" ? "danger" : undefined} />
            <Stat label={t("common.method")} value={t(`paymentMethod.${p.method}`)} />
            <Stat label={t("common.status")} value={p.status === "cancelled" ? t("common.cancelled") : p.chequeStatus ? t(`payment.chequeStatus.${p.chequeStatus}`) : t("status.document.posted")} />
            {p.referenceNumber && <Stat label={p.method === "cheque" ? t("payment.chequeNumber") : t("payment.reference")} value={p.referenceNumber} />}
            {p.chequeDate && <Stat label={t("payment.chequeDate")} value={dateMedium(p.chequeDate)} />}
            {p.chequeBank && <Stat label={t("payment.chequeBank")} value={p.chequeBank} />}
            {Number(p.unallocatedAmount) > 0 && <Stat label={t("payment.advanceShort")} value={money(p.unallocatedAmount)} tone="warn" />}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
            <Segmented
              size="sm"
              label={t("settings.printLanguage")}
              value={printLocale}
              onChange={setPrintLocale}
              options={[
                { value: "en", label: "English" },
                { value: "hi", label: "हिन्दी" },
              ]}
            />
            <Button size="sm" icon={<Printer size={14} />} onClick={() => window.print()}>
              {p.direction === "in" ? t("receipt.print") : t("receipt.printVoucher")}
            </Button>
            <PdfActions size="sm" path={`/payments/${p.id}/pdf`} locale={printLocale} number={p.paymentNumber ?? ""} shareText={message.text} mobile={message.mobile} />
            <SendButton size="sm" documentType="receipt" documentId={p.id} number={p.paymentNumber ?? ""} party={{ name: printable?.partyName ?? "", mobile: message.mobile}} locale={printLocale} />
          </div>
          {printable && (
            <PrintPortal>
              <ReceiptDocument payment={printable} locale={printLocale} />
            </PrintPortal>
          )}
          {p.cancelReason && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {t("common.reason")}: {p.cancelReason}
            </p>
          )}
          {p.notes && <p className="text-[13px] text-ink-2">{p.notes}</p>}
          <div>
            <h3 className="mb-1.5 text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("payment.allocated")}</h3>
            {p.allocations.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("payment.noAllocations")}</p>
            ) : (
              <ul className="num divide-y divide-line rounded-lg border border-line text-[13.5px]">
                {p.allocations.map((a) => (
                  <li key={a.id} className="flex items-center justify-between px-3 py-2">
                    <span className={a.reversedAt ? "text-ink-3 line-through" : "text-ink"}>{a.documentNumber ?? "—"}</span>
                    <span className={a.reversedAt ? "text-ink-3 line-through" : "font-medium"}>{money(a.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(cancelling || chequeOpen) && posted && (
            <Field label={t("common.reason")} htmlFor="pay-reason" hint={cancelling ? t("payment.cancelHint") : t("common.optional")}>
              <Input id="pay-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
