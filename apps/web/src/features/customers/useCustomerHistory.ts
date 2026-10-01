import { useQuery } from "@tanstack/react-query";
import type { PaymentMethod } from "@digitalbahi/core";
import { useMemo } from "react";
import { useI18n } from "../../app/i18n";
import { customerById } from "../../data/db";
import { LIVE } from "../../data/source";
import { customerInvoices, customerPayments, useStoreVersion } from "../../data/store";
import { api } from "../../lib/api";
import { deviceDocuments } from "../../offline/documents";
import { unreachable, workingOffline } from "../../offline/sync";

export interface HistoryInvoice {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  total: number;
  paid: number;
  cancelled: boolean;
}

export interface HistoryPayment {
  id: string;
  number: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  amount: number;
  cancelled: boolean;
}

export interface LedgerLine {
  key: string;
  date: string;
  label: string;
  debit: number;
  credit: number;
  balance: number;
}

interface ApiLedger {
  opening: string;
  closing: string;
  entries: Array<{ id: number; date: string; docType: string; docNumber: string | null; debit: string; credit: string; narration: string | null; balance: string }>;
}

/**
 * Invoices, receipts and the account statement of one customer: from the API
 * in live mode (statement from the party ledger), from the sample data otherwise.
 */
export function useCustomerHistory(customerId: string) {
  const { t } = useI18n();
  const version = useStoreVersion();
  const invoices = useQuery({
    queryKey: ["customer-invoices", customerId],
    queryFn: async () => {
      type Row = { id: string; invoiceNumber: string; invoiceDate: string; dueDate: string | null; grandTotal: string; amountPaid: string; status: string; customerId?: string };
      const toHistory = (i: Row): HistoryInvoice => ({
        id: i.id,
        number: i.invoiceNumber,
        date: i.invoiceDate,
        dueDate: i.dueDate ?? i.invoiceDate,
        total: Number(i.grandTotal),
        paid: Number(i.amountPaid),
        cancelled: i.status === "cancelled",
      });
      // Without a connection: this customer's recent bills kept on the device (they open, print and take returns).
      const onDevice = () => deviceDocuments<Row>("invoice").filter((i) => i.customerId === customerId).map(toHistory);
      if (workingOffline()) return onDevice();
      try {
        return (await api.get<{ data: Row[] }>("/invoices", { customerId, limit: 50 })).data.map(toHistory);
      } catch (e) {
        if (unreachable(e)) return onDevice();
        throw e;
      }
    },
    enabled: LIVE,
    networkMode: "always",
  });
  const payments = useQuery({
    queryKey: ["customer-payments", customerId],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; paymentNumber: string; paymentDate: string; method: PaymentMethod; referenceNumber: string | null; amount: string; status: string }> }>("/payments", {
          customerId,
          direction: "in",
          limit: 50,
        })
        .then((r) =>
          r.data.map<HistoryPayment>((p) => ({
            id: p.id,
            number: p.paymentNumber,
            date: p.paymentDate,
            method: p.method,
            reference: p.referenceNumber ?? "",
            amount: Number(p.amount),
            cancelled: p.status === "cancelled",
          })),
        ),
    enabled: LIVE,
    networkMode: "always",
  });
  const ledger = useQuery({
    queryKey: ["customer-ledger", customerId],
    queryFn: () => api.get<ApiLedger>(`/customers/${customerId}/ledger`),
    enabled: LIVE,
    networkMode: "always",
  });

  return useMemo(() => {
    if (LIVE) {
      const docLabel = (docType: string, number: string | null, narration: string | null) => {
        if (docType === "invoice") return `${t("nav.invoices")} ${number ?? ""}`;
        if (docType === "opening") return narration ?? "Opening balance";
        if (docType === "credit_note") return `${t("notes.creditNote")} ${number ?? ""}`;
        if (docType === "credit_note_cancel") return `${t("ledger.credit_note_cancel")} ${number ?? ""}`;
        return [number, narration].filter(Boolean).join(" · ") || docType;
      };
      return {
        loading: invoices.isPending || payments.isPending || ledger.isPending,
        invoices: invoices.data ?? [],
        payments: payments.data ?? [],
        ledger: [...(ledger.data?.entries ?? [])]
          .reverse()
          .slice(0, 60)
          .map<LedgerLine>((e) => ({
            key: String(e.id),
            date: e.date,
            label: docLabel(e.docType, e.docNumber, e.narration),
            debit: Number(e.debit),
            credit: Number(e.credit),
            balance: Number(e.balance),
          })),
      };
    }
    const customer = customerById.get(customerId);
    if (!customer) return { loading: false, invoices: [], payments: [], ledger: [] };
    const inv = customerInvoices(customerId);
    const pay = customerPayments(customerId);
    const entries = [
      ...inv.map((i) => ({ date: i.date, key: `i${i.id}`, label: `${t("nav.invoices")} ${i.number}`, debit: i.total, credit: 0 })),
      ...pay.map((p) => ({ date: p.date, key: `p${p.id}`, label: `${t(`paymentMethod.${p.method}`)} ${p.number}${p.reference ? ` · ${p.reference}` : ""}`, debit: 0, credit: p.amount })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.debit ? -1 : 1));
    let bal = customer.openingBalance;
    return {
      loading: false,
      invoices: [...inv].reverse().map((i) => ({ id: i.id, number: i.number, date: i.date, dueDate: i.dueDate, total: i.total, paid: i.paid, cancelled: false })),
      payments: [...pay].reverse().map((p) => ({ ...p, cancelled: false })),
      ledger: entries.map((e) => ({ ...e, balance: (bal += e.debit - e.credit) })).reverse().slice(0, 40),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, t, version, invoices.data, payments.data, ledger.data, invoices.isPending, payments.isPending, ledger.isPending]);
}
