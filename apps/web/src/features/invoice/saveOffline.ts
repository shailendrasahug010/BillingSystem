import { BUSINESS, productById, WORKSPACE } from "../../data/db";
import { takeOfflineNumber } from "../../offline/device";
import { getOfflineState, queueBill, refreshDevice, type OutboxEntry } from "../../offline/sync";
import type { SavedInvoice } from "./postInvoice";
import type { PrintableInvoice } from "./printable";
import { factorOf, lutValidOn, unitSymbolOf, zeroRatedBody, type DraftView } from "./useInvoiceDraft";

export class OfflineNotReady extends Error {
  constructor() {
    super("offline-not-ready");
  }
}

/** The bill as it prints, from the totals the form showed (the same calculation the server makes). */
function printable(view: DraftView, id: string, number: string): PrintableInvoice {
  const { draft, customer, totals, dueDate } = view;
  const c = customer!;
  const t = totals!;
  const lines = draft.lines.map((l) => {
    const p = productById.get(l.productId)!;
    const r = t.lines.find((x) => x.key === l.key)!;
    return {
      name: p.name,
      nameLocal: p.nameHi,
      batch: null,
      hsn: p.hsn,
      qty: l.qty,
      freeQty: l.freeQty,
      unit: unitSymbolOf(p, l.unitId),
      rate: l.rate,
      discountPercent: l.discountPercent,
      taxable: r.taxable.toNumber(),
      gstRate: r.gstRate.toNumber(),
      cgst: r.cgst.toNumber(),
      sgst: r.sgst.toNumber(),
      igst: r.igst.toNumber(),
      total: r.total.toNumber(),
    };
  });
  const grandTotal = t.grandTotal.toNumber();
  const paid = Math.min(t.amountPaid.toNumber(), grandTotal);
  const z = view.zeroRated;
  const sb = draft.zeroRated;
  return {
    id,
    number,
    date: draft.date,
    dueDate,
    placeOfSupply: z?.kind === "export" ? "96" : c.stateCode,
    intraState: !z && c.stateCode === BUSINESS.stateCode,
    billOfSupply: !WORKSPACE.chargeTax,
    reverseCharge: false,
    status: t.paymentStatus,
    customerId: c.id,
    buyer: { businessName: c.businessName, name: c.name, address: c.address, pincode: c.pincode, stateCode: c.stateCode, gstin: c.gstin },
    lines,
    hsnSummary: t.hsnSummary.map((h) => ({ hsn: h.hsnCode, gstRate: h.gstRate.toNumber(), taxable: h.taxable.toNumber(), cgst: h.cgst.toNumber(), sgst: h.sgst.toNumber(), igst: h.igst.toNumber() })),
    taxableTotal: t.taxableTotal.toNumber(),
    cgstTotal: t.cgstTotal.toNumber(),
    sgstTotal: t.sgstTotal.toNumber(),
    igstTotal: t.igstTotal.toNumber(),
    cessTotal: t.cessTotal.toNumber(),
    roundOff: t.roundOff.toNumber(),
    grandTotal,
    paid,
    balance: Math.max(0, grandTotal - paid),
    zeroRated: z
      ? {
          type: z.type,
          lutArn: !z.withPayment && lutValidOn(draft.date) ? WORKSPACE.lut!.arn : null,
          shippingBill: z.kind === "export" ? { number: sb.shippingBillNumber.trim() || null, date: sb.shippingBillDate || null, portCode: sb.portCode.trim() || null } : { number: null, date: null, portCode: null },
        }
      : null,
  };
}

/**
 * Saves the bill on this device with the device's next number; it goes to
 * the server when the connection is back. `idempotencyKey` is the key of the
 * online attempt, if there was one: should that attempt have reached the
 * server after all, the sync returns that bill instead of making a second.
 */
export async function saveOffline(view: DraftView, idempotencyKey: string): Promise<SavedInvoice> {
  const { draft, customer, totals } = view;
  const { device } = getOfflineState();
  if (!device || !customer || !totals) throw new OfflineNotReady();
  const taken = await takeOfflineNumber(device.userId, device.businessId, draft.date);
  if (!taken) throw new OfflineNotReady();
  const received = draft.received.trim() === "" ? 0 : Number(draft.received) || 0;
  const savedAt = new Date().toISOString();
  const doc = printable(view, `offline:${idempotencyKey}`, taken.number);
  const entry: OutboxEntry = {
    id: idempotencyKey,
    userId: device.userId,
    businessId: device.businessId,
    number: taken.number,
    date: draft.date,
    savedAt,
    customerId: customer.id,
    customerName: customer.businessName,
    total: doc.grandTotal,
    paid: doc.paid,
    lineCount: draft.lines.length,
    body: {
      customerId: customer.id,
      invoiceDate: draft.date,
      lines: draft.lines.map((l) => ({
        productId: l.productId,
        ...(l.unitId ? { unitId: l.unitId } : {}),
        qty: l.qty.toFixed(3),
        ...(l.freeQty > 0 ? { freeQty: l.freeQty.toFixed(3) } : {}),
        rate: l.rate.toFixed(4),
        discountPercent: Math.min(100, Math.max(0, l.discountPercent || 0)).toFixed(2),
      })),
      ...(received > 0 ? { payment: { amount: received.toFixed(2), method: draft.method } } : {}),
      ...zeroRatedBody(view),
      offline: { deviceId: taken.device.id, invoiceNumber: taken.number, savedAt },
    },
    printable: doc,
    stock: draft.lines.map((l) => ({ productId: l.productId, qty: (l.qty + l.freeQty) * factorOf(productById.get(l.productId)!, l.unitId) })),
    status: "pending",
    error: null,
  };
  if (!(await queueBill(entry))) throw new OfflineNotReady();
  void refreshDevice();
  return { id: doc.id, number: taken.number, date: draft.date, total: doc.grandTotal, paid: doc.paid, lineCount: entry.lineCount, warnings: [] };
}
