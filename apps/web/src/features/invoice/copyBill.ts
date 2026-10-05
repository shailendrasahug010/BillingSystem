import { productById } from "../../data/db";
import type { Draft, DraftLine } from "./useInvoiceDraft";

/** An old bill's lines, ready to open as a new bill (for today, nothing received yet). */
export interface CopiedBill {
  number: string;
  draft: Omit<Draft, "focusKey">;
}

/** A line of the bill being copied: what was sold, in what unit, how many, at what rate. */
export interface CopiedLine {
  productId: string;
  unitId: string | null;
  qty: number;
  freeQty?: number;
  rate: number;
  discountPercent: number;
}

// Handed from the bill's screen to the new bill's screen as it opens.
let pending: CopiedBill | null = null;

export function copyBill(number: string, customerId: string, lines: CopiedLine[]): void {
  const draftLines: DraftLine[] = lines
    .filter((l) => productById.has(l.productId))
    .map((l, i) => {
      // The stock unit is the line's own unit (null); a pack only while the product still has it.
      const packs = productById.get(l.productId)?.packUnits ?? [];
      return {
        key: `copy${i}`,
        productId: l.productId,
        unitId: l.unitId && packs.some((p) => p.unitId === l.unitId) ? l.unitId : null,
        qty: l.qty,
        freeQty: l.freeQty ?? 0,
        rate: l.rate,
        discountPercent: l.discountPercent,
      };
    });
  pending = {
    number,
    draft: { customerId, date: "", lines: draftLines, received: "", method: "cash", zeroRated: { withPayment: null, shippingBillNumber: "", shippingBillDate: "", portCode: "" } },
  };
}

/** The bill to copy, once: the new bill's screen takes it as it opens. */
export function takeCopiedBill(): CopiedBill | null {
  const copied = pending;
  pending = null;
  return copied;
}
