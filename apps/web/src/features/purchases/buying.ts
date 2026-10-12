import type { GoodsReceiptStatus, GoodsReceiptView, PurchaseOrderItemView, PurchaseOrderStatus, PurchaseOrderView } from "@digitalbahi/contracts";
import type { Tone } from "../../components/ui/Badge";

/** Badge colour of an order's status. */
export const ORDER_STATUS_TONE: Record<PurchaseOrderStatus, Tone> = {
  open: "accent",
  partly_received: "warn",
  received: "good",
  closed: "neutral",
  cancelled: "danger",
};

/** Badge colour of a goods receipt's status. */
export const RECEIPT_STATUS_TONE: Record<GoodsReceiptStatus, Tone> = {
  received: "warn",
  billed: "good",
  cancelled: "danger",
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What of an order line is still to come, in the line's own unit: the paid
 * quantity first, then the free goods (10 + 1 free with 5½ cartons in: 4½
 * and 1 free).
 */
export function leftOnOrderLine(item: Pick<PurchaseOrderItemView, "qty" | "freeQty" | "conversionFactor" | "remainingBase" | "receivedBase">): { qty: number; free: number } {
  const factor = Number(item.conversionFactor) || 1;
  const remaining = Number(item.remainingBase) / factor;
  if (remaining <= 0) return { qty: 0, free: 0 };
  const received = Number(item.receivedBase) / factor;
  const qty = round3(Math.max(0, Number(item.qty) - received));
  return { qty, free: round3(Math.max(0, remaining - qty)) };
}

/** An order as a WhatsApp message to the supplier: its number, the goods and quantities, when they are wanted. */
export function orderMessage(
  order: Pick<PurchaseOrderView, "items">,
  options: { unitSymbol: (unitId: string) => string; number: (n: number) => string; heading: string; deliverBy: string | null; free: string },
): string {
  const lines = order.items.map((i, n) => {
    const free = Number(i.freeQty) > 0 ? ` + ${options.number(Number(i.freeQty))} ${options.free}` : "";
    return `${n + 1}. ${i.productName} — ${options.number(Number(i.qty))} ${options.unitSymbol(i.unitId)}${free}`;
  });
  return [options.heading, "", ...lines, ...(options.deliverBy ? ["", options.deliverBy] : [])].join("\n");
}

/** Goods receipts not billed yet and orders still open, of one supplier (what a bill can be made from). */
export interface OpenPurchases {
  receipts: GoodsReceiptView[];
  orders: PurchaseOrderView[];
}
