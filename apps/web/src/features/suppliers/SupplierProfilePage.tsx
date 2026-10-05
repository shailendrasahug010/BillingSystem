import { useQuery } from "@tanstack/react-query";
import { findState, type PaymentMethod } from "@digitalbahi/core";
import type { TranslationKey } from "@digitalbahi/i18n";
import { Landmark, MapPin, Pencil, Phone, ShoppingCart, Wallet } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Avatar, EmptyState, Skeleton } from "../../components/ui/misc";
import { BackButton, DataTable, ErrorNote, TAB_TRIGGER, Tile, type Column } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { api } from "../../lib/api";
import { PaymentDialog } from "../payments/PaymentDialog";
import { PurchaseStatusBadge, type PurchaseRow } from "../purchases/PurchasesPage";
import { SupplierDialog, type SupplierDetail } from "./SupplierDialog";

const LEDGER_TYPES = new Set(["opening", "invoice", "invoice_cancel", "purchase", "purchase_cancel", "payment_in", "payment_out", "payment_in_cancel", "payment_out_cancel", "cheque_bounce", "credit_note", "credit_note_cancel", "debit_note", "debit_note_cancel"]);

export interface LedgerEntry {
  id: number;
  date: string;
  docType: string;
  docNumber: string | null;
  debit: string;
  credit: string;
  narration: string | null;
  balance: string;
}

/** Account statement table: date | particulars | debit | credit | balance. */
export function LedgerTable({ entries, opening, closing, loading }: { entries: LedgerEntry[]; opening?: string; closing?: string; loading?: boolean }) {
  const { t, money, dateMedium } = useI18n();
  const columns: Column<LedgerEntry>[] = [
    { key: "date", header: t("common.date"), render: (e) => <span className="text-ink-2">{dateMedium(e.date)}</span> },
    {
      key: "particulars",
      header: t("customer.ledger.particulars"),
      render: (e) => (
        <span className="text-ink">
          {LEDGER_TYPES.has(e.docType) ? t(`ledger.${e.docType}` as TranslationKey) : e.docType}
          {e.docNumber && <span className="text-ink-3"> · {e.docNumber}</span>}
          {e.narration && e.docType !== "opening" && <span className="block text-[12px] text-ink-3">{e.narration}</span>}
        </span>
      ),
    },
    { key: "debit", header: t("customer.ledger.debit"), align: "right", render: (e) => (Number(e.debit) ? money(e.debit) : "") },
    { key: "credit", header: t("customer.ledger.credit"), align: "right", render: (e) => (Number(e.credit) ? money(e.credit) : "") },
    { key: "balance", header: t("customer.ledger.runningBalance"), align: "right", render: (e) => <span className="font-medium text-ink">{money(e.balance)}</span> },
  ];
  return (
    <div className="flex flex-col gap-2">
      {opening !== undefined && (
        <p className="num text-[13px] text-ink-3">
          {t("ledger.openingBalance")}: <span className="font-semibold text-ink">{money(opening)}</span>
          {closing !== undefined && (
            <>
              {" "}
              · {t("ledger.closingBalance")}: <span className="font-semibold text-ink">{money(closing)}</span>
            </>
          )}
        </p>
      )}
      <DataTable columns={columns} rows={[...entries].reverse()} rowKey={(e) => String(e.id)} loading={loading} minWidth={640} />
    </div>
  );
}

export function SupplierProfilePage({ supplierId }: { supplierId: string }) {
  const { t, money, dateMedium, locale } = useI18n();
  const { navigate } = useRouter();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const detail = useQuery({ queryKey: ["supplier-detail", supplierId], queryFn: () => api.get<SupplierDetail>(`/suppliers/${supplierId}`) });
  const purchases = useQuery({
    queryKey: ["purchases", "supplier", supplierId],
    queryFn: () => api.get<{ data: PurchaseRow[] }>("/purchases", { supplierId, limit: 100 }).then((r) => r.data),
    enabled: allowed("purchase.view"),
  });
  const payments = useQuery({
    queryKey: ["payments", "supplier", supplierId],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; paymentNumber: string; paymentDate: string; method: PaymentMethod; referenceNumber: string | null; amount: string; status: string }> }>("/payments", {
          supplierId,
          direction: "out",
          limit: 100,
        })
        .then((r) => r.data),
    enabled: allowed("payment.view"),
  });
  const ledger = useQuery({
    queryKey: ["supplier-ledger", supplierId],
    queryFn: () => api.get<{ opening: string; closing: string; entries: LedgerEntry[] }>(`/suppliers/${supplierId}/ledger`),
    enabled: allowed("supplier.view_ledger"),
  });

  if (detail.isPending) return <Skeleton className="h-40 w-full" />;
  if (detail.error) return <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />;
  const s = detail.data;
  const state = findState(s.stateCode);
  const title = s.name;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-1">
            <BackButton onClick={() => navigate({ name: "planned", module: "suppliers" })} />
          </div>
          <Avatar name={title} className="mt-0.5 size-12 text-[15px]" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[24px] leading-tight font-semibold text-ink">{title}</h1>
              <Badge tone={s.gstRegistration === "regular" ? "accent" : "neutral"}>{t(`supplier.registration.${s.gstRegistration === "composition" || s.gstRegistration === "regular" ? s.gstRegistration : "unregistered"}`)}</Badge>
              {!s.isActive && <Badge tone="danger">{t("common.inactive")}</Badge>}
            </div>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-3">
              <span className="font-mono">{s.code}</span>
              {s.companyName && s.name !== s.companyName && <span>{s.companyName}</span>}
              {s.mobile && (
                <span className="num inline-flex items-center gap-1">
                  <Phone size={12} /> {s.mobile}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {[s.addressLine1, s.city, locale === "hi" ? state?.nameHi : state?.name, s.pincode].filter(Boolean).join(", ")}
              </span>
              {s.gstin && <span className="font-mono text-[12px]">GSTIN {s.gstin}</span>}
            </p>
            {(s.bankAccountNumberMasked || s.upiId) && (
              <p className="mt-0.5 inline-flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
                <Landmark size={12} />
                {[s.bankName, s.bankAccountNumberMasked, s.bankIfsc, s.upiId].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {allowed("supplier.update") && (
            <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
              {t("common.edit")}
            </Button>
          )}
          {allowed("payment.pay") && (
            <Button icon={<Wallet size={16} />} onClick={() => setPaying(true)}>
              {t("payment.pay")}
            </Button>
          )}
          {allowed("purchase.create") && (
            <Button variant="primary" icon={<ShoppingCart size={16} />} onClick={() => navigate({ name: "purchase-new", supplierId: s.id })}>
              {t("purchase.new")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={t("supplier.outstandingPayable")} value={money(s.summary.balance, 0)} tone={Number(s.summary.balance) > 0 ? "danger" : undefined} />
        <Tile label={t("supplier.totalPurchases")} value={money(s.summary.totalPurchases, 0)} sub={t("purchase.billCount", { count: s.summary.purchaseCount })} />
        <Tile label={t("supplier.lastPurchase")} value={s.summary.lastPurchaseDate ? dateMedium(s.summary.lastPurchaseDate) : "—"} />
        <Tile label={t("supplier.lastPayment")} value={s.summary.lastPaymentDate ? dateMedium(s.summary.lastPaymentDate) : "—"} sub={s.creditDays ? `${t("customer.creditDays")}: ${s.creditDays}` : undefined} />
      </div>

      <Tabs.Root defaultValue="purchases" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={title}>
          <Tabs.Trigger value="purchases" className={TAB_TRIGGER}>
            {t("nav.purchases")}
          </Tabs.Trigger>
          <Tabs.Trigger value="payments" className={TAB_TRIGGER}>
            {t("nav.payments")}
          </Tabs.Trigger>
          {allowed("supplier.view_ledger") && (
            <Tabs.Trigger value="ledger" className={TAB_TRIGGER}>
              {t("customer.tabs.ledger")}
            </Tabs.Trigger>
          )}
        </Tabs.List>
        <Tabs.Content value="purchases">
          <DataTable
            rows={purchases.data ?? []}
            loading={purchases.isPending && allowed("purchase.view")}
            rowKey={(p) => p.id}
            onRowClick={(p) => navigate({ name: "purchase-view", purchaseId: p.id })}
            empty={<EmptyState title={t("purchase.empty")} hint={t("supplier.noPurchasesHint")} />}
            columns={[
              { key: "date", header: t("purchase.billDate"), render: (p) => <span className="text-ink-2">{dateMedium(p.supplierInvoiceDate)}</span> },
              { key: "bill", header: t("purchase.billNumber"), render: (p) => <span className="font-medium text-ink">{p.supplierInvoiceNumber}</span> },
              { key: "number", header: t("purchase.number"), render: (p) => <span className="text-ink-3">{p.purchaseNumber}</span> },
              { key: "status", header: t("common.status"), render: (p) => <PurchaseStatusBadge row={p} /> },
              { key: "total", header: t("common.total"), align: "right", render: (p) => money(p.grandTotal) },
              { key: "due", header: t("common.balance"), align: "right", render: (p) => (p.status === "posted" && Number(p.balanceDue) > 0 ? <span className="font-semibold">{money(p.balanceDue)}</span> : "—") },
            ]}
          />
        </Tabs.Content>
        <Tabs.Content value="payments">
          <DataTable
            rows={payments.data ?? []}
            loading={payments.isPending && allowed("payment.view")}
            rowKey={(p) => p.id}
            empty={<EmptyState title={t("payment.empty")} hint={t("supplier.noPaymentsHint")} />}
            columns={[
              { key: "date", header: t("common.date"), render: (p) => <span className="text-ink-2">{dateMedium(p.paymentDate)}</span> },
              { key: "number", header: t("common.number"), render: (p) => <span className="font-medium text-ink">{p.paymentNumber}</span> },
              { key: "method", header: t("common.method"), render: (p) => `${t(`paymentMethod.${p.method}`)}${p.referenceNumber ? ` · ${p.referenceNumber}` : ""}` },
              { key: "amount", header: t("common.amount"), align: "right", render: (p) => <span className={p.status === "cancelled" ? "text-ink-3 line-through" : "font-semibold"}>{money(p.amount)}</span> },
            ]}
          />
        </Tabs.Content>
        <Tabs.Content value="ledger">
          {ledger.error ? <ErrorNote error={ledger.error} onRetry={() => void ledger.refetch()} /> : <LedgerTable entries={ledger.data?.entries ?? []} opening={ledger.data?.opening} closing={ledger.data?.closing} loading={ledger.isPending} />}
        </Tabs.Content>
      </Tabs.Root>

      <SupplierDialog supplierId={s.id} open={editing} onOpenChange={setEditing} />
      <PaymentDialog direction="out" partyId={s.id} open={paying} onOpenChange={setPaying} />
    </div>
  );
}
