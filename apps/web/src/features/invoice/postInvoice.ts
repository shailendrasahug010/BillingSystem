import { queryClient } from "../../app/session";
import { customerById } from "../../data/db";
import { adjustStock } from "../../data/live";
import { dropLiveInsight, touch } from "../../data/store";
import { api, QUICK_SAVE_MS } from "../../lib/api";
import { bodyLines, zeroRatedBody, type DraftView } from "./useInvoiceDraft";

export interface SavedInvoice {
  id: string;
  number: string;
  date: string;
  total: number;
  paid: number;
  lineCount: number;
  warnings: Array<{ code: string; params: Record<string, string | number> }>;
}

interface PostedInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
  items: Array<{ productId: string; qtyBase: string; freeQty: string; conversionFactor: string }>;
  warnings: SavedInvoice["warnings"];
}

/**
 * Posts the draft to the API. The server re-prices and re-taxes it; sending
 * the displayed grand total makes it refuse (TOTALS_MISMATCH) rather than
 * save a bill that differs from what the user saw. The idempotency key makes
 * a retry after a network failure safe.
 */
export async function postInvoice(view: DraftView, idempotencyKey: string): Promise<SavedInvoice> {
  const { draft, customer, totals } = view;
  const received = draft.received.trim() === "" ? 0 : Number(draft.received) || 0;
  const res = await api.post<PostedInvoice>(
    "/invoices",
    {
      customerId: customer!.id,
      invoiceDate: draft.date,
      lines: bodyLines(view.billLines),
      ...(received > 0 ? { payment: { amount: received.toFixed(2), method: draft.method } } : {}),
      ...zeroRatedBody(view),
      clientTotals: { grandTotal: totals!.grandTotal.toFixed(2) },
    },
    { idempotencyKey, timeoutMs: QUICK_SAVE_MS },
  );
  // Keep the cached workspace in step without reloading it.
  for (const item of res.items) {
    adjustStock(item.productId, -(Number(item.qtyBase) + Number(item.freeQty) * Number(item.conversionFactor)));
  }
  const c = customerById.get(customer!.id);
  if (c) c.balance = (c.balance ?? 0) + Number(res.grandTotal) - Number(res.amountPaid);
  dropLiveInsight(customer!.id);
  void queryClient.invalidateQueries({ queryKey: ["insight", customer!.id] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  touch();
  return {
    id: res.id,
    number: res.invoiceNumber,
    date: res.invoiceDate,
    total: Number(res.grandTotal),
    paid: Number(res.amountPaid),
    lineCount: res.items.length,
    warnings: res.warnings ?? [],
  };
}

